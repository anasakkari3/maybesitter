import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/activity_event.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_loop_analytics.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/in_memory_pilot_loop_analytics_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_activity_repository.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/soft_awareness_reminder_engine.dart';

void main() {
  group('SoftAwarenessReminderEngine', () {
    test(
      'schedules one hour before timed important items with actions',
      () async {
        final notifications = MockNotificationService(
          initialPermissionState: NotificationPermissionState.granted,
        );
        final engine = SoftAwarenessReminderEngine(
          notificationService: notifications,
          awarenessStateStore: InMemoryAwarenessStateStore(),
          reminderPolicy: () => const ReminderPolicy(),
          routineProfile: () => null,
          notificationsEnabled: () => true,
          flags: () => const PilotPresenceFeatureFlags(
            widget: false,
            voice: false,
            awareness: true,
            watch: false,
            imports: false,
          ),
          now: () => DateTime(2026, 8, 19, 8),
        );

        final commitment = Commitment(
          id: 'must-1',
          title: 'Pediatric appointment',
          scheduledDate: DateTime(2026, 8, 19),
          startTime: '10:30 AM',
          priority: CommitmentPriority.must,
        );

        await engine.syncCommitments([commitment]);

        expect(notifications.scheduledRequests, hasLength(1));
        final request = notifications.scheduledRequests.single;
        expect(request.commitmentId, 'must-1');
        expect(request.scheduledAt, DateTime(2026, 8, 19, 9, 30));
        expect(request.intensity, ReminderIntensity.softAwareness);
        expect(request.actions, const [
          NotificationActionType.aware,
          NotificationActionType.snooze,
          NotificationActionType.done,
        ]);
      },
    );

    test('does not schedule during quiet hours without override', () async {
      final notifications = MockNotificationService(
        initialPermissionState: NotificationPermissionState.granted,
      );
      final engine = SoftAwarenessReminderEngine(
        notificationService: notifications,
        awarenessStateStore: InMemoryAwarenessStateStore(),
        reminderPolicy: () => const ReminderPolicy(),
        routineProfile: () => UserRoutineProfile(
          updatedAt: DateTime.utc(2026, 8, 19, 7),
          timezone: 'Asia/Hebron',
          quietHours: const RoutineTimeWindow(start: '09:00', end: '11:00'),
        ),
        notificationsEnabled: () => true,
        flags: () => const PilotPresenceFeatureFlags(
          widget: false,
          voice: false,
          awareness: true,
          watch: false,
          imports: false,
        ),
        now: () => DateTime(2026, 8, 19, 8),
      );

      final commitment = Commitment(
        id: 'must-quiet',
        title: 'School meeting',
        scheduledDate: DateTime(2026, 8, 19),
        startTime: '10:30',
        priority: CommitmentPriority.must,
      );

      await engine.syncCommitments([commitment]);

      expect(notifications.scheduledRequests, isEmpty);
      expect(notifications.cancelledCommitmentIds, contains('must-quiet'));
    });

    test(
      'schedules during quiet hours when user override is allowed',
      () async {
        final notifications = MockNotificationService(
          initialPermissionState: NotificationPermissionState.granted,
        );
        final engine = SoftAwarenessReminderEngine(
          notificationService: notifications,
          awarenessStateStore: InMemoryAwarenessStateStore(),
          reminderPolicy: () => const ReminderPolicy(
            quietHoursRespectMode: QuietHoursRespectMode.allowUserOverride,
          ),
          routineProfile: () => UserRoutineProfile(
            updatedAt: DateTime.utc(2026, 8, 19, 7),
            timezone: 'Asia/Hebron',
            quietHours: const RoutineTimeWindow(start: '09:00', end: '11:00'),
          ),
          notificationsEnabled: () => true,
          flags: () => const PilotPresenceFeatureFlags(
            widget: false,
            voice: false,
            awareness: true,
            watch: false,
            imports: false,
          ),
          now: () => DateTime(2026, 8, 19, 8),
        );

        final commitment = Commitment(
          id: 'must-override',
          title: 'Exam arrival',
          scheduledDate: DateTime(2026, 8, 19),
          startTime: '10:30',
          priority: CommitmentPriority.must,
        );

        await engine.syncCommitments([commitment]);

        expect(notifications.scheduledRequests, hasLength(1));
        expect(
          notifications.scheduledRequests.single.scheduledAt,
          DateTime(2026, 8, 19, 9, 30),
        );
      },
    );

    test(
      'kill switch disables new notifications and clears existing schedules',
      () async {
        final notifications = MockNotificationService(
          initialPermissionState: NotificationPermissionState.granted,
        );
        var awarenessEnabled = true;
        final engine = SoftAwarenessReminderEngine(
          notificationService: notifications,
          awarenessStateStore: InMemoryAwarenessStateStore(),
          reminderPolicy: () => const ReminderPolicy(),
          routineProfile: () => null,
          notificationsEnabled: () => true,
          flags: () => PilotPresenceFeatureFlags(
            widget: false,
            voice: false,
            awareness: awarenessEnabled,
            watch: false,
            imports: false,
          ),
          now: () => DateTime(2026, 8, 19, 8),
        );

        final commitment = Commitment(
          id: 'must-kill',
          title: 'Dentist',
          scheduledDate: DateTime(2026, 8, 19),
          startTime: '11:00',
          priority: CommitmentPriority.must,
        );

        await engine.syncCommitments([commitment]);
        expect(notifications.scheduledRequests, hasLength(1));

        awarenessEnabled = false;
        await engine.syncCommitments([commitment]);

        expect(notifications.scheduledRequests, isEmpty);
        expect(notifications.cancelledCommitmentIds, contains('must-kill'));
      },
    );
  });

  group('SoftAwarenessCommandDispatcher', () {
    test('commands serialize deterministically and stay distinct', () {
      final at = DateTime.utc(2026, 8, 19, 8);
      expect(
        MarkAwareNotificationCommand(
          commitmentId: 'comm-1',
          occurredAt: at,
          notificationId: 'notif-1',
        ).toJson(),
        {
          'type': 'mark_aware',
          'commitmentId': 'comm-1',
          'occurredAt': '2026-08-19T08:00:00.000Z',
          'notificationId': 'notif-1',
        },
      );
      expect(
        SnoozeNotificationCommand(
          commitmentId: 'comm-1',
          occurredAt: at,
          snoozedUntil: DateTime.utc(2026, 8, 19, 8, 15),
          notificationId: 'notif-1',
        ).toJson(),
        {
          'type': 'snooze',
          'commitmentId': 'comm-1',
          'occurredAt': '2026-08-19T08:00:00.000Z',
          'snoozedUntil': '2026-08-19T08:15:00.000Z',
          'notificationId': 'notif-1',
        },
      );
      expect(
        DoneNotificationCommand(
          commitmentId: 'comm-1',
          occurredAt: at,
          notificationId: 'notif-1',
        ).toJson(),
        isNot(
          equals(
            MarkAwareNotificationCommand(
              commitmentId: 'comm-1',
              occurredAt: at,
              notificationId: 'notif-1',
            ).toJson(),
          ),
        ),
      );
    });

    test('aware snooze and done flow through deterministic commands', () async {
      final notifications = MockNotificationService();
      final activity = MockActivityRepository();
      final analytics = InMemoryPilotLoopAnalyticsService();
      final repo = InMemoryCommitmentRepository(activityRepository: activity);
      final dispatcher = SoftAwarenessCommandDispatcher(
        commitmentRepository: repo,
        notificationService: notifications,
        awarenessStateStore: InMemoryAwarenessStateStore(),
        activityRepository: activity,
        analyticsService: analytics,
        flags: const PilotPresenceFeatureFlags(
          widget: false,
          voice: false,
          awareness: true,
          watch: false,
          imports: false,
        ),
      );

      final target = (await repo.getUpcoming()).first;
      final occurredAt = DateTime.utc(2026, 8, 19, 9);
      final snoozedUntil = DateTime.utc(2026, 8, 20, 8, 45);

      await dispatcher.dispatch(
        MarkAwareNotificationCommand(
          commitmentId: target.id,
          occurredAt: occurredAt,
          notificationId: 'notif-aware',
        ),
      );
      await dispatcher.dispatch(
        SnoozeNotificationCommand(
          commitmentId: target.id,
          occurredAt: occurredAt,
          snoozedUntil: snoozedUntil,
          notificationId: 'notif-aware',
        ),
      );
      expect(notifications.requestFor(target.id)?.scheduledAt, snoozedUntil);
      await dispatcher.dispatch(
        DoneNotificationCommand(
          commitmentId: target.id,
          occurredAt: occurredAt,
          notificationId: 'notif-done',
        ),
      );

      expect(notifications.cancelledCommitmentIds, contains(target.id));
      expect(
        (await repo.getById(target.id))!.status,
        CommitmentStatus.completed,
      );

      final events = await activity.getActivity();
      expect(
        events.any(
          (event) => event.type == ActivityEventType.softAwarenessAcknowledged,
        ),
        isTrue,
      );
      expect(
        events.any(
          (event) => event.type == ActivityEventType.softAwarenessSnoozed,
        ),
        isTrue,
      );
      expect(
        analytics.events.where(
          (event) =>
              event.name == PilotLoopAnalyticsEventName.softAwarenessAction,
        ),
        hasLength(3),
      );
    });

    test(
      'ignored and missed reminders are recorded without raw text',
      () async {
        final notifications = MockNotificationService();
        final activity = MockActivityRepository();
        final analytics = InMemoryPilotLoopAnalyticsService();
        final repo = InMemoryCommitmentRepository(activityRepository: activity);
        final dispatcher = SoftAwarenessCommandDispatcher(
          commitmentRepository: repo,
          notificationService: notifications,
          awarenessStateStore: InMemoryAwarenessStateStore(),
          activityRepository: activity,
          analyticsService: analytics,
          flags: const PilotPresenceFeatureFlags(
            widget: false,
            voice: false,
            awareness: true,
            watch: false,
            imports: false,
          ),
        );

        final target = (await repo.getUpcoming()).first;
        final occurredAt = DateTime.utc(2026, 8, 19, 9);

        await dispatcher.dispatch(
          IgnoreNotificationCommand(
            commitmentId: target.id,
            occurredAt: occurredAt,
            notificationId: 'notif-ignore',
          ),
        );
        await dispatcher.dispatch(
          MissedNotificationCommand(
            commitmentId: target.id,
            occurredAt: occurredAt.add(const Duration(minutes: 10)),
            notificationId: 'notif-missed',
          ),
        );

        final events = await activity.getActivity();
        final ignored = events.firstWhere(
          (event) => event.type == ActivityEventType.softAwarenessIgnored,
        );
        final missed = events.firstWhere(
          (event) => event.type == ActivityEventType.softAwarenessMissed,
        );

        expect(
          ignored.description.toLowerCase(),
          isNot(contains(target.title.toLowerCase())),
        );
        expect(
          missed.description.toLowerCase(),
          isNot(contains(target.title.toLowerCase())),
        );
        expect(
          analytics.events.where(
            (event) =>
                event.name == PilotLoopAnalyticsEventName.softAwarenessMissed,
          ),
          hasLength(2),
        );
      },
    );
  });
}
