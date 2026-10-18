package dev.spitifo

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.chaquo.python.Python
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope

/**
 * The Android half of the Google Drive token bridge (ADR 0002, sections 2, 3
 * and 7).
 *
 * Desktop signs in with a loopback OAuth flow and keeps a refresh token on disk
 * (backend/app/cloud/connect.py, tokens.StoredTokenSource). Android has no
 * browser of its own and no client secret, so the host asks Identity Services
 * for a `drive.file` access token and pushes it into the embedded Python
 * backend (`backend.app.cloud.android.set_token`), which serves it with
 * `StaticTokenSource`.
 *
 * One instance per Activity: it holds the pending consent result, the last push
 * time and the silent-refresh timer, all of which die with the Activity.
 *
 * The token is never logged.
 */
class DriveAuth(private val activity: Activity) {

    private val main = Handler(Looper.getMainLooper())

    /** Scheduled silent refresh, or null when there is none. */
    private var scheduled: Runnable? = null

    /** elapsedRealtime of the last token pushed to Python, or 0. */
    @Volatile
    private var lastPushAt = 0L

    /**
     * Interactive sign-in: the user asked for it from the Connect dialog, so a
     * consent screen is allowed. Always called on the UI thread.
     */
    fun connect() = authorize(interactive = true)

    /**
     * Silent refresh: startup, onResume and the ~50 min timer. Never prompts —
     * a consent screen popping out of nowhere is worse than an expired token,
     * and the user can always reconnect from the dialog.
     */
    fun refreshSilently() = authorize(interactive = false)

    fun onResume() {
        val age = SystemClock.elapsedRealtime() - lastPushAt
        if (lastPushAt > 0 && age > RESUME_REFRESH_MS) {
            Log.i(TAG, "token pushed ${age / 60_000} min ago: refreshing silently")
            refreshSilently()
        }
    }

    /** Handles the consent screen's result. Returns true if it was ours. */
    @Suppress("DEPRECATION")
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_DRIVE_AUTH) return false
        if (resultCode != Activity.RESULT_OK) {
            // The user closed the consent screen (RESULT_CANCELED) or it failed
            // before returning anything: for the UI that is a cancel.
            Log.i(TAG, "consent screen closed: resultCode=$resultCode")
            reportCancelled()
            return true
        }
        try {
            push(
                Identity.getAuthorizationClient(activity)
                    .getAuthorizationResultFromIntent(data),
                interactive = true,
            )
        } catch (e: Exception) {
            failed("${e.javaClass.simpleName}: ${e.message}")
        }
        return true
    }

    /** Cancels the pending timer: the Activity (and its Handler) is going away. */
    fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        scheduled = null
    }

    // ------------------------------------------------------------------ internals

    @Suppress("DEPRECATION")
    private fun authorize(interactive: Boolean) {
        val request = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(DRIVE_FILE)))
            .build()
        Identity.getAuthorizationClient(activity).authorize(request)
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    if (!interactive) {
                        Log.w(TAG, "silent refresh needs consent: not prompting")
                        return@addOnSuccessListener
                    }
                    Log.i(TAG, "consent screen required (interactive)")
                    try {
                        activity.startIntentSenderForResult(
                            result.pendingIntent!!.intentSender, REQUEST_DRIVE_AUTH,
                            null, 0, 0, 0, null,
                        )
                    } catch (e: Exception) {
                        failed("${e.javaClass.simpleName}: ${e.message}")
                    }
                } else {
                    // The grant is already there: no UI at all (measured at
                    // 87-131 ms after a force-stop on the Pixel).
                    push(result, interactive)
                }
            }
            .addOnFailureListener { e -> failed("${e.javaClass.simpleName}: ${e.message}") }
    }

    /** Hands an access token to Python, on a background thread. */
    private fun push(result: AuthorizationResult, interactive: Boolean) {
        val token = result.accessToken
        if (token == null) {
            failed("authorized without an access token " +
                "(granted=${result.grantedScopes})")
            return
        }
        // AuthorizationResult carries no expiry. Google access tokens last
        // 3600 s; 3300 keeps a 5 min margin so a request never rides one that
        // dies mid-flight.
        val expiresAt = System.currentTimeMillis() / 1000.0 + TOKEN_TTL_S
        thread {
            if (python("set_token", token, expiresAt, interactive)) {
                lastPushAt = SystemClock.elapsedRealtime()
                main.post { scheduleRefresh() }
            }
        }
    }

    private fun failed(message: String) {
        Log.e(TAG, "sign-in failed: $message")
        thread { python("connect_failed", message, false) }
    }

    private fun reportCancelled() {
        thread { python("connect_failed", "", true) }
    }

    /**
     * Calls one of the module-level functions of `backend.app.cloud.android`.
     *
     * `Backend.setUp` starts CPython on its own thread, so a call arriving
     * before then waits instead of failing. Returns false if Python never came
     * up or the call threw: the caller decides what to do about it.
     */
    private fun python(function: String, vararg args: Any): Boolean {
        return try {
            waitForPython()
            Python.getInstance().getModule(PY_MODULE).callAttr(function, *args)
            true
        } catch (e: Exception) {
            Log.e(TAG, "$function did not reach Python", e)
            false
        }
    }

    private fun waitForPython() {
        val deadline = SystemClock.elapsedRealtime() + 60_000
        while (!Python.isStarted()) {
            if (SystemClock.elapsedRealtime() > deadline) error("Python did not start in 60 s")
            Thread.sleep(100)
        }
    }

    /**
     * Silent refresh ~50 min after the last push, i.e. before the 55 min the
     * token still has left. Runs on the main thread because `authorize` does.
     */
    private fun scheduleRefresh() {
        scheduled?.let { main.removeCallbacks(it) }
        val runnable = Runnable {
            Log.i(TAG, "scheduled silent refresh")
            refreshSilently()
        }
        scheduled = runnable
        main.postDelayed(runnable, REFRESH_AFTER_MS)
    }

    private fun thread(block: () -> Unit) {
        Thread(block, "spitifo-drive-auth").apply { isDaemon = true }.start()
    }

    private companion object {
        const val TAG = "Spitifo"

        /** Request code for the consent screen (permissions use 1). */
        const val REQUEST_DRIVE_AUTH = 2

        const val PY_MODULE = "backend.app.cloud.android"
        const val DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"

        /** What is left of the token's 3600 s when Python stores it. */
        const val TOKEN_TTL_S = 3300.0

        /** Scheduled refresh: 50 min, with the token still good for ~5 more. */
        const val REFRESH_AFTER_MS = 50 * 60 * 1000L

        /** onResume refresh threshold; the timer covers shorter gaps. */
        const val RESUME_REFRESH_MS = 45 * 60 * 1000L
    }
}
