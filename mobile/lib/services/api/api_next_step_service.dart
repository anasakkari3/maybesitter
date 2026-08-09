import '../../models/next_step.dart';
import '../../models/pilot_trust.dart';
import '../contracts/next_step_service.dart';
import 'api_client.dart';
import 'dtos/next_step_dtos.dart';

/// Talks to the mobile recommendation endpoint.
///
/// Endpoint shape is specified in
/// `docs/architecture/V03_FLUTTER_PILOT_CONTRACT.md`. Participant identity is
/// the bearer token injected by [ApiClient]; this service never sends
/// participant ids or experiment assignment fields.
class ApiNextStepService implements NextStepService {
  static const recommendationPath = '/api/mobile/recommendations/next-step';
  static const actionPath = '/api/mobile/recommendations/next-step/actions';

  final ApiClient apiClient;

  const ApiNextStepService({required this.apiClient});

  @override
  Future<NextStepResult> getNextStep({
    required String locale,
  }) async {
    try {
      final json = await apiClient.get(
        recommendationPath,
        queryParameters: {'locale': locale},
      );
      final envelope = NextStepRecommendationEnvelopeDto.fromJson(json);
      final recommendation = envelope.recommendation.toDomain();
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
    required NextStepRecommendation recommendation,
    required NextStepDecision decision,
    required String idempotencyKey,
    required String locale,
    String? editedTitle,
  }) async {
    // The proposal is echoed verbatim. The server re-derives its own canonical
    // proposal and compares proposalId, so a decision can never be applied to a
    // step the participant is no longer looking at.
    final body = <String, dynamic>{
      'locale': locale,
      'decision': decision.toJsonString(),
      'idempotencyKey': idempotencyKey,
      'proposal': _toWire(recommendation),
      if (editedTitle != null) 'editedTitle': editedTitle,
    };
    try {
      final json = await apiClient.post(actionPath, body);
      return NextStepDecisionActionEnvelopeDto.fromJson(json).outcome.toDomain();
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
