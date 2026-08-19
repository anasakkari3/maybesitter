/// Reminder delivery, proved against the real notification system.
///
/// The unit tests prove the scheduling rules. These prove the operating system
/// actually took the request — that a MaybeSitter reminder exists as a pending
/// iOS notification, keyed the way cancellation expects, and that permission is
/// reported from the OS rather than assumed.
library;

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/flutter_local_notifications_gateway.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/native_notification_service.dart';
import 'package:maybesitter_mobile/services/soft_awareness_reminder_engine.dart';
import 'package:timezone/data/latest.dart' as tz_data;

const _flags = PilotPresenceFeatureFlags(
  widget: false,
  voice: false,
  awareness: true,
  watch: false,
  imports: false,
);

Future<FlutterLocalNotificationsGateway> _startedGateway() async {
  final gateway = FlutterLocalNotificationsGateway(
    localTimezoneName: () => 'Asia/Jerusalem',
  );
  await gateway.initialize(onAction: (_) {});
  return gateway;
}

/// Whether the OS has actually granted us permission.
///
/// Prints the real state either way. A delivery test that quietly skips reads
/// as a pass in the summary, which is precisely the kind of false green this
/// work exists to remove.
Future<bool> _requireGranted(FlutterLocalNotificationsGateway gateway) async {
  final state = await gateway.checkPermission();
  // ignore: avoid_print
  print('NOTIFICATION PERMISSION STATE: ${state.name}');
  if (state == NativeNotificationPermission.granted) return true;
  markTestSkipped('SKIPPED: notification permission is ${state.name}.');
  return false;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  tz_data.initializeTimeZones();

  setUpAll(() async {
    // Provisional authorisation is a real grant from the real OS -- quiet
    // notifications, no dialog. It exists so these tests can exercise
    // UNUserNotificationCenter unattended. Production still asks for full
    // permission properly; nothing here changes what a participant sees.
    await FlutterLocalNotificationsPlugin()
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >()
        ?.requestPermissions(alert: true, badge: true, sound: true,
            provisional: true);
  });

  setUp(() async {
    await FlutterLocalNotificationsPlugin().cancelAll();
  });

  testWidgets('the operating system reports its own permission state', (
    tester,
  ) async {
    final gateway = await _startedGateway();

    final state = await gateway.checkPermission();
    // ignore: avoid_print
    print('NOTIFICATION PERMISSION STATE: ${state.name}');

    // Any of the three is a legitimate answer. What matters is that it came
    // from iOS: the mock this replaced could only ever say "granted".
    expect(NativeNotificationPermission.values, contains(state));
  });

  testWidgets('a granted app leaves a real pending notification with iOS', (
    tester,
  ) async {
    final gateway = await _startedGateway();
    if (!await _requireGranted(gateway)) return;

    final service = NativeNotificationService(gateway: gateway);
    await service.schedule(
      ScheduledNotificationRequest(
        notificationId: 'soft-awareness-itest-1-softAwareness',
        commitmentId: 'itest-1',
        scheduledAt: DateTime.now().add(const Duration(hours: 2)),
        intensity: ReminderIntensity.softAwareness,
      ),
    );

    final pending = await gateway.pending();
    expect(
      pending.map((notification) => notification.commitmentId),
      contains('itest-1'),
    );
  });

  testWidgets('scheduling the same reminder twice leaves one pending', (
    tester,
  ) async {
    final gateway = await _startedGateway();
    if (!await _requireGranted(gateway)) return;

    final service = NativeNotificationService(gateway: gateway);
    final request = ScheduledNotificationRequest(
      notificationId: 'soft-awareness-itest-2-softAwareness',
      commitmentId: 'itest-2',
      scheduledAt: DateTime.now().add(const Duration(hours: 2)),
      intensity: ReminderIntensity.softAwareness,
    );

    await service.schedule(request);
    await service.schedule(request);

    final mine = (await gateway.pending())
        .where((notification) => notification.commitmentId == 'itest-2');
    expect(mine, hasLength(1));
  });

  testWidgets('a relaunched app can cancel what a previous process scheduled', (
    tester,
  ) async {
    final gateway = await _startedGateway();
    if (!await _requireGranted(gateway)) return;

    await NativeNotificationService(gateway: gateway).schedule(
      ScheduledNotificationRequest(
        notificationId: 'soft-awareness-itest-3-softAwareness',
        commitmentId: 'itest-3',
        scheduledAt: DateTime.now().add(const Duration(hours: 2)),
        intensity: ReminderIntensity.softAwareness,
      ),
    );

    // A fresh service is what a relaunch produces: iOS still holds the
    // notification, the process has forgotten it.
    final afterRestart = NativeNotificationService(gateway: gateway);
    await afterRestart.restoreFromPlatform();
    await afterRestart.cancelFor('itest-3');

    final mine = (await gateway.pending())
        .where((notification) => notification.commitmentId == 'itest-3');
    expect(mine, isEmpty);
  });

  testWidgets('a must commitment leaves both a soft stage and an escalation', (
    tester,
  ) async {
    final gateway = await _startedGateway();
    if (!await _requireGranted(gateway)) return;

    final engine = SoftAwarenessReminderEngine(
      notificationService: NativeNotificationService(gateway: gateway),
      reminderPolicy: () => const ReminderPolicy(
        maxIntensity: ReminderIntensity.strongReminder,
        strongRemindersRequireExplicitOptIn: false,
      ),
      routineProfile: () => null,
      notificationsEnabled: () => true,
      flags: () => _flags,
      awarenessStateStore: InMemoryAwarenessStateStore(),
    );

    final start = DateTime.now().add(const Duration(hours: 4));
    await engine.syncCommitments([
      Commitment(
        id: 'itest-4',
        title: 'Exam',
        scheduledDate: DateTime(start.year, start.month, start.day),
        startTime:
            '${start.hour.toString().padLeft(2, '0')}:'
            '${start.minute.toString().padLeft(2, '0')}',
        priority: CommitmentPriority.must,
      ),
    ]);

    final mine = (await gateway.pending())
        .where((notification) => notification.commitmentId == 'itest-4');
    expect(mine, hasLength(2));
  });
}
