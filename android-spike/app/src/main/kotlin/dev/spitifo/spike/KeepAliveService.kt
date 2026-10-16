package dev.spitifo.spike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Spike-only: keeps the process in the foreground-service state so Android does
 * not cut its network (APP_BACKGROUND / METERED_USER_RESTRICTED) when the screen
 * turns off, and holds a partial wake lock so the CPU keeps running unplugged.
 * The real app (roadmap session 5) should start it per download and stop it
 * when the queue is empty.
 */
class KeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW)
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("Spitifo")
            .setContentText("Backend running")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spitifo:backend")
                .apply { acquire() }
        }
        Log.i(TAG, "KeepAliveService foreground + wake lock held")
        return START_STICKY
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private companion object {
        const val TAG = "SpitifoSpike"
        const val CHANNEL = "downloads"
        const val NOTIFICATION_ID = 1
    }
}
