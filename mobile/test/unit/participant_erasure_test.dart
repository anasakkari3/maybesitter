/// Deleting a participant has to remove what is on the device.
///
/// Dropping the credential ends the session; it does not touch the imported
/// calendar, the snapshot the widget and the watch read, the acknowledgement
/// record, or the reminders already handed to iOS. Any of those surviving means
/// "delete my data" deleted a token and left the data.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/models/calendar_import.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/notification_service.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/mock/mock_calendar_import_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/participant_data_eraser.dart';
import 'package:maybesitter_mobile/services/pilot_presence_snapshot_publisher.dart';
import 'package:maybesitter_mobile/services/shared_preferences_pilot_presence_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _flags = PilotPresenceFeatureFlags(
  widget: true,
  voice: false,
  awareness: true,
  watch: false,
  imports: true,
);

CalendarImportSnapshot _imported() => CalendarImportSnapshot(
  provider: CalendarImportProvider.appleCalendar,
  connectionState: CalendarImportConnectionState.connected,
  lastSyncedAt: DateTime(2026, 8, 20, 7),
  retainedBusyBlocks: [
    ImportedCalendarBusyBlock(
      id: 'apple-1',
      startAt: DateTime(2026, 8, 20, 9),
      endAt: DateTime(2026, 8, 20, 10),
      allDay: false,
    ),
  ],
);

({
  ParticipantDataEraser eraser,
  MockCalendarImportService calendar,
  MockNotificationService notifications,
  InMemoryAwarenessStateStore awareness,
  SharedPreferencesPilotPresenceStore presence,
})
_build() {
  final calendar = MockCalendarImportService(snapshot: _imported());
  final notifications = MockNotificationService();
  final awareness = InMemoryAwarenessStateStore();
  final presence = SharedPreferencesPilotPresenceStore();
  return (
    eraser: ParticipantDataEraser(
      calendarImportService: calendar,
      notificationService: notifications,
      awarenessStateStore: awareness,
      snapshotPublisher: PilotPresenceSnapshotPublisher(
        store: presence,
        now: () => DateTime.utc(2026, 8, 20, 8),
        flags: _flags,
      ),
    ),
    calendar: calendar,
    notifications: notifications,
    awareness: awareness,
    presence: presence,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('erasing removes the imported calendar data', () async {
    final harness = _build();

    await harness.eraser.eraseEverything();

    final snapshot = await harness.calendar.getSnapshot();
    expect(snapshot.retainedBusyBlocks, isEmpty);
    expect(snapshot.lastSyncedAt, isNull);
  });

  test('erasing clears the snapshot the widget and watch read', () async {
    final harness = _build();
    await harness.eraser.snapshotPublisher.publishWidgetSnapshot([
      Commitment(
        id: 'c1',
        title: 'Exam',
        scheduledDate: DateTime(2026, 8, 20),
        priority: CommitmentPriority.must,
      ),
    ]);
    expect(await harness.presence.readSnapshot(), isNotNull);

    await harness.eraser.eraseEverything();

    expect(await harness.presence.readSnapshot(), isNull);
  });

  test('erasing forgets what the user had acknowledged', () async {
    final harness = _build();
    await harness.awareness.markAware('c1', DateTime(2026, 8, 20, 9));

    await harness.eraser.eraseEverything();

    expect(await harness.awareness.isAware('c1'), isFalse);
  });

  test('erasing cancels reminders already handed to the platform', () async {
    final harness = _build();
    await harness.notifications.schedule(
      ScheduledNotificationRequest(
        notificationId: 'soft-awareness-c1-softAwareness',
        commitmentId: 'c1',
        scheduledAt: DateTime(2026, 8, 20, 9),
        intensity: ReminderIntensity.softAwareness,
      ),
    );

    await harness.eraser.eraseEverything();

    expect(harness.notifications.scheduledRequests, isEmpty);
  });

  test('one failing store does not stop the rest being erased', () async {
    final harness = _build();
    await harness.awareness.markAware('c1', DateTime(2026, 8, 20, 9));
    harness.calendar.failNextOperation = true;

    await harness.eraser.eraseEverything();

    // A calendar that refuses must not leave the acknowledgement record behind.
    expect(await harness.awareness.isAware('c1'), isFalse);
  });
}
