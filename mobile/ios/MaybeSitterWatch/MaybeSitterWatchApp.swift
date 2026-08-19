import SwiftUI

@main
struct MaybeSitterWatchApp: App {
  var body: some Scene {
    WindowGroup { WatchRootView() }
  }
}

struct WatchRootView: View {
  @StateObject private var reader = WatchConnectivityReader()

  var body: some View {
    Group {
      guard let snapshot = reader.snapshot else {
        return AnyView(
          WatchStatus(
            title: "Not synced",
            message: "Open MaybeSitter on your iPhone."
          )
        )
      }
      if snapshot.isStale(now: Date()) {
        // Say so rather than show yesterday's priority as if it were now.
        return AnyView(
          WatchStatus(
            title: "Out of date",
            message: "Open MaybeSitter on your iPhone to refresh."
          )
        )
      }
      let items = snapshot.safeItems
      if items.isEmpty {
        return AnyView(
          WatchStatus(title: "Clear for now", message: "Nothing is waiting.")
        )
      }
      return AnyView(WatchAgenda(items: items))
    }
  }
}

/// The one thing that matters now, and what follows it.
///
/// Three at most. A wrist is glanced at, not read.
struct WatchAgenda: View {
  let items: [WatchItem]

  var body: some View {
    List {
      Section("Now") {
        WatchRow(item: items[0], prominent: true)
      }
      if items.count > 1 {
        Section("Next") {
          ForEach(items.dropFirst().prefix(2)) { item in
            WatchRow(item: item, prominent: false)
          }
        }
      }
    }
  }
}

struct WatchRow: View {
  let item: WatchItem
  let prominent: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 4) {
        Circle()
          .fill(priorityColor)
          .frame(width: 6, height: 6)
        Text(item.priority.capitalized)
          .font(.caption2)
          .foregroundStyle(.secondary)
        if let startTime = item.startTime {
          Spacer()
          Text(startTime).font(.caption2).foregroundStyle(.secondary)
        }
      }
      Text(item.title)
        .font(prominent ? .headline : .body)
        .lineLimit(2)
    }
    .padding(.vertical, 2)
  }

  private var priorityColor: Color {
    switch item.priority {
    case "must": return .red
    case "should": return .orange
    default: return .secondary
    }
  }
}

struct WatchStatus: View {
  let title: String
  let message: String

  var body: some View {
    VStack(spacing: 6) {
      Text(title).font(.headline)
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding()
  }
}
