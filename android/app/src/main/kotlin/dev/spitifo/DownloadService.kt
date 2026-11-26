package dev.spitifo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Keeps the process in the foreground-service state while a download runs.
 *
 * The backend tells the shell when the first download starts and when the last
 * one ends (`backend.app.activity`); this service mirrors exactly that. While
 * it is up, Android leaves the process alone when the screen turns off, so
 * neither the network nor the CPU is cut mid-download. It is stopped [STOP_DELAY]
 * after the queue empties, so it never stays up idle.
 */
class DownloadService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var renewWakeLock: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("Downloading music…")
            .setContentText("Spitifo keeps running while the screen is off")
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

        val lock = wakeLock ?: getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spitifo:downloads")
            .apply { setReferenceCounted(false) }
        lock.acquire(WAKE_LOCK_TIMEOUT_MS)
        wakeLock = lock
        scheduleWakeLockRenew()
        Log.i(TAG, "download service in foreground")
        return START_NOT_STICKY
    }

    // A single large download can outlast the lock's own safety timeout, so it
    // is renewed well inside that window instead of relying on a fresh
    // onStartCommand (an album may not get one for the whole transfer).
    private fun scheduleWakeLockRenew() {
        renewWakeLock?.let { main.removeCallbacks(it) }
        val renew = object : Runnable {
            override fun run() {
                wakeLock?.acquire(WAKE_LOCK_TIMEOUT_MS)
                main.postDelayed(this, WAKE_LOCK_RENEW_MS)
            }
        }
        renewWakeLock = renew
        main.postDelayed(renew, WAKE_LOCK_RENEW_MS)
    }

    override fun onDestroy() {
        renewWakeLock?.let { main.removeCallbacks(it) }
        renewWakeLock = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        Log.i(TAG, "download service stopped")
        super.onDestroy()
    }

    companion object {
        private const val TAG = "Spitifo"
        private const val CHANNEL = "downloads"
        private const val NOTIFICATION_ID = 1

        /**
         * Downloads can hand over to each other with a gap of milliseconds, so
         * the stop waits a moment: a queue that is still draining cancels it
         * instead of flickering the notification off and on.
         */
        private const val STOP_DELAY = 3_000L
        private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
        private const val WAKE_LOCK_RENEW_MS = 5 * 60 * 1000L

        private val main = Handler(Looper.getMainLooper())
        private var pendingStop: Runnable? = null

        /**
         * Mirrors backend download activity. The call arrives on a Python
         * thread, so everything below happens on the main thread: starting and
         * stopping a service is not thread-safe.
         */
        fun setBusy(context: Context, busy: Boolean) {
            main.post {
                if (busy) {
                    pendingStop?.let { main.removeCallbacks(it) }
                    pendingStop = null
                    start(context)
                } else if (pendingStop == null) {
                    val app = context.applicationContext
                    val stop = Runnable {
                        pendingStop = null
                        app.stopService(Intent(app, DownloadService::class.java))
                    }
                    pendingStop = stop
                    main.postDelayed(stop, STOP_DELAY)
                }
            }
        }

        private fun start(context: Context) {
            try {
                context.applicationContext.startForegroundService(
                    Intent(context.applicationContext, DownloadService::class.java)
                )
            } catch (e: android.app.ForegroundServiceStartNotAllowedException) {
                // Android 12+ forbids starting a foreground service from the
                // background. The download itself is unaffected: only the
                // notification (and the guarantee that the process survives the
                // screen turning off) is lost, which beats crashing.
                Log.w(TAG, "not allowed to start the download service now", e)
            } catch (e: RuntimeException) {
                Log.w(TAG, "could not start the download service", e)
            }
        }
    }
}
