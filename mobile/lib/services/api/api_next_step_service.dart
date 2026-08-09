import '../../models/next_step.dart';
import '../../models/pilot_trust.dart';
import '../contracts/next_step_service.dart';
import 'api_client.dart';
import 'dtos/next_step_dtos.dart';

/// Talks to the mobile recommendation endpoint.
///
/// Endpoint shape is specified in
/// `docs/architecture/V03_FLUTTER_PILOT_CONTRACT.md` and is a thin,
/// participant-bound wrapper over the existing `/api/next-step` handler — the
/// response body is the unchanged `NextStepRecommendationContract`.
class ApiNextStepService implements NextStepService {
  static const recommendationPath = '/api/mobile/recommendation';

  final ApiClient apiClient;

  const ApiNextStepService({required this.apiClient});

  @override
  Future<NextStepResult> getNextStep({
    required String participantId,
    required String locale,
  }) async {
    try {
      final json = await apiClient.get(
        recommendationPath,
        queryParameters: {'participantId': participantId, 'locale': locale},
      );
      final recommendation = NextStepRecommendationDto.fromJson(json).toDomain();
      if (recommendation.isActionable) {
        return NextStepAvailable(recommendation);
      }
      return NextStepUnavailable(recommendation.state);
    } on ForbiddenException catch (error) {
      return NextStepBlocked(PilotStopReason.fromJsonString(error.reason));
    }
  }

  @override
  Future<NextStepDecisionOutcome> recordDecision({
    required String participantId,
    required NextStepRecommendation recommendation,
    required NextStepDecision decision,
    required String locale,
    String? editedTitle,
  }) async {
    // The proposal is echoed verbatim. The server re-derives its own canonical
    // proposal and compares proposalId, so a decision can never be applied to a
    // step the participant is no longer looking at.
    final body = <String, dynamic>{
      'participantId': participantId,
      'locale': locale,
      'decision': decision.toJsonString(),
      'proposal': _toWire(recommendation),
      if (editedTitle != null) 'editedTitle': editedTitle,
    };
    try {
      final json = await apiClient.post(recommendationPath, body);
      return NextStepDecisionOutcomeDto.fromJson(json).toDomain();
    } on ConflictException catch (error) {
      throw StaleProposalException(error.message);
    }
  }

  Map<String, dynamic> _toWire(NextStepRecommendation recommendation) =>
      NextStepRecommendationDto(
        proposalId: recommendation.proposalId,
        state: recommendation.state == NextStepState.ready
            ? 'ready'
            : recommendation.state.name,
        locale: recommendation.locale,
        primaryStep: recommendation.primaryStep == null
            ? null
            : NextStepPrimaryStepDto(
                commitmentId: recommendation.primaryStep!.commitmentId,
                title: recommendation.primaryStep!.title,
              ),
        availableActions: recommendation.availableActions
            .map((action) => action.toJsonString())
            .toList(growable: false),
        persistenceOccurred: recommendation.persistenceOccurred,
        confirmationRequired: recommendation.confirmationRequired,
      ).toJson();
}
