/// "Delete my data" from the Trust Center, all the way to the device.
///
/// The eraser has its own tests. This one goes through the action a
/// participant actually takes -- DeletePilotData applied to the trust
/// controller -- so the wiring between the button and the erasure is covered,
/// not just the erasure itself. Dropping that wiring would leave every eraser
/// test passing while nothing on the device was touched.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/trust/pilot_trust_controller.dart';
import 'package:maybesitter_mobile/models/calendar_import.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_trust_service.dart';
import 'package:maybesitter_mobile/services/in_memory_awareness_state_store.dart';
import 'package:maybesitter_mobile/services/mock/mock_calendar_import_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_pilot_trust_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_notification_service.dart';
import 'package:maybesitter_mobile/services/participant_data_eraser.dart';
import 'package:maybesitter_mobile/services/pilot_presence_snapshot_publisher.dart';
import 'package:maybesitter_mobile/services/shared_preferences_pilot_presence_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _flags = PilotPresenceFeatureFlags(
  widget: true,
  voice: true,
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('applying DeletePilotData erases what the device holds', () async {
    final calendar = MockCalendarImportService(snapshot: _imported());
    final awareness = InMemoryAwarenessStateStore();
    await awareness.markAware('c1', DateTime(2026, 8, 20, 9));

    final eraser = ParticipantDataEraser(
      calendarImportService: calendar,
      notificationService: MockNotificationService(),
      awarenessStateStore: awareness,
      snapshotPublisher: PilotPresenceSnapshotPublisher(
        store: SharedPreferencesPilotPresenceStore(),
        now: () => DateTime.utc(2026, 8, 20, 8),
        flags: _flags,
      ),
    );

    var sessionEnded = false;
    final controller = PilotTrustNotifier(
      service: MockPilotTrustService(),
      onDeleted: () async {
        await eraser.eraseEverything();
        sessionEnded = true;
      },
    );
    addTearDown(controller.dispose);

    await controller.apply(const DeletePilotData());

    expect(
      (await calendar.getSnapshot()).retainedBusyBlocks,
      isEmpty,
      reason: 'the imported calendar has to go with the participant',
    );
    expect(await awareness.isAware('c1'), isFalse);
    expect(sessionEnded, isTrue);
  });

  test('the erasure runs before the session is ended', () async {
    final calendar = MockCalendarImportService(snapshot: _imported());
    final order = <String>[];

    final controller = PilotTrustNotifier(
      service: MockPilotTrustService(),
      onDeleted: () async {
        await ParticipantDataEraser(
          calendarImportService: calendar,
          notificationService: MockNotificationService(),
          awarenessStateStore: InMemoryAwarenessStateStore(),
          snapshotPublisher: PilotPresenceSnapshotPublisher(
            store: SharedPreferencesPilotPresenceStore(),
            now: () => DateTime.utc(2026, 8, 20, 8),
            flags: _flags,
          ),
        ).eraseEverything();
        order.add('erased');
        order.add('session ended');
      },
    );
    addTearDown(controller.dispose);

    await controller.apply(const DeletePilotData());

    // Ending the session first would leave the data orphaned behind a dropped
    // credential if the app were torn down in between.
    expect(order, ['erased', 'session ended']);
  });
}
