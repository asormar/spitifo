package dev.spitifo

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.widget.ScrollView
import android.widget.TextView
import com.chaquo.python.Python
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import org.json.JSONObject

/**
 * Session 7 spike, debug builds only: can the app get a Google Drive token on
 * Android without a server, and keep getting one after a restart without asking
 * the user again? (ADR 0002, section 2: "Android sign-in that survives an app
 * restart without user interaction".)
 *
 * 1. Asks the Identity Services AuthorizationClient for `drive.file`. The first
 *    time it returns a pending intent (the consent screen); once granted, it
 *    should return an access token directly, with no UI.
 * 2. Hands only the access token to Python, which runs
 *    `backend.app.cloud.probe` against the file the PC benchmark uploaded.
 *
 * Every step is logged under the `SpitifoProbe` tag and shown on screen. The
 * token itself is never logged.
 */
class DriveProbeActivity : Activity() {

    private val backend: Backend get() = (application as SpitifoApp).backend
    private lateinit var out: TextView
    private val lines = StringBuilder()
    private var t0 = 0L

    private val listener = object : Backend.Listener {
        override fun onReady(port: Int) = Unit
        override fun onFailed(message: String) = say("backend failed: $message")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        out = TextView(this).apply { textSize = 14f; setPadding(32, 32, 32, 32) }
        setContentView(ScrollView(this).apply { addView(out) })
        // The listener only matters for its side effect: it makes sure the
        // backend (and so Python) is starting before the probe needs it.
        backend.addListener(listener)
        t0 = SystemClock.elapsedRealtime()
        say("authorize(drive.file)…")
        val request = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(DRIVE_FILE)))
            .build()
        Identity.getAuthorizationClient(this).authorize(request)
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    say("RESULT: needs the consent screen (interactive)")
                    startIntentSenderForResult(
                        result.pendingIntent!!.intentSender, REQUEST_AUTH,
                        null, 0, 0, 0, null)
                } else {
                    onAuthorized(result, interactive = false)
                }
            }
            .addOnFailureListener { e -> say("authorize failed: ${e.javaClass.simpleName}: ${e.message}") }
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_AUTH) return
        if (resultCode != RESULT_OK) {
            say("consent screen closed: resultCode=$resultCode")
            return
        }
        try {
            onAuthorized(
                Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(data),
                interactive = true,
            )
        } catch (e: Exception) {
            say("consent result failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    override fun onDestroy() {
        backend.removeListener(listener)
        super.onDestroy()
    }

    private fun onAuthorized(result: AuthorizationResult, interactive: Boolean) {
        val token = result.accessToken
        val ms = SystemClock.elapsedRealtime() - t0
        if (token == null) {
            say("authorized but no access token (granted=${result.grantedScopes})")
            return
        }
        say("RESULT: token in $ms ms, ${if (interactive) "AFTER the consent screen" else "SILENT (no UI)"}")
        say("granted scopes: ${result.grantedScopes}")
        say("running the Drive probe from Python…")
        Thread {
            val report = try {
                waitForPython()
                Python.getInstance().getModule("backend.app.cloud.probe")
                    .callAttr("probe", token, 5).toString()
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", "${e.javaClass.simpleName}: ${e.message}")
                    .toString()
            }
            runOnUiThread { say("probe: " + JSONObject(report).toString(2)) }
        }.start()
    }

    /** Backend.setUp starts Python on its own thread; never start it twice. */
    private fun waitForPython() {
        val deadline = SystemClock.elapsedRealtime() + 60_000
        while (!Python.isStarted()) {
            if (SystemClock.elapsedRealtime() > deadline) error("Python did not start in 60 s")
            Thread.sleep(100)
        }
    }

    private fun say(line: String) {
        Log.i(TAG, line)
        lines.append(line).append('\n')
        out.text = lines
    }

    private companion object {
        const val TAG = "SpitifoProbe"
        const val REQUEST_AUTH = 7
        const val DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"
    }
}
