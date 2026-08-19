import Flutter
import UIKit
import EventKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if let controller = window?.rootViewController as? FlutterViewController {
      PilotPresenceSharedStorePlugin.register(binaryMessenger: controller.binaryMessenger)
      PilotDeepLinkPlugin.register(binaryMessenger: controller.binaryMessenger)
      AppleCalendarImportPlugin.register(binaryMessenger: controller.binaryMessenger)
      WatchSnapshotBridgePlugin.register(binaryMessenger: controller.binaryMessenger)
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if PilotDeepLinkPlugin.handle(url: url) {
      return true
    }
    return super.application(app, open: url, options: options)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }
}

final class AppleCalendarImportPlugin {
  private static let channelName = "com.maybesitter.mobile/apple_calendar_import"

  private let eventStore = EKEventStore()
  private let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static func register(binaryMessenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: binaryMessenger)
    let plugin = AppleCalendarImportPlugin()
    channel.setMethodCallHandler { call, result in
      plugin.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "authorizationStatus":
      result(Self.authorizationStatusName())
    case "requestAccessAndFetchEvents":
      let lookAheadDays = Self.lookAheadDays(from: call.arguments)
      requestAccessAndFetchEvents(lookAheadDays: lookAheadDays, result: result)
    case "fetchEvents":
      let lookAheadDays = Self.lookAheadDays(from: call.arguments)
      fetchEvents(lookAheadDays: lookAheadDays, result: result)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func requestAccessAndFetchEvents(
    lookAheadDays: Int,
    result: @escaping FlutterResult
  ) {
    if #available(iOS 17.0, *) {
      eventStore.requestFullAccessToEvents { granted, error in
        if let error {
          self.respond(
            with: Self.authorizationStatusName(),
            lookAheadDays: lookAheadDays,
            error: error,
            result: result
          )
          return
        }
        let status = granted ? "authorized" : Self.authorizationStatusName()
        self.respond(with: status, lookAheadDays: lookAheadDays, result: result)
      }
    } else {
      eventStore.requestAccess(to: .event) { granted, error in
        if let error {
          self.respond(
            with: Self.authorizationStatusName(),
            lookAheadDays: lookAheadDays,
            error: error,
            result: result
          )
          return
        }
        let status = granted ? "authorized" : Self.authorizationStatusName()
        self.respond(with: status, lookAheadDays: lookAheadDays, result: result)
      }
    }
  }

  private func fetchEvents(lookAheadDays: Int, result: @escaping FlutterResult) {
    respond(with: Self.authorizationStatusName(), lookAheadDays: lookAheadDays, result: result)
  }

  private func respond(
    with status: String,
    lookAheadDays: Int,
    error: Error? = nil,
    result: @escaping FlutterResult
  ) {
    if let error {
      DispatchQueue.main.async {
        result(
          FlutterError(
            code: "calendar_import_failed",
            message: error.localizedDescription,
            details: nil
          )
        )
      }
      return
    }

    guard status == "authorized" else {
      DispatchQueue.main.async {
        result([
          "status": status,
          "events": []
        ])
      }
      return
    }

    let windowStart = Calendar.current.startOfDay(for: Date())
    let windowEnd = Calendar.current.date(byAdding: .day, value: max(lookAheadDays, 1), to: windowStart)
      ?? windowStart.addingTimeInterval(TimeInterval(lookAheadDays * 86_400))
    let predicate = eventStore.predicateForEvents(
      withStart: windowStart,
      end: windowEnd,
      calendars: nil
    )
    let events = eventStore.events(matching: predicate)
      .sorted { $0.startDate < $1.startDate }
      .map { event in
        [
          "id": event.eventIdentifier ?? "\(event.calendarItemIdentifier)-\(event.startDate.timeIntervalSince1970)",
          "startAt": isoFormatter.string(from: event.startDate),
          "endAt": isoFormatter.string(from: event.endDate),
          "allDay": event.isAllDay
        ]
      }

    DispatchQueue.main.async {
      result([
        "status": status,
        "windowStart": self.isoFormatter.string(from: windowStart),
        "windowEnd": self.isoFormatter.string(from: windowEnd),
        "events": events
      ])
    }
  }

  private static func authorizationStatusName() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess:
      return "authorized"
    case .writeOnly:
      return "write_only"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    case .notDetermined:
      return "not_determined"
    @unknown default:
      return "unsupported"
    }
  }

  private static func lookAheadDays(from arguments: Any?) -> Int {
    guard
      let args = arguments as? [String: Any],
      let lookAheadDays = args["lookAheadDays"] as? Int
    else {
      return 14
    }
    return max(lookAheadDays, 1)
  }
}
