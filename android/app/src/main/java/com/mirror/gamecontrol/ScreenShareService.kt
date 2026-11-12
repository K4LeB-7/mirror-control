package com.mirror.gamecontrol

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/** Foreground service (tipo mediaProjection): mantém captura + WebRTC vivos mesmo ao girar a tela. */
class ScreenShareService : Service() {

    private var client: RtcClient? = null
    private var displayManager: DisplayManager? = null

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            client?.onDisplayChanged()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val roomId = intent?.getStringExtra(EXTRA_ROOM)
        @Suppress("DEPRECATION")
        val projection = intent?.getParcelableExtra<Intent>(EXTRA_PROJECTION)
        if (roomId == null || projection == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        // O Android 14 exige startForeground(mediaProjection) ANTES de iniciar a captura.
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
        )

        client?.dispose()
        client = RtcClient(
            ctx = this,
            projectionData = projection,
            roomId = roomId,
            onStatus = { publish(it) },
            onStopped = { stopSelf() },
        ).also { it.start() }
        running = true
        displayManager = (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).also {
            it.registerDisplayListener(displayListener, null)
        }
        // Não reinicia sozinho: o token do MediaProjection é de uso único.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        displayManager?.unregisterDisplayListener(displayListener)
        client?.dispose()
        client = null
        publish("Parado")
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Espelhamento", NotificationManager.IMPORTANCE_LOW)
        )
        val stop = PendingIntent.getService(
            this, 0,
            Intent(this, ScreenShareService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val open = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentTitle("Mirror Control ativo")
            .setContentText("Sua tela está sendo espelhada e pode receber toques do notebook")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_pause, "Parar", stop)
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.mirror.gamecontrol.STOP"
        const val EXTRA_ROOM = "room"
        const val EXTRA_PROJECTION = "projection"
        private const val CHANNEL_ID = "mirror"
        private const val NOTIFICATION_ID = 1

        @Volatile var running = false
            private set
        @Volatile var status = "Parado"
            private set
        @Volatile var statusListener: ((String) -> Unit)? = null

        fun publish(s: String) {
            status = s
            statusListener?.invoke(s)
        }
    }
}
