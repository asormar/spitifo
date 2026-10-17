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
import java.util.zip.ZipFile

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
            val natives = setupFfmpeg()
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
            environ.callAttr("__setitem__", "YTDLP_ENABLED", "1")
            // yt-dlp and friends keep their caches under HOME.
            environ.callAttr("__setitem__", "HOME", app.filesDir.absolutePath)

            if (natives != null) {
                val (binDir, libDir) = natives
                // The backend prepends this to PATH itself (runtime.py), which
                // is where shutil.which and yt-dlp look for it.
                environ.callAttr("__setitem__", "SPITIFO_FFMPEG_DIR", binDir.absolutePath)
                // ffmpeg and ffprobe load their .so's from here: not something
                // the backend can know about.
                val ldPath = listOf(libDir.absolutePath, app.applicationInfo.nativeLibraryDir)
                    .filter { it.isNotEmpty() }
                    .joinToString(":") { it }
                environ.callAttr("__setitem__", "LD_LIBRARY_PATH", ldPath)
                probeFfmpeg(File(binDir, "ffmpeg"), ldPath)
            } else {
                Log.e(TAG, "continuing without ffmpeg: YouTube downloads will fail")
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
     * executables, and hand back binDir (PATH lookup) and libDir
     * (LD_LIBRARY_PATH).
     *
     * @return binDir to libDir, or null if the artifact is not in the APK.
     */
    private fun setupFfmpeg(): Pair<File, File>? {
        val t0 = SystemClock.elapsedRealtime()
        val nativeDir = File(app.applicationInfo.nativeLibraryDir)
        val ffmpegExe = File(nativeDir, "libffmpeg.so")
        val ffprobeExe = File(nativeDir, "libffprobe.so")
        val payload = File(nativeDir, "libffmpeg.zip.so")
        if (!ffmpegExe.isFile || !ffprobeExe.isFile || !payload.isFile) {
            Log.e(TAG, "ffmpeg artifact incomplete in ${nativeDir.absolutePath}: " +
                "ffmpeg=${ffmpegExe.exists()} ffprobe=${ffprobeExe.exists()} zip=${payload.exists()}")
            return null
        }

        // Unzipped once, and the payload size doubles as its version: a new AAR
        // changes it and forces a re-extract. The schema prefix bumps the
        // extraction when this code changes. The whole payload is kept as-is:
        // ffmpeg and ffprobe share 70.9 of its 74.5 MB, so trimming would buy
        // almost nothing.
        val ffmpegDir = File(app.noBackupFilesDir, "youtubedl-android/packages/ffmpeg")
        val stamp = "1:${payload.length()}"
        val marker = File(ffmpegDir, ".payload-size")
        if (!marker.isFile || marker.readText() != stamp) {
            ffmpegDir.deleteRecursively()
            ffmpegDir.mkdirs()
            val tUnzip = SystemClock.elapsedRealtime()
            val (files, links) = extractZip(payload, ffmpegDir)
            // Libraries the ffmpeg payload does not ship (libexpat, libcrypto,
            // libc++_shared...), staged as assets from the same publisher's
            // library AAR. Same dir, so one LD_LIBRARY_PATH entry covers all.
            val copied = copyAssetDir("ffmpeg-support", File(ffmpegDir, "usr/lib"))
            marker.writeText(stamp)
            Log.i(TAG, "ffmpeg payload unzipped in ${SystemClock.elapsedRealtime() - tUnzip} ms " +
                "($files files, $links symlinks, $copied support libs, " +
                "${payload.length() / 1_048_576} MB -> ${dirSize(ffmpegDir) / 1_048_576} MB)")
        } else {
            Log.i(TAG, "ffmpeg payload already extracted (${marker.readText()})")
        }
        val libDir = File(ffmpegDir, "usr/lib")

        // The names the backend looks for, pointing at the extracted executables.
        val binDir = File(app.filesDir, "bin").apply { mkdirs() }
        symlink(File(binDir, "ffmpeg"), ffmpegExe.absolutePath)
        symlink(File(binDir, "ffprobe"), ffprobeExe.absolutePath)

        Log.i(TAG, "ffmpeg ready in ${SystemClock.elapsedRealtime() - t0} ms; " +
            "exe=${ffmpegExe.absolutePath} libs=${libDir.absolutePath} " +
            "libCount=${libDir.list()?.size}")
        return binDir to libDir
    }

    /**
     * Runs `ffmpeg -version` the same way the backend will: by name, with the
     * extracted libraries on LD_LIBRARY_PATH. A binary that is present but
     * cannot load its libraries would otherwise only show up as a mysterious
     * failed download, and failures here are logged, not fatal.
     */
    private fun probeFfmpeg(ffmpeg: File, ldLibraryPath: String) {
        try {
            val process = ProcessBuilder(ffmpeg.absolutePath, "-version")
                .apply { environment()["LD_LIBRARY_PATH"] = ldLibraryPath }
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            val rc = process.waitFor()
            Log.i(TAG, "ffmpeg probe rc=$rc: ${output.lineSequence().firstOrNull() ?: "<no output>"}")
        } catch (e: Exception) {
            Log.e(TAG, "ffmpeg probe failed", e)
        }
    }

    /**
     * Extracts a zip that stores some entries as Unix symlinks. Java's
     * java.util.zip does not expose the Unix mode, so this sniffs them the way
     * they are stored: a tiny entry whose content is the (relative) link
     * target. Anything ambiguous is written as a plain file instead.
     */
    private fun extractZip(zip: File, destDir: File): Pair<Int, Int> {
        var files = 0
        val candidates = LinkedHashMap<String, ByteArray>()
        ZipFile(zip).use { zf ->
            val entries = zf.entries()
            while (entries.hasMoreElements()) {
                val e = entries.nextElement()
                val out = File(destDir, e.name)
                if (e.isDirectory) {
                    out.mkdirs()
                    continue
                }
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
                    !target.contains("..") && resolved != null && resolved.exists()
                ) {
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
            Log.w(TAG, "payload entry kept as a file: $name")
        }
        return files to links
    }

    /** Copies every flat asset in `assetsPath` into `destDir`, keeping names. */
    private fun copyAssetDir(assetsPath: String, destDir: File): Int {
        val names = app.assets.list(assetsPath) ?: return 0
        destDir.mkdirs()
        for (n in names) {
            app.assets.open("$assetsPath/$n").use { i ->
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
            Log.e(TAG, "could not symlink ${link.absolutePath} -> $target", e)
        }
    }

    private fun dirSize(dir: File): Long =
        dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

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

        /** A stored symlink entry is just the target path, far below this. */
        private const val MAX_SYMLINK_ENTRY = 128

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
