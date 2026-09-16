import Foundation

/// The snapshot contract, decoded (UC-3.R1, #203).
///
/// Mirrors `WidgetSnapshot` in `src/features/widget/snapshot.ts`; keep the two
/// in step. The app writes it as a JSON string into the App Group through
/// `@bacons/apple-targets`' `ExtensionStorage`.
///
/// Titles have already been redacted by the app when the user has not opted
/// in — they never reach this suite. `SafeItem` redacts *again* for a surface
/// the snapshot does not allow, so a lock-screen family can never draw a title
/// the snapshot only allowed on the home screen.
enum WidgetStore {
  static let appGroup = "group.com.maybesitter.app"
  static let snapshotKey = "maybesitter.widget.snapshot.v1"
}

enum WidgetSurface: String {
  case widget
  case lockScreen
}

enum WidgetDisplayState: Equatable {
  case loading
  case empty
  case stale
  case populated
}

struct WidgetLabels: Decodable {
  let privateCommitment: String
  let nextStep: String
  let empty: String
  let capture: String
  let stale: String
}

struct WidgetTitlePrivacy: Decodable {
  let mode: String
  let allowedSurfaceIds: [String]

  func allows(_ surface: WidgetSurface) -> Bool {
    mode == "allowedSurfacesOnly" && allowedSurfaceIds.contains(surface.rawValue)
  }
}

struct WidgetLinks: Decodable {
  let capture: String
  let today: String
}

struct WidgetSnapshotItem: Decodable {
  let id: String
  let title: String
  let titleRedacted: Bool
  let priority: String?
  let timeLabel: String?
  let isNextStep: Bool
  let link: String
}

struct WidgetSnapshot: Decodable {
  let contract: String
  let schemaVersion: Int
  let generatedAt: String
  let expiresAt: String
  let titlePrivacy: WidgetTitlePrivacy
  let locale: String
  let direction: String
  let labels: WidgetLabels
  let links: WidgetLinks
  let items: [WidgetSnapshotItem]

  var isSupported: Bool { contract == "commitmentSnapshot" && schemaVersion == 1 }

  var expiry: Date? { WidgetSnapshot.parseDate(expiresAt) }

  func displayState(now: Date) -> WidgetDisplayState {
    guard isSupported else { return .loading }
    guard let expiry, now < expiry else { return .stale }
    return items.isEmpty ? .empty : .populated
  }

  func safeItems(on surface: WidgetSurface) -> [SafeItem] {
    items.map { SafeItem(item: $0, allowed: titlePrivacy.allows(surface), redacted: labels.privateCommitment) }
  }

  static func parseDate(_ value: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
  }

  static func load() -> WidgetSnapshot? {
    guard
      let defaults = UserDefaults(suiteName: WidgetStore.appGroup),
      let raw = defaults.string(forKey: WidgetStore.snapshotKey),
      let data = raw.data(using: .utf8),
      let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
      snapshot.isSupported
    else { return nil }
    return snapshot
  }
}

struct SafeItem: Identifiable {
  let id: String
  let title: String
  let isRedacted: Bool
  let priority: String?
  let timeLabel: String?
  let url: URL?

  init(item: WidgetSnapshotItem, allowed: Bool, redacted: String) {
    id = item.id
    let show = allowed && !item.titleRedacted && !item.title.isEmpty
    title = show ? item.title : redacted
    isRedacted = !show
    priority = item.priority
    timeLabel = item.timeLabel
    url = URL(string: item.link)
  }
}

/// Words for the one state that has no snapshot to carry them: before the app
/// has ever written one. Picked from the phone's language, since there is no
/// app language to read yet.
enum FallbackCopy {
  static func labels() -> (nextStep: String, stale: String, rtl: Bool) {
    let language = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en"
    switch language {
    case "ar": return ("خطوتك التالية", "افتح MaybeSitter ليتحدّث.", true)
    case "he", "iw": return ("הצעד הבא שלך", "פתח את MaybeSitter כדי לרענן.", true)
    default: return ("Next step", "Open MaybeSitter to refresh.", false)
    }
  }
}
