package dev.spitifo

import android.app.Application

/**
 * The process is the backend's lifetime, so it starts here and nowhere else:
 * the server has to outlive Activity recreation and the download service, and
 * it has to be up even if the first thing that happens is a shared link
 * arriving through [MainActivity].
 */
class SpitifoApp : Application() {

    /** Process-wide, created once. See [Backend]. */
    val backend: Backend by lazy { Backend(this) }

    override fun onCreate() {
        super.onCreate()
        backend.start()
    }
}
