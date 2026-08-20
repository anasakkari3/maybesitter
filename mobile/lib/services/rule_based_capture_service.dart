import '../models/capture_result.dart';
import 'api/dtos/proposal_dtos.dart';
import 'contracts/capture_service.dart';
import 'rule_based_extractor.dart';

/// Turns what the user wrote into proposed commitments, on the device.
///
/// This replaces a stub that read nothing: it answered every input with one
/// commitment, tomorrow, 10:00, "should", titled by truncating the raw text at
/// thirty-seven characters. Three intentions in one sentence became one, a
/// stated hour became 10:00, and "لازم" became "should".
///
/// Nothing here saves anything. The result is always a proposal the user
/// reviews and confirms, which is the boundary the product promises: no
/// captured text becomes a commitment without the person agreeing to it.
class RuleBasedCaptureService implements CaptureService {
  final RuleBasedExtractor extractor;
  final DateTime Function() now;

  RuleBasedCaptureService({
    this.extractor = const RuleBasedExtractor(),
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;

  @override
  Future<CaptureResult> capture(CaptureRequest request) async {
    final at = request.capturedAt;
    final commitments = extractor.extract(request.rawInput, now: at);
    final requestId = 'cap-${at.microsecondsSinceEpoch}';

    if (commitments.isEmpty) {
      return CaptureResult(
        requestId: requestId,
        scopeId: request.scopeId ?? 'default',
        rawInput: request.rawInput,
        status: CaptureStatus.needsConfirmation,
        confidence: ExtractionConfidence.low,
        extractedCommitments: const [],
        analysisNote: 'No commitment was found in this text.',
      );
    }

    // A commitment with no date is not a failure to understand -- the person
    // may not have said one. It is surfaced for review like everything else,
    // and the review screen is where a date can be given.
    final undated = commitments.where((c) => c.scheduledDate == null).length;

    return CaptureResult(
      requestId: requestId,
      // No proposalId on purpose: extraction happened here, not on a server,
      // so there is no remote proposal to confirm. Confirmation writes to the
      // local repository, which is the path a device with no backend takes.
      scopeId: request.scopeId ?? 'default',
      rawInput: request.rawInput,
      status: CaptureStatus.needsConfirmation,
      confidence: undated == commitments.length
          ? ExtractionConfidence.medium
          : ExtractionConfidence.high,
      extractedCommitments: commitments,
    );
  }

  @override
  Future<ConfirmProposalResponseDto> confirmProposal({
    required String proposalId,
    required String scopeId,
    required List<String> itemIds,
    DateTime? referenceTime,
  }) async {
    final at = referenceTime ?? now();
    return ConfirmProposalResponseDto(
      success: true,
      persisted: itemIds
          .map(
            (id) => PersistedProposalItemDto(
              itemId: id,
              commitmentId: id,
              title: '',
              resolvedTime: at.toIso8601String(),
            ),
          )
          .toList(growable: false),
      failed: const [],
    );
  }
}
