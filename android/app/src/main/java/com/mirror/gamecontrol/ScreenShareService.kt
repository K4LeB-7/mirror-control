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
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service (tipo mediaProjection): mantém a captura viva mesmo ao girar a tela.
 * Um modo por vez: WebRTC ([RtcClient]) ou USB/ADB ([UsbStreamServer]); iniciar um encerra o outro.
 */
class ScreenShareService : Service() {

    private var client: RtcClient? = null
    private var usb: UsbStreamServer? = null
    private var usbProjection: MediaProjection? = null
    private var displayManager: DisplayManager? = null

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            client?.onDisplayChanged()
            usb?.onDisplayChanged()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val usbMode = intent?.getStringExtra(EXTRA_MODE) == MODE_USB
        val roomId = intent?.getStringExtra(EXTRA_ROOM)
        @Suppress("DEPRECATION")
        val projection = intent?.getParcelableExtra<Intent>(EXTRA_PROJECTION)
        if (projection == null || (!usbMode && roomId == null)) {
            stopSelf()
            return START_NOT_STICKY
        }

        // O Android 14 exige startForeground(mediaProjection) ANTES de iniciar a captura.
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(usbMode),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
        )

        // Um modo por vez: encerra o anterior (o token de captura antigo morre junto).
        stopModes()
        if (usbMode) {
            startUsb(projection)
            registerDisplayListener()
            return START_NOT_STICKY
        }
        client = RtcClient(
            ctx = this,
            projectionData = projection,
            roomId = requireNotNull(roomId),
            onStatus = { publish(it) },
            onStopped = { stopSelf() },
        ).also { it.start() }
        running = true
        registerDisplayListener()
        // Não reinicia sozinho: o token do MediaProjection é de uso único.
        return START_NOT_STICKY
    }

    private fun registerDisplayListener() {
        if (displayManager != null) return
        displayManager = (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).also {
            it.registerDisplayListener(displayListener, null)
        }
    }

    private fun startUsb(data: Intent) {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = try {
            mpm.getMediaProjection(android.app.Activity.RESULT_OK, data)
        } catch (e: Exception) {
            null
        }
        if (mp == null) {
            publish("Modo USB: captura de tela não autorizada; toque em Iniciar modo USB de novo")
            stopSelf()
            return
        }
        usbProjection = mp
        // Android 14+: o callback tem de ser registrado ANTES de createVirtualDisplay.
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                // Captura encerrada pelo sistema/usuário (ex.: "Parar compartilhamento" na barra).
                if (usbProjection === mp) stopSelf()
            }
        }, Handler(Looper.getMainLooper()))
        val server = UsbStreamServer(this, mp) { publish(it) }
        usbPin = server.pin // antes do start(): o 1º status já mostra o PIN na tela
        try {
            server.start()
        } catch (e: Exception) {
            server.stop()
            usbPin = null
            usbProjection = null
            mp.stop()
            publish("Modo USB: não foi possível abrir a porta ${UsbWire.PORT} (${e.message}). Feche e abra o app.")
            stopSelf()
            return
        }
        usb = server
        running = true
    }

    private fun stopModes() {
        client?.dispose()
        client = null
        val mp = usbProjection
        usbProjection = null // antes do stop(): o onStop() deste token não derruba o serviço
        usb?.stop()
        usb = null
        usbPin = null
        try { mp?.stop() } catch (_: Exception) {}
    }

    override fun onDestroy() {
        running = false
        displayManager?.unregisterDisplayListener(displayListener)
        displayManager = null
        stopModes()
        publish("Parado")
        super.onDestroy()
    }

    private fun buildNotification(usbMode: Boolean): Notification {
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
            .setContentText(
                if (usbMode) "Modo USB (ADB): tela espelhada pelo cabo; pode receber toques do PC"
                else "Sua tela está sendo espelhada e pode receber toques do notebook"
            )
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_pause, "Parar", stop)
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.mirror.gamecontrol.STOP"
        const val EXTRA_ROOM = "room"
        const val EXTRA_PROJECTION = "projection"
        const val EXTRA_MODE = "mode"
        const val MODE_USB = "usb"
        private const val CHANNEL_ID = "mirror"
        private const val NOTIFICATION_ID = 1

        @Volatile var running = false
            private set
        @Volatile var status = "Parado"
            private set
        /** PIN do modo USB em execução (null fora do modo USB). */
        @Volatile var usbPin: String? = null
            private set
        @Volatile var statusListener: ((String) -> Unit)? = null

        fun publish(s: String) {
            status = s
            statusListener?.invoke(s)
        }
    }
}
