package com.mirror.gamecontrol

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.mirror.gamecontrol.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private val prefs by lazy { getSharedPreferences("mirror", Context.MODE_PRIVATE) }

    private val scan = registerForActivityResult(ScanContract()) { r ->
        r.contents?.let { b.roomId.setText(it.trim()) }
    }

    /** Modo pedido no último toque: WebRTC ("2. Iniciar espelhamento") ou USB/ADB. */
    private var usbRequested = false

    private val projection = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val data = r.data
        if (r.resultCode == RESULT_OK && data != null) {
            val intent = Intent(this, ScreenShareService::class.java)
                .putExtra(ScreenShareService.EXTRA_PROJECTION, data)
            if (usbRequested) intent.putExtra(ScreenShareService.EXTRA_MODE, ScreenShareService.MODE_USB)
            else intent.putExtra(ScreenShareService.EXTRA_ROOM, roomId())
            ContextCompat.startForegroundService(this, intent)
        } else {
            Toast.makeText(this, "Permissão de captura negada", Toast.LENGTH_SHORT).show()
        }
    }

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        requestProjection()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.roomId.setText(prefs.getString("room", ""))
        b.scanQr.setOnClickListener {
            scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setBeepEnabled(false).setOrientationLocked(false))
        }
        b.openAccessibility.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        b.allowRotation.setOnClickListener {
            // Fallback da rotação (Settings.System). Com o serviço de acessibilidade ativo isso nem é preciso.
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, android.net.Uri.parse("package:$packageName")))
            } catch (_: Exception) {
                startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS))
            }
        }
        b.start.setOnClickListener { startMirroring() }
        b.startUsb.setOnClickListener {
            usbRequested = true
            askPermissionsThenProject()
        }
        b.stop.setOnClickListener {
            startService(Intent(this, ScreenShareService::class.java).setAction(ScreenShareService.ACTION_STOP))
        }
        b.touchDiag.isChecked = prefs.getBoolean("touchDiag", false)
        b.touchDiag.setOnCheckedChangeListener { _, on ->
            prefs.edit().putBoolean("touchDiag", on).apply()
            // Ligar zera os contadores: jogue um pouco, volte aqui e mande os números.
            if (on) GameAccessibilityService.instance?.injector?.resetStats()
            showTouchDiag()
        }
    }

    /** Linha "Diagnóstico de toque": contadores reais do injetor desde que a opção foi ligada. */
    private fun showTouchDiag() {
        val on = b.touchDiag.isChecked
        b.touchDiagText.visibility = if (on) android.view.View.VISIBLE else android.view.View.GONE
        if (!on) return
        val injector = GameAccessibilityService.instance?.injector
        b.touchDiagText.text = injector?.stats?.text(android.os.SystemClock.uptimeMillis())
            ?: "Serviço de acessibilidade desligado: sem injetor de toques."
    }

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val usbPoll = object : Runnable {
        override fun run() {
            b.usbState.text = UsbNet.current()
            handler.postDelayed(this, 2000)
        }
    }
    private val diagPoll = object : Runnable {
        override fun run() {
            showTouchDiag()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(usbPoll)
        handler.post(diagPoll)
        ScreenShareService.statusListener = { s -> runOnUiThread { showStatus(s) } }
        showStatus(ScreenShareService.status)
        val a11y = accessibilityEnabled()
        b.accessibilityState.text =
            if (a11y) "✔ Acessibilidade ativa" else "✘ Acessibilidade desativada (sem ela só há vídeo, sem toques)"
        val canWrite = RotationController.canWriteSettings(this)
        b.rotationState.text = when {
            a11y && canWrite -> "✔ Girar pelo site: acessibilidade (e configurações do sistema como reserva)"
            a11y -> "✔ Girar pelo site: pelo serviço de acessibilidade"
            canWrite -> "✔ Girar pelo site: por Modificar configurações do sistema"
            else -> "✘ Girar pelo site: ative a acessibilidade ou toque no botão acima"
        }
    }

    override fun onPause() {
        handler.removeCallbacks(usbPoll)
        handler.removeCallbacks(diagPoll)
        ScreenShareService.statusListener = null
        super.onPause()
    }

    private fun showStatus(s: String) {
        b.status.text = s
        val pin = ScreenShareService.usbPin
        b.usbPin.text = if (pin != null) "PIN do modo USB: ${pin.chunked(3).joinToString(" ")}" else ""
        b.usbPin.visibility = if (pin != null) android.view.View.VISIBLE else android.view.View.GONE
    }

    private fun roomId() = b.roomId.text.toString().trim().lowercase()

    private fun startMirroring() {
        val id = roomId()
        if (!Regex("[a-z0-9]{6,32}").matches(id)) {
            Toast.makeText(this, "ID da sala inválido", Toast.LENGTH_SHORT).show()
            return
        }
        prefs.edit().putString("room", id).apply()
        usbRequested = false
        askPermissionsThenProject()
    }

    private fun askPermissionsThenProject() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            requestProjection()
        }
    }

    private fun requestProjection() {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection.launch(mpm.createScreenCaptureIntent())
    }

    private fun accessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = ComponentName(this, GameAccessibilityService::class.java).flattenToString()
        return enabled.split(':').any { it.equals(me, ignoreCase = true) }
    }
}
