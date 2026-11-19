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

/// Built once per process. A formatter is the slow part of parsing a date; the
/// widget reads a snapshot on every timeline reload and every entry, and used to
/// build two of them each time. `ISO8601DateFormatter` is documented thread-safe
/// for reading, so sharing the pair is sound.
private enum IsoDates {
  nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  nonisolated(unsafe) static let plain = ISO8601DateFormatter()
}

struct WidgetSnapshot: Decodable {
  let contract: String
  let schemaVersion: Int
  let generatedAt: String
  let expiresAt: String
  let titlePrivacy: WidgetTitlePrivacy
  let locale: String
  let direction: String
  /// The app's own appearance setting: "dark" (its default), "light" or "system".
  /// Optional: a snapshot written before this field existed still decodes.
  let appearance: String?
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
    IsoDates.withFraction.date(from: value) ?? IsoDates.plain.date(from: value)
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

  init(id: String, title: String, isRedacted: Bool, priority: String?, timeLabel: String?, url: URL?) {
    self.id = id
    self.title = title
    self.isRedacted = isRedacted
    self.priority = priority
    self.timeLabel = timeLabel
    self.url = url
  }

  /// Shapes for WidgetKit's placeholder, which is drawn `.redacted` — the words
  /// are never seen, only how long they are. Not user content, not localised.
  static let placeholders: [SafeItem] = [
    SafeItem(id: "p1", title: "Placeholder for the next step title", isRedacted: false, priority: "must", timeLabel: "10:30", url: nil),
    SafeItem(id: "p2", title: "Another open step", isRedacted: false, priority: "should", timeLabel: "13:00", url: nil),
    SafeItem(id: "p3", title: "A third open step", isRedacted: false, priority: "nice", timeLabel: "18:00", url: nil),
  ]
}

/// Words for the one state that has no snapshot to carry them: before the app
/// has ever written one. Picked from the phone's language, since there is no
/// app language to read yet.
enum FallbackCopy {
  static func labels() -> (nextStep: String, stale: String, capture: String, rtl: Bool) {
    let language = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en"
    switch language {
    case "ar": return ("خطوتك التالية", "افتح MaybeSitter ليتحدّث.", "احكيها", true)
    case "he", "iw": return ("הצעד הבא שלך", "פתח את MaybeSitter כדי לרענן.", "להגיד", true)
    default: return ("Next step", "Open MaybeSitter to refresh.", "Say it", false)
    }
  }
}
