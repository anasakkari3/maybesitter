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
      default:
        result(FlutterMethodNotImplemented)
      }
    }
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
    guard session.activationState == .activated, session.isPaired,
          session.isWatchAppInstalled
    else { return false }

    do {
      if let json {
        try session.updateApplicationContext([Self.contextKey: json])
      } else {
        try session.updateApplicationContext([:])
      }
      return true
    } catch {
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
