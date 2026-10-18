package dev.spitifo

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import com.chaquo.python.Python

/**
 * The whole UI: a full-screen WebView pointed at the embedded backend.
 *
 * The React app, the API and the audio all come from 127.0.0.1, so there is no
 * native UI to keep in sync with the web one: whatever the desktop shell shows
 * (which runs the same backend) is what shows here.
 *
 * `singleTask` so a shared link does not stack a second window on top of a
 * running one; the new intent arrives through [onNewIntent].
 */
class MainActivity : Activity() {

    private val backend: Backend get() = (application as SpitifoApp).backend

    /**
     * Google Drive sign-in, which needs an Activity for the consent screen.
     * See [DriveAuth]: the token itself goes to Python, not to the WebView.
     */
    private val driveAuth by lazy { DriveAuth(this) }

    private var web: WebView? = null
    private var pendingShare: String? = null

    private val listener = object : Backend.Listener {
        override fun onReady(port: Int) {
            showUi(port)
            refreshDriveTokenIfConnected()
        }

        override fun onFailed(message: String) = showStatus(message)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "onCreate")
        // Best effort, and never blocking: notifications only change whether the
        // download notification is visible, and the media permissions only
        // change whether files left in Music/Spitifo by an earlier install can
        // be listed. Everything has to keep working when they are denied.
        requestOptionalPermissions()
        pendingShare = shareUrl(intent)
        if (pendingShare != null) Log.i(TAG, "shared link: $pendingShare")
        showStatus("Starting…")
        backend.addListener(listener)
    }

    override fun onResume() {
        super.onResume()
        // Coming back from the background can mean the token aged out while the
        // app was not running: DriveAuth refreshes only if it is old enough.
        driveAuth.onResume()
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        driveAuth.onActivityResult(requestCode, resultCode, data)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Deliberately no setIntent: the share has been consumed here, and
        // keeping it around would replay the search on an Activity recreation.
        val share = shareUrl(intent) ?: return
        Log.i(TAG, "shared link while running: $share")
        val view = web
        val port = backend.port
        if (view != null && port > 0) {
            view.loadUrl(backend.url(port, share, isYouTube(share)))
        } else {
            pendingShare = share
        }
    }

    /** Back goes through the web history first, then leaves the app. */
    @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
    override fun onBackPressed() {
        val view = web
        if (view != null && view.canGoBack()) view.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        backend.removeListener(listener)
        driveAuth.onDestroy()
        val view = web
        if (view != null) {
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            web = null
        }
        super.onDestroy()
    }

    // ------------------------------------------------------- google drive auth

    /**
     * The page asks for the native Drive sign-in.
     *
     * Only the 127.0.0.1 page the shell loads can reach this: it is the only
     * origin the WebView ever has (see `shouldOverrideUrlLoading`), and the
     * interface is added after the backend is up, so nothing else can be
     * showing.
     *
     * Public on purpose: the WebView bridge reflects on it, and it only sees
     * public classes and methods.
     */
    inner class AndroidBridge {
        @JavascriptInterface
        fun connectDrive() {
            // JavascriptInterfaces are called on the WebView's own thread; the
            // consent screen and the Activity lifecycle belong to the UI one.
            runOnUiThread { driveAuth.connect() }
        }
    }

    /**
     * On startup the grant is usually already there, so this is the silent path
     * (ADR 0002, section 2: sign-in survives a restart with no user action).
     *
     * Asks Python whether a Google account is connected — on Android that flag
     * is persisted, while the token itself is memory-only and lost on restart —
     * then refreshes in silence. Never on the main thread: Chaquopy can take a
     * moment and the first frame must not wait for it.
     */
    private fun refreshDriveTokenIfConnected() {
        Thread({
            val connected = try {
                Python.getInstance().getModule(DRIVE_AUTH_MODULE)
                    .callAttr("is_google_connected").toJava(Boolean::class.java) ?: false
            } catch (e: Exception) {
                Log.w(TAG, "could not ask Python about Drive", e)
                false
            }
            if (connected) runOnUiThread { driveAuth.refreshSilently() }
        }, "spitifo-drive-startup").apply { isDaemon = true }.start()
    }

    // ------------------------------------------------------------------- ui

    private fun showStatus(message: String) {
        setContentView(TextView(this).apply {
            text = message
            textSize = 18f
            gravity = Gravity.CENTER
        })
    }

    private fun showUi(port: Int) {
        if (web != null) return
        Log.i(TAG, "showing the UI on port $port")
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The library auto-advances to the next track on `ended`, which
            // means calling audio.play() with no user gesture. Android WebView
            // blocks exactly that by default, so the next track would silently
            // never start.
            settings.mediaPlaybackRequiresUserGesture = false
            // The Drive sign-in needs a native Activity: the page asks for it
            // through this interface instead of a link (see DriveAuth).
            addJavascriptInterface(AndroidBridge(), "SpitifoAndroid")
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val url: Uri = request.url
                    // The app is loopback-only; everything else is a track page
                    // the user opened on purpose and belongs in the browser.
                    return when {
                        url.host == "127.0.0.1" || url.host == "localhost" -> false
                        url.scheme == "http" || url.scheme == "https" -> {
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, url))
                            } catch (e: Exception) {
                                Log.w(TAG, "no activity can open $url", e)
                            }
                            true
                        }
                        else -> false
                    }
                }
            }
        }
        setContentView(view)
        web = view
        val share = pendingShare
        pendingShare = null
        // One load: the backend trades the token for the session cookie and
        // keeps `q`, so the shared search runs on boot.
        view.loadUrl(backend.url(port, share, share != null && isYouTube(share)))
    }

    // -------------------------------------------------------- share target

    /** The first http(s) URL in an ACTION_SEND text, or null for any other call. */
    private fun shareUrl(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        if (intent.type?.startsWith("text/") != true) return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: return null
        return URL_PATTERN.find(text)?.value
    }

    private fun isYouTube(url: String): Boolean = YOUTUBE_PATTERN.matches(url)

    private fun requestOptionalPermissions() {
        val wanted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            listOf(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        val missing = wanted.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), PERMISSIONS_REQUEST)
    }

    private companion object {
        const val TAG = "Spitifo"
        const val PERMISSIONS_REQUEST = 1

        /** The Python module the native Drive bridge talks to (and its flag). */
        const val DRIVE_AUTH_MODULE = "backend.app.cloud.android"

        /** YouTube shares "Title https://youtu.be/xyz": the URL is the search. */
        val URL_PATTERN = Regex("""https?://\S+""")

        // Same host rule as YT_URL in frontend/src/main.jsx: a YouTube link is
        // only searchable as YouTube (iTunes cannot search a URL), and the boot
        // path in main.jsx does not switch modes on its own.
        val YOUTUBE_PATTERN = Regex(
            """^https?://(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/\S+$""",
            RegexOption.IGNORE_CASE,
        )
    }
}
