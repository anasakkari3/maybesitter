import Flutter
import UIKit
import WidgetKit

final class PilotPresenceSharedStorePlugin {
  private static let channelName = "com.maybesitter.mobile/pilot_presence_shared_store"
  private static let appGroup = "group.com.maybesitter.maybesitterMobile"
  private static let snapshotKey = "pilot_presence_commitment_snapshot_v1"
  private static let timelineKinds = ["MaybeSitterHomeWidget", "MaybeSitterLockScreenWidget"]

  static func register(binaryMessenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: binaryMessenger)
    channel.setMethodCallHandler { call, result in
      handle(call, result: result)
    }
  }

  private static func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard
      let args = call.arguments as? [String: Any],
      let suiteName = args["suiteName"] as? String,
      let key = args["key"] as? String,
      suiteName == appGroup,
      key == snapshotKey
    else {
      result(FlutterError(
        code: "invalid_pilot_presence_store_request",
        message: "Pilot presence shared store accepts only the versioned App Group snapshot key.",
        details: nil
      ))
      return
    }

    guard let defaults = UserDefaults(suiteName: suiteName) else {
      result(false)
      return
    }

    switch call.method {
    case "readString":
      result(defaults.string(forKey: key))
    case "writeString":
      guard let value = args["value"] as? String else {
        result(FlutterError(
          code: "missing_value",
          message: "writeString requires a value.",
          details: nil
        ))
        return
      }
      defaults.set(value, forKey: key)
      let synchronized = defaults.synchronize()
      reloadWidgetTimelines()
      result(synchronized)
    case "removeString":
      defaults.removeObject(forKey: key)
      _ = defaults.synchronize()
      reloadWidgetTimelines()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private static func reloadWidgetTimelines() {
    guard #available(iOS 14.0, *) else { return }
    for kind in timelineKinds {
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }
  }
}
