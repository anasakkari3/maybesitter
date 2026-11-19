import SwiftUI
import WidgetKit

/// The widget's drawing, one view per family (UC-3.R1, #203).
///
/// ── What it draws ────────────────────────────────────────────────
///
/// The App Group snapshot and nothing else: no network, no query, no second
/// copy of the words. The look is the app's (`WidgetPalette`): paper and navy
/// surfaces, a coral action, the app's importance colours, radius-20 cards, a
/// quiet coral edge on the one card that is the next step.
///
/// ── What each family is for ──────────────────────────────────────
///
/// `systemSmall`   the next step, large, and the one after it. One tap target —
///                 iOS gives a small widget `widgetURL` only, `Link` is ignored.
/// `systemMedium`  the next step as a card, the rest beside it, a «احكيها» button.
/// `systemLarge`   the next step, the rest as a list, a full-width «احكيها» bar.
/// `accessoryRectangular` / `accessoryInline`  the lock screen: never a title.
/// `accessoryCircular`    the lock screen's way to «احكيها».
///
/// ── What it must never do ────────────────────────────────────────
///
/// Draw a title the snapshot did not allow on this surface (`SafeItem`
/// redacts again), or draw one that iOS cannot hide while the phone is locked
/// (every title is `.privacySensitive()`). A test reads this file for both.

// MARK: - Deep links

enum Deep {
  static let capture = URL(string: "maybesitter://capture?source=widget&input=voice")!
  static let today = URL(string: "maybesitter://today")!
}

/// Which snapshot surface a family is. The home screen may be allowed titles;
/// the lock screen never is.
func surface(for family: WidgetFamily) -> WidgetSurface {
  switch family {
  case .accessoryInline, .accessoryRectangular, .accessoryCircular: return .lockScreen
  default: return .widget
  }
}

func isAccessory(_ family: WidgetFamily) -> Bool {
  surface(for: family) == .lockScreen
}

// MARK: - What a family draws

/// Everything a view needs, resolved once per render from the entry, so no
/// view re-reads the snapshot or re-decides privacy.
struct WidgetContent {
  let state: WidgetDisplayState
  let items: [SafeItem]
  let nextStepLabel: String
  let emptyLabel: String
  let staleLabel: String
  let captureLabel: String?
  let captureURL: URL
  let todayURL: URL
  let rtl: Bool
  let p: WidgetPalette
  /// WidgetKit's placeholder: sample shapes, drawn redacted. Its words are not
  /// user content, so privacy marking steps aside and lets the redaction draw bars.
  let isPlaceholder: Bool

  init(entry: NextStepEntry, family: WidgetFamily, scheme: ColorScheme) {
    let fallback = FallbackCopy.labels()
    let snapshot = entry.snapshot
    p = WidgetPalette.of(scheme)
    isPlaceholder = entry.isPlaceholder
    rtl = snapshot.map { $0.direction == "rtl" } ?? fallback.rtl
    nextStepLabel = snapshot?.labels.nextStep ?? fallback.nextStep
    staleLabel = snapshot?.labels.stale ?? fallback.stale
    emptyLabel = snapshot?.labels.empty ?? fallback.stale
    captureLabel = snapshot?.labels.capture
    captureURL = snapshot.flatMap { URL(string: $0.links.capture) } ?? Deep.capture
    todayURL = snapshot.flatMap { URL(string: $0.links.today) } ?? Deep.today

    if entry.isPlaceholder {
      state = .populated
      items = SafeItem.placeholders
      return
    }
    state = entry.state
    guard entry.state == .populated, let snapshot else {
      items = []
      return
    }
    let all = snapshot.safeItems(on: surface(for: family))
    switch family {
    case .systemSmall, .accessoryRectangular: items = Array(all.prefix(2))
    case .accessoryInline: items = Array(all.prefix(1))
    default: items = all
    }
  }

  var first: SafeItem? { items.first }

  /// Where a tap on the widget as a whole goes.
  var primaryURL: URL {
    switch state {
    case .populated: return first?.url ?? todayURL
    case .empty: return captureURL
    case .stale, .loading: return todayURL
    }
  }
}

// MARK: - The entry point

/// Reads the family and colour scheme WidgetKit sets, and hands them on.
struct NextStepWidgetView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var scheme
  let entry: NextStepEntry

  var body: some View {
    FamilyView(entry: entry, family: family, scheme: scheme)
  }
}

/// The widget for one family and one scheme, given rather than read — so the
/// same drawing can be rendered to an image for every family, which WidgetKit's
/// read-only environment would not allow.
struct FamilyView: View {
  let entry: NextStepEntry
  let family: WidgetFamily
  let scheme: ColorScheme

  var body: some View {
    let content = WidgetContent(entry: entry, family: family, scheme: scheme)
    Group {
      switch family {
      case .systemSmall: SmallWidgetView(c: content)
      case .systemLarge: LargeWidgetView(c: content)
      case .accessoryRectangular: RectangularWidgetView(c: content)
      case .accessoryCircular: CircularWidgetView(c: content)
      case .accessoryInline: InlineWidgetView(c: content)
      default: MediumWidgetView(c: content)
      }
    }
    .environment(\.layoutDirection, content.rtl ? .rightToLeft : .leftToRight)
    .redacted(reason: entry.isPlaceholder ? RedactionReasons.placeholder : RedactionReasons())
    .containerBackground(for: .widget) {
      if isAccessory(family) { Color.clear } else { content.p.bg }
    }
  }
}

// MARK: - Pieces

private let cardRadius: CGFloat = 18

private struct ImportanceDot: View {
  let priority: String?
  let p: WidgetPalette
  var size: CGFloat = 8

  var body: some View {
    Circle()
      .fill(p.importance(priority))
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

private struct TimeLabel: View {
  let time: String
  let p: WidgetPalette

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "clock").font(.caption2.weight(.semibold)).accessibilityHidden(true)
      Text(time).font(.caption.weight(.semibold)).monospacedDigit()
    }
    .foregroundStyle(p.accent)
  }
}

/// The next step: its label, its title, its time.
private struct HeroBlock: View {
  let item: SafeItem
  let label: String
  let p: WidgetPalette
  let placeholder: Bool
  let titleFont: Font
  let lines: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        ImportanceDot(priority: item.priority, p: p)
        Text(label)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(p.muted)
          .lineLimit(1)
        Spacer(minLength: 0)
      }
      Text(item.title)
        .privacySensitive(!placeholder)
        .font(titleFont)
        .foregroundStyle(item.isRedacted ? p.muted : p.ink)
        .lineLimit(lines)
        .minimumScaleFactor(0.8)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let time = item.timeLabel { TimeLabel(time: time, p: p) }
    }
    .accessibilityElement(children: .combine)
  }
}

/// One of the steps after the next.
private struct SecondaryRow: View {
  let item: SafeItem
  let p: WidgetPalette
  let placeholder: Bool
  var showTime: Bool = true

  var body: some View {
    HStack(spacing: 8) {
      ImportanceDot(priority: item.priority, p: p, size: 6)
      VStack(alignment: .leading, spacing: 1) {
        Text(item.title)
          .privacySensitive(!placeholder)
          .font(.footnote.weight(.medium))
          .foregroundStyle(item.isRedacted ? p.muted : p.ink)
          .lineLimit(1)
          .multilineTextAlignment(.leading)
        if showTime, let time = item.timeLabel {
          Text(time).font(.caption2).foregroundStyle(p.muted).monospacedDigit()
        }
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

private struct CaptureButton: View {
  let label: String
  let url: URL
  let p: WidgetPalette
  var fill: Bool = false

  var body: some View {
    Link(destination: url) {
      HStack(spacing: 6) {
        Image(systemName: "mic.fill").font(.caption.weight(.bold)).accessibilityHidden(true)
        Text(label).font(.footnote.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
      }
      .foregroundStyle(p.onAccent)
      .padding(.horizontal, 12)
      .frame(maxWidth: fill ? .infinity : nil, minHeight: fill ? 44 : 40)
      .background(Capsule().fill(p.accent))
      .widgetAccentable()
    }
  }
}

/// Nothing open, or nothing fresh to show: an icon in a soft disc and a line.
private struct StateBlock: View {
  enum Kind { case empty, stale }

  let kind: Kind
  let text: String
  let p: WidgetPalette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack {
        Circle().fill(kind == .empty ? p.doneSoft : p.accentSoft)
        Image(systemName: kind == .empty ? "checkmark" : "arrow.clockwise")
          .font(.footnote.weight(.bold))
          .foregroundStyle(kind == .empty ? p.done : p.accent)
      }
      .frame(width: 32, height: 32)
      .accessibilityHidden(true)
      Text(text)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(kind == .empty ? p.ink : p.muted)
        .lineLimit(3)
        .minimumScaleFactor(0.85)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private extension WidgetContent {
  var stateKind: StateBlock.Kind { state == .empty ? .empty : .stale }
  var stateText: String { state == .empty ? emptyLabel : staleLabel }
}

private extension View {
  /// The card the next step sits on, with the app's quiet coral edge.
  func heroCard(_ p: WidgetPalette, padding: CGFloat) -> some View {
    self
      .padding(padding)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: cardRadius, style: .continuous).fill(p.card))
      .overlay(
        RoundedRectangle(cornerRadius: cardRadius, style: .continuous)
          .stroke(p.accent.opacity(0.4), lineWidth: 1)
      )
  }
}

// MARK: - Home screen

struct SmallWidgetView: View {
  let c: WidgetContent

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if c.state == .populated, let first = c.first {
        HeroBlock(
          item: first,
          label: c.nextStepLabel,
          p: c.p,
          placeholder: c.isPlaceholder,
          titleFont: .headline,
          lines: c.items.count > 1 ? 2 : 3
        )
        Spacer(minLength: 0)
        if c.items.count > 1 { SecondaryRow(item: c.items[1], p: c.p, placeholder: c.isPlaceholder, showTime: false) }
      } else {
        Spacer(minLength: 0)
        StateBlock(kind: c.stateKind, text: c.stateText, p: c.p)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(c.primaryURL)
  }
}

struct MediumWidgetView: View {
  let c: WidgetContent

  var body: some View {
    if c.state == .populated, let first = c.first {
      HStack(alignment: .top, spacing: 10) {
        Link(destination: first.url ?? c.todayURL) {
          HeroBlock(item: first, label: c.nextStepLabel, p: c.p, placeholder: c.isPlaceholder, titleFont: .headline, lines: 3)
            .heroCard(c.p, padding: 12)
        }
        VStack(alignment: .leading, spacing: 8) {
          ForEach(c.items.dropFirst()) { item in
            Link(destination: item.url ?? c.todayURL) { SecondaryRow(item: item, p: c.p, placeholder: c.isPlaceholder) }
          }
          Spacer(minLength: 0)
          if let label = c.captureLabel { CaptureButton(label: label, url: c.captureURL, p: c.p, fill: true) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
    } else {
      HStack(alignment: .center, spacing: 12) {
        StateBlock(kind: c.stateKind, text: c.stateText, p: c.p)
          .frame(maxHeight: .infinity, alignment: .center)
        if let label = c.captureLabel {
          CaptureButton(label: label, url: c.captureURL, p: c.p)
        }
      }
      .widgetURL(c.primaryURL)
    }
  }
}

struct LargeWidgetView: View {
  let c: WidgetContent

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if c.state == .populated, let first = c.first {
        Link(destination: first.url ?? c.todayURL) {
          HeroBlock(item: first, label: c.nextStepLabel, p: c.p, placeholder: c.isPlaceholder, titleFont: .title3.weight(.semibold), lines: 4)
            .heroCard(c.p, padding: 14)
        }
        if c.items.count > 1 {
          VStack(spacing: 0) {
            ForEach(Array(c.items.dropFirst().enumerated()), id: \.element.id) { index, item in
              if index > 0 { Rectangle().fill(c.p.muted.opacity(0.18)).frame(height: 1) }
              Link(destination: item.url ?? c.todayURL) {
                SecondaryRow(item: item, p: c.p, placeholder: c.isPlaceholder)
                  .padding(.horizontal, 14)
                  .padding(.vertical, 10)
              }
            }
          }
          .frame(maxWidth: .infinity)
          .background(RoundedRectangle(cornerRadius: cardRadius, style: .continuous).fill(c.p.card))
        }
        Spacer(minLength: 0)
      } else {
        Spacer(minLength: 0)
        StateBlock(kind: c.stateKind, text: c.stateText, p: c.p)
        Spacer(minLength: 0)
      }
      if let label = c.captureLabel { CaptureButton(label: label, url: c.captureURL, p: c.p, fill: true) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(c.state == .populated ? nil : c.primaryURL)
  }
}

// MARK: - Lock screen

struct RectangularWidgetView: View {
  let c: WidgetContent

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(c.nextStepLabel).font(.caption2.weight(.semibold)).widgetAccentable()
      if c.state == .populated, !c.items.isEmpty {
        ForEach(Array(c.items.enumerated()), id: \.element.id) { index, item in
          HStack(spacing: 4) {
            // A lock-screen title is always the redacted word; say it once.
            if index == 0 || !item.isRedacted {
              Text(item.title).font(.caption).lineLimit(1).privacySensitive(!c.isPlaceholder)
            } else {
              Text("•").font(.caption)
            }
            Spacer(minLength: 0)
            if let time = item.timeLabel { Text(time).font(.caption2).monospacedDigit() }
          }
        }
      } else {
        Text(c.stateText).font(.caption).lineLimit(2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(c.primaryURL)
  }
}

struct CircularWidgetView: View {
  let c: WidgetContent

  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      Image(systemName: "mic.fill").font(.title3.weight(.semibold)).widgetAccentable()
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(c.captureLabel ?? c.nextStepLabel)
    .widgetURL(c.captureURL)
  }
}

struct InlineWidgetView: View {
  let c: WidgetContent

  var body: some View {
    if let first = c.first {
      Text(first.timeLabel.map { "\($0) · \(first.title)" } ?? first.title)
        .privacySensitive(!c.isPlaceholder)
        .widgetURL(c.primaryURL)
    } else {
      Text(c.stateText).widgetURL(c.primaryURL)
    }
  }
}
