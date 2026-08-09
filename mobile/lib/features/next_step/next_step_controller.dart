import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/next_step.dart';
import '../../models/pilot_trust.dart';
import '../../services/api/api_client.dart';
import '../../services/contracts/next_step_service.dart';
import '../../services/contracts/pilot_trust_service.dart';
import '../../services/providers.dart';
import '../trust/pilot_trust_controller.dart';

enum NextStepStatus {
  /// Nothing requested yet.
  idle,
  loading,

  /// A proposal is on screen awaiting the participant's decision.
  ready,

  /// Backend had nothing to propose, or not enough evidence yet.
  unavailable,

  /// Pilot exposure refused — [NextStepUiState.blockedReason] says why.
  blocked,

  /// A decision is in flight.
  submitting,

  /// The decision was recorded and acknowledged.
  decided,

  /// Transport or server failure. Retryable.
  failed,
}

class NextStepUiState {
  final NextStepStatus status;
  final NextStepRecommendation? recommendation;
  final NextStepState? unavailableState;
  final PilotStopReason? blockedReason;

  /// The decision the participant just made, held so the UI can acknowledge it
  /// without pretending it happened before the server confirmed.
  final NextStepDecision? lastDecision;
  final bool staleProposal;

  const NextStepUiState({
    this.status = NextStepStatus.idle,
    this.recommendation,
    this.unavailableState,
    this.blockedReason,
    this.lastDecision,
    this.staleProposal = false,
  });

  bool get isBusy =>
      status == NextStepStatus.loading || status == NextStepStatus.submitting;

  NextStepUiState copyWith({
    NextStepStatus? status,
    NextStepRecommendation? recommendation,
    NextStepState? unavailableState,
    PilotStopReason? blockedReason,
    NextStepDecision? lastDecision,
    bool? staleProposal,
    bool clearRecommendation = false,
  }) => NextStepUiState(
    status: status ?? this.status,
    recommendation: clearRecommendation
        ? null
        : (recommendation ?? this.recommendation),
    unavailableState: unavailableState ?? this.unavailableState,
    blockedReason: blockedReason ?? this.blockedReason,
    lastDecision: lastDecision ?? this.lastDecision,
    staleProposal: staleProposal ?? this.staleProposal,
  );
}

class NextStepNotifier extends StateNotifier<NextStepUiState> {
  final NextStepService service;
  final String participantId;

  /// Invoked when something happened that may have changed trust state — a
  /// served proposal (first value) or a recorded decision.
  final void Function()? onTrustMayHaveChanged;

  NextStepNotifier({
    required this.service,
    required this.participantId,
    this.onTrustMayHaveChanged,
  }) : super(const NextStepUiState());

  Future<void> load({required String locale}) async {
    state = state.copyWith(
      status: NextStepStatus.loading,
      staleProposal: false,
    );
    try {
      final result = await service.getNextStep(
        participantId: participantId,
        locale: locale,
      );
      // The card requests on the first frame, so a widget torn down mid-flight
      // must not write state back.
      if (!mounted) return;
      switch (result) {
        case NextStepAvailable(:final recommendation):
          state = NextStepUiState(
            status: NextStepStatus.ready,
            recommendation: recommendation,
          );
          // Serving a proposal can be what records first value server-side,
          // which is what unlocks the calendar step of the ladder.
          onTrustMayHaveChanged?.call();
        case NextStepUnavailable(state: final unavailable):
          state = NextStepUiState(
            status: NextStepStatus.unavailable,
            unavailableState: unavailable,
          );
        case NextStepBlocked(:final reason):
          state = NextStepUiState(
            status: NextStepStatus.blocked,
            blockedReason: reason,
          );
      }
    } on PilotNotAdmittedException catch (error) {
      if (!mounted) return;
      state = NextStepUiState(
        status: NextStepStatus.blocked,
        blockedReason: error.reason,
      );
    } on ApiException {
      if (!mounted) return;
      state = const NextStepUiState(status: NextStepStatus.failed);
    } catch (_) {
      if (!mounted) return;
      state = const NextStepUiState(status: NextStepStatus.failed);
    }
  }

  /// Records one participant decision. [editedTitle] is only meaningful for
  /// [NextStepDecision.edit].
  Future<void> decide(
    NextStepDecision decision, {
    required String locale,
    String? editedTitle,
  }) async {
    final recommendation = state.recommendation;
    if (recommendation == null) return;
    if (!recommendation.allows(decision)) return;

    state = state.copyWith(status: NextStepStatus.submitting);
    try {
      await service.recordDecision(
        participantId: participantId,
        recommendation: recommendation,
        decision: decision,
        locale: locale,
        editedTitle: editedTitle,
      );
      if (!mounted) return;
      state = NextStepUiState(
        status: NextStepStatus.decided,
        lastDecision: decision,
      );
      // A decision changes canonical state, so the trust view's confirmed
      // commitment count may no longer be accurate.
      onTrustMayHaveChanged?.call();
    } on StaleProposalException {
      if (!mounted) return;
      // The proposal moved on. Reload rather than re-posting against a step
      // the participant is no longer looking at.
      state = state.copyWith(
        status: NextStepStatus.ready,
        staleProposal: true,
      );
      await load(locale: locale);
      if (!mounted) return;
      state = state.copyWith(staleProposal: true);
    } on PilotNotAdmittedException catch (error) {
      if (!mounted) return;
      state = NextStepUiState(
        status: NextStepStatus.blocked,
        blockedReason: error.reason,
      );
    } catch (_) {
      if (!mounted) return;
      state = state.copyWith(status: NextStepStatus.failed);
    }
  }

  /// Returns to a fresh proposal after an acknowledged decision.
  Future<void> next({required String locale}) => load(locale: locale);
}

final nextStepControllerProvider =
    StateNotifierProvider<NextStepNotifier, NextStepUiState>((ref) {
      return NextStepNotifier(
        service: ref.watch(nextStepServiceProvider),
        participantId: ref.watch(appConfigProvider).participantId,
        onTrustMayHaveChanged: () => ref.invalidate(pilotTrustControllerProvider),
      );
    });
