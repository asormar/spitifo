package dev.spitifo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Owns the framework media session and the media notification for the WebView.
 *
 * The audio itself still lives in the WebView: this service never decodes a
 * note. What it adds is the system-facing half of a player — metadata, a seek
 * bar, transport buttons and a foreground state — plus a partial wake lock so
 * the screen going off cannot suspend the process mid-track. Every button is
 * forwarded to the page through [MediaActionRelay] and applied by the engine;
 * there is deliberately no second copy of the playback state here, only the
 * last snapshot the page reported.
 */
class PlaybackService : Service() {

    private val backend: Backend get() = (application as SpitifoApp).backend

    private lateinit var mediaSession: MediaSession
    private var wakeLock: PowerManager.WakeLock? = null

    /* La pagina solo avisa al cambiar de estado (play, pausa, pista): una pista
       de mas de diez minutos no traeria ningun refresh. Mientras suena, el
       plazo del wake lock se renueva solo cada cinco minutos. */
    private val renewWakeLock = object : Runnable {
        override fun run() {
            if (stopped || !(playing || buffering)) return
            wakeLock?.acquire(WAKE_LOCK_TIMEOUT_MS)
            main.postDelayed(this, WAKE_LOCK_RENEW_MS)
        }
    }
    private var foregrounded = false
    private var stopped = false

    private var title = ""
    private var artist = ""
    private var artworkUrl = ""
    private var playing = false
    private var buffering = false
    private var positionMs = 0L
    private var durationMs = 0L
    private var hasNext = false

    /* Reported by the page for completeness; prev stays actionable even with
       no earlier track because the engine restarts the current one. */
    @Suppress("unused")
    private var hasPrev = false

    /** Last artwork that was asked for; a late download for an old track is dropped. */
    private var requestedArtwork: String? = null
    private var cachedBitmap: Bitmap? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        mediaSession = MediaSession(this, "spitifo-playback").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = MediaActionRelay.dispatch("play")
                override fun onPause() = MediaActionRelay.dispatch("pause")
                override fun onSkipToNext() = MediaActionRelay.dispatch("next")
                override fun onSkipToPrevious() = MediaActionRelay.dispatch("prev")
                override fun onSeekTo(pos: Long) = MediaActionRelay.dispatch("seekto", pos / 1000.0)
            })
            isActive = true
        }
        instance = this
        Log.i(TAG, "playback service created")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()
        when (intent?.action) {
            ACTION_PLAY -> MediaActionRelay.dispatch("play")
            ACTION_PAUSE -> MediaActionRelay.dispatch("pause")
            ACTION_PREV -> MediaActionRelay.dispatch("prev")
            ACTION_NEXT -> MediaActionRelay.dispatch("next")
        }
        val json = intent?.getStringExtra(EXTRA_UPDATE)
        if (json != null) {
            // A startForegroundService call must reach startForeground quickly,
            // even when the first snapshot turns out to be paused; refresh()
            // detaches again right below in that case.
            if (!foregrounded) enterForeground()
            applyUpdate(json)
        } else if (!foregrounded && intent?.action == null) {
            enterForeground()
            refresh()
        }
        return START_NOT_STICKY
    }

    private fun enterForeground() {
        // Resuming from a detached notification calls this with the app in the
        // background, where Android 12+ may refuse it. The music still plays and
        // the notification is still posted; only the foreground guarantee is lost.
        try {
            startForeground(
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
            foregrounded = true
        } catch (e: android.app.ForegroundServiceStartNotAllowedException) {
            Log.w(TAG, "not allowed to enter the foreground now", e)
            notificationManager().notify(NOTIFICATION_ID, buildNotification())
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not enter the foreground", e)
            notificationManager().notify(NOTIFICATION_ID, buildNotification())
        }
    }

    /** Applies one JSON snapshot from the page. Main thread only. */
    private fun applyUpdate(json: String) {
        try {
            val o = JSONObject(json)
            val art = o.optString("artwork", "")
            title = o.optString("title", "")
            artist = o.optString("artist", "")
            playing = o.optBoolean("playing", false)
            buffering = o.optBoolean("buffering", false)
            positionMs = (number(o, "position") * 1000).toLong().coerceAtLeast(0)
            durationMs = (number(o, "duration") * 1000).toLong().coerceAtLeast(0)
            hasNext = o.optBoolean("hasNext", false)
            hasPrev = o.optBoolean("hasPrev", false)
            if (art != artworkUrl) {
                artworkUrl = art
                requestedArtwork = art
                cachedBitmap = null
                if (art.isNotEmpty()) artworkExecutor.execute { loadArtwork(art) }
            }
            refresh()
        } catch (e: Exception) {
            Log.w(TAG, "ignored a malformed media update", e)
        }
    }

    private fun number(o: JSONObject, key: String): Double {
        if (o.isNull(key)) return 0.0
        val n = o.optDouble(key, 0.0)
        return if (n.isFinite()) n else 0.0
    }

    /** Off the main thread: both the request and the bitmap decode are slow. */
    private fun loadArtwork(url: String) {
        var bitmap: Bitmap? = null
        try {
            bitmap = fetchArtwork(url)
        } catch (e: Exception) {
            Log.w(TAG, "could not load artwork $url", e)
        }
        main.post {
            if (stopped || requestedArtwork != url) return@post
            cachedBitmap = bitmap
            refresh()
        }
    }

    private fun fetchArtwork(url: String): Bitmap? {
        // Library artwork comes back as a relative /api/... path; the backend
        // only answers with the per-launch secret, which in-app code may read
        // (the WebView gets it as a cookie instead, but it cannot hand it here).
        val absolute = if (url.startsWith("/")) {
            val port = backend.port
            if (port <= 0) return null
            "http://127.0.0.1:$port$url"
        } else {
            url
        }
        if (!absolute.startsWith("http://") && !absolute.startsWith("https://")) return null

        val conn = URL(absolute).openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        conn.readTimeout = 10_000
        conn.instanceFollowRedirects = true
        if (url.startsWith("/")) conn.setRequestProperty("x-spitifo-token", backend.authToken)
        try {
            if (conn.responseCode !in 200..299) return null
            val bytes = conn.inputStream.use { readLimited(it, MAX_ART_BYTES) } ?: return null
            return downscale(bytes)
        } finally {
            conn.disconnect()
        }
    }

    /** Capped so a hostile CDN cannot make the notification allocate for ever. */
    private fun readLimited(stream: InputStream, max: Int): ByteArray? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8 * 1024)
        var total = 0
        while (true) {
            val n = stream.read(buf)
            if (n < 0) break
            total += n
            if (total > max) return null
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /** Decode at the smallest useful sample size, then cap the longest edge. */
    private fun downscale(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample / 2 >= ART_SIZE && bounds.outHeight / sample / 2 >= ART_SIZE) {
            sample *= 2
        }
        val bitmap = BitmapFactory.decodeByteArray(
            bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: return null
        val ratio = ART_SIZE.toFloat() / maxOf(bitmap.width, bitmap.height)
        if (ratio >= 1f) return bitmap
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * ratio).toInt().coerceAtLeast(1),
            (bitmap.height * ratio).toInt().coerceAtLeast(1),
            true,
        )
    }

    /** Republishes metadata, transport state and the notification together. */
    private fun refresh() {
        if (stopped) return
        val meta = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
        cachedBitmap?.let { meta.putBitmap(MediaMetadata.METADATA_KEY_ART, it) }
        mediaSession.setMetadata(meta.build())

        val state = when {
            buffering -> PlaybackState.STATE_BUFFERING
            playing -> PlaybackState.STATE_PLAYING
            else -> PlaybackState.STATE_PAUSED
        }
        var actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
            PlaybackState.ACTION_SEEK_TO
        if (hasNext) actions = actions or PlaybackState.ACTION_SKIP_TO_NEXT
        /* elapsedRealtime is the clock the system expects for updateTime: it
           advances during deep sleep, so the seek bar keeps moving on its own
           instead of freezing at the last reported position. */
        mediaSession.setPlaybackState(
            PlaybackState.Builder()
                .setState(state, positionMs, 1.0f, SystemClock.elapsedRealtime())
                .setActions(actions)
                .build(),
        )

        val notification = buildNotification()
        if (playing || buffering) {
            if (!foregrounded) enterForeground() else notificationManager().notify(NOTIFICATION_ID, notification)
            // Un acquire() sin plazo no tiene red de seguridad si algun camino
            // futuro deja `playing = true` sin volver a `false`. El plazo se
            // renueva en cada refresh (la pagina los manda seguido mientras
            // suena), asi que una sesion real nunca lo nota; uno que se queda
            // trabado se suelta solo en minutos, no al matar el proceso.
            val lock = wakeLock ?: getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spitifo:playback")
                .apply { setReferenceCounted(false) }
            lock.acquire(WAKE_LOCK_TIMEOUT_MS)
            wakeLock = lock
            main.removeCallbacks(renewWakeLock)
            main.postDelayed(renewWakeLock, WAKE_LOCK_RENEW_MS)
        } else {
            main.removeCallbacks(renewWakeLock)
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
            if (foregrounded) {
                // The notification stays, but it can be swiped away while the
                // audio is stopped; ongoing is reserved for actual playback.
                @Suppress("DEPRECATION")
                stopForeground(Service.STOP_FOREGROUND_DETACH)
                foregrounded = false
            }
            notificationManager().notify(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val playPause = if (playing && !buffering) {
            action(ACTION_PAUSE, 2, R.drawable.ic_media_pause, "Pausar")
        } else {
            action(ACTION_PLAY, 2, R.drawable.ic_media_play, "Reproducir")
        }
        val style = Notification.MediaStyle()
            .setMediaSession(mediaSession.sessionToken)
            .setShowActionsInCompactView(0, 1, 2)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(title.ifEmpty { "Spitifo" })
            .setContentText(artist)
            .setLargeIcon(cachedBitmap)
            .setContentIntent(open)
            .setStyle(style)
            .addAction(action(ACTION_PREV, 1, R.drawable.ic_media_prev, "Anterior"))
            .addAction(playPause)
            .addAction(action(ACTION_NEXT, 3, R.drawable.ic_media_next, "Siguiente"))
            .setOngoing(playing || buffering)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()
    }

    private fun action(serviceAction: String, requestCode: Int, icon: Int, label: String): Notification.Action {
        val intent = Intent(this, PlaybackService::class.java).setAction(serviceAction)
        val pending = PendingIntent.getService(
            this, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Action.Builder(Icon.createWithResource(this, icon), label, pending).build()
    }

    private fun createChannel() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            notificationManager().createNotificationChannel(
                NotificationChannel(CHANNEL, "Reproducción", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun notificationManager(): NotificationManager =
        getSystemService(NotificationManager::class.java)

    private fun clearAndStop() {
        stopped = true
        notificationManager().cancel(NOTIFICATION_ID)
        mediaSession.isActive = false
        mediaSession.release()
        main.removeCallbacks(renewWakeLock)
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        if (foregrounded) {
            @Suppress("DEPRECATION")
            stopForeground(Service.STOP_FOREGROUND_REMOVE)
            foregrounded = false
        }
        if (instance === this) instance = null
        stopSelf()
        Log.i(TAG, "playback service stopped")
    }

    override fun onDestroy() {
        if (!stopped) {
            stopped = true
            if (instance === this) instance = null
            main.removeCallbacks(renewWakeLock)
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
            try {
                mediaSession.isActive = false
                mediaSession.release()
            } catch (e: Exception) {
                Log.w(TAG, "could not release the media session", e)
            }
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "Spitifo"
        private const val CHANNEL = "playback"
        private const val NOTIFICATION_ID = 2
        private const val ART_SIZE = 512
        private const val MAX_ART_BYTES = 8 * 1024 * 1024
        private const val EXTRA_UPDATE = "dev.spitifo.media.update"
        private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
        private const val WAKE_LOCK_RENEW_MS = 5 * 60 * 1000L
        private const val ACTION_PLAY = "dev.spitifo.media.play"
        private const val ACTION_PAUSE = "dev.spitifo.media.pause"
        private const val ACTION_PREV = "dev.spitifo.media.prev"
        private const val ACTION_NEXT = "dev.spitifo.media.next"

        private val main = Handler(Looper.getMainLooper())
        private val artworkExecutor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "spitifo-artwork").apply { isDaemon = true }
        }

        @Volatile
        private var instance: PlaybackService? = null

        /** Called from the WebView bridge, which runs on a WebView thread. */
        fun update(context: Context, json: String) {
            main.post {
                val app = context.applicationContext
                val service = instance
                if (service != null && !service.stopped) {
                    service.applyUpdate(json)
                } else {
                    val intent = Intent(app, PlaybackService::class.java).putExtra(EXTRA_UPDATE, json)
                    try {
                        app.startForegroundService(intent)
                    } catch (e: android.app.ForegroundServiceStartNotAllowedException) {
                        // Same guard as DownloadService: Android 12+ can refuse a
                        // foreground start from the background. Losing the
                        // notification is bad, but crashing the app is worse.
                        Log.w(TAG, "not allowed to start the playback service now", e)
                    } catch (e: RuntimeException) {
                        Log.w(TAG, "could not start the playback service", e)
                    }
                }
            }
        }

        /** No track (or the Activity is gone): drop the notification entirely. */
        fun clear(context: Context) {
            main.post {
                val app = context.applicationContext
                val service = instance
                if (service != null && !service.stopped) {
                    service.clearAndStop()
                } else {
                    app.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
                }
            }
        }
    }
}
