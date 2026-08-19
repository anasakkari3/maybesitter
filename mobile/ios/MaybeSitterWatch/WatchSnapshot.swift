import Foundation

/// The phone's commitment snapshot, as the watch receives it.
///
/// Deliberately a mirror of the contract the widget already reads rather than a
/// second model. The watch decides nothing: what is important, what is next,
/// and whether a title may be shown are all settled on the phone before this
/// arrives. Anything else and Aware would come to mean one thing on the phone
/// and something else here.
struct WatchSnapshot: Decodable {
  static let surfaceId = "watch"

  let contract: String?
  let schemaVersion: Int
  let generatedAt: Date
  let expiresAt: Date
  let titlePrivacy: WatchTitlePrivacy
  let items: [WatchSnapshotItem]

  var isSupportedContract: Bool {
    contract == "commitmentSnapshot" && schemaVersion == 1
  }

  func isStale(now: Date) -> Bool { expiresAt <= now }

  /// The items in the order the phone ranked them, already redacted.
  var safeItems: [WatchItem] {
    items.map { WatchItem(item: $0, titlePrivacy: titlePrivacy) }
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    contract = try c.decodeIfPresent(String.self, forKey: .contract)
    schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 0
    titlePrivacy = try c.decodeIfPresent(WatchTitlePrivacy.self, forKey: .titlePrivacy)
      ?? WatchTitlePrivacy(mode: "neverIncludeTitles", allowedSurfaceIds: [])
    items = try c.decodeIfPresent([WatchSnapshotItem].self, forKey: .items) ?? []
    generatedAt = Self.parseDate(try c.decodeIfPresent(String.self, forKey: .generatedAt))
      ?? Date(timeIntervalSince1970: 0)
    expiresAt = Self.parseDate(try c.decodeIfPresent(String.self, forKey: .expiresAt))
      ?? Date(timeIntervalSince1970: 0)
  }

  private enum CodingKeys: String, CodingKey {
    case contract, schemaVersion, generatedAt, expiresAt, titlePrivacy, items
  }

  static func parseDate(_ raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = iso.date(from: raw) { return d }
    iso.formatOptions = [.withInternetDateTime]
    if let d = iso.date(from: raw) { return d }
    let local = DateFormatter()
    local.locale = Locale(identifier: "en_US_POSIX")
    local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
    return local.date(from: raw)
  }
}

struct WatchTitlePrivacy: Decodable {
  let mode: String
  let allowedSurfaceIds: [String]

  /// The watch is its own surface. Allowing titles on the Home Screen widget
  /// says nothing about a wrist someone else can read over your shoulder.
  func allowsTitles(on surfaceId: String) -> Bool {
    switch mode {
    case "allowedSurfacesOnly", "explicitlyAllowed":
      return allowedSurfaceIds.contains(surfaceId)
    default:
      return false
    }
  }
}

struct WatchSnapshotItem: Decodable {
  let id: String
  let title: String
  let titleRedacted: Bool
  let redactionReason: String
  let priority: String
  let scheduledDate: Date?
  let startTime: String?

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? WatchItem.redactedTitle
    titleRedacted = try c.decodeIfPresent(Bool.self, forKey: .titleRedacted) ?? true
    redactionReason = try c.decodeIfPresent(String.self, forKey: .redactionReason) ?? "titlesDisabled"
    priority = try c.decodeIfPresent(String.self, forKey: .priority) ?? "should"
    scheduledDate = WatchSnapshot.parseDate(try c.decodeIfPresent(String.self, forKey: .scheduledDate))
    startTime = try c.decodeIfPresent(String.self, forKey: .startTime)
  }

  private enum CodingKeys: String, CodingKey {
    case id, title, titleRedacted, redactionReason, priority, scheduledDate, startTime
  }
}

/// One item, with the title question already answered.
struct WatchItem: Identifiable {
  static let redactedTitle = "Private commitment"

  let id: String
  let title: String
  let priority: String
  let startTime: String?

  init(item: WatchSnapshotItem, titlePrivacy: WatchTitlePrivacy) {
    id = item.id
    priority = item.priority
    startTime = item.startTime
    let allowed = titlePrivacy.allowsTitles(on: WatchSnapshot.surfaceId)
      && !item.titleRedacted
      && item.redactionReason == "none"
      && !item.title.isEmpty
    title = allowed ? item.title : Self.redactedTitle
  }
}
