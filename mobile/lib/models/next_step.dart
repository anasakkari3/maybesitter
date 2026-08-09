import 'package:flutter/foundation.dart';

/// The V03 one-next-step proposal, as the participant sees it.
///
/// Mirrors `src/contracts/v1/nextStepContracts.ts`. Two invariants from that
/// contract are load-bearing here and are asserted in tests:
///
///  * at most **one** primary step is ever proposed;
///  * the proposal has **not** been persisted — `persistence.occurred` is
///    always false and confirmation is always required. The UI must never
///    imply the app already changed anything.
///
/// The contract deliberately carries no experiment-arm field. Assignment is
/// backend-controlled and must stay invisible to the participant.
enum NextStepState {
  ready,
  empty,
  insufficientEvidence,
  unknown;

  static NextStepState fromJsonString(String? value) {
    switch (value) {
      case 'ready':
        return NextStepState.ready;
      case 'empty':
        return NextStepState.empty;
      case 'insufficient_evidence':
        return NextStepState.insufficientEvidence;
      default:
        return NextStepState.unknown;
    }
  }
}

enum NextStepDecision {
  accept,
  edit,
  defer,
  dismiss,
  done;

  static NextStepDecision? fromJsonString(String? value) {
    switch (value) {
      case 'accept':
        return NextStepDecision.accept;
      case 'edit':
        return NextStepDecision.edit;
      case 'defer':
        return NextStepDecision.defer;
      case 'dismiss':
        return NextStepDecision.dismiss;
      case 'done':
        return NextStepDecision.done;
      default:
        return null;
    }
  }

  String toJsonString() => name;
}

@immutable
class NextStepExplanation {
  /// One short sentence. Never a command, never guilt-framed.
  final String summary;

  /// Privacy-safe evidence labels, e.g. `due_today`, `confirmed_by_you`.
  /// These are codes the UI localises; they never contain user text.
  final List<String> evidenceLabels;

  /// Always false in V03. Surfaced so the UI can state it positively.
  final bool sensitiveInferenceUsed;

  const NextStepExplanation({
    required this.summary,
    required this.evidenceLabels,
    this.sensitiveInferenceUsed = false,
  });
}

@immutable
class NextStepPrimaryStep {
  final String commitmentId;
  final String title;

  const NextStepPrimaryStep({required this.commitmentId, required this.title});
}

@immutable
class NextStepRecommendation {
  final String proposalId;
  final NextStepState state;
  final String locale;
  final NextStepPrimaryStep? primaryStep;
  final NextStepExplanation? explanation;
  final List<NextStepDecision> availableActions;

  /// False for the whole of V03: the model proposes, it never persists.
  final bool persistenceOccurred;
  final bool confirmationRequired;

  const NextStepRecommendation({
    required this.proposalId,
    required this.state,
    required this.locale,
    this.primaryStep,
    this.explanation,
    this.availableActions = const [],
    this.persistenceOccurred = false,
    this.confirmationRequired = true,
  });

  /// A proposal is only showable when the backend said `ready` *and* actually
  /// gave us a step. Anything else is an empty or degraded state — never a
  /// half-rendered card.
  bool get isActionable =>
      state == NextStepState.ready && primaryStep != null;

  bool allows(NextStepDecision decision) => availableActions.contains(decision);
}

@immutable
class NextStepDecisionOutcome {
  final String proposalId;
  final NextStepDecision decision;
  final String? editedTitle;
  final DateTime decidedAt;

  const NextStepDecisionOutcome({
    required this.proposalId,
    required this.decision,
    required this.decidedAt,
    this.editedTitle,
  });
}
