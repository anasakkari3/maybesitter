/// Where "the user knows about this" is kept.
///
/// Awareness is deliberately its own record rather than a commitment status.
/// A user who has seen a reminder has not completed anything, so acknowledging
/// one must never look like finishing it. The reminder engine reads this to
/// decide whether an escalation is still warranted; nothing else may infer
/// progress from it.
abstract interface class AwarenessStateStore {
  /// Whether [commitmentId] has been acknowledged and not since cleared.
  Future<bool> isAware(String commitmentId);

  /// Record that the user acknowledged [commitmentId] at [at].
  Future<void> markAware(String commitmentId, DateTime at);

  /// Forget any acknowledgement for [commitmentId].
  ///
  /// Called when the commitment moves on -- completed, cancelled, deleted, or
  /// rescheduled -- so a fresh reminder cycle is not silenced by a stale
  /// acknowledgement of the old one.
  Future<void> clear(String commitmentId);

  /// Drop acknowledgements for every commitment outside [liveCommitmentIds].
  Future<void> retainOnly(Set<String> liveCommitmentIds);
}
