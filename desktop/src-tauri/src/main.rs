// No console window next to the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::Backend;
use tauri::{Manager, RunEvent};

fn main() {
    tauri::Builder::default()
        .manage(Backend::default())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window is declared in tauri.conf.json");
            backend::start(app.handle(), window)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Spitifo app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Backend>().stop();
            }
        });
}
