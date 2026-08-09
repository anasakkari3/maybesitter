import 'package:flutter/foundation.dart';
import '../../../models/capture_result.dart';
import '../../../models/commitment.dart';
import '../dtos/proposal_dtos.dart';
import 'backend_time_mapper.dart';

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
    bool invalidDateFlag = false;

    if (dto.needsClarification) {
      date = null;
    } else if (dto.resolvedTime != null && dto.resolvedTime!.isNotEmpty) {
      try {
        final parsed = BackendTimeMapper.parseAbsoluteIsoToLocal(
          dto.resolvedTime!,
        );
        date = parsed;
        timeStr = BackendTimeMapper.formatLocalClock(parsed);
      } catch (e) {
        invalidDateFlag = true;
        date = null;
        if (kDebugMode) {
          debugPrint(
            '[ProposalMapper] Invalid date string "${dto.resolvedTime}" for proposed item ${dto.itemId}: $e',
          );
        }
      }
    }

    return Commitment(
      id: dto.itemId,
      title: dto.title,
      scheduledDate: date,
      startTime: timeStr,
      priority: _mapPriorityLevel(dto.priorityLevel),
      status: CommitmentStatus.pending,
      needsClarification: dto.needsClarification,
      hasInvalidDate: invalidDateFlag,
    );
  }

  static CommitmentPriority _mapPriorityLevel(String? level) {
    switch (level?.toLowerCase()) {
      case 'high':
      case 'must':
        return CommitmentPriority.must;
      case 'low':
      case 'nice':
        return CommitmentPriority.nice;
      case 'normal':
      case 'should':
      default:
        return CommitmentPriority.should;
    }
  }
}
