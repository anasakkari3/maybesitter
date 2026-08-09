import '../../models/activity_event.dart';

abstract interface class ActivityRepository {
  Future<List<ActivityEvent>> getActivity();
  Future<void> logEvent(ActivityEvent event);
  Stream<List<ActivityEvent>> watchActivity();
}
