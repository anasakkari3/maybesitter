import SwiftUI
import WidgetKit

/// The iOS widget: the next step and up to two more open items (UC-3.R1, #203).
///
/// Families: `systemSmall`, `systemMedium` on the home screen;
/// `accessoryRectangular`, `accessoryInline` on the lock screen. It never makes
/// a network call — it draws the App Group snapshot the app last wrote, and
/// turns it "stale" at `expiresAt` through a second timeline entry, so an app
/// that has not run for half an hour stops showing a list that may be wrong.
struct NextStepEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?

  var state: WidgetDisplayState { snapshot?.displayState(now: date) ?? .loading }
}

struct NextStepProvider: TimelineProvider {
  func placeholder(in context: Context) -> NextStepEntry {
    NextStepEntry(date: Date(), snapshot: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (NextStepEntry) -> Void) {
    completion(NextStepEntry(date: Date(), snapshot: WidgetSnapshot.load()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<NextStepEntry>) -> Void) {
    let now = Date()
    let snapshot = WidgetSnapshot.load()
    var entries = [NextStepEntry(date: now, snapshot: snapshot)]
    // The moment the snapshot expires, the same snapshot is drawn as stale.
    if let expiry = snapshot?.expiry, expiry > now {
      entries.append(NextStepEntry(date: expiry, snapshot: snapshot))
    }
    // After that nothing changes until the app writes again, which reloads the
    // timelines itself. The periodic check is a backstop, not the mechanism.
    let backstop = Calendar.current.date(byAdding: .minute, value: 30, to: entries.last!.date) ?? now
    completion(Timeline(entries: entries, policy: .after(backstop)))
  }
}

private enum Deep {
  static let capture = URL(string: "maybesitter://capture?source=widget&input=voice")!
  static let today = URL(string: "maybesitter://today")!
}

private func dotColor(_ priority: String?) -> Color {
  switch priority {
  case "must": return Color("must")
  case "should": return Color("brand")
  default: return Color("textMuted")
  }
}

struct NextStepWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: NextStepEntry

  /// Lock-screen families read the same snapshot, whose privacy never lists
  /// `lockScreen` — so `safeItems(on: .lockScreen)` is always redacted.
  private var surface: WidgetSurface {
    switch family {
    case .accessoryInline, .accessoryRectangular: return .lockScreen
    default: return .widget
    }
  }

  private var rtl: Bool {
    if let snapshot = entry.snapshot { return snapshot.direction == "rtl" }
    return FallbackCopy.labels().rtl
  }

  private var items: [SafeItem] {
    guard entry.state == .populated, let snapshot = entry.snapshot else { return [] }
    let all = snapshot.safeItems(on: surface)
    switch family {
    case .systemSmall, .accessoryRectangular: return Array(all.prefix(2))
    case .accessoryInline: return Array(all.prefix(1))
    default: return all
    }
  }

  private var nextStepLabel: String { entry.snapshot?.labels.nextStep ?? FallbackCopy.labels().nextStep }
  private var staleLabel: String { entry.snapshot?.labels.stale ?? FallbackCopy.labels().stale }

  var body: some View {
    content
      .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
      .containerBackground(for: .widget) { Color("$widgetBackground") }
  }

  @ViewBuilder private var content: some View {
    switch family {
    case .accessoryInline:
      inline
    case .accessoryRectangular:
      rectangular
    default:
      home
    }
  }

  // MARK: Lock screen

  @ViewBuilder private var inline: some View {
    if let first = items.first {
      Text(first.timeLabel.map { "\($0) · \(first.title)" } ?? first.title)
        .privacySensitive()
        .widgetURL(first.url ?? Deep.today)
    } else if entry.state == .empty, let snapshot = entry.snapshot {
      Text(snapshot.labels.empty).widgetURL(Deep.capture)
    } else {
      Text(staleLabel).widgetURL(Deep.today)
    }
  }

  @ViewBuilder private var rectangular: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(nextStepLabel).font(.caption2).widgetAccentable()
      if items.isEmpty {
        Text(entry.state == .empty ? (entry.snapshot?.labels.empty ?? staleLabel) : staleLabel)
          .font(.caption)
      } else {
        ForEach(items) { item in
          HStack(spacing: 4) {
            Text(item.title).font(.caption).lineLimit(1).privacySensitive()
            Spacer(minLength: 0)
            if let time = item.timeLabel { Text(time).font(.caption2) }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(items.first?.url ?? (entry.state == .empty ? Deep.capture : Deep.today))
  }

  // MARK: Home screen

  @ViewBuilder private var home: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(nextStepLabel).font(.caption).foregroundStyle(Color("textMuted"))
        Spacer(minLength: 4)
        Link(destination: Deep.capture) {
          Text(entry.snapshot?.labels.capture ?? "")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color("onBrand"))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color("brand")))
        }
        .opacity(entry.snapshot == nil ? 0 : 1)
      }
      switch entry.state {
      case .populated:
        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
          Link(destination: item.url ?? Deep.today) {
            HStack(spacing: 6) {
              Circle().fill(dotColor(item.priority)).frame(width: 7, height: 7)
              Text(item.title)
                // Hidden by iOS while the device is locked, even on the home
                // screen and even when the user allowed titles there.
                .privacySensitive()
                .font(index == 0 ? .headline : .subheadline)
                .foregroundStyle(item.isRedacted ? Color("textMuted") : Color("textPrimary"))
                .lineLimit(family == .systemSmall && index == 0 ? 2 : 1)
              Spacer(minLength: 0)
              if let time = item.timeLabel {
                Text(time).font(.caption).foregroundStyle(Color("textMuted"))
              }
            }
          }
        }
      case .empty:
        Link(destination: Deep.capture) {
          Text(entry.snapshot?.labels.empty ?? "").font(.subheadline).foregroundStyle(Color("textPrimary"))
        }
      case .stale, .loading:
        Link(destination: Deep.today) {
          Text(staleLabel).font(.subheadline).foregroundStyle(Color("textMuted"))
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct NextStepWidget: Widget {
  let kind = "MaybeSitterNextStep"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: NextStepProvider()) { entry in
      NextStepWidgetView(entry: entry)
    }
    .configurationDisplayName("MaybeSitter")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
  }
}
