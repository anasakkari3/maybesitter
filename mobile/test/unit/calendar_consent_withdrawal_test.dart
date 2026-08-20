/// Withdrawing calendar consent has to remove what was imported under it.
///
/// Disconnecting and withdrawing consent are different acts. Disconnecting
/// stops future syncing and may reasonably keep what is already here.
/// Withdrawing consent removes the basis for holding it at all, so the data
/// has to go with it -- otherwise the app keeps someone's calendar after being
/// told it may not.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/trust/calendar_import_controller.dart';
import 'package:maybesitter_mobile/models/calendar_import.dart';
import 'package:maybesitter_mobile/services/mock/mock_calendar_import_service.dart';

CalendarImportSnapshot _connectedWithData() => CalendarImportSnapshot(
  provider: CalendarImportProvider.appleCalendar,
  connectionState: CalendarImportConnectionState.connected,
  lastSyncedAt: DateTime(2026, 8, 20, 7),
  importedWindowStart: DateTime(2026, 8, 20),
  importedWindowEnd: DateTime(2026, 8, 27),
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
  group('withdrawing consent', () {
    test('erases the busy blocks imported under it', () async {
      final service = MockCalendarImportService(snapshot: _connectedWithData());
      final controller = CalendarImportNotifier(service: service);

      await controller.withdrawConsent();

      final snapshot = await service.getSnapshot();
      expect(snapshot.retainedBusyBlocks, isEmpty);
    });

    test('forgets when the import happened and what it covered', () async {
      final service = MockCalendarImportService(snapshot: _connectedWithData());
      final controller = CalendarImportNotifier(service: service);

      await controller.withdrawConsent();

      final snapshot = await service.getSnapshot();
      expect(snapshot.lastSyncedAt, isNull);
      expect(snapshot.importedWindowStart, isNull);
      expect(snapshot.importedWindowEnd, isNull);
    });

    test('leaves the connection disconnected', () async {
      final service = MockCalendarImportService(snapshot: _connectedWithData());
      final controller = CalendarImportNotifier(service: service);

      await controller.withdrawConsent();

      final snapshot = await service.getSnapshot();
      expect(snapshot.isConnected, isFalse);
    });
  });

  group('disconnecting is a different act', () {
    test('disconnecting stops syncing but keeps what is already here', () async {
      final service = MockCalendarImportService(snapshot: _connectedWithData());
      final controller = CalendarImportNotifier(service: service);

      await controller.disconnect();

      final snapshot = await service.getSnapshot();
      expect(snapshot.isConnected, isFalse);
      expect(
        snapshot.retainedBusyBlocks,
        isNotEmpty,
        reason: 'disconnect is not a deletion; consent withdrawal is',
      );
    });
  });
}
