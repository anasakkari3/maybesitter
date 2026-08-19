import 'dart:async';
import '../../models/activity_event.dart';
import '../contracts/activity_repository.dart';

class MockActivityRepository implements ActivityRepository {
  final List<ActivityEvent> _events = [];
  final _controller = StreamController<List<ActivityEvent>>.broadcast();

  MockActivityRepository() {
    _seedInitialEvents();
  }

  void _seedInitialEvents() {
    final now = DateTime.now();
    _events.addAll([
      ActivityEvent(
        id: 'act-1',
        type: ActivityEventType.aiCaptureExtracted,
        title: 'Plan Extracted by AI',
        description: 'Extracted 3 commitments from voice note.',
        timestamp: now.subtract(const Duration(hours: 2)),
      ),
      ActivityEvent(
        id: 'act-2',
        type: ActivityEventType.commitmentCompleted,
        title: 'Commitment Completed',
        description: 'Completed "Check water filter".',
        timestamp: now.subtract(const Duration(hours: 5)),
      ),
      ActivityEvent(
        id: 'act-3',
        type: ActivityEventType.commitmentCreated,
        title: 'Commitment Created',
        description: 'Added "Pet-Sitter Briefing" for today.',
        timestamp: now.subtract(const Duration(days: 1)),
      ),
    ]);
    _notify();
  }

  void _notify() {
    _controller.add(List.unmodifiable(_events));
  }

  @override
  Future<List<ActivityEvent>> getActivity() async {
    return List.unmodifiable(_events);
  }

  @override
  Future<void> logEvent(ActivityEvent event) async {
    _events.insert(0, event);
    _notify();
  }

  @override
  Stream<List<ActivityEvent>> watchActivity() async* {
    // The current list first, then every later change.
    //
    // This used to return the broadcast stream alone. The constructor seeds
    // three events and emits them before anything has subscribed, and a
    // broadcast stream does not replay to a late subscriber — so the Activity
    // screen, which subscribes when it is first built, received nothing and
    // showed "No Activity Yet" over a repository that was not empty.
    yield List.unmodifiable(_events);
    yield* _controller.stream;
  }
}
