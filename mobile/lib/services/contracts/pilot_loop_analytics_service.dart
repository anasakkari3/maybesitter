import '../../models/pilot_loop_analytics.dart';

abstract interface class PilotLoopAnalyticsService {
  Future<void> record(PilotLoopAnalyticsEvent event);
}
