import 'package:flutter/foundation.dart';

import '../../../models/next_step.dart';

/// Wire shapes for the V03 recommendation, field-for-field with
/// `src/contracts/v1/nextStepContracts.ts`. Nothing here is invented: the
/// backend already emits exactly these keys from `/api/next-step`, and the
/// mobile wrapper is expected to pass them through unchanged.
@immutable
class NextStepExplanationDto {
  final String summary;
  final List<String> evidenceLabels;
  final bool sensitiveInferenceUsed;

  const NextStepExplanationDto({
    required this.summary,
    required this.evidenceLabels,
    required this.sensitiveInferenceUsed,
  });

  factory NextStepExplanationDto.fromJson(Map<String, dynamic> json) {
    final labels = json['evidenceLabels'];
    return NextStepExplanationDto(
      summary: json['summary'] as String? ?? '',
      evidenceLabels: labels is List
          ? labels.whereType<String>().toList(growable: false)
          : const <String>[],
      // Defaults to true so a malformed payload can never silently claim that
      // no sensitive inference was used.
      sensitiveInferenceUsed: json['sensitiveInferenceUsed'] as bool? ?? true,
    );
  }

  NextStepExplanation toDomain() => NextStepExplanation(
    summary: summary,
    evidenceLabels: evidenceLabels,
    sensitiveInferenceUsed: sensitiveInferenceUsed,
  );
}

@immutable
class NextStepPrimaryStepDto {
  final String commitmentId;
  final String title;

  const NextStepPrimaryStepDto({
    required this.commitmentId,
    required this.title,
  });

  factory NextStepPrimaryStepDto.fromJson(Map<String, dynamic> json) =>
      NextStepPrimaryStepDto(
        commitmentId: json['commitmentId'] as String? ?? '',
        title: json['title'] as String? ?? '',
      );

  NextStepPrimaryStep toDomain() =>
      NextStepPrimaryStep(commitmentId: commitmentId, title: title);
}

@immutable
class NextStepRecommendationDto {
  final String proposalId;
  final String state;
  final String locale;
  final NextStepPrimaryStepDto? primaryStep;
  final NextStepExplanationDto? explanation;
  final List<String> availableActions;
  final bool persistenceOccurred;
  final bool confirmationRequired;

  const NextStepRecommendationDto({
    required this.proposalId,
    required this.state,
    required this.locale,
    required this.availableActions,
    required this.persistenceOccurred,
    required this.confirmationRequired,
    this.primaryStep,
    this.explanation,
  });

  factory NextStepRecommendationDto.fromJson(Map<String, dynamic> json) {
    final step = json['primaryStep'];
    final explanation = json['explanation'];
    final actions = json['availableActions'];
    final persistence = json['persistence'];
    return NextStepRecommendationDto(
      proposalId: json['proposalId'] as String? ?? '',
      state: json['state'] as String? ?? 'unknown',
      locale: json['locale'] as String? ?? 'en',
      primaryStep: step is Map<String, dynamic>
          ? NextStepPrimaryStepDto.fromJson(step)
          : null,
      explanation: explanation is Map<String, dynamic>
          ? NextStepExplanationDto.fromJson(explanation)
          : null,
      availableActions: actions is List
          ? actions.whereType<String>().toList(growable: false)
          : const <String>[],
      // Both default to the safe reading: assume nothing was persisted and
      // that confirmation is still required.
      persistenceOccurred: persistence is Map<String, dynamic>
          ? persistence['occurred'] as bool? ?? false
          : false,
      confirmationRequired: persistence is Map<String, dynamic>
          ? persistence['confirmationRequired'] as bool? ?? true
          : true,
    );
  }

  NextStepRecommendation toDomain() => NextStepRecommendation(
    proposalId: proposalId,
    state: NextStepState.fromJsonString(state),
    locale: locale,
    primaryStep: primaryStep?.toDomain(),
    explanation: explanation?.toDomain(),
    availableActions: availableActions
        .map(NextStepDecision.fromJsonString)
        .whereType<NextStepDecision>()
        .toList(growable: false),
    persistenceOccurred: persistenceOccurred,
    confirmationRequired: confirmationRequired,
  );

  /// Round-trips the proposal back to the server on a decision. The server
  /// re-derives the canonical proposal and rejects a stale `proposalId` with
  /// HTTP 409, so this must be echoed exactly as received.
  Map<String, dynamic> toJson() => {
    'proposalId': proposalId,
    'state': state,
    'locale': locale,
    if (primaryStep != null)
      'primaryStep': {
        'commitmentId': primaryStep!.commitmentId,
        'title': primaryStep!.title,
      },
    'availableActions': availableActions,
    'persistence': {
      'occurred': persistenceOccurred,
      'confirmationRequired': confirmationRequired,
    },
  };
}

@immutable
class NextStepDecisionOutcomeDto {
  final String proposalId;
  final String decision;
  final String? editedTitle;
  final String decidedAt;

  const NextStepDecisionOutcomeDto({
    required this.proposalId,
    required this.decision,
    required this.decidedAt,
    this.editedTitle,
  });

  factory NextStepDecisionOutcomeDto.fromJson(Map<String, dynamic> json) =>
      NextStepDecisionOutcomeDto(
        proposalId: json['proposalId'] as String? ?? '',
        decision: json['decision'] as String? ?? '',
        editedTitle: json['editedTitle'] as String?,
        decidedAt: json['decidedAt'] as String? ?? '',
      );

  NextStepDecisionOutcome toDomain() => NextStepDecisionOutcome(
    proposalId: proposalId,
    decision: NextStepDecision.fromJsonString(decision) ?? NextStepDecision.dismiss,
    editedTitle: editedTitle,
    decidedAt: DateTime.tryParse(decidedAt)?.toUtc() ?? DateTime.now().toUtc(),
  );
}
