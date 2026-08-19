import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_activity_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/soft_awareness_reminder_engine.dart';

const _flags = PilotPresenceFeatureFlags(
  widget: false,
  voice: false,
  awareness: true,
  watch: false,
  imports: false,
);

const _escalatingPolicy = ReminderPolicy(
  maxIntensity: ReminderIntensity.strongReminder,
  strongRemindersRequireExplicitOptIn: false,
);

Commitment _mustCommitment() => Commitment(
  id: 'must-1',
  title: 'Pediatric appointment',
  scheduledDate: DateTime(2026, 8, 19),
  startTime: '10:30 AM',
  priority: CommitmentPriority.must,
);

({
  SoftAwarenessReminderEngine engine,
  MockNotificationService notifications,
  InMemoryAwarenessStateStore awareness,
})
_build({DateTime? now}) {
  final notifications = MockNotificationService(
    initialPermissionState: NotificationPermissionState.granted,
  );
  final awareness = InMemoryAwarenessStateStore();
  return (
    engine: SoftAwarenessReminderEngine(
      notificationService: notifications,
      reminderPolicy: () => _escalatingPolicy,
      routineProfile: () => null,
      notificationsEnabled: () => true,
      flags: () => _flags,
      awarenessStateStore: awareness,
      now: () => now ?? DateTime(2026, 8, 19, 8),
    ),
    notifications: notifications,
    awareness: awareness,
  );
}

void main() {
  group('escalation scheduling', () {
    test('a must commitment schedules both the soft stage and the escalation', () async {
      final harness = _build();

      await harness.engine.syncCommitments([_mustCommitment()]);

      final scheduled = harness.notifications.scheduledRequests;
      expect(scheduled, hasLength(2));
      expect(
        scheduled.map((request) => request.scheduledAt),
        containsAll([
          DateTime(2026, 8, 19, 9, 30), // soft awareness, 60 min before
          DateTime(2026, 8, 19, 10, 20), // escalation, 10 min before
        ]),
      );
    });

    test('each stage gets its own stable notification id', () async {
      final harness = _build();

      await harness.engine.syncCommitments([_mustCommitment()]);
      final firstIds = harness.notifications.scheduledRequests
          .map((request) => request.notificationId)
          .toSet();

      await harness.engine.syncCommitments([_mustCommitment()]);
      final secondIds = harness.notifications.scheduledRequests
          .map((request) => request.notificationId)
          .toSet();

      expect(firstIds, hasLength(2));
      expect(secondIds, firstIds, reason: 're-syncing must not churn ids');
      expect(harness.notifications.scheduledRequests, hasLength(2));
    });
  });

  group('awareness suppresses escalation', () {
    test('an acknowledged commitment keeps no escalation scheduled', () async {
      final harness = _build();
      await harness.awareness.markAware('must-1', DateTime(2026, 8, 19, 9, 31));

      await harness.engine.syncCommitments([_mustCommitment()]);

      expect(
        harness.notifications.scheduledRequests
            .map((request) => request.intensity),
        isNot(contains(ReminderIntensity.strongReminder)),
      );
    });

    test('an acknowledged commitment is not re-reminded on the next sync', () async {
      final harness = _build();
      await harness.awareness.markAware('must-1', DateTime(2026, 8, 19, 9, 31));

      await harness.engine.syncCommitments([_mustCommitment()]);

      expect(harness.notifications.scheduledRequests, isEmpty);
    });

    test('awareness of one commitment does not silence another', () async {
      final harness = _build();
      await harness.awareness.markAware('must-1', DateTime(2026, 8, 19, 9, 31));
      final other = Commitment(
        id: 'must-2',
        title: 'Dentist',
        scheduledDate: DateTime(2026, 8, 19),
        startTime: '14:00',
        priority: CommitmentPriority.must,
      );

      await harness.engine.syncCommitments([_mustCommitment(), other]);

      expect(
        harness.notifications.scheduledRequests
            .map((request) => request.commitmentId)
            .toSet(),
        {'must-2'},
      );
    });
  });

  group('dispatcher writes awareness through to canonical state', () {
    test('marking aware persists so a later sync stays quiet', () async {
      final harness = _build();
      final repository = InMemoryCommitmentRepository();
      await repository.ready;
      await repository.saveAll([_mustCommitment()]);
      final dispatcher = SoftAwarenessCommandDispatcher(
        commitmentRepository: repository,
        notificationService: harness.notifications,
        activityRepository: MockActivityRepository(),
        awarenessStateStore: harness.awareness,
        flags: _flags,
      );

      await harness.engine.syncCommitments([_mustCommitment()]);
      await dispatcher.dispatch(
        MarkAwareNotificationCommand(
          commitmentId: 'must-1',
          occurredAt: DateTime(2026, 8, 19, 9, 31),
        ),
      );
      await harness.engine.syncCommitments([_mustCommitment()]);

      expect(harness.notifications.scheduledRequests, isEmpty);
    });

    test('awareness is not completion', () async {
      final harness = _build();
      final repository = InMemoryCommitmentRepository();
      await repository.ready;
      await repository.saveAll([_mustCommitment()]);
      final dispatcher = SoftAwarenessCommandDispatcher(
        commitmentRepository: repository,
        notificationService: harness.notifications,
        activityRepository: MockActivityRepository(),
        awarenessStateStore: harness.awareness,
        flags: _flags,
      );

      await dispatcher.dispatch(
        MarkAwareNotificationCommand(
          commitmentId: 'must-1',
          occurredAt: DateTime(2026, 8, 19, 9, 31),
        ),
      );

      final commitment = await repository.getById('must-1');
      expect(commitment!.status.isCompleted, isFalse);
    });

    test('completing a commitment clears its awareness record', () async {
      final harness = _build();
      final repository = InMemoryCommitmentRepository();
      await repository.ready;
      await repository.saveAll([_mustCommitment()]);
      final dispatcher = SoftAwarenessCommandDispatcher(
        commitmentRepository: repository,
        notificationService: harness.notifications,
        activityRepository: MockActivityRepository(),
        awarenessStateStore: harness.awareness,
        flags: _flags,
      );

      await dispatcher.dispatch(
        MarkAwareNotificationCommand(
          commitmentId: 'must-1',
          occurredAt: DateTime(2026, 8, 19, 9, 31),
        ),
      );
      await dispatcher.dispatch(
        DoneNotificationCommand(
          commitmentId: 'must-1',
          occurredAt: DateTime(2026, 8, 19, 9, 40),
        ),
      );

      expect(await harness.awareness.isAware('must-1'), isFalse);
    });
  });
}
