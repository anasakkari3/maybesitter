import '../../models/next_step.dart';
import '../contracts/next_step_service.dart';
import '../contracts/pilot_trust_service.dart';
import 'mock_pilot_trust_service.dart';

/// Mock recommendation source for mock mode and widget tests.
///
/// It reads exposure from the same [MockPilotTrustService] the trust screens
/// use, so a quiet-mode or revoke toggle in a test immediately blocks the
/// recommendation exactly as the server would.
class MockNextStepService implements NextStepService {
  final MockPilotTrustService trustService;

  /// Proposal returned when the pilot is authorised. Null models the `empty`
  /// state — a participant with nothing worth proposing.
  final NextStepRecommendation? proposal;

  /// State reported when [proposal] is null.
  final NextStepState emptyState;

  /// Set to throw a transport failure, for the network-error surface.
  final Object? failWith;

  final List<NextStepDecisionOutcome> recordedDecisions = [];

  /// [proposal] is nullable on purpose: passing null is how a caller models
  /// "the backend had nothing to propose". It therefore must not fall back to
  /// [defaultProposal].
  MockNextStepService({
    required this.trustService,
    this.proposal,
    this.emptyState = NextStepState.empty,
    this.failWith,
  });

  static const defaultProposal = NextStepRecommendation(
    proposalId: 'proposal-mock-1',
    state: NextStepState.ready,
    locale: 'en',
    primaryStep: NextStepPrimaryStep(
      commitmentId: 'commitment-1',
      title: 'Call the vet about the booster shot',
    ),
    explanation: NextStepExplanation(
      summary: 'This is due today and you confirmed it yourself.',
      evidenceLabels: ['due_today', 'confirmed_by_you'],
    ),
    availableActions: [
      NextStepDecision.accept,
      NextStepDecision.edit,
      NextStepDecision.defer,
      NextStepDecision.dismiss,
      NextStepDecision.done,
    ],
  );

  @override
  Future<NextStepResult> getNextStep({
    required String locale,
  }) async {
    if (failWith != null) throw failWith!;
    final snapshot = await trustService.getSnapshot();
    if (!snapshot.exposure.allowed) {
      return NextStepBlocked(snapshot.exposure.reason);
    }
    if (proposal == null) return NextStepUnavailable(emptyState);
    // Serving a ready proposal is what earns first value, matching the server.
    trustService.recordFirstValue(DateTime.now().toUtc());
    return NextStepAvailable(proposal!);
  }

  @override
  Future<NextStepDecisionOutcome> recordDecision({
    required NextStepRecommendation recommendation,
    required NextStepDecision decision,
    required String idempotencyKey,
    required String locale,
    String? editedTitle,
  }) async {
    if (failWith != null) throw failWith!;
    final snapshot = await trustService.getSnapshot();
    if (!snapshot.exposure.allowed) {
      throw PilotNotAdmittedException(snapshot.exposure.reason);
    }
    if (recommendation.proposalId != proposal?.proposalId) {
      throw const StaleProposalException();
    }
    final outcome = NextStepDecisionOutcome(
      proposalId: recommendation.proposalId,
      decision: decision,
      editedTitle: editedTitle,
      decidedAt: DateTime.now().toUtc(),
    );
    recordedDecisions.add(outcome);
    return outcome;
  }
}
