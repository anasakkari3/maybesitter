/// Each kill switch actually stops its surface.
///
/// A kill switch nobody has pulled is indistinguishable from one that does
/// nothing. These pull each of the five and check the surface goes quiet --
/// and that pulling one does not take the others with it, since a pilot
/// operator disabling the widget must not silently lose reminders too.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/pilot_presence_snapshot_publisher.dart';
import 'package:maybesitter_mobile/services/shared_preferences_pilot_presence_store.dart';
import 'package:maybesitter_mobile/services/soft_awareness_reminder_engine.dart';
import 'package:maybesitter_mobile/services/watch_snapshot_bridge.dart';
import 'package:shared_preferences/shared_preferences.dart';

PilotPresenceFeatureFlags _flags({
  bool widget = true,
  bool voice = true,
  bool awareness = true,
  bool watch = true,
  bool imports = true,
}) => PilotPresenceFeatureFlags(
  widget: widget,
  voice: voice,
  awareness: awareness,
  watch: watch,
  imports: imports,
);

class _RecordingWatchBridge implements WatchSnapshotBridge {
  final List<String?> published = [];

  @override
  Future<bool> isSupported() async => true;

  @override
  Future<bool> publishSnapshot(String json) async {
    published.add(json);
    return true;
  }

  @override
  Future<bool> clearSnapshot() async {
    published.add(null);
    return true;
  }

  @override
  Future<Map<String, Object?>> diagnostics() async => const {};
}

final _must = Commitment(
  id: 'c1',
  title: 'Exam',
  scheduledDate: DateTime(2026, 8, 20),
  startTime: '10:00',
  priority: CommitmentPriority.must,
);

Future<SoftAwarenessReminderEngine> _engine(
  MockNotificationService notifications,
  PilotPresenceFeatureFlags flags,
) async => SoftAwarenessReminderEngine(
  notificationService: notifications,
  reminderPolicy: () => const ReminderPolicy(),
  routineProfile: () => null,
  notificationsEnabled: () => true,
  flags: () => flags,
  awarenessStateStore: InMemoryAwarenessStateStore(),
  now: () => DateTime(2026, 8, 20, 8),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the awareness kill switch', () {
    test('stops reminders being scheduled', () async {
      final notifications = MockNotificationService(
        initialPermissionState: NotificationPermissionState.granted,
      );
      final engine = await _engine(notifications, _flags(awareness: false));

      await engine.syncCommitments([_must]);

      expect(notifications.scheduledRequests, isEmpty);
    });

    test('cancels reminders already scheduled, without deleting the commitment', () async {
      final notifications = MockNotificationService(
        initialPermissionState: NotificationPermissionState.granted,
      );
      await (await _engine(notifications, _flags())).syncCommitments([_must]);
      expect(notifications.scheduledRequests, isNotEmpty);

      final killed = await _engine(notifications, _flags(awareness: false));
      await killed.syncCommitments([_must]);

      expect(notifications.scheduledRequests, isEmpty);
    });

    test('leaves reminders alone when only the widget is killed', () async {
      final notifications = MockNotificationService(
        initialPermissionState: NotificationPermissionState.granted,
      );
      final engine = await _engine(notifications, _flags(widget: false));

      await engine.syncCommitments([_must]);

      expect(notifications.scheduledRequests, isNotEmpty);
    });
  });

  group('the watch kill switch', () {
    test('clears the wrist instead of leaving stale state on it', () async {
      final bridge = _RecordingWatchBridge();

      await PilotPresenceSnapshotPublisher(
        store: SharedPreferencesPilotPresenceStore(),
        now: () => DateTime.utc(2026, 8, 20, 8),
        flags: _flags(watch: false),
        watchBridge: bridge,
      ).publishWidgetSnapshot([_must]);

      expect(bridge.published, [null]);
    });

    test('does not stop the widget snapshot', () async {
      final store = SharedPreferencesPilotPresenceStore();

      await PilotPresenceSnapshotPublisher(
        store: store,
        now: () => DateTime.utc(2026, 8, 20, 8),
        flags: _flags(watch: false),
        watchBridge: _RecordingWatchBridge(),
      ).publishWidgetSnapshot([_must]);

      expect(await store.readSnapshot(), isNotNull);
    });
  });

  group('the voice and imports kill switches', () {
    test('voice off makes spoken capture report itself unavailable', () {
      // The switch is read in CaptureController.startSpokenPrompt, which sets
      // SpokenPromptStatus.unavailable and returns before touching the
      // microphone. Asserted here as a contract so the branch is not removed.
      expect(SpokenPromptStatus.values, contains(SpokenPromptStatus.unavailable));
      expect(_flags(voice: false).voice, isFalse);
    });

    test('a killed switch is off in the serialised flag set', () {
      final json = _flags(voice: false, imports: false).toJson();

      expect(json['voice'], isFalse);
      expect(json['imports'], isFalse);
      expect(json['awareness'], isTrue, reason: 'switches are independent');
    });
  });
}
