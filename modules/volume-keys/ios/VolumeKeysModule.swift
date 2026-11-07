import AVFoundation
import ExpoModulesCore
import MediaPlayer
import UIKit

// iOS has no public API for volume button presses, so this watches the system
// volume instead: each press moves it one step, which is reported as a key and
// then undone through a hidden MPVolumeView, whose presence also hides the HUD.
public class VolumeKeysModule: Module {
  // Hardware buttons move the system volume in sixteenths.
  private static let step: Float = 1.0 / 16

  private var enabled = false
  private var observation: NSKeyValueObservation?
  private var volumeView: MPVolumeView?
  private var baseline: Float = 0
  // Set when the volume sat at an end of its range and had to be nudged inward.
  private var originalVolume: Float?

  public func definition() -> ModuleDefinition {
    Name("VolumeKeys")

    Events("onVolumeKeyPressed")

    OnCreate {
      let center = NotificationCenter.default
      // Control Center and the lock screen change the volume while the app is
      // inactive; those are real volume changes, not page turns.
      center.addObserver(
        self, selector: #selector(self.appWillResignActive),
        name: UIApplication.willResignActiveNotification, object: nil
      )
      center.addObserver(
        self, selector: #selector(self.appDidBecomeActive),
        name: UIApplication.didBecomeActiveNotification, object: nil
      )
    }

    OnDestroy {
      NotificationCenter.default.removeObserver(self)
      DispatchQueue.main.async {
        self.enabled = false
        self.stop()
      }
    }

    Function("setEnabled") { (value: Bool) in
      DispatchQueue.main.async {
        self.enabled = value
        if value {
          self.start()
        } else {
          self.stop()
        }
      }
    }
  }

  @objc private func appWillResignActive() {
    stop()
  }

  @objc private func appDidBecomeActive() {
    if enabled { start() }
  }

  private func start() {
    guard observation == nil, UIApplication.shared.applicationState == .active else { return }
    let session = AVAudioSession.sharedInstance()
    // outputVolume only reports changes while the session is active, and
    // activating under expo-audio's doNotMix category would stop another app's music.
    guard !session.isOtherAudioPlaying else { return }
    do {
      try session.setActive(true)
    } catch {
      return
    }
    guard let window = Self.keyWindow() else { return }

    // Must stay in the hierarchy and not hidden, or iOS shows the HUD again.
    let view = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
    view.alpha = 0.01
    window.addSubview(view)
    volumeView = view

    // At either end of the range a press in that direction changes nothing,
    // so keep one step of headroom on both sides.
    let current = session.outputVolume
    baseline = min(max(current, Self.step), 1 - Self.step)
    if baseline != current {
      originalVolume = current
      Self.setVolume(baseline, on: view)
    }

    observation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
      guard let volume = change.newValue else { return }
      DispatchQueue.main.async { self?.handleVolumeChange(volume) }
    }
  }

  private func stop() {
    observation?.invalidate()
    observation = nil
    // The session stays active: deactivating could cut off narration that
    // expo-audio starts right after the web turns paging off.
    guard let view = volumeView else { return }
    volumeView = nil
    if let original = originalVolume {
      originalVolume = nil
      Self.setVolume(original, on: view)
    }
    // Keep the view attached until the restore lands, so it doesn't flash the HUD.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      view.removeFromSuperview()
    }
  }

  private func handleVolumeChange(_ volume: Float) {
    // Changes back to the baseline are our own resets.
    guard let view = volumeView, abs(volume - baseline) > Self.step / 2 else { return }
    sendEvent("onVolumeKeyPressed", ["direction": volume > baseline ? "up" : "down"])
    Self.setVolume(baseline, on: view)
  }

  // A freshly attached MPVolumeView ignores slider writes until it has laid out.
  private static func setVolume(_ value: Float, on view: MPVolumeView) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
      view.subviews.compactMap { $0 as? UISlider }.first?.value = value
    }
  }

  private static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }
}
