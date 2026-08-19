/// The daily loop, end to end, through real collaborators.
///
/// Each piece has its own tests. These exercise the sequence a person actually
/// lives: something gets captured, a reminder is scheduled, the user answers it
/// or ignores it, and what is still owed changes accordingly.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_activity_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/native_notification_service.dart';
import 'package:maybesitter_mobile/services/notification_action_router.dart';
import 'package:maybesitter_mobile/services/soft_awareness_reminder_engine.dart';

const _flags = PilotPresenceFeatureFlags(
  widget: true,
  voice: true,
  awareness: true,
  watch: false,
  imports: false,
);

const _escalating = ReminderPolicy(
  maxIntensity: ReminderIntensity.strongReminder,
  strongRemindersRequireExplicitOptIn: false,
);

class _Loop {
  final MockNotificationService notifications;
  final InMemoryAwarenessStateStore awareness;
  final InMemoryCommitmentRepository repository;
  final SoftAwarenessReminderEngine engine;
  final NotificationActionRouter router;
  final DateTime now;

  _Loop._({
    required this.notifications,
    required this.awareness,
    required this.repository,
    required this.engine,
    required this.router,
    required this.now,
  });

  static Future<_Loop> start({
    ReminderPolicy policy = _escalating,
    UserRoutineProfile? profile,
  }) async {
    final now = DateTime(2026, 8, 19, 8);
    final notifications = MockNotificationService(
      initialPermissionState: NotificationPermissionState.granted,
    );
    final awareness = InMemoryAwarenessStateStore();
    final repository = InMemoryCommitmentRepository();
    await repository.ready;
    await repository.saveAll(const []);

    final dispatcher = SoftAwarenessCommandDispatcher(
      commitmentRepository: repository,
      notificationService: notifications,
      activityRepository: MockActivityRepository(),
      awarenessStateStore: awareness,
      flags: _flags,
    );

    return _Loop._(
      notifications: notifications,
      awareness: awareness,
      repository: repository,
      engine: SoftAwarenessReminderEngine(
        notificationService: notifications,
        reminderPolicy: () => policy,
        routineProfile: () => profile,
        notificationsEnabled: () => true,
        flags: () => _flags,
        awarenessStateStore: awareness,
        now: () => now,
      ),
      router: NotificationActionRouter(dispatcher: dispatcher),
      now: now,
    );
  }

  Commitment capture({
    required String id,
    required CommitmentPriority priority,
    String startTime = '10:30',
  }) => Commitment(
    id: id,
    title: 'Captured commitment',
    scheduledDate: DateTime(2026, 8, 19),
    startTime: startTime,
    priority: priority,
  );

  Future<void> sync(List<Commitment> commitments) async {
    await repository.saveAll(commitments);
    await engine.syncCommitments(commitments);
  }

  Future<void> press(
    NotificationActionType action,
    String commitmentId, {
    Duration after = const Duration(minutes: 91),
  }) => router.handle(
    NativeNotificationActionEvent(
      commitmentId: commitmentId,
      notificationId: NativeNotificationService.platformIdFor(
        commitmentId,
      ).toString(),
      action: action,
      occurredAt: now.add(after),
    ),
  );

  List<ReminderIntensity> pendingFor(String id) => notifications
      .requestsFor(id)
      .map((request) => request.intensity)
      .toList();
}

void main() {
  group('capture, remind, acknowledge, do not escalate', () {
    test('an acknowledged must commitment loses its escalation', () async {
      final loop = await _Loop.start();
      final exam = loop.capture(id: 'exam', priority: CommitmentPriority.must);

      await loop.sync([exam]);
      expect(
        loop.pendingFor('exam'),
        containsAll([
          ReminderIntensity.softAwareness,
          ReminderIntensity.strongReminder,
        ]),
        reason: 'a must commitment is reminded, then escalated',
      );

      await loop.press(NotificationActionType.aware, 'exam');
      await loop.sync([exam]);

      expect(loop.pendingFor('exam'), isEmpty);
      final stored = await loop.repository.getById('exam');
      expect(
        stored!.status.isCompleted,
        isFalse,
        reason: 'knowing about it is not doing it',
      );
    });
  });

  group('capture, remind, ignore, escalate', () {
    test('an unacknowledged must commitment keeps its escalation', () async {
      final loop = await _Loop.start();
      final exam = loop.capture(id: 'exam', priority: CommitmentPriority.must);

      await loop.sync([exam]);
      await loop.sync([exam]);

      expect(
        loop.pendingFor('exam'),
        contains(ReminderIntensity.strongReminder),
      );
    });

    test('a nice commitment is never escalated, acknowledged or not', () async {
      final loop = await _Loop.start();
      final errand = loop.capture(
        id: 'errand',
        priority: CommitmentPriority.nice,
      );

      await loop.sync([errand]);

      expect(loop.pendingFor('errand'), [ReminderIntensity.softAwareness]);
    });
  });

  group('completion stops what is no longer owed', () {
    test('completing from the notification cancels every pending stage', () async {
      final loop = await _Loop.start();
      final exam = loop.capture(id: 'exam', priority: CommitmentPriority.must);
      await loop.sync([exam]);

      await loop.press(NotificationActionType.done, 'exam');

      expect(loop.pendingFor('exam'), isEmpty);
      final stored = await loop.repository.getById('exam');
      expect(stored!.status.isCompleted, isTrue);
    });

    test('completing in the app cancels the reminder on the next sync', () async {
      final loop = await _Loop.start();
      final exam = loop.capture(id: 'exam', priority: CommitmentPriority.must);
      await loop.sync([exam]);

      await loop.repository.complete('exam');
      final refreshed = await loop.repository.getById('exam');
      await loop.engine.syncCommitments([refreshed!]);

      expect(
        loop.pendingFor('exam'),
        isEmpty,
        reason: 'a done commitment must not still fire',
      );
    });

    test('a deleted commitment leaves nothing scheduled behind', () async {
      final loop = await _Loop.start();
      final exam = loop.capture(id: 'exam', priority: CommitmentPriority.must);
      await loop.sync([exam]);

      await loop.engine.syncCommitments(const []);

      expect(loop.notifications.scheduledRequests, isEmpty);
    });
  });

  group('snoozing defers without acknowledging', () {
    test('a snooze re-arms the reminder and does not mark awareness', () async {
      final loop = await _Loop.start();
      final exam = loop.capture(id: 'exam', priority: CommitmentPriority.must);
      await loop.sync([exam]);

      await loop.press(NotificationActionType.snooze, 'exam');

      expect(loop.notifications.requestsFor('exam'), isNotEmpty);
      expect(await loop.awareness.isAware('exam'), isFalse);
    });
  });

  group('quiet hours are respected', () {
    test('a reminder landing in the sleep window is not scheduled', () async {
      final loop = await _Loop.start(
        profile: UserRoutineProfile(
          updatedAt: DateTime(2026, 8, 19),
          timezone: 'Asia/Jerusalem',
          sleepWindow: const RoutineTimeWindow(start: '23:00', end: '09:00'),
        ),
      );
      // 10:30 start, soft awareness one hour before, lands at 09:30 -- awake.
      // A 09:00 start would put awareness at 08:00, inside the window.
      final early = loop.capture(
        id: 'early',
        priority: CommitmentPriority.must,
        startTime: '09:00',
      );

      await loop.sync([early]);

      expect(
        loop.pendingFor('early'),
        isNot(contains(ReminderIntensity.softAwareness)),
      );
    });
  });
}
