/// A reminder that actually arrives, on a real phone.
///
/// The other integration test proves iOS accepted the schedule. This one exists
/// to be watched: it arms a reminder a short way out, with the real Aware /
/// Later / Done buttons, so a person can lock the phone, see it arrive, press
/// one, and check that canonical state moved. That last step is the part no
/// build output can stand in for.
library;

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/flutter_local_notifications_gateway.dart';
import 'package:maybesitter_mobile/services/native_notification_service.dart';
import 'package:timezone/data/latest.dart' as tz_data;
import 'package:flutter_timezone/flutter_timezone.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  tz_data.initializeTimeZones();

  testWidgets('the calendar channel is registered on a real device', (
    tester,
  ) async {
    // Under the scene lifecycle the app delegate's window is nil at launch, so
    // the registration block there never runs. The calendar plugin was
    // registered only in that dead block -- the Swift implementation existed
    // and the channel did not. Nothing but a device shows the difference.
    const channel = MethodChannel('com.maybesitter.mobile/apple_calendar_import');
    try {
      final status = await channel.invokeMethod<String>('authorizationStatus');
      // ignore: avoid_print
      print('CALENDAR CHANNEL: registered, status=$status');
    } on MissingPluginException {
      fail('the apple_calendar_import channel is not registered on device');
    }
  });

  testWidgets('arm a real reminder one minute out, with real action buttons', (
    tester,
  ) async {
    final zone = (await FlutterTimezone.getLocalTimezone()).identifier;
    // ignore: avoid_print
    print('DEVICE TIMEZONE: $zone');

    final gateway = FlutterLocalNotificationsGateway(
      localTimezoneName: () => zone,
    );
    await gateway.initialize(
      onAction: (event) {
        // ignore: avoid_print
        print('ACTION RECEIVED: ${event.action.name} for ${event.commitmentId}');
      },
    );

    // Full permission, the way a participant grants it.
    final requested = await gateway.requestPermission();
    // ignore: avoid_print
    print('PERMISSION AFTER REQUEST: ${requested.name}');
    if (requested != NativeNotificationPermission.granted) {
      markTestSkipped('SKIPPED: permission is ${requested.name}.');
      return;
    }

    await FlutterLocalNotificationsPlugin().cancelAll();

    final service = NativeNotificationService(gateway: gateway);
    final fireAt = DateTime.now().add(const Duration(minutes: 1));
    await service.schedule(
      ScheduledNotificationRequest(
        notificationId: 'device-check-softAwareness',
        commitmentId: 'device-check',
        scheduledAt: fireAt,
        intensity: ReminderIntensity.softAwareness,
      ),
    );

    final pending = await gateway.pending();
    // ignore: avoid_print
    print('SCHEDULED FOR: $fireAt');
    // ignore: avoid_print
    print('PENDING WITH IOS: ${pending.length}');

    expect(
      pending.map((notification) => notification.commitmentId),
      contains('device-check'),
    );
  });
}
