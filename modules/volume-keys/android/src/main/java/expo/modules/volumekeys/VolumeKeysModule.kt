package expo.modules.volumekeys

import android.view.KeyEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

class VolumeKeysModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VolumeKeys")

    Events("onVolumeKeyPressed")

    OnCreate {
      instance = WeakReference(this@VolumeKeysModule)
    }

    OnDestroy {
      enabled = false
      if (instance?.get() === this@VolumeKeysModule) instance = null
    }

    Function("setEnabled") { value: Boolean ->
      enabled = value
    }
  }

  companion object {
    @Volatile private var enabled = false
    @Volatile private var instance: WeakReference<VolumeKeysModule>? = null

    // Called from MainActivity.dispatchKeyEvent (see plugins/withVolumeKeyPaging).
    // Consumes every phase of the key so the system never adjusts the volume,
    // but only the first ACTION_DOWN turns a page — holding the key must not flip through a chapter.
    @JvmStatic
    fun handleKeyEvent(event: KeyEvent): Boolean {
      if (!enabled) return false
      val direction = when (event.keyCode) {
        KeyEvent.KEYCODE_VOLUME_UP -> "up"
        KeyEvent.KEYCODE_VOLUME_DOWN -> "down"
        else -> return false
      }
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
        instance?.get()?.sendEvent("onVolumeKeyPressed", mapOf("direction" to direction))
      }
      return true
    }
  }
}
