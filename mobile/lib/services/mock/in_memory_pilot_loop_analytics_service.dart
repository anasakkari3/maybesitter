import '../../models/pilot_loop_analytics.dart';
import '../contracts/pilot_loop_analytics_service.dart';

class DisabledPilotLoopAnalyticsService implements PilotLoopAnalyticsService {
  const DisabledPilotLoopAnalyticsService();

  @override
  Future<void> record(PilotLoopAnalyticsEvent event) async {}
}

class InMemoryPilotLoopAnalyticsService implements PilotLoopAnalyticsService {
  final List<PilotLoopAnalyticsEvent> events = [];

  @override
  Future<void> record(PilotLoopAnalyticsEvent event) async {
    event.toJson();
    events.add(event);
  }
}
