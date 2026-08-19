import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_activity_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/native_notification_service.dart';
import 'package:maybesitter_mobile/services/notification_action_router.dart';
import 'package:maybesitter_mobile/services/soft_awareness_reminder_engine.dart';

const _flags = PilotPresenceFeatureFlags(
  widget: false,
  voice: false,
  awareness: true,
  watch: false,
  imports: false,
);

NativeNotificationActionEvent _event(
  NotificationActionType action, {
  String commitmentId = 'c1',
}) => NativeNotificationActionEvent(
  commitmentId: commitmentId,
  notificationId: 'soft-awareness-$commitmentId-softAwareness',
  action: action,
  occurredAt: DateTime(2026, 8, 19, 9, 31),
);

({
  NotificationActionRouter router,
  InMemoryAwarenessStateStore awareness,
  InMemoryCommitmentRepository repository,
  MockNotificationService notifications,
})
_build() {
  final notifications = MockNotificationService();
  final awareness = InMemoryAwarenessStateStore();
  final repository = InMemoryCommitmentRepository();
  return (
    router: NotificationActionRouter(
      dispatcher: SoftAwarenessCommandDispatcher(
        commitmentRepository: repository,
        notificationService: notifications,
        activityRepository: MockActivityRepository(),
        awarenessStateStore: awareness,
        flags: _flags,
      ),
      snoozeDuration: const Duration(minutes: 15),
    ),
    awareness: awareness,
    repository: repository,
    notifications: notifications,
  );
}

void main() {
  group('a notification action reaches canonical state', () {
    test('pressing Aware records awareness', () async {
      final harness = _build();

      await harness.router.handle(_event(NotificationActionType.aware));

      expect(await harness.awareness.isAware('c1'), isTrue);
    });

    test('pressing Aware does not complete the commitment', () async {
      final harness = _build();
      await harness.repository.ready;
      await harness.repository.saveAll([
        Commitment(
          id: 'c1',
          title: 'Dentist',
          scheduledDate: DateTime(2026, 8, 19),
          startTime: '10:30',
          priority: CommitmentPriority.must,
        ),
      ]);

      await harness.router.handle(_event(NotificationActionType.aware));

      final commitment = await harness.repository.getById('c1');
      expect(commitment!.status.isCompleted, isFalse);
    });

    test('pressing Done completes the commitment', () async {
      final harness = _build();
      await harness.repository.ready;
      await harness.repository.saveAll([
        Commitment(
          id: 'c1',
          title: 'Dentist',
          scheduledDate: DateTime(2026, 8, 19),
          startTime: '10:30',
          priority: CommitmentPriority.must,
        ),
      ]);

      await harness.router.handle(_event(NotificationActionType.done));

      final commitment = await harness.repository.getById('c1');
      expect(commitment!.status.isCompleted, isTrue);
    });

    test('pressing Snooze re-schedules by the configured duration', () async {
      final harness = _build();

      await harness.router.handle(_event(NotificationActionType.snooze));

      final rescheduled = harness.notifications.requestsFor('c1');
      expect(rescheduled, hasLength(1));
      expect(rescheduled.single.scheduledAt, DateTime(2026, 8, 19, 9, 46));
    });

    test('snoozing is not awareness', () async {
      final harness = _build();

      await harness.router.handle(_event(NotificationActionType.snooze));

      expect(await harness.awareness.isAware('c1'), isFalse);
    });
  });

  group('the same action is never applied twice', () {
    test('a redelivered action event is ignored', () async {
      final harness = _build();

      // The two delivery paths -- the live callback and the cold-start launch
      // details -- each stamp their own DateTime.now(), so a replay of one tap
      // never carries the same instant twice. Deduping on the instant would
      // therefore never fire.
      await harness.router.handle(
        NativeNotificationActionEvent(
          commitmentId: 'c1',
          notificationId: 'soft-awareness-c1-softAwareness',
          action: NotificationActionType.snooze,
          occurredAt: DateTime(2026, 8, 19, 9, 31, 0),
        ),
      );
      await harness.router.handle(
        NativeNotificationActionEvent(
          commitmentId: 'c1',
          notificationId: 'soft-awareness-c1-softAwareness',
          action: NotificationActionType.snooze,
          occurredAt: DateTime(2026, 8, 19, 9, 31, 2),
        ),
      );

      // A second snooze from the same delivery would push the reminder out
      // twice for one tap.
      expect(harness.notifications.requestsFor('c1'), hasLength(1));
      expect(
        harness.notifications.requestsFor('c1').single.scheduledAt,
        DateTime(2026, 8, 19, 9, 46),
      );
    });

    test('the same action long afterwards is a new tap, not a replay', () async {
      final harness = _build();

      await harness.router.handle(
        NativeNotificationActionEvent(
          commitmentId: 'c1',
          notificationId: 'soft-awareness-c1-softAwareness',
          action: NotificationActionType.snooze,
          occurredAt: DateTime(2026, 8, 19, 9, 31),
        ),
      );
      await harness.router.handle(
        NativeNotificationActionEvent(
          commitmentId: 'c1',
          notificationId: 'soft-awareness-c1-softAwareness',
          action: NotificationActionType.snooze,
          occurredAt: DateTime(2026, 8, 19, 9, 46),
        ),
      );

      // Snoozed again a quarter of an hour later: a real second decision.
      expect(
        harness.notifications.requestsFor('c1').single.scheduledAt,
        DateTime(2026, 8, 19, 10, 1),
      );
    });

    test('a genuinely later action on the same commitment still applies', () async {
      final harness = _build();

      await harness.router.handle(_event(NotificationActionType.snooze));
      await harness.router.handle(
        NativeNotificationActionEvent(
          commitmentId: 'c1',
          notificationId: 'soft-awareness-c1-softAwareness',
          action: NotificationActionType.aware,
          occurredAt: DateTime(2026, 8, 19, 9, 50),
        ),
      );

      expect(await harness.awareness.isAware('c1'), isTrue);
    });
  });
}
