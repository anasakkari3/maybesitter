import Flutter
import UIKit

final class PilotDeepLinkPlugin {
  private static let channelName = "com.maybesitter.mobile/deep_links"
  private static let scheme = "maybesitter"
  private static var channel: FlutterMethodChannel?
  private static var pendingURL: String?

  static func register(binaryMessenger: FlutterBinaryMessenger) {
    let nextChannel = FlutterMethodChannel(name: channelName, binaryMessenger: binaryMessenger)
    channel = nextChannel
    nextChannel.setMethodCallHandler { call, result in
      switch call.method {
      case "getInitialLink":
        result(pendingURL)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  @discardableResult
  static func handle(url: URL) -> Bool {
    guard url.scheme == scheme else { return false }
    let absoluteString = url.absoluteString
    pendingURL = absoluteString
    channel?.invokeMethod("link", arguments: absoluteString)
    return true
  }
}
