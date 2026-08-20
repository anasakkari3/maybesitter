import Flutter
import Foundation
import WatchConnectivity

/// Forwards the phone's commitment snapshot to a paired Apple Watch.
///
/// App Groups do not cross to the watch, so the store the widget reads is not
/// reachable from there. The application context carries the same JSON instead
/// and keeps only the newest value, which is what a snapshot means. The watch
/// renders it and decides nothing: priority, ordering and title redaction are
/// all settled here, so both surfaces agree by construction.
final class WatchSnapshotBridgePlugin: NSObject, WCSessionDelegate {
  private static let channelName = "com.maybesitter.mobile/watch_snapshot_bridge"
  private static let contextKey = "pilot_presence_commitment_snapshot_v1"
  private static var shared: WatchSnapshotBridgePlugin?

  /// Why the last publish failed. A swallowed error makes a watch that never
  /// updates indistinguishable from a watch nobody owns.
  private var lastError: String?

  static func register(binaryMessenger: FlutterBinaryMessenger) {
    let plugin = shared ?? WatchSnapshotBridgePlugin()
    shared = plugin
    plugin.activateIfPossible()

    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: binaryMessenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "isSupported":
        result(WCSession.isSupported())
      case "publishSnapshot":
        guard let json = call.arguments as? String else {
          result(FlutterError(code: "bad_arguments",
                              message: "publishSnapshot expects a JSON string",
                              details: nil))
          return
        }
        result(plugin.publish(json: json))
      case "clearSnapshot":
        result(plugin.publish(json: nil))
      case "diagnostics":
        result(plugin.diagnostics())
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  /// Why a publish would be refused, in the session's own terms.
  ///
  /// "No watch accepted it" is true of a missing watch, an inactive session and
  /// an uninstalled companion app alike, and the three want different answers.
  private func diagnostics() -> [String: Any] {
    guard WCSession.isSupported() else { return ["supported": false] }
    let session = WCSession.default
    return [
      "supported": true,
      "activationState": session.activationState.rawValue,
      "isPaired": session.isPaired,
      "isWatchAppInstalled": session.isWatchAppInstalled,
      "isReachable": session.isReachable,
      "isComplicationEnabled": session.isComplicationEnabled,
      "lastError": lastError ?? "none",
    ]
  }

  private func activateIfPossible() {
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    if session.delegate == nil { session.delegate = self }
    if session.activationState != .activated { session.activate() }
  }

  /// Returns false when there is no watch to talk to, so the caller can tell
  /// "no watch" apart from "sent" rather than assuming it worked.
  private func publish(json: String?) -> Bool {
    guard WCSession.isSupported() else { return false }
    let session = WCSession.default
    guard session.activationState == .activated else {
      lastError = "session not activated"
      return false
    }
    guard session.isPaired else {
      lastError = "no paired watch"
      return false
    }
    // iOS enforces this inside updateApplicationContext too, refusing with
    // WCErrorDomain 7006 "Watch app is not installed." Checking first turns a
    // thrown error into a stated reason; skipping the check does not make the
    // context arrive.
    guard session.isWatchAppInstalled else {
      lastError = "watch app not installed on the paired watch"
      return false
    }

    do {
      if let json {
        try session.updateApplicationContext([Self.contextKey: json])
      } else {
        try session.updateApplicationContext([:])
      }
      lastError = nil
      return true
    } catch {
      lastError = String(describing: error)
      return false
    }
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {}

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    // Reactivate so a watch switch does not silently stop updates.
    session.activate()
  }
}
