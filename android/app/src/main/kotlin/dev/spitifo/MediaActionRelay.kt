package dev.spitifo

import android.os.Handler
import android.os.Looper

/**
 * Hands media-button actions from the long-lived [PlaybackService] to the
 * Activity's WebView.
 *
 * The service owns the MediaSession but has no view, and the Activity can be
 * gone while the notification is still up (the process keeps playing with the
 * screen off). The Activity registers itself while it is alive and clears it
 * on destroy, so an action pressed with no UI around is dropped instead of
 * being delivered to a destroyed WebView. Everything happens on the main
 * thread: registration is a lifecycle operation and `evaluateJavascript` must
 * run on the thread that created the WebView.
 */
object MediaActionRelay {

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var receiver: ((String, Double?) -> Unit)? = null

    /** [handler] receives (action, seek time in seconds, or null). */
    fun register(handler: (String, Double?) -> Unit) {
        main.post { receiver = handler }
    }

    /** Only clears [handler], so a late destroy cannot unregister a new Activity. */
    fun unregister(handler: (String, Double?) -> Unit) {
        main.post { if (receiver === handler) receiver = null }
    }

    fun dispatch(action: String, time: Double? = null) {
        main.post { receiver?.invoke(action, time) }
    }
}
