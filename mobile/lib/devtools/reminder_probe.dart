/// A tiny harness for watching a reminder actually arrive.
///
/// Not shipped and not referenced by the app. `flutter test` uninstalls the app
/// when it finishes, which cancels every notification it scheduled, so a
/// delivery can only be observed from something that stays installed and
/// running. Run it with `flutter run -t lib/devtools/reminder_probe.dart`.
library;

import 'package:flutter/material.dart';
import 'package:timezone/data/latest.dart' as tz_data;

import '../models/pilot_presence.dart';
import '../services/contracts/notification_service.dart';
import '../services/flutter_local_notifications_gateway.dart';
import '../services/native_notification_service.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  tz_data.initializeTimeZones();
  runApp(const _ProbeApp());
}

class _ProbeApp extends StatefulWidget {
  const _ProbeApp();

  @override
  State<_ProbeApp> createState() => _ProbeAppState();
}

class _ProbeAppState extends State<_ProbeApp> {
  final List<String> _log = [];

  @override
  void initState() {
    super.initState();
    _run();
  }

  void _say(String line) {
    // ignore: avoid_print
    print('PROBE: $line');
    if (mounted) setState(() => _log.add(line));
  }

  Future<void> _run() async {
    final gateway = FlutterLocalNotificationsGateway(
      localTimezoneName: () => 'Asia/Jerusalem',
    );
    await gateway.initialize(
      onAction: (event) =>
          _say('ACTION RECEIVED: ${event.action.name} for ${event.commitmentId}'),
    );

    final launch = await gateway.takeLaunchAction();
    if (launch != null) {
      _say('LAUNCH ACTION: ${launch.action.name} for ${launch.commitmentId}');
    }

    final state = await gateway.requestPermission();
    _say('PERMISSION: ${state.name}');
    if (state != NativeNotificationPermission.granted) return;

    final fireAt = DateTime.now().add(const Duration(seconds: 25));
    await NativeNotificationService(gateway: gateway).schedule(
      ScheduledNotificationRequest(
        notificationId: 'probe-softAwareness',
        commitmentId: 'probe',
        scheduledAt: fireAt,
        intensity: ReminderIntensity.softAwareness,
      ),
    );
    _say('SCHEDULED FOR $fireAt');
    _say('PENDING: ${(await gateway.pending()).length}');
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: ListView(
              children: [
                for (final line in _log)
                  Text(line, style: const TextStyle(fontSize: 13)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
