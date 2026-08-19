import SwiftUI
import WidgetKit

private enum PilotPresenceStoreKeys {
  static let appGroupIdentifier = "group.com.maybesitter.maybesitterMobile"
  static let snapshotV1 = "pilot_presence_commitment_snapshot_v1"
}

private enum MaybeSitterDeepLink {
  static let capture = URL(string: "maybesitter://capture?source=widget&input=voice")!
  static let today = URL(string: "maybesitter://today")!

  static func item(_ id: String?) -> URL {
    guard let id, !id.isEmpty else { return today }
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    return URL(string: "maybesitter://commitments/\(encoded)")!
  }
}

private enum SnapshotDisplayState {
  case loading
  case empty
  case stale
  case populated
}

private struct CommitmentSnapshot: Decodable {
  let contract: String?
  let schemaVersion: Int
  let generatedAt: Date
  let expiresAt: Date
  let surface: String
  let titlePrivacy: SnapshotTitlePrivacy
  let items: [CommitmentSnapshotItem]

  var safeItems: [SafeCommitmentItem] {
    safeItems(for: "widget")
  }

  func safeItems(for surfaceId: String) -> [SafeCommitmentItem] {
    items.map {
      SafeCommitmentItem(
        item: $0,
        titlePrivacy: titlePrivacy,
        surfaceId: surfaceId
      )
    }
  }

  var isSupportedContract: Bool {
    contract == "commitmentSnapshot" && schemaVersion == 1
  }

  func displayState(now: Date) -> SnapshotDisplayState {
    if expiresAt <= now { return .stale }
    if safeItems.isEmpty { return .empty }
    return .populated
  }

  init(
    generatedAt: Date,
    expiresAt: Date,
    titlePrivacy: SnapshotTitlePrivacy,
    items: [CommitmentSnapshotItem],
    contract: String? = "commitmentSnapshot",
    schemaVersion: Int = 1,
    surface: String = "widget"
  ) {
    self.contract = contract
    self.schemaVersion = schemaVersion
    self.generatedAt = generatedAt
    self.expiresAt = expiresAt
    self.surface = surface
    self.titlePrivacy = titlePrivacy
    self.items = items
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    contract = try container.decodeIfPresent(String.self, forKey: .contract)
    schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 0
    surface = try container.decodeIfPresent(String.self, forKey: .surface) ?? "widget"
    titlePrivacy = try container.decodeIfPresent(SnapshotTitlePrivacy.self, forKey: .titlePrivacy)
      ?? SnapshotTitlePrivacy(mode: "neverIncludeTitles", allowedSurfaceIds: [])
    items = try container.decodeIfPresent([CommitmentSnapshotItem].self, forKey: .items) ?? []
    generatedAt = Self.parseDate(try container.decodeIfPresent(String.self, forKey: .generatedAt))
      ?? Date(timeIntervalSince1970: 0)
    expiresAt = Self.parseDate(try container.decodeIfPresent(String.self, forKey: .expiresAt))
      ?? Date(timeIntervalSince1970: 0)
  }

  private enum CodingKeys: String, CodingKey {
    case contract
    case schemaVersion
    case generatedAt
    case expiresAt
    case surface
    case titlePrivacy
    case items
  }

  static func parseDate(_ raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: raw) { return date }

    formatter.formatOptions = [.withInternetDateTime]
    if let date = formatter.date(from: raw) { return date }

    let localFormatter = DateFormatter()
    localFormatter.locale = Locale(identifier: "en_US_POSIX")
    localFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
    return localFormatter.date(from: raw)
  }
}

private struct SnapshotTitlePrivacy: Decodable {
  let mode: String
  let allowedSurfaceIds: [String]

  func allowsTitles(on surfaceId: String) -> Bool {
    switch mode {
    case "allowedSurfacesOnly", "explicitlyAllowed":
      return allowedSurfaceIds.contains(surfaceId)
    default:
      return false
    }
  }
}

private struct CommitmentSnapshotItem: Decodable, Identifiable {
  let id: String
  let title: String
  let titleRedacted: Bool
  let redactionReason: String
  let priority: String
  let status: String
  let timeGranularity: String
  let scheduledDate: Date?
  let startTime: String?
  let endTime: String?
  let category: String?

  init(
    id: String,
    title: String,
    titleRedacted: Bool,
    redactionReason: String,
    priority: String,
    status: String = "pending",
    timeGranularity: String = "exact",
    scheduledDate: Date? = nil,
    startTime: String? = nil,
    endTime: String? = nil,
    category: String? = nil
  ) {
    self.id = id
    self.title = title
    self.titleRedacted = titleRedacted
    self.redactionReason = redactionReason
    self.priority = priority
    self.status = status
    self.timeGranularity = timeGranularity
    self.scheduledDate = scheduledDate
    self.startTime = startTime
    self.endTime = endTime
    self.category = category
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
    title = try container.decodeIfPresent(String.self, forKey: .title) ?? SafeCommitmentItem.redactedTitle
    titleRedacted = try container.decodeIfPresent(Bool.self, forKey: .titleRedacted) ?? true
    redactionReason = try container.decodeIfPresent(String.self, forKey: .redactionReason) ?? "titlesDisabled"
    priority = try container.decodeIfPresent(String.self, forKey: .priority) ?? "should"
    status = try container.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
    timeGranularity = try container.decodeIfPresent(String.self, forKey: .timeGranularity) ?? "exact"
    scheduledDate = CommitmentSnapshot.parseDate(try container.decodeIfPresent(String.self, forKey: .scheduledDate))
    startTime = try container.decodeIfPresent(String.self, forKey: .startTime)
    endTime = try container.decodeIfPresent(String.self, forKey: .endTime)
    category = try container.decodeIfPresent(String.self, forKey: .category)
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case title
    case titleRedacted
    case redactionReason
    case priority
    case status
    case timeGranularity
    case scheduledDate
    case startTime
    case endTime
    case category
  }
}

private struct SafeCommitmentItem: Identifiable {
  static let redactedTitle = "Private commitment"

  let id: String
  let title: String
  let priority: String
  let scheduledDate: Date?
  let startTime: String?
  let endTime: String?
  let category: String?

  init(
    item: CommitmentSnapshotItem,
    titlePrivacy: SnapshotTitlePrivacy,
    surfaceId: String = "widget"
  ) {
    id = item.id
    priority = item.priority
    scheduledDate = item.scheduledDate
    startTime = item.startTime
    endTime = item.endTime
    category = item.category

    let titleAllowed = titlePrivacy.allowsTitles(on: surfaceId)
      && !item.titleRedacted
      && item.redactionReason == "none"
      && !item.title.isEmpty
    title = titleAllowed ? item.title : Self.redactedTitle
  }
}

private struct MaybeSitterWidgetEntry: TimelineEntry {
  let date: Date
  let displayState: SnapshotDisplayState
  let snapshot: CommitmentSnapshot?

  var items: [SafeCommitmentItem] {
    guard displayState == .populated else { return [] }
    return snapshot?.safeItems ?? []
  }

  var primaryURL: URL {
    switch displayState {
    case .loading, .empty:
      return MaybeSitterDeepLink.capture
    case .stale:
      return MaybeSitterDeepLink.today
    case .populated:
      return MaybeSitterDeepLink.item(items.first?.id)
    }
  }
}

private struct MaybeSitterTimelineProvider: TimelineProvider {
  func placeholder(in context: Context) -> MaybeSitterWidgetEntry {
    MaybeSitterWidgetEntry(date: Date(), displayState: .loading, snapshot: nil)
  }

  func getSnapshot(
    in context: Context,
    completion: @escaping (MaybeSitterWidgetEntry) -> Void
  ) {
    completion(context.isPreview ? .previewPopulated : loadEntry(now: Date()))
  }

  func getTimeline(
    in context: Context,
    completion: @escaping (Timeline<MaybeSitterWidgetEntry>) -> Void
  ) {
    let now = Date()
    let entry = loadEntry(now: now)
    let refreshDate = nextRefreshDate(for: entry.snapshot, displayState: entry.displayState, now: now)
    completion(Timeline(entries: [entry], policy: .after(refreshDate)))
  }

  private func loadEntry(now: Date) -> MaybeSitterWidgetEntry {
    guard
      let defaults = UserDefaults(suiteName: PilotPresenceStoreKeys.appGroupIdentifier),
      let raw = defaults.string(forKey: PilotPresenceStoreKeys.snapshotV1),
      let data = raw.data(using: .utf8),
      let snapshot = try? JSONDecoder().decode(CommitmentSnapshot.self, from: data),
      snapshot.isSupportedContract
    else {
      return MaybeSitterWidgetEntry(date: now, displayState: .loading, snapshot: nil)
    }

    return MaybeSitterWidgetEntry(
      date: now,
      displayState: snapshot.displayState(now: now),
      snapshot: snapshot
    )
  }

  private func nextRefreshDate(
    for snapshot: CommitmentSnapshot?,
    displayState: SnapshotDisplayState,
    now: Date
  ) -> Date {
    let earliest = now.addingTimeInterval(15 * 60)
    let latest = now.addingTimeInterval(60 * 60)

    guard let snapshot, displayState != .loading else { return earliest }
    guard displayState != .stale else { return earliest }

    let target = snapshot.expiresAt
    if target <= now { return earliest }
    return min(max(target, earliest), latest)
  }
}

private struct MaybeSitterHomeWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: MaybeSitterWidgetEntry

  var body: some View {
    Group {
      switch family {
      case .systemMedium:
        mediumContent
      default:
        smallContent
      }
    }
    .widgetURL(entry.primaryURL)
    .maybeSitterWidgetBackground()
  }

  private var smallContent: some View {
    VStack(alignment: .leading, spacing: 10) {
      WidgetHeader()
      Spacer(minLength: 0)

      switch entry.displayState {
      case .loading:
        StatusBlock(title: "Syncing", message: "Open MaybeSitter to refresh your priorities.")
      case .empty:
        StatusBlock(title: "Nothing due", message: "Capture a commitment before it slips.")
      case .stale:
        StatusBlock(title: "Needs refresh", message: "Open Today for the latest snapshot.")
      case .populated:
        if let item = entry.items.first {
          CommitmentSummary(item: item, isPrimary: true)
        }
      }

      Spacer(minLength: 0)
      FooterLinkLabel(text: footerText)
    }
    .padding(14)
  }

  private var mediumContent: some View {
    HStack(alignment: .top, spacing: 14) {
      VStack(alignment: .leading, spacing: 10) {
        WidgetHeader()
        Spacer(minLength: 0)
        primaryMediumContent
        Spacer(minLength: 0)
        HStack(spacing: 8) {
          Link(destination: MaybeSitterDeepLink.capture) {
            FooterLinkLabel(text: "Capture")
          }
          Link(destination: MaybeSitterDeepLink.today) {
            FooterLinkLabel(text: "Today")
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if entry.displayState == .populated {
        Divider().opacity(0.35)
        VStack(alignment: .leading, spacing: 8) {
          Text("Top priorities")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(WidgetPalette.secondaryText)
          ForEach(entry.items.prefix(3)) { item in
            Link(destination: MaybeSitterDeepLink.item(item.id)) {
              PriorityRow(item: item)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(16)
  }

  @ViewBuilder
  private var primaryMediumContent: some View {
    switch entry.displayState {
    case .loading:
      StatusBlock(title: "Syncing", message: "Open MaybeSitter once so the widget can read your latest snapshot.")
    case .empty:
      StatusBlock(title: "Clear for now", message: "Add the next commitment when it appears.")
    case .stale:
      StatusBlock(title: "Snapshot expired", message: "Open Today before acting on priorities.")
    case .populated:
      if let item = entry.items.first {
        CommitmentSummary(item: item, isPrimary: true)
      }
    }
  }

  private var footerText: String {
    switch entry.displayState {
    case .loading, .empty:
      return "Capture"
    case .stale:
      return "Today"
    case .populated:
      return "Open next"
    }
  }
}

private struct MaybeSitterLockScreenWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: MaybeSitterWidgetEntry

  var body: some View {
    Group {
      switch family {
      case .accessoryInline:
        Text(inlineText)
      default:
        rectangularContent
      }
    }
    .widgetURL(entry.primaryURL)
    .privacySensitive()
  }

  private var rectangularContent: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("MaybeSitter")
        .font(.caption2.weight(.semibold))
      Text(lockTitle)
        .font(.headline)
        .lineLimit(1)
        .minimumScaleFactor(0.72)
    }
  }

  private var inlineText: String {
    switch entry.displayState {
    case .loading:
      return "MaybeSitter syncing"
    case .empty:
      return "MaybeSitter: nothing due"
    case .stale:
      return "MaybeSitter needs refresh"
    case .populated:
      guard let item = lockScreenItems.first else { return "MaybeSitter" }
      return "MaybeSitter: \(item.title)"
    }
  }

  private var lockTitle: String {
    switch entry.displayState {
    case .loading:
      return "Syncing"
    case .empty:
      return "Nothing due"
    case .stale:
      return "Refresh Today"
    case .populated:
      return lockScreenItems.first?.title ?? "Open next"
    }
  }

  private var lockScreenItems: [SafeCommitmentItem] {
    entry.snapshot?.safeItems(for: "lockScreen") ?? []
  }
}

private struct WidgetHeader: View {
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "checkmark.seal.fill")
        .font(.caption.weight(.semibold))
        .foregroundStyle(WidgetPalette.accent)
      Text("MaybeSitter")
        .font(.caption.weight(.semibold))
        .foregroundStyle(WidgetPalette.primaryText)
    }
  }
}

private struct StatusBlock: View {
  let title: String
  let message: String

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title)
        .font(.headline.weight(.semibold))
        .foregroundStyle(WidgetPalette.primaryText)
        .lineLimit(2)
        .minimumScaleFactor(0.76)
      Text(message)
        .font(.caption)
        .foregroundStyle(WidgetPalette.secondaryText)
        .lineLimit(3)
    }
  }
}

private struct CommitmentSummary: View {
  let item: SafeCommitmentItem
  let isPrimary: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(isPrimary ? "Next" : item.priorityLabel)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(WidgetPalette.accent)
      Text(item.title)
        .font(isPrimary ? .headline.weight(.semibold) : .subheadline.weight(.semibold))
        .foregroundStyle(WidgetPalette.primaryText)
        .lineLimit(isPrimary ? 3 : 2)
        .minimumScaleFactor(0.68)
      Text(item.detailText)
        .font(.caption)
        .foregroundStyle(WidgetPalette.secondaryText)
        .lineLimit(1)
    }
  }
}

private struct PriorityRow: View {
  let item: SafeCommitmentItem

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 7) {
      Circle()
        .fill(item.priorityColor)
        .frame(width: 7, height: 7)
      VStack(alignment: .leading, spacing: 2) {
        Text(item.title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(WidgetPalette.primaryText)
          .lineLimit(1)
          .minimumScaleFactor(0.72)
        Text(item.detailText)
          .font(.caption2)
          .foregroundStyle(WidgetPalette.secondaryText)
          .lineLimit(1)
      }
    }
  }
}

private struct FooterLinkLabel: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption2.weight(.semibold))
      .foregroundStyle(WidgetPalette.accent)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(WidgetPalette.accent.opacity(0.12), in: Capsule())
      .lineLimit(1)
      .minimumScaleFactor(0.75)
  }
}

private extension SafeCommitmentItem {
  var priorityLabel: String {
    switch priority {
    case "must":
      return "Must"
    case "nice":
      return "Nice"
    default:
      return "Should"
    }
  }

  var priorityColor: Color {
    switch priority {
    case "must":
      return Color(red: 0.82, green: 0.20, blue: 0.24)
    case "nice":
      return Color(red: 0.15, green: 0.50, blue: 0.42)
    default:
      return WidgetPalette.accent
    }
  }

  var detailText: String {
    let timeText = [startTime, endTime]
      .compactMap { $0 }
      .filter { !$0.isEmpty }
      .joined(separator: "-")
    if !timeText.isEmpty { return "\(priorityLabel) at \(timeText)" }
    if let scheduledDate {
      return "\(priorityLabel) \(scheduledDate.formatted(date: .abbreviated, time: .omitted))"
    }
    return priorityLabel
  }
}

private enum WidgetPalette {
  static let background = Color(red: 0.98, green: 0.97, blue: 0.94)
  static let primaryText = Color(red: 0.11, green: 0.13, blue: 0.16)
  static let secondaryText = Color(red: 0.42, green: 0.44, blue: 0.48)
  static let accent = Color(red: 0.03, green: 0.43, blue: 0.56)
}

private extension View {
  @ViewBuilder
  func maybeSitterWidgetBackground() -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(for: .widget) {
        WidgetPalette.background
      }
    } else {
      background(WidgetPalette.background)
    }
  }
}

struct MaybeSitterHomeWidget: Widget {
  let kind = "MaybeSitterHomeWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: MaybeSitterTimelineProvider()) { entry in
      MaybeSitterHomeWidgetView(entry: entry)
    }
    .configurationDisplayName("MaybeSitter")
    .description("Shows your next commitment and top priorities.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct MaybeSitterLockScreenWidget: Widget {
  let kind = "MaybeSitterLockScreenWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: MaybeSitterTimelineProvider()) { entry in
      MaybeSitterLockScreenWidgetView(entry: entry)
    }
    .configurationDisplayName("MaybeSitter Next")
    .description("Keeps your next commitment visible from the Lock Screen.")
    .supportedFamilies([.accessoryInline, .accessoryRectangular])
  }
}

@main
struct MaybeSitterWidgetsBundle: WidgetBundle {
  var body: some Widget {
    MaybeSitterHomeWidget()
    MaybeSitterLockScreenWidget()
  }
}

private extension MaybeSitterWidgetEntry {
  static let previewLoading = MaybeSitterWidgetEntry(
    date: Date(),
    displayState: .loading,
    snapshot: nil
  )

  static let previewEmpty = MaybeSitterWidgetEntry(
    date: Date(),
    displayState: .empty,
    snapshot: CommitmentSnapshot(
      generatedAt: Date(),
      expiresAt: Date().addingTimeInterval(45 * 60),
      titlePrivacy: SnapshotTitlePrivacy(mode: "explicitlyAllowed", allowedSurfaceIds: ["widget"]),
      items: []
    )
  )

  static let previewStale = MaybeSitterWidgetEntry(
    date: Date(),
    displayState: .stale,
    snapshot: CommitmentSnapshot(
      generatedAt: Date().addingTimeInterval(-3 * 60 * 60),
      expiresAt: Date().addingTimeInterval(-60),
      titlePrivacy: SnapshotTitlePrivacy(mode: "explicitlyAllowed", allowedSurfaceIds: ["widget"]),
      items: [
        CommitmentSnapshotItem(
          id: "stale-1",
          title: "Call the school office",
          titleRedacted: false,
          redactionReason: "none",
          priority: "must"
        ),
      ]
    )
  )

  static let previewPopulated = MaybeSitterWidgetEntry(
    date: Date(),
    displayState: .populated,
    snapshot: CommitmentSnapshot(
      generatedAt: Date(),
      expiresAt: Date().addingTimeInterval(30 * 60),
      titlePrivacy: SnapshotTitlePrivacy(mode: "explicitlyAllowed", allowedSurfaceIds: ["widget"]),
      items: [
        CommitmentSnapshotItem(
          id: "next-1",
          title: "Confirm pickup window",
          titleRedacted: false,
          redactionReason: "none",
          priority: "must",
          startTime: "15:30"
        ),
        CommitmentSnapshotItem(
          id: "next-2",
          title: "Send dinner note",
          titleRedacted: false,
          redactionReason: "none",
          priority: "should"
        ),
        CommitmentSnapshotItem(
          id: "next-3",
          title: "Pack spare clothes",
          titleRedacted: false,
          redactionReason: "none",
          priority: "nice"
        ),
      ]
    )
  )

  static let previewPrivate = MaybeSitterWidgetEntry(
    date: Date(),
    displayState: .populated,
    snapshot: CommitmentSnapshot(
      generatedAt: Date(),
      expiresAt: Date().addingTimeInterval(30 * 60),
      titlePrivacy: SnapshotTitlePrivacy(mode: "neverIncludeTitles", allowedSurfaceIds: []),
      items: [
        CommitmentSnapshotItem(
          id: "private-1",
          title: "Sensitive original title must not render",
          titleRedacted: true,
          redactionReason: "titlesDisabled",
          priority: "must"
        ),
      ]
    )
  )

  static let previewRTL = MaybeSitterWidgetEntry(
    date: Date(),
    displayState: .populated,
    snapshot: CommitmentSnapshot(
      generatedAt: Date(),
      expiresAt: Date().addingTimeInterval(30 * 60),
      titlePrivacy: SnapshotTitlePrivacy(mode: "explicitlyAllowed", allowedSurfaceIds: ["widget"]),
      items: [
        CommitmentSnapshotItem(
          id: "rtl-1",
          title: "تأكيد موعد المدرسة",
          titleRedacted: false,
          redactionReason: "none",
          priority: "must",
          startTime: "14:45"
        ),
        CommitmentSnapshotItem(
          id: "rtl-2",
          title: "להכין תיק למחר",
          titleRedacted: false,
          redactionReason: "none",
          priority: "should"
        ),
      ]
    )
  )
}

struct MaybeSitterWidgetsPreview: PreviewProvider {
  static var previews: some View {
    Group {
      MaybeSitterHomeWidgetView(entry: .previewLoading)
        .previewContext(WidgetPreviewContext(family: .systemSmall))
        .previewDisplayName("Small Loading")
      MaybeSitterHomeWidgetView(entry: .previewEmpty)
        .previewContext(WidgetPreviewContext(family: .systemSmall))
        .previewDisplayName("Small Empty")
      MaybeSitterHomeWidgetView(entry: .previewStale)
        .previewContext(WidgetPreviewContext(family: .systemMedium))
        .previewDisplayName("Medium Stale")
      MaybeSitterHomeWidgetView(entry: .previewPopulated)
        .previewContext(WidgetPreviewContext(family: .systemMedium))
        .previewDisplayName("Medium Populated")
      MaybeSitterHomeWidgetView(entry: .previewPrivate)
        .previewContext(WidgetPreviewContext(family: .systemSmall))
        .previewDisplayName("Small Private")
      MaybeSitterHomeWidgetView(entry: .previewPopulated)
        .environment(\.colorScheme, .dark)
        .previewContext(WidgetPreviewContext(family: .systemMedium))
        .previewDisplayName("Medium Dark")
      MaybeSitterHomeWidgetView(entry: .previewRTL)
        .environment(\.layoutDirection, .rightToLeft)
        .previewContext(WidgetPreviewContext(family: .systemMedium))
        .previewDisplayName("Medium RTL")
      MaybeSitterLockScreenWidgetView(entry: .previewPopulated)
        .previewContext(WidgetPreviewContext(family: .accessoryRectangular))
        .previewDisplayName("Lock Populated")
      MaybeSitterLockScreenWidgetView(entry: .previewPrivate)
        .environment(\.colorScheme, .dark)
        .previewContext(WidgetPreviewContext(family: .accessoryRectangular))
        .previewDisplayName("Lock Dark Private")
      MaybeSitterLockScreenWidgetView(entry: .previewRTL)
        .environment(\.layoutDirection, .rightToLeft)
        .previewContext(WidgetPreviewContext(family: .accessoryInline))
        .previewDisplayName("Lock RTL")
    }
  }
}
