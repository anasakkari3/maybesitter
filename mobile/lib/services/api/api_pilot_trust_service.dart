import '../../models/pilot_trust.dart';
import '../contracts/pilot_trust_service.dart';
import 'api_client.dart';
import 'dtos/pilot_trust_dtos.dart';

/// Talks to the mobile trust endpoint. Participant identity is the bearer token
/// injected by [ApiClient], never a query or body field.
class ApiPilotTrustService implements PilotTrustService {
  static const trustPath = '/api/mobile/pilot/trust';

  final ApiClient apiClient;

  const ApiPilotTrustService({required this.apiClient});

  @override
  Future<PilotTrustSnapshot> getSnapshot() async {
    try {
      final json = await apiClient.get(trustPath);
      return PilotTrustSnapshotDto.fromJson(json).toDomain();
    } on ForbiddenException catch (error) {
      throw PilotNotAdmittedException(
        PilotStopReason.fromJsonString(error.reason),
      );
    }
  }

  @override
  Future<PilotTrustSnapshot> apply({
    required PilotTrustAction action,
  }) async {
    try {
      final json = await apiClient.post(trustPath, {'action': action.toJson()});
      return PilotTrustSnapshotDto.fromJson(json).toDomain();
    } on ForbiddenException catch (error) {
      throw PilotNotAdmittedException(
        PilotStopReason.fromJsonString(error.reason),
      );
    }
  }
}
