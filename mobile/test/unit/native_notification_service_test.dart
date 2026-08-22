import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/native_notification_service.dart';

/// Records what the service asked the platform to do.
class _FakeGateway implements LocalNotificationsGateway {
  final List<ScheduledNativeNotification> scheduled = [];
  final List<int> cancelled = [];
  int initializeCallCount = 0;
  int requestPermissionCallCount = 0;

  NativeNotificationPermission permission;
  NativeNotificationPermission permissionAfterRequest;
  Object? scheduleError;

  _FakeGateway({
    this.permission = NativeNotificationPermission.notDetermined,
    this.permissionAfterRequest = NativeNotificationPermission.granted,
  });

  @override
  Future<void> initialize({
    required void Function(NativeNotificationActionEvent event) onAction,
  }) async {
    initializeCallCount += 1;
  }

  @override
  Future<NativeNotificationPermission> checkPermission() async => permission;

  @override
  Future<NativeNotificationPermission> requestPermission() async {
    requestPermissionCallCount += 1;
    permission = permissionAfterRequest;
    return permission;
  }

  @override
  Future<void> schedule(ScheduledNativeNotification notification) async {
    if (scheduleError != null) throw scheduleError!;
    scheduled
      ..removeWhere((existing) => existing.id == notification.id)
      ..add(notification);
  }

  @override
  Future<void> cancel(int id) async {
    cancelled.add(id);
    scheduled.removeWhere((existing) => existing.id == id);
  }

  @override
  Future<List<PendingNativeNotification>> pending() async => scheduled
      .map(
        (notification) => PendingNativeNotification(
          id: notification.id,
          notificationId: notification.notificationId,
          commitmentId: notification.commitmentId,
        ),
      )
      .toList();

  @override
  Future<NativeNotificationActionEvent?> takeLaunchAction() async => null;
}

ScheduledNotificationRequest _request({
  String notificationId = 'soft-awareness-c1-softAwareness',
  String commitmentId = 'c1',
  ReminderIntensity intensity = ReminderIntensity.softAwareness,
  DateTime? at,
}) => ScheduledNotificationRequest(
  notificationId: notificationId,
  commitmentId: commitmentId,
  scheduledAt: at ?? DateTime(2026, 8, 19, 9, 30),
  intensity: intensity,
);

void main() {
  _permissionMapping();

  group('permission is the platform\'s answer, never our own', () {
    test('reports denied when the platform denied', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.denied,
      );
      final service = NativeNotificationService(gateway: gateway);

      expect(
        await service.permissionState(),
        NotificationPermissionState.denied,
      );
    });

    test('requesting a denied permission stays denied', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.notDetermined,
        permissionAfterRequest: NativeNotificationPermission.denied,
      );
      final service = NativeNotificationService(gateway: gateway);

      expect(
        await service.requestPermission(),
        NotificationPermissionState.denied,
      );
      expect(gateway.requestPermissionCallCount, 1);
    });

    test('nothing is scheduled while permission is denied', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.denied,
      );
      final service = NativeNotificationService(gateway: gateway);

      await service.schedule(_request());

      expect(gateway.scheduled, isEmpty);
    });

    test(
      'permissionState reflects a permission revoked after the initial grant',
      () async {
        final gateway = _FakeGateway(
          permission: NativeNotificationPermission.granted,
        );
        final service = NativeNotificationService(gateway: gateway);

        // Simulate the user revoking permission in system settings, out from
        // under a service that already reported "granted" once before.
        gateway.permission = NativeNotificationPermission.denied;

        final current = await service.permissionState();

        expect(current, NotificationPermissionState.denied);
      },
    );
  });

  group('scheduling', () {
    test('a granted request reaches the platform', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.granted,
      );
      final service = NativeNotificationService(gateway: gateway);

      await service.schedule(_request());

      expect(gateway.scheduled, hasLength(1));
      expect(gateway.scheduled.single.commitmentId, 'c1');
      expect(
        gateway.scheduled.single.scheduledAt,
        DateTime(2026, 8, 19, 9, 30),
      );
    });

    test('scheduling the same request twice leaves one pending', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.granted,
      );
      final service = NativeNotificationService(gateway: gateway);

      await service.schedule(_request());
      await service.schedule(_request());

      expect(gateway.scheduled, hasLength(1));
    });

    test(
      'the same notification id always maps to the same platform id',
      () async {
        final gateway = _FakeGateway(
          permission: NativeNotificationPermission.granted,
        );
        final service = NativeNotificationService(gateway: gateway);

        await service.schedule(_request());
        final first = gateway.scheduled.single.id;
        await service.cancelFor('c1');
        await service.schedule(_request());

        expect(gateway.scheduled.single.id, first);
      },
    );

    test(
      'different stages of one commitment get different platform ids',
      () async {
        final gateway = _FakeGateway(
          permission: NativeNotificationPermission.granted,
        );
        final service = NativeNotificationService(gateway: gateway);

        await service.schedule(_request());
        await service.schedule(
          _request(
            notificationId: 'soft-awareness-c1-strongReminder',
            intensity: ReminderIntensity.strongReminder,
            at: DateTime(2026, 8, 19, 10, 20),
          ),
        );

        final ids = gateway.scheduled.map((n) => n.id).toSet();
        expect(ids, hasLength(2));
      },
    );

    test('a stage carries the actions the user can take on it', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.granted,
      );
      final service = NativeNotificationService(gateway: gateway);

      await service.schedule(_request());

      expect(gateway.scheduled.single.actions, const [
        NotificationActionType.aware,
        NotificationActionType.snooze,
        NotificationActionType.done,
      ]);
    });

    test('a platform failure is observable, not swallowed', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.granted,
      )..scheduleError = StateError('platform refused');
      final failures = <String>[];
      final service = NativeNotificationService(
        gateway: gateway,
        onDeliveryFailure: (commitmentId, _) => failures.add(commitmentId),
      );

      await service.schedule(_request());

      expect(failures, ['c1']);
    });
  });

  group('surviving a restart', () {
    test(
      'a relaunched app can still cancel what it scheduled before',
      () async {
        final gateway = _FakeGateway(
          permission: NativeNotificationPermission.granted,
        );
        await NativeNotificationService(gateway: gateway).schedule(_request());

        // A fresh service instance is what a relaunch produces: same pending
        // notifications on the platform, no in-memory bookkeeping.
        final afterRestart = NativeNotificationService(gateway: gateway);
        await afterRestart.restoreFromPlatform();
        await afterRestart.cancelFor('c1');

        expect(gateway.scheduled, isEmpty);
      },
    );

    test(
      'a relaunched app does not duplicate an already pending stage',
      () async {
        final gateway = _FakeGateway(
          permission: NativeNotificationPermission.granted,
        );
        await NativeNotificationService(gateway: gateway).schedule(_request());

        final afterRestart = NativeNotificationService(gateway: gateway);
        await afterRestart.restoreFromPlatform();
        await afterRestart.schedule(_request());

        expect(gateway.scheduled, hasLength(1));
      },
    );
  });

  group('cancellation', () {
    test('cancelling a commitment cancels every stage it owns', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.granted,
      );
      final service = NativeNotificationService(gateway: gateway);

      await service.schedule(_request());
      await service.schedule(
        _request(
          notificationId: 'soft-awareness-c1-strongReminder',
          intensity: ReminderIntensity.strongReminder,
        ),
      );

      await service.cancelFor('c1');

      expect(gateway.scheduled, isEmpty);
    });

    test('cancelling one commitment leaves another alone', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.granted,
      );
      final service = NativeNotificationService(gateway: gateway);

      await service.schedule(_request());
      await service.schedule(
        _request(
          notificationId: 'soft-awareness-c2-softAwareness',
          commitmentId: 'c2',
        ),
      );

      await service.cancelFor('c1');

      expect(gateway.scheduled.map((n) => n.commitmentId), ['c2']);
    });
  });
}

// The plugin reports iOS authorization as a set of booleans. Mapping them is
// real logic: provisional authorization delivers notifications quietly, so
// treating it as a denial would make the app refuse to schedule reminders that
// iOS would in fact deliver.
void _permissionMapping() {
  group('reading the platform\'s authorization', () {
    test('full authorization is granted', () {
      expect(
        nativePermissionFrom(isEnabled: true, isProvisionalEnabled: false),
        NativeNotificationPermission.granted,
      );
    });

    test('provisional authorization is granted, not denied', () {
      expect(
        nativePermissionFrom(isEnabled: false, isProvisionalEnabled: true),
        NativeNotificationPermission.granted,
      );
    });

    test('no authorization of any kind is denied', () {
      expect(
        nativePermissionFrom(isEnabled: false, isProvisionalEnabled: false),
        NativeNotificationPermission.denied,
      );
    });

    test('an absent answer is not determined, not denied', () {
      expect(
        nativePermissionFrom(),
        NativeNotificationPermission.notDetermined,
      );
    });
  });
}
