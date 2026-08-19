import '../../models/pilot_loop_analytics.dart';
import '../contracts/pilot_loop_analytics_service.dart';
import 'api_client.dart';

class ApiPilotLoopAnalyticsService implements PilotLoopAnalyticsService {
  static const path = '/api/mobile/analytics';

  final ApiClient apiClient;

  const ApiPilotLoopAnalyticsService({required this.apiClient});

  @override
  Future<void> record(PilotLoopAnalyticsEvent event) async {
    await apiClient.post(path, event.toJson());
  }
}
