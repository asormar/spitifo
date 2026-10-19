package dev.spitifo

import android.app.Application
import android.media.MediaScannerConnection
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.system.Os
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns the embedded Python backend for the whole process.
 *
 * One instance per process, held by [SpitifoApp]: the server has to survive
 * Activity recreation and keep running while a download is in flight, so it can
 * never live on an Activity. [start] is called once from Application.onCreate
 * and sets everything up on a background thread, because extracting the
 * frontend, unzipping ffmpeg and booting CPython take seconds and the first
 * frame must not wait for them.
 */
class Backend(private val app: Application) {

    /** Where the shell learns that the backend is up (or why it is not). */
    interface Listener {
        /** The server is listening; [port] is the real one (the OS picked it). */
        fun onReady(port: Int)

        /** Startup failed for good; [message] is meant to be shown to the user. */
        fun onFailed(message: String)
    }

    /**
     * The single object handed to `spitifo_android.serve()`: Python calls all
     * three methods (readiness, download activity, failure) from its own
     * thread, so every callback hops to the main thread before touching UI or
     * services.
     */
    interface ServeListener {
        fun onReady(port: Int)
        fun onBusyChanged(busy: Boolean)
        fun onFailed(message: String)
    }

    private val token: String = newToken()

    @Volatile
    private var bound = -1

    @Volatile
    private var failure: String? = null

    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<Listener>()
    private val started = AtomicBoolean(false)

    /** The real listening port, or -1 until [Listener.onReady]. */
    val port: Int get() = bound

    /** Boots the backend once per process, on a daemon thread. */
    fun start() {
        if (!started.compareAndSet(false, true)) return
        Thread({ setUp() }, "spitifo-backend").apply { isDaemon = true }.start()
    }

    /**
     * Registers [l] and replays the current state immediately, so an Activity
     * that attaches after the server came up still gets its port.
     */
    fun addListener(l: Listener) {
        listeners.add(l)
        main.post {
            val error = failure
            when {
                error != null -> l.onFailed(error)
                bound > 0 -> l.onReady(bound)
            }
        }
    }

    fun removeListener(l: Listener) {
        listeners.remove(l)
    }

    /**
     * The one URL the WebView loads: the backend trades `token` for a session
     * cookie and keeps whatever else is in the query.
     *
     * @param query a search to run on boot (share target), or null for the
     *   plain UI.
     * @param youTube whether [query] is a YouTube link, which only makes sense
     *   in "YouTube" mode (iTunes cannot search a URL).
     */
    fun url(port: Int, query: String? = null, youTube: Boolean = false): String {
        val sb = StringBuilder("http://127.0.0.1:").append(port).append("/?token=").append(token)
        if (!query.isNullOrEmpty()) {
            sb.append("&q=").append(URLEncoder.encode(query, StandardCharsets.UTF_8.name()))
            if (youTube) sb.append("&mode=ytdlp")
        }
        return sb.toString()
    }

    // ------------------------------------------------------------- startup

    private fun setUp() {
        val t0 = SystemClock.elapsedRealtime()
        try {
            val dist = extractFrontendDist()
            val ffmpegBin = setupFfmpeg()
            // Leftovers from a download that was killed mid-flight: they would
            // never be finished, and yt-dlp's temp names are random.
            val temp = File(app.cacheDir, "downloads").apply {
                deleteRecursively()
                mkdirs()
            }
            // Public Music folder: the files stay reachable by any music
            // player on the phone, which is the whole point of the app. minSdk
            // 30 means direct file paths into it work through FUSE.
            val library = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC),
                "Spitifo",
            ).apply { mkdirs() }

            if (!Python.isStarted()) Python.start(AndroidPlatform(app))
            val environ = Python.getInstance().getModule("os").get("environ")!!

            // Every variable backend.app.main reads at import time. Setting
            // them through os.environ is also what makes them reach the ffmpeg
            // and yt-dlp child processes later.
            environ.callAttr("__setitem__", "SPITIFO_TOKEN", token)
            environ.callAttr("__setitem__", "SPITIFO_LIBRARY", library.absolutePath)
            environ.callAttr("__setitem__", "SPITIFO_TEMP_DIR", temp.absolutePath)
            environ.callAttr("__setitem__", "SPITIFO_FRONTEND_DIST", dist.absolutePath)
            // Tells the backend it is the embedded shell, not the desktop one:
            // Drive sign-in goes through this app (DriveAuth), not a loopback
            // OAuth flow. See backend/app/cloud/android.py.
            environ.callAttr("__setitem__", "SPITIFO_PLATFORM", "android")
            environ.callAttr("__setitem__", "YTDLP_ENABLED", "1")
            // yt-dlp and friends keep their caches under HOME.
            environ.callAttr("__setitem__", "HOME", app.filesDir.absolutePath)
            // yt-dlp writes the JavaScript it feeds to QuickJS into a temp
            // file, and TMPDIR is what Python's tempfile reads: setdefault
            // keeps an already configured one.
            environ.callAttr("setdefault", "TMPDIR", app.cacheDir.absolutePath)

            if (ffmpegBin != null) {
                // The backend prepends this to PATH itself (runtime.py), which
                // is where shutil.which and yt-dlp look for it.
                environ.callAttr("__setitem__", "SPITIFO_FFMPEG_DIR", ffmpegBin.absolutePath)
                probeFfmpeg(File(ffmpegBin, "ffmpeg"))
            } else {
                Log.e(TAG, "continuing without ffmpeg: YouTube downloads will fail")
            }

            // QuickJS-ng, extracted next to ffmpeg's binaries because it ships
            // as libqjs.so (see downloadQuickJs in app/build.gradle.kts). It is
            // the JavaScript runtime yt-dlp runs to solve YouTube's challenges.
            val qjs = File(app.applicationInfo.nativeLibraryDir, "libqjs.so")
            if (qjs.isFile) {
                environ.callAttr("__setitem__", "SPITIFO_QJS", qjs.absolutePath)
            } else {
                Log.w(TAG, "libqjs.so is not in ${app.applicationInfo.nativeLibraryDir}: " +
                    "YouTube challenges will go unsolved")
            }

            Log.i(TAG, "library=${library.absolutePath} temp=${temp.absolutePath} " +
                "dist=${dist.absolutePath} setup=${SystemClock.elapsedRealtime() - t0} ms")

            val listener = object : ServeListener {
                override fun onReady(p: Int) {
                    bound = p
                    Log.i(TAG, "backend ready on port $p")
                    main.post { listeners.forEach { it.onReady(p) } }
                }

                override fun onBusyChanged(busy: Boolean) {
                    // Downloads come and go: the foreground service mirrors
                    // that, and only that, so it is never left running idle.
                    // Walking the library over FUSE is slow: never on the
                    // asyncio thread this callback arrives on. One thread keeps
                    // each snapshot ahead of the scan that diffs against it.
                    scanner.execute {
                        if (busy) librarySnapshot = snapshot(library)
                        else scanChanges(library)
                    }
                    main.post { DownloadService.setBusy(app, busy) }
                }

                override fun onFailed(message: String) {
                    Log.e(TAG, "backend failed: $message")
                    failure = message
                    main.post { listeners.forEach { it.onFailed(message) } }
                }
            }

            // Blocks for the life of the process.
            Python.getInstance().getModule("spitifo_android").callAttr("serve", listener)
        } catch (e: Throwable) {
            Log.e(TAG, "backend startup failed", e)
            failure = "Backend failed to start: ${e.message}"
            main.post { listeners.forEach { it.onFailed(failure!!) } }
        }
    }

    // ------------------------------------------------------- media scanning

    /** Library files and their mtimes when the current batch started. */
    @Volatile
    private var librarySnapshot: Map<String, Long> = emptyMap()

    private val scanner = Executors.newSingleThreadExecutor { r ->
        Thread(r, "spitifo-media-scan").apply { isDaemon = true }
    }

    private fun snapshot(library: File): Map<String, Long> =
        library.walkTopDown().filter { it.isFile }
            .associate { it.absolutePath to it.lastModified() }

    /**
     * Tells MediaStore about the files the last batch of downloads produced.
     *
     * Files created through FUSE by a direct path are NOT indexed on their own
     * (measured on Android 16: the folders showed up, the MP3 did not), so other
     * music players would never see them. A snapshot diff is used instead of a
     * "modified since" filter because yt-dlp sets a file's mtime from the
     * server's Last-Modified header, which can be years old.
     */
    private fun scanChanges(library: File) {
        val before = librarySnapshot
        val changed = snapshot(library).filter { (path, mtime) -> before[path] != mtime }.keys
        if (changed.isEmpty()) return
        MediaScannerConnection.scanFile(app, changed.toTypedArray(), null) { path, uri ->
            Log.i(TAG, "media scan: $path -> $uri")
        }
    }

    /**
     * Copies the compiled frontend out of the assets, but only when the APK
     * changed: it is ~1 MB of files and re-copying it on every launch only
     * delays the first frame. `lastUpdateTime` bumps exactly when a new APK is
     * installed, which is also the only moment the dist can differ.
     */
    private fun extractFrontendDist(): File {
        val dist = File(app.filesDir, "frontend/dist")
        val marker = File(dist, ".apk-update-time")
        val apk = app.packageManager.getPackageInfo(app.packageName, 0).lastUpdateTime.toString()
        if (marker.isFile && marker.readText() == apk) {
            Log.i(TAG, "frontend dist already extracted (apk $apk)")
            return dist
        }
        val t0 = SystemClock.elapsedRealtime()
        dist.deleteRecursively()
        dist.mkdirs()
        copyAsset("frontend-dist", dist)
        marker.writeText(apk)
        Log.i(TAG, "frontend dist extracted in ${SystemClock.elapsedRealtime() - t0} ms")
        return dist
    }

    /**
     * Makes Spitifo's own ffmpeg/ffprobe usable by the unchanged backend, which
     * shells out to `ffmpeg`/`ffprobe` by name (shutil.which in downloader.py)
     * and lets yt-dlp find them on PATH.
     *
     * Both are statically linked executables (scripts/ffmpeg/build.sh), staged
     * as libffmpeg.so and libffprobe.so (see downloadFfmpeg in
     * app/build.gradle.kts). Android extracts them to nativeLibraryDir because
     * jniLibs useLegacyPackaging = true, and that is the only place an app may
     * exec from. They need no libraries of their own, so all that is left is to
     * symlink them under the names the backend looks for.
     *
     * @return the directory that holds the `ffmpeg` and `ffprobe` links, or null
     *   if the executables are not in the APK.
     */
    private fun setupFfmpeg(): File? {
        val nativeDir = File(app.applicationInfo.nativeLibraryDir)
        val ffmpegExe = File(nativeDir, "libffmpeg.so")
        val ffprobeExe = File(nativeDir, "libffprobe.so")
        if (!ffmpegExe.isFile || !ffprobeExe.isFile) {
            Log.e(TAG, "ffmpeg missing in ${nativeDir.absolutePath}: " +
                "ffmpeg=${ffmpegExe.exists()} ffprobe=${ffprobeExe.exists()}")
            return null
        }
        val binDir = File(app.filesDir, "bin").apply { mkdirs() }
        symlink(File(binDir, "ffmpeg"), ffmpegExe.absolutePath)
        symlink(File(binDir, "ffprobe"), ffprobeExe.absolutePath)
        return binDir
    }

    /**
     * Runs `ffmpeg -version` the same way the backend will: by name. A binary
     * that is present but cannot start would otherwise only show up as a
     * mysterious failed download, and failures here are logged, not fatal.
     */
    private fun probeFfmpeg(ffmpeg: File) {
        try {
            val process = ProcessBuilder(ffmpeg.absolutePath, "-version")
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            val rc = process.waitFor()
            Log.i(TAG, "ffmpeg probe rc=$rc: ${output.lineSequence().firstOrNull() ?: "<no output>"}")
        } catch (e: Exception) {
            Log.e(TAG, "ffmpeg probe failed", e)
        }
    }

    /** Creates/replaces a symlink (File.delete removes the link, not the target). */
    private fun symlink(link: File, target: String) {
        try {
            link.delete()
            Os.symlink(target, link.absolutePath)
        } catch (e: Exception) {
            Log.e(TAG, "could not symlink ${link.absolutePath} -> $target", e)
        }
    }

    /** Recursive copy of an asset file or directory tree. */
    private fun copyAsset(path: String, dest: File) {
        val list = app.assets.list(path) ?: emptyArray()
        if (list.isEmpty()) {
            dest.parentFile?.mkdirs()
            app.assets.open(path).use { i -> dest.outputStream().use { o -> i.copyTo(o) } }
        } else {
            dest.mkdirs()
            for (n in list) copyAsset("$path/$n", File(dest, n))
        }
    }

    companion object {
        private const val TAG = "Spitifo"

        /**
         * A fresh secret per launch, hex-encoded: the backend refuses every
         * request that does not carry it, and the WebView only learns it from
         * the URL the shell loads. Another app on the phone can reach
         * 127.0.0.1, so this is the only thing standing between it and the
         * user's library.
         */
        private fun newToken(): String {
            val bytes = ByteArray(32)
            SecureRandom().nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }
    }
}
