import Foundation
import WatchConnectivity

/// Receives the phone's snapshot on the watch.
///
/// App Groups do not cross from an iPhone to an Apple Watch -- they are
/// separate devices with separate containers -- so the watch cannot read the
/// store the widget reads. WatchConnectivity's application context carries the
/// latest snapshot instead: it keeps only the most recent value, which is
/// exactly the semantics a snapshot wants.
final class WatchConnectivityReader: NSObject, ObservableObject, WCSessionDelegate {
  @Published private(set) var snapshot: WatchSnapshot?
  @Published private(set) var receivedAt: Date?

  static let contextKey = "pilot_presence_commitment_snapshot_v1"

  override init() {
    super.init()
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    session.delegate = self
    session.activate()
    // A context that arrived before this launch is still the latest one.
    apply(session.receivedApplicationContext)
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith state: WCSessionActivationState,
    error: Error?
  ) {
    guard error == nil else { return }
    apply(session.receivedApplicationContext)
  }

  func session(
    _ session: WCSession,
    didReceiveApplicationContext applicationContext: [String: Any]
  ) {
    apply(applicationContext)
  }

  private func apply(_ context: [String: Any]) {
    guard let raw = context[Self.contextKey] as? String,
          let data = raw.data(using: .utf8),
          let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data),
          decoded.isSupportedContract
    else { return }

    DispatchQueue.main.async {
      self.snapshot = decoded
      self.receivedAt = Date()
    }
  }
}
