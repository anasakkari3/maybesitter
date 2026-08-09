import '../../models/capture_result.dart';
import '../contracts/capture_service.dart';
import 'api_client.dart';
import 'dtos/proposal_dtos.dart';
import 'mappers/proposal_mapper.dart';

class ApiCaptureService implements CaptureService {
  final ApiClient apiClient;
  final String defaultScopeId;
  final String defaultTimezone;

  ApiCaptureService({
    required this.apiClient,
    this.defaultScopeId = 'default',
    this.defaultTimezone = 'Asia/Jerusalem',
  });

  @override
  Future<CaptureResult> capture(CaptureRequest request) async {
    try {
      final payload = {
        'text': request.rawInput,
        'referenceTime': request.capturedAt.toIso8601String(),
        'timezone': request.timezone ?? defaultTimezone,
        'scopeId': request.scopeId ?? defaultScopeId,
      };

      final responseJson = await apiClient.post('/api/mobile/capture', payload);
      final proposalDto = CaptureProposalResponseDto.fromJson(responseJson);

      return ProposalMapper.mapToDomain(
        dto: proposalDto,
        rawInput: request.rawInput,
      );
    } on ApiException catch (e) {
      return CaptureResult(
        requestId: 'err-${DateTime.now().millisecondsSinceEpoch}',
        rawInput: request.rawInput,
        status: e is ValidationException
            ? CaptureStatus.validationError
            : CaptureStatus.extractionFailed,
        errorMessage: e.message,
      );
    } catch (e) {
      return CaptureResult(
        requestId: 'err-${DateTime.now().millisecondsSinceEpoch}',
        rawInput: request.rawInput,
        status: CaptureStatus.networkError,
        errorMessage: 'Network error: $e',
      );
    }
  }

  @override
  Future<ConfirmProposalResponseDto> confirmProposal({
    required String proposalId,
    required String scopeId,
    required List<String> itemIds,
    DateTime? referenceTime,
  }) async {
    final payload = {
      'proposalId': proposalId,
      'scopeId': scopeId.isNotEmpty ? scopeId : defaultScopeId,
      'itemIds': itemIds,
      if (referenceTime != null)
        'referenceTime': referenceTime.toIso8601String(),
    };

    try {
      final responseJson = await apiClient.post(
        '/api/mobile/capture/confirm',
        payload,
      );
      return ConfirmProposalResponseDto.fromJson(responseJson);
    } on ApiException catch (e) {
      return ConfirmProposalResponseDto(
        success: false,
        persisted: const [],
        failed: itemIds
            .map((id) => FailedProposalItemDto(itemId: id, reason: e.message))
            .toList(),
      );
    } catch (e) {
      return ConfirmProposalResponseDto(
        success: false,
        persisted: const [],
        failed: itemIds
            .map(
              (id) => FailedProposalItemDto(itemId: id, reason: e.toString()),
            )
            .toList(),
      );
    }
  }
}
