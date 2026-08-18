import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/feedback_history.dart';
import '../../services/contracts/feedback_history_service.dart';
import '../../services/providers.dart';

enum FeedbackHistoryStatus {
  loading,
  ready,

  /// The record could not be read. Distinct from [unavailable]: this one is
  /// worth retrying.
  failed,

  /// This build has no behaviour record connected. Never rendered as an empty
  /// history — "we hold nothing about you" and "we cannot show you what we
  /// hold" are different statements and the user is owed the accurate one.
  unavailable,
}

class FeedbackHistoryUiState {
  final FeedbackHistoryStatus status;
  final FeedbackHistory history;

  /// The row whose revoke is in flight, if any. Only that row's control is
  /// disabled, so one slow request does not freeze the whole list.
  final String? revokingId;

  /// Set when a revoke failed, so the screen can say nothing changed instead
  /// of quietly showing the row unchanged and letting the user assume it did.
  final bool lastRevokeFailed;

  const FeedbackHistoryUiState({
    this.status = FeedbackHistoryStatus.loading,
    this.history = FeedbackHistory.empty,
    this.revokingId,
    this.lastRevokeFailed = false,
  });

  FeedbackHistoryUiState copyWith({
    FeedbackHistoryStatus? status,
    FeedbackHistory? history,
    String? revokingId,
    bool clearRevokingId = false,
    bool? lastRevokeFailed,
  }) {
    return FeedbackHistoryUiState(
      status: status ?? this.status,
      history: history ?? this.history,
      revokingId: clearRevokingId ? null : (revokingId ?? this.revokingId),
      lastRevokeFailed: lastRevokeFailed ?? this.lastRevokeFailed,
    );
  }
}

class FeedbackHistoryNotifier extends StateNotifier<FeedbackHistoryUiState> {
  final FeedbackHistoryService service;

  FeedbackHistoryNotifier({required this.service})
    : super(const FeedbackHistoryUiState()) {
    load();
  }

  Future<void> load() async {
    state = state.copyWith(status: FeedbackHistoryStatus.loading);
    try {
      final history = await service.getHistory();
      if (!mounted) return;
      state = FeedbackHistoryUiState(
        status: FeedbackHistoryStatus.ready,
        history: history,
      );
    } on FeedbackHistoryUnavailableException {
      if (!mounted) return;
      state = const FeedbackHistoryUiState(
        status: FeedbackHistoryStatus.unavailable,
      );
    } catch (_) {
      if (!mounted) return;
      state = const FeedbackHistoryUiState(status: FeedbackHistoryStatus.failed);
    }
  }

  /// Returns true when the record now shows the correction.
  ///
  /// The row is replaced with what the server returned rather than with an
  /// optimistic guess: the screen shows what is on record, and a failed revoke
  /// leaves the row exactly as it was.
  Future<bool> revoke(String eventId) async {
    if (state.revokingId != null) return false;
    state = state.copyWith(revokingId: eventId, lastRevokeFailed: false);
    try {
      final updated = await service.revoke(eventId);
      if (!mounted) return true;
      state = state.copyWith(
        history: FeedbackHistory(
          rows: [
            for (final row in state.history.rows)
              if (row.id == updated.id) updated else row,
          ],
          baselineNotice: state.history.baselineNotice,
        ),
        clearRevokingId: true,
      );
      return true;
    } catch (_) {
      if (!mounted) return false;
      state = state.copyWith(clearRevokingId: true, lastRevokeFailed: true);
      return false;
    }
  }
}

/// Titles for the items history rows refer to, keyed by commitment id.
///
/// A `FeedbackEvent` carries only a `subjectId` — the contract holds no
/// human-readable field, deliberately, because the event log is not a second
/// copy of the user's commitments. So the title is joined in here from the
/// commitments the app already has. When the item is gone the row says so
/// rather than printing an opaque id at someone and calling it transparency.
final feedbackSubjectTitlesProvider = Provider<Map<String, String>>((ref) {
  final commitments = ref.watch(commitmentsStreamProvider).value ?? const [];
  return {for (final commitment in commitments) commitment.id: commitment.title};
});

final feedbackHistoryControllerProvider =
    StateNotifierProvider<FeedbackHistoryNotifier, FeedbackHistoryUiState>((
      ref,
    ) {
      return FeedbackHistoryNotifier(
        service: ref.watch(feedbackHistoryServiceProvider),
      );
    });
