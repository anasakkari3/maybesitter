import Flutter
import UIKit
import WidgetKit

final class PilotPresenceSharedStorePlugin {
  private static let channelName = "com.maybesitter.mobile/pilot_presence_shared_store"
  private static let appGroup = "group.com.maybesitter.maybesitterMobile"
  private static let snapshotKey = "pilot_presence_commitment_snapshot_v1"
  private static let watchEnabledKey = "pilot_presence_watch_enabled_v1"
  private static let allowedKeys = [snapshotKey, watchEnabledKey]
  private static let timelineKinds = [
    "MaybeSitterHomeWidget",
    "MaybeSitterLockScreenWidget",
    "MaybeSitterWatchComplicationWidget",
  ]

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
      allowedKeys.contains(key)
    else {
      result(FlutterError(
        code: "invalid_pilot_presence_store_request",
        message: "Pilot presence shared store accepts only versioned App Group keys.",
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
      guard key == snapshotKey else {
        result(FlutterError(
          code: "invalid_key_type",
          message: "readString accepts only the snapshot key.",
          details: nil
        ))
        return
      }
      result(defaults.string(forKey: key))
    case "readBool":
      guard key == watchEnabledKey else {
        result(FlutterError(
          code: "invalid_key_type",
          message: "readBool accepts only the watch enabled key.",
          details: nil
        ))
        return
      }
      if defaults.object(forKey: key) == nil {
        result(nil)
      } else {
        result(defaults.bool(forKey: key))
      }
    case "writeString":
      guard key == snapshotKey else {
        result(FlutterError(
          code: "invalid_key_type",
          message: "writeString accepts only the snapshot key.",
          details: nil
        ))
        return
      }
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
    case "writeBool":
      guard key == watchEnabledKey else {
        result(FlutterError(
          code: "invalid_key_type",
          message: "writeBool accepts only the watch enabled key.",
          details: nil
        ))
        return
      }
      guard let value = args["value"] as? Bool else {
        result(FlutterError(
          code: "missing_value",
          message: "writeBool requires a boolean value.",
          details: nil
        ))
        return
      }
      defaults.set(value, forKey: key)
      let synchronized = defaults.synchronize()
      reloadWidgetTimelines()
      result(synchronized)
    case "removeString":
      guard key == snapshotKey else {
        result(FlutterError(
          code: "invalid_key_type",
          message: "removeString accepts only the snapshot key.",
          details: nil
        ))
        return
      }
      defaults.removeObject(forKey: key)
      _ = defaults.synchronize()
      reloadWidgetTimelines()
      result(nil)
    case "removeBool":
      guard key == watchEnabledKey else {
        result(FlutterError(
          code: "invalid_key_type",
          message: "removeBool accepts only the watch enabled key.",
          details: nil
        ))
        return
      }
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
