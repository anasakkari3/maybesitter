import '../../models/capture_result.dart';
import '../api/dtos/proposal_dtos.dart';

abstract interface class CaptureService {
  Future<CaptureResult> capture(CaptureRequest request);

  Future<ConfirmProposalResponseDto> confirmProposal({
    required String proposalId,
    required String scopeId,
    required List<String> itemIds,
    DateTime? referenceTime,
  });
}
