import SwiftUI
import WidgetKit

/// The iOS widget: the next step and the open items after it (UC-3.R1, #203).
///
/// Families: `systemSmall`, `systemMedium`, `systemLarge` on the home screen;
/// `accessoryRectangular`, `accessoryCircular`, `accessoryInline` on the lock
/// screen. The drawing is in `WidgetViews.swift`, the colours in
/// `WidgetPalette.swift`.
///
/// It never makes a network call — it draws the App Group snapshot the app last
/// wrote, and turns it "stale" at `expiresAt` through a second timeline entry,
/// so an app that has not run for half an hour stops showing a list that may be
/// wrong.
struct NextStepEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?
  /// WidgetKit asked for a placeholder: draw the shape of the widget, redacted,
  /// instead of words.
  var isPlaceholder: Bool = false

  var state: WidgetDisplayState { snapshot?.displayState(now: date) ?? .loading }
}

struct NextStepProvider: TimelineProvider {
  func placeholder(in context: Context) -> NextStepEntry {
    NextStepEntry(date: Date(), snapshot: nil, isPlaceholder: true)
  }

  func getSnapshot(in context: Context, completion: @escaping (NextStepEntry) -> Void) {
    let snapshot = WidgetSnapshot.load()
    // The gallery on a phone whose app has never run has nothing to show:
    // show the placeholder's shape rather than a "stale" message.
    completion(NextStepEntry(date: Date(), snapshot: snapshot, isPlaceholder: snapshot == nil && context.isPreview))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<NextStepEntry>) -> Void) {
    let now = Date()
    let snapshot = WidgetSnapshot.load()
    var entries = [NextStepEntry(date: now, snapshot: snapshot)]
    // The moment the snapshot expires, the same snapshot is drawn as stale.
    if let expiry = snapshot?.expiry, expiry > now {
      entries.append(NextStepEntry(date: expiry, snapshot: snapshot))
    }
    // After the last entry nothing changes until the app writes again, and the
    // app reloads the timelines itself when it does. This is only a backstop
    // for a write whose reload was lost, so it waits an hour after the last
    // entry instead of waking a stale widget every half hour.
    let backstop = (entries.last?.date ?? now).addingTimeInterval(60 * 60)
    completion(Timeline(entries: entries, policy: .after(backstop)))
  }
}

struct NextStepWidget: Widget {
  let kind = "MaybeSitterNextStep"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: NextStepProvider()) { entry in
      NextStepWidgetView(entry: entry)
    }
    .configurationDisplayName("MaybeSitter")
    .supportedFamilies([
      .systemSmall,
      .systemMedium,
      .systemLarge,
      .accessoryRectangular,
      .accessoryCircular,
      .accessoryInline,
    ])
  }
}
