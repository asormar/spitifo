//! Starts and stops the Python backend sidecar.
//!
//! The backend is the PyInstaller build in `resources/backend/`. It picks a free
//! port, prints `SPITIFO_READY port=<n>` on stdout once it listens, and rejects
//! every request without the per-launch secret (`SPITIFO_TOKEN`). The shell
//! waits for that line and then points the window at the backend, which serves
//! the React UI exactly as in the browser version.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewWindow};

const READY_PREFIX: &str = "SPITIFO_READY port=";
/// The first launch after install can be slow while antivirus scans the
/// unpacked Python runtime.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// The running sidecar, so it can be killed when the app exits.
#[derive(Default)]
pub struct Backend(Mutex<Option<Child>>);

impl Backend {
    pub fn stop(&self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Spawns the sidecar and navigates `window` to it once it is ready.
pub fn start(app: &AppHandle, window: WebviewWindow) -> Result<(), String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let library = app
        .path()
        .audio_dir()
        .map_err(|e| e.to_string())?
        .join("Spitifo");
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log_path = log_dir.join("backend.log");

    let token = new_token()?;
    let mut child = spawn(&resources, &library, &log_path, &token)
        .map_err(|e| format!("No se pudo iniciar el backend: {e}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    app.state::<Backend>().0.lock().unwrap().replace(child);

    let settled = Arc::new(AtomicBool::new(false));

    let reader_settled = settled.clone();
    let reader_window = window.clone();
    let reader_log = log_path.clone();
    thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        for line in lines.by_ref().map_while(Result::ok) {
            let Some(port) = line.strip_prefix(READY_PREFIX) else {
                continue;
            };
            if reader_settled.swap(true, Ordering::SeqCst) {
                return;
            }
            let url = format!("http://127.0.0.1:{}/?token={token}", port.trim());
            match Url::parse(&url) {
                Ok(url) => {
                    if let Err(e) = reader_window.navigate(url) {
                        fail(&reader_window, &format!("No se pudo abrir la interfaz: {e}"));
                    }
                }
                Err(e) => fail(&reader_window, &format!("Puerto inválido ({port}): {e}")),
            }
            break;
        }
        // Keep draining stdout so the backend never blocks on a full pipe.
        for _ in lines {}
        if !reader_settled.swap(true, Ordering::SeqCst) {
            fail(
                &reader_window,
                &format!(
                    "El backend se cerró al iniciar.\nDetalles en {}",
                    reader_log.display()
                ),
            );
        }
    });

    thread::spawn(move || {
        thread::sleep(READY_TIMEOUT);
        if !settled.swap(true, Ordering::SeqCst) {
            fail(
                &window,
                &format!(
                    "El backend no respondió en {} s.\nDetalles en {}",
                    READY_TIMEOUT.as_secs(),
                    log_path.display()
                ),
            );
        }
    });

    Ok(())
}

fn spawn(resources: &Path, library: &Path, log_path: &Path, token: &str) -> std::io::Result<Child> {
    let exe = resources.join("backend").join(executable("spitifo-backend"));
    let log = File::create(log_path)?;

    let mut cmd = Command::new(&exe);
    cmd.env("SPITIFO_TOKEN", token)
        .env("SPITIFO_PORT", "0")
        .env("SPITIFO_LIBRARY", library)
        .env("SPITIFO_FRONTEND_DIST", resources.join("frontend"))
        .env("SPITIFO_FFMPEG_DIR", resources.join("ffmpeg"))
        .env("YTDLP_ENABLED", "1")
        // Python would otherwise write logs in the console code page.
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(log);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn()?;
    #[cfg(windows)]
    kill_with_parent(&child);
    Ok(child)
}

fn executable(name: &str) -> PathBuf {
    PathBuf::from(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    })
}

/// 32 random bytes as hex: the secret every backend request must carry.
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn fail(window: &WebviewWindow, message: &str) {
    let arg = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!("window.spitifoFailed && window.spitifoFailed({arg})"));
}

/// Puts the sidecar in a job object that kills it when the shell's last handle
/// closes, so a crashed or force-closed shell never leaves the backend running.
/// The job handle is leaked on purpose: Windows closes it when the process ends.
#[cfg(windows)]
fn kill_with_parent(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::{mem, ptr};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        AssignProcessToJobObject(job, child.as_raw_handle() as _);
    }
}
