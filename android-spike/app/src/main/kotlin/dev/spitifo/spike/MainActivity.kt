package dev.spitifo.spike

import android.app.Activity
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.system.Os
import android.util.Log
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.TextView
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.zip.ZipFile

class MainActivity : Activity() {
    private val tag = "SpitifoSpike"
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val t0 = SystemClock.elapsedRealtime()
        val status = TextView(this).apply {
            text = "Starting Python backend..."; textSize = 18f; setPadding(40, 120, 40, 40)
        }
        setContentView(status)

        // Foreground service: keeps network + CPU alive with the screen off.
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        startForegroundService(android.content.Intent(this, KeepAliveService::class.java))

        Thread {
            try {
                // 1) frontend dist out of assets -> real files
                val dist = File(filesDir, "frontend/dist")
                if (dist.exists()) dist.deleteRecursively()
                copyAsset("frontend-dist", dist)
                val tAssets = SystemClock.elapsedRealtime()
                Log.i(tag, "assets copied in ${tAssets - t0} ms")

                // 2) ffmpeg/ffprobe from the youtubedl-android ffmpeg AAR, before
                //    Python starts: the backend finds them by name on PATH.
                val ff = setupFfmpeg()
                if (ff == null) {
                    Log.e(tag, "continuing without ffmpeg: YouTube mp3/m4a will fail")
                }

                // 3) Python start
                val music = getExternalFilesDir(Environment.DIRECTORY_MUSIC)!!
                music.mkdirs()
                if (!Python.isStarted()) Python.start(AndroidPlatform(this))
                val py = Python.getInstance()
                val tPy = SystemClock.elapsedRealtime()
                Log.i(tag, "Python.start in ${tPy - tAssets} ms")

                val env = py.getModule("os").get("environ")!!
                env.callAttr("__setitem__", "SPITIFO_LIBRARY", music.absolutePath)
                env.callAttr("__setitem__", "YTDLP_ENABLED", "1")
                env.callAttr("__setitem__", "SPITIFO_FRONTEND_DIST", dist.absolutePath)
                env.callAttr("__setitem__", "HOME", filesDir.absolutePath)
                if (ff != null) {
                    val (binDir, libDir) = ff
                    val path = System.getenv("PATH").orEmpty()
                    val ldPath = System.getenv("LD_LIBRARY_PATH").orEmpty()
                    env.callAttr("__setitem__", "PATH",
                        listOf(binDir.absolutePath, applicationInfo.nativeLibraryDir, path)
                            .filter { it.isNotEmpty() }.joinToString(":"))
                    env.callAttr("__setitem__", "LD_LIBRARY_PATH",
                        listOf(libDir.absolutePath, applicationInfo.nativeLibraryDir, ldPath)
                            .filter { it.isNotEmpty() }.joinToString(":"))
                }
                Log.i(tag, "library=${music.absolutePath}")

                // 4) import backend + run uvicorn (blocking call) in its own thread
                Thread {
                    try {
                        val tImp = SystemClock.elapsedRealtime()
                        val m = py.getModule("spike_server")
                        Log.i(tag, "backend import in ${SystemClock.elapsedRealtime() - tImp} ms (python-side ${m.get("IMPORT_SECONDS")} s)")
                        // prove ffmpeg/ffprobe resolve by name and actually run
                        m.callAttr("verify_binaries").toString().lines()
                            .forEach { Log.i(tag, "BIN $it") }
                        m.callAttr("serve", "127.0.0.1", 8000)
                    } catch (e: Throwable) {
                        Log.e(tag, "server thread died", e)
                    }
                }.apply { name = "uvicorn"; isDaemon = true }.start()

                // 5) poll until it answers
                val tPoll = SystemClock.elapsedRealtime()
                var ready = false
                while (SystemClock.elapsedRealtime() - tPoll < 120_000) {
                    try {
                        val c = URL("http://127.0.0.1:8000/api/health").openConnection() as HttpURLConnection
                        c.connectTimeout = 500; c.readTimeout = 2000
                        if (c.responseCode == 200) { ready = true; break }
                    } catch (_: Exception) {
                        Thread.sleep(100)
                    }
                }
                val tReady = SystemClock.elapsedRealtime()
                Log.i(tag, "server ready=$ready; ${tReady - tPy} ms after Python.start, ${tReady - t0} ms since onCreate")
                runOnUiThread {
                    if (!ready) { status.text = "Backend did not come up"; return@runOnUiThread }
                    web = WebView(this).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        webChromeClient = WebChromeClient()
                    }
                    setContentView(web)
                    web.loadUrl("http://127.0.0.1:8000/")
                    Log.i(tag, "WebView loadUrl issued")
                }
            } catch (e: Throwable) {
                Log.e(tag, "startup failed", e)
                runOnUiThread { status.text = "Startup failed: $e" }
            }
        }.start()
    }

    /**
     * Makes the ffmpeg/ffprobe binaries from the youtubedl-android `ffmpeg` AAR
     * usable by the unchanged backend, which shells out to `ffmpeg`/`ffprobe`
     * by name (shutil.which in downloader.py) and lets yt-dlp find them on PATH.
     *
     * The AAR ships three files in nativeLibraryDir (Android extracts them
     * there because jniLibs useLegacyPackaging = true):
     *   libffmpeg.so      - the ffmpeg PIE executable (interp /system/bin/linker64)
     *   libffprobe.so     - the ffprobe PIE executable
     *   libffmpeg.zip.so  - a zip of the usr/lib shared libraries both need
     *
     * So: unzip the payload next to the app, symlink `ffmpeg`/`ffprobe` to the
     * executables, and let the caller prepend the symlink dir to PATH and the
     * lib dir to LD_LIBRARY_PATH.
     *
     * @return binDir (PATH lookup) to libDir (LD_LIBRARY_PATH), or null if the
     *         artifact is not in the APK.
     */
    private fun setupFfmpeg(): Pair<File, File>? {
        val tStart = SystemClock.elapsedRealtime()
        val nativeDir = File(applicationInfo.nativeLibraryDir)
        val ffmpegExe = File(nativeDir, "libffmpeg.so")
        val ffprobeExe = File(nativeDir, "libffprobe.so")
        val payload = File(nativeDir, "libffmpeg.zip.so")
        if (!ffmpegExe.isFile || !ffprobeExe.isFile || !payload.isFile) {
            Log.e(tag, "ffmpeg artifact incomplete in ${nativeDir.absolutePath}: " +
                "ffmpeg=${ffmpegExe.exists()} ffprobe=${ffprobeExe.exists()} zip=${payload.exists()}")
            return null
        }

        // 1) Unzip the shared-lib payload once. The payload size doubles as its
        //    version: a new AAR changes it and forces a re-extract. The schema
        //    prefix bumps extraction when this code changes.
        val ffmpegDir = File(noBackupFilesDir, "youtubedl-android/packages/ffmpeg")
        val stamp = "3:${payload.length()}"
        val marker = File(ffmpegDir, ".payload-size")
        if (!marker.isFile || marker.readText() != stamp) {
            ffmpegDir.deleteRecursively()
            ffmpegDir.mkdirs()
            val tUnzip = SystemClock.elapsedRealtime()
            val (files, links) = extractZip(payload, ffmpegDir)
            // Libs the ffmpeg payload does not ship (libexpat, libcrypto,
            // libc++_shared...), staged as assets from the same publisher's
            // library AAR. Same dir so one LD_LIBRARY_PATH entry covers all.
            val support = File(ffmpegDir, "usr/lib")
            val copied = copyAssetDir("ffmpeg-support", support)
            marker.writeText(stamp)
            Log.i(tag, "ffmpeg payload unzipped in ${SystemClock.elapsedRealtime() - tUnzip} ms " +
                "($files files, $links symlinks, $copied support libs, " +
                "${payload.length() / 1_048_576} MB -> ${dirSize(ffmpegDir) / 1_048_576} MB)")
        } else {
            Log.i(tag, "ffmpeg payload already extracted (${marker.readText()})")
        }
        val libDir = File(ffmpegDir, "usr/lib")

        // 2) Names the backend looks for, pointing at the extracted executables.
        val binDir = File(filesDir, "bin").apply { mkdirs() }
        symlink(File(binDir, "ffmpeg"), ffmpegExe.absolutePath)
        symlink(File(binDir, "ffprobe"), ffprobeExe.absolutePath)

        Log.i(tag, "ffmpeg ready in ${SystemClock.elapsedRealtime() - tStart} ms; " +
            "exe=${ffmpegExe.absolutePath} libs=${libDir.absolutePath} " +
            "libCount=${libDir.list()?.size}")
        return binDir to libDir
    }

    /**
     * Extracts a zip that stores some entries as Unix symlinks. Java's
     * java.util.zip does not expose the Unix mode, so this sniffs them the way
     * they are stored: a tiny entry whose content is the (relative) link target.
     * Anything ambiguous is written as a plain file instead.
     */
    private fun extractZip(zip: File, destDir: File): Pair<Int, Int> {
        var files = 0
        val candidates = LinkedHashMap<String, ByteArray>()
        ZipFile(zip).use { zf ->
            val entries = zf.entries()
            while (entries.hasMoreElements()) {
                val e = entries.nextElement()
                val out = File(destDir, e.name)
                if (e.isDirectory) { out.mkdirs(); continue }
                val bytes = zf.getInputStream(e).use { it.readBytes() }
                if (bytes.size <= MAX_SYMLINK_ENTRY) {
                    candidates[e.name] = bytes
                    continue
                }
                out.parentFile?.mkdirs()
                out.writeBytes(bytes)
                files++
            }
        }
        var links = 0
        // Symlinks can point at other symlinks (glib-2.0.so -> .so.0 ->
        // .so.0.8600.0), so link in several passes: a target may not exist yet.
        var remaining = candidates
        while (remaining.isNotEmpty()) {
            val next = LinkedHashMap<String, ByteArray>()
            var progressed = false
            for ((name, bytes) in remaining) {
                val out = File(destDir, name)
                out.parentFile?.mkdirs()
                val target = String(bytes, StandardCharsets.UTF_8).trim()
                val resolved = out.parentFile?.let { File(it, target) }
                if (target.isNotEmpty() && !target.startsWith("/") &&
                    !target.contains("..") && resolved != null && resolved.exists()) {
                    Os.symlink(target, out.absolutePath)
                    links++
                    progressed = true
                } else {
                    next[name] = bytes
                }
            }
            if (!progressed) break
            remaining = next
        }
        for ((name, bytes) in remaining) {
            File(destDir, name).writeBytes(bytes)
            files++
            Log.w(tag, "payload entry kept as a file: $name")
        }
        return files to links
    }

    /** Copies every flat asset in `assetsPath` into `destDir`, keeping names. */
    private fun copyAssetDir(assetsPath: String, destDir: File): Int {
        val names = assets.list(assetsPath) ?: return 0
        destDir.mkdirs()
        for (n in names) {
            assets.open("$assetsPath/$n").use { i ->
                File(destDir, n).outputStream().use { o -> i.copyTo(o) }
            }
        }
        return names.size
    }

    /** Creates/replaces a symlink (File.delete removes the link, not the target). */
    private fun symlink(link: File, target: String) {
        try {
            link.delete()
            Os.symlink(target, link.absolutePath)
        } catch (e: Exception) {
            Log.e(tag, "could not symlink ${link.absolutePath} -> $target", e)
        }
    }

    private fun dirSize(dir: File): Long =
        dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    private fun copyAsset(path: String, dest: File) {
        val list = assets.list(path) ?: emptyArray()
        if (list.isEmpty()) {
            dest.parentFile?.mkdirs()
            assets.open(path).use { i -> dest.outputStream().use { o -> i.copyTo(o) } }
        } else {
            dest.mkdirs()
            for (n in list) copyAsset("$path/$n", File(dest, n))
        }
    }

    private companion object {
        /** A stored symlink entry is just the target path, far below this. */
        const val MAX_SYMLINK_ENTRY = 128
    }
}
