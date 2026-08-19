import Flutter
import UIKit

final class PilotPresenceSharedStorePlugin {
  private static let channelName = "com.maybesitter.mobile/pilot_presence_shared_store"
  private static let appGroup = "group.com.maybesitter.maybesitterMobile"
  private static let snapshotKey = "pilot_presence_commitment_snapshot_v1"

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
      result(defaults.synchronize())
    case "removeString":
      defaults.removeObject(forKey: key)
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
