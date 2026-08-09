import '../../models/next_step.dart';
import '../../models/pilot_trust.dart';

/// Result of asking for the current next-step proposal.
///
/// A blocked pilot is a first-class result, not an error: the participant is
/// entitled to a clear explanation of *why* nothing is being proposed.
sealed class NextStepResult {
  const NextStepResult();
}

class NextStepAvailable extends NextStepResult {
  final NextStepRecommendation recommendation;
  const NextStepAvailable(this.recommendation);
}

/// The backend returned a proposal that is not showable — `empty` (nothing to
/// propose) or `insufficient_evidence` (not enough confirmed commitments yet).
class NextStepUnavailable extends NextStepResult {
  final NextStepState state;
  const NextStepUnavailable(this.state);
}

/// Pilot exposure was refused. [reason] drives which pilot state screen the
/// participant sees.
class NextStepBlocked extends NextStepResult {
  final PilotStopReason reason;
  const NextStepBlocked(this.reason);
}

abstract class NextStepService {
  /// Fetches the single current proposal for the authenticated pilot token.
  Future<NextStepResult> getNextStep({
    required String locale,
  });

  /// Records the participant's decision. The [recommendation] is echoed back so
  /// the server can reject a stale proposal rather than acting on a step the
  /// participant is no longer looking at.
  Future<NextStepDecisionOutcome> recordDecision({
    required NextStepRecommendation recommendation,
    required NextStepDecision decision,
    required String idempotencyKey,
    required String locale,
    String? editedTitle,
  });
}

/// Thrown when the server rejects a decision because the proposal moved on.
/// The UI reloads rather than retrying blindly.
class StaleProposalException implements Exception {
  final String message;
  const StaleProposalException([this.message = 'proposal is stale or invalid']);

  @override
  String toString() => 'StaleProposalException: $message';
}
