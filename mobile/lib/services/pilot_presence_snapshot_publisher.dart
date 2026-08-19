import '../models/commitment.dart';
import '../models/pilot_presence.dart';
import 'contracts/pilot_presence_store.dart';

class PilotPresenceSnapshotPublisher {
  final PilotPresenceStore store;
  final DateTime Function() now;
  final Duration snapshotTtl;

  const PilotPresenceSnapshotPublisher({
    required this.store,
    required this.now,
    this.snapshotTtl = const Duration(minutes: 30),
  });

  Future<void> publishWidgetSnapshot(List<Commitment> commitments) async {
    final generatedAt = now().toUtc();
    final visibleCommitments = _prioritizedWidgetCommitments(commitments);
    final snapshot = CommitmentSnapshot.fromCommitments(
      commitments: visibleCommitments,
      generatedAt: generatedAt,
      expiresAt: generatedAt.add(snapshotTtl),
      surface: PilotPresenceSurface.widget,
      titlePrivacy: const SnapshotTitlePrivacy(
        mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
      ),
    );

    await store.publishSnapshot(snapshot);
  }

  Future<void> clearWidgetSnapshot() => store.clearSnapshot();

  List<Commitment> _prioritizedWidgetCommitments(List<Commitment> commitments) {
    final active = commitments
        .where((commitment) => !commitment.status.isCompleted)
        .toList(growable: false);
    final sorted = [...active]..sort(_compareCommitmentsForWidget);
    return sorted.take(3).toList(growable: false);
  }

  int _compareCommitmentsForWidget(Commitment a, Commitment b) {
    final priority = _priorityRank(
      a.priority,
    ).compareTo(_priorityRank(b.priority));
    if (priority != 0) return priority;

    final date = _dateRank(a).compareTo(_dateRank(b));
    if (date != 0) return date;

    return a.title.compareTo(b.title);
  }

  int _priorityRank(CommitmentPriority priority) {
    return switch (priority) {
      CommitmentPriority.must => 0,
      CommitmentPriority.should => 1,
      CommitmentPriority.nice => 2,
    };
  }

  int _dateRank(Commitment commitment) {
    return commitment.scheduledDate?.millisecondsSinceEpoch ?? 1 << 62;
  }
}
