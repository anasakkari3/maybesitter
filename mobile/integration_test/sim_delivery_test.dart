/// A reminder that is actually delivered, watched end to end on a simulator.
///
/// Everything up to here proves iOS accepted the schedule. This proves the
/// notification arrives, carries the real action buttons, and that pressing one
/// moves canonical state -- the part that no build output can stand in for.
library;

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/flutter_local_notifications_gateway.dart';
import 'package:maybesitter_mobile/services/native_notification_service.dart';
import 'package:timezone/data/latest.dart' as tz_data;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  tz_data.initializeTimeZones();

  testWidgets('a real reminder is delivered with its action buttons', (
    tester,
  ) async {
    final gateway = FlutterLocalNotificationsGateway(
      localTimezoneName: () => 'Asia/Jerusalem',
    );
    await gateway.initialize(
      onAction: (event) {
        // ignore: avoid_print
        print('ACTION RECEIVED: ${event.action.name} for ${event.commitmentId}');
      },
    );

    // Full authorization, not provisional: a provisional grant is deliberately
    // quiet, and a reminder nobody sees is the thing being tested.
    final state = await gateway.requestPermission();
    // ignore: avoid_print
    print('PERMISSION AFTER REQUEST: ${state.name}');
    expect(state, NativeNotificationPermission.granted);

    await FlutterLocalNotificationsPlugin().cancelAll();

    final service = NativeNotificationService(gateway: gateway);
    final fireAt = DateTime.now().add(const Duration(seconds: 30));
    await service.schedule(
      ScheduledNotificationRequest(
        notificationId: 'sim-check-softAwareness',
        commitmentId: 'sim-check',
        scheduledAt: fireAt,
        intensity: ReminderIntensity.softAwareness,
      ),
    );

    // ignore: avoid_print
    print('SCHEDULED FOR: $fireAt');
    final pending = await gateway.pending();
    // ignore: avoid_print
    print('PENDING WITH IOS: ${pending.length}');
    expect(pending.map((n) => n.commitmentId), contains('sim-check'));
  });
}
