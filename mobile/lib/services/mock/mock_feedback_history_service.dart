import '../../models/feedback_history.dart';
import '../contracts/feedback_history_service.dart';

/// An in-memory behaviour record for mock mode and widget tests.
///
/// It is a faithful double rather than a prop: revoking really stamps the row,
/// the stamp survives a reload, and a revoked row keeps its place in the list.
/// A double that only pretended would let the screen pass its tests while
/// lying to the user, which is the exact failure this feature exists to remove.
class MockFeedbackHistoryService implements FeedbackHistoryService {
  final List<FeedbackHistoryRow> _rows;

  final FeedbackBaselineNotice? baseline;

  /// Thrown by both calls when set — for exercising the failure paths.
  final Object? failWith;

  /// When true the record answers as "not connected in this build".
  final bool unavailable;

  MockFeedbackHistoryService({
    List<FeedbackHistoryRow>? rows,
    this.baseline = defaultBaseline,
    this.failWith,
    this.unavailable = false,
  }) : _rows = List.of(rows ?? defaultRows());

  static const defaultBaseline = FeedbackBaselineNotice(
    ignoredSuggestions: 3,
    completedActions: 11,
    delayedActions: 5,
    clarificationSuccesses: 2,
    clarificationFailures: 1,
    lastUpdatedAt: null,
  );

  /// A spread wide enough that every state of the screen is reachable by hand:
  /// several outcomes, one row the user has already corrected, and one row
  /// whose item no longer exists, so the "we can no longer name this" line is
  /// visible rather than only theoretical.
  ///
  /// The subject ids match the seeded commitments, because a history that could
  /// not be matched back to real items would hide the join the screen depends on.
  static List<FeedbackHistoryRow> defaultRows() {
    final now = DateTime.now();
    DateTime ago(int hours) => now.subtract(Duration(hours: hours));
    return [
      FeedbackHistoryRow(
        id: 'evt-001',
        outcome: FeedbackOutcome.defer,
        subjectId: 'c-today-2',
        occurredAt: ago(3),
        revokedAt: null,
        canRevoke: true,
      ),
      FeedbackHistoryRow(
        id: 'evt-002',
        outcome: FeedbackOutcome.complete,
        subjectId: 'c-today-4',
        occurredAt: ago(21),
        revokedAt: null,
        canRevoke: true,
      ),
      FeedbackHistoryRow(
        id: 'evt-003',
        outcome: FeedbackOutcome.ignore,
        subjectId: 'c-up-2',
        occurredAt: ago(30),
        revokedAt: ago(4),
        canRevoke: false,
      ),
      FeedbackHistoryRow(
        id: 'evt-004',
        outcome: FeedbackOutcome.accept,
        subjectId: 'c-up-1',
        occurredAt: ago(52),
        revokedAt: null,
        canRevoke: true,
      ),
      FeedbackHistoryRow(
        id: 'evt-005',
        // Deleted since; the row stays, and the screen says the item is gone.
        outcome: FeedbackOutcome.edit,
        subjectId: 'c-deleted-1',
        occurredAt: ago(76),
        revokedAt: null,
        canRevoke: true,
      ),
    ];
  }

  @override
  Future<FeedbackHistory> getHistory() async {
    if (unavailable) throw const FeedbackHistoryUnavailableException();
    if (failWith != null) throw failWith!;
    final sorted = List.of(_rows)
      ..sort((a, b) => b.occurredAt.compareTo(a.occurredAt));
    return FeedbackHistory(rows: sorted, baselineNotice: baseline);
  }

  @override
  Future<FeedbackHistoryRow> revoke(String eventId) async {
    if (unavailable) throw const FeedbackHistoryUnavailableException();
    if (failWith != null) throw failWith!;
    final index = _rows.indexWhere((row) => row.id == eventId);
    if (index < 0) throw StateError('unknown feedback event: $eventId');
    final existing = _rows[index];
    // Re-revoking keeps the original correction time, matching the store.
    if (existing.isRevoked) return existing;
    final revoked = existing.copyWith(revokedAt: DateTime.now(), canRevoke: false);
    _rows[index] = revoked;
    return revoked;
  }
}
