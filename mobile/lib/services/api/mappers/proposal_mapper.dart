import 'package:intl/intl.dart';
import '../../../models/capture_result.dart';
import '../../../models/commitment.dart';
import '../dtos/proposal_dtos.dart';

class ProposalMapper {
  static CaptureResult mapToDomain({
    required CaptureProposalResponseDto dto,
    required String rawInput,
  }) {
    final domainStatus = _mapStatus(dto.status);
    final domainCommitments = dto.items
        .map((item) => _mapItemToCommitment(item))
        .toList();

    return CaptureResult(
      requestId: dto.proposalId,
      proposalId: dto.proposalId,
      rawInput: rawInput,
      status: domainStatus,
      extractedCommitments: domainCommitments,
      confidence: dto.status == ProposalStatusDto.proposed
          ? ExtractionConfidence.high
          : ExtractionConfidence.medium,
      clarificationPrompt: dto.status == ProposalStatusDto.needsClarification
          ? 'Additional details are needed to confirm your intent.'
          : null,
      clarificationOptions: dto.status == ProposalStatusDto.needsClarification
          ? [
              const ClarificationOption(
                id: 'opt-1',
                text: 'Confirm as proposed',
                actionType: 'CONFIRM',
              ),
            ]
          : const [],
      errorMessage: dto.status == ProposalStatusDto.extractionFailed
          ? 'Unable to extract commitments from this input.'
          : (dto.status == ProposalStatusDto.unknown
                ? 'Unknown server response status.'
                : null),
    );
  }

  static CaptureStatus _mapStatus(ProposalStatusDto dtoStatus) {
    switch (dtoStatus) {
      case ProposalStatusDto.proposed:
        return CaptureStatus.needsConfirmation;
      case ProposalStatusDto.needsClarification:
        return CaptureStatus.needsClarification;
      case ProposalStatusDto.noCommitment:
        return CaptureStatus.noCommitment;
      case ProposalStatusDto.unsupportedRequest:
        return CaptureStatus.unsupportedRequest;
      case ProposalStatusDto.extractionFailed:
        return CaptureStatus.extractionFailed;
      case ProposalStatusDto.unknown:
        return CaptureStatus.extractionFailed;
    }
  }

  static Commitment _mapItemToCommitment(ProposedItemViewDto dto) {
    DateTime? date;
    String? timeStr;

    if (dto.resolvedTime != null && dto.resolvedTime!.isNotEmpty) {
      try {
        final parsed = DateTime.parse(dto.resolvedTime!);
        date = parsed;
        timeStr = DateFormat('hh:mm a').format(parsed);
      } catch (_) {
        // Fallback to null
      }
    }

    final fallbackNow = DateTime.now();
    final tomorrow = DateTime(
      fallbackNow.year,
      fallbackNow.month,
      fallbackNow.day,
    ).add(const Duration(days: 1));

    return Commitment(
      id: dto.itemId,
      title: dto.title,
      scheduledDate: date ?? tomorrow,
      startTime: timeStr,
      priority: CommitmentPriority.must,
      status: CommitmentStatus.pending,
    );
  }
}
