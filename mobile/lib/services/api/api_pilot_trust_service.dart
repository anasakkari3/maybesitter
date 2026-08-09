import '../../models/pilot_trust.dart';
import '../contracts/pilot_trust_service.dart';
import 'api_client.dart';
import 'dtos/pilot_trust_dtos.dart';

/// Talks to the mobile trust endpoint — a participant-bound wrapper over the
/// existing `/api/pilot/trust` handler, returning the unchanged
/// `{ trust, exposure, whatKnows }` body.
class ApiPilotTrustService implements PilotTrustService {
  static const trustPath = '/api/mobile/trust';

  final ApiClient apiClient;

  const ApiPilotTrustService({required this.apiClient});

  @override
  Future<PilotTrustSnapshot> getSnapshot({
    required String participantId,
  }) async {
    try {
      final json = await apiClient.get(
        trustPath,
        queryParameters: {'participantId': participantId},
      );
      return PilotTrustSnapshotDto.fromJson(json).toDomain();
    } on ForbiddenException catch (error) {
      throw PilotNotAdmittedException(
        PilotStopReason.fromJsonString(error.reason),
      );
    }
  }

  @override
  Future<PilotTrustSnapshot> apply({
    required String participantId,
    required PilotTrustAction action,
  }) async {
    try {
      final json = await apiClient.post(trustPath, {
        'participantId': participantId,
        'action': action.toJson(),
      });
      return PilotTrustSnapshotDto.fromJson(json).toDomain();
    } on ForbiddenException catch (error) {
      throw PilotNotAdmittedException(
        PilotStopReason.fromJsonString(error.reason),
      );
    }
  }
}
