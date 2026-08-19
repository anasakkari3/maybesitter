import 'contracts/awareness_state_store.dart';

/// Session-scoped awareness state.
///
/// Acknowledgement is intentionally not durable across a reinstall: a stale
/// "you already knew about this" is worse than one extra reminder.
class InMemoryAwarenessStateStore implements AwarenessStateStore {
  final Map<String, DateTime> _acknowledgedAt = {};

  @override
  Future<bool> isAware(String commitmentId) async =>
      _acknowledgedAt.containsKey(commitmentId);

  @override
  Future<void> markAware(String commitmentId, DateTime at) async {
    _acknowledgedAt[commitmentId] = at;
  }

  @override
  Future<void> clear(String commitmentId) async {
    _acknowledgedAt.remove(commitmentId);
  }

  @override
  Future<void> retainOnly(Set<String> liveCommitmentIds) async {
    _acknowledgedAt.removeWhere((id, _) => !liveCommitmentIds.contains(id));
  }
}
