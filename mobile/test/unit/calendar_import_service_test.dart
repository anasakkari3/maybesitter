import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/models/calendar_import.dart';
import 'package:maybesitter_mobile/services/apple_calendar_import_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AppleCalendarImportService', () {
    late FakeAppleCalendarBridge bridge;
    late AppleCalendarImportService service;

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      bridge = FakeAppleCalendarBridge();
      service = AppleCalendarImportService(
        bridge: bridge,
        sharedPreferences: SharedPreferences.getInstance,
      );
    });

    test('connect imports busy blocks and persists them', () async {
      bridge.authorizationStatus = AppleCalendarAuthorizationStatus.authorized;
      bridge.fetchResult = AppleCalendarFetchResult(
        authorizationStatus: AppleCalendarAuthorizationStatus.authorized,
        windowStart: DateTime(2026, 8, 19, 0),
        windowEnd: DateTime(2026, 9, 2, 0),
        busyBlocks: [
          ImportedCalendarBusyBlock(
            id: 'event-1',
            startAt: DateTime(2026, 8, 20, 9),
            endAt: DateTime(2026, 8, 20, 10),
            allDay: false,
          ),
        ],
      );

      final snapshot = await service.connect();

      expect(snapshot.isConnected, isTrue);
      expect(snapshot.importedEventCount, 1);
      final reloaded = await service.getSnapshot();
      expect(reloaded.importedEventCount, 1);
    });

    test('disconnect keeps retained data but stops active use', () async {
      bridge.authorizationStatus = AppleCalendarAuthorizationStatus.authorized;
      bridge.fetchResult = AppleCalendarFetchResult(
        authorizationStatus: AppleCalendarAuthorizationStatus.authorized,
        windowStart: DateTime(2026, 8, 19, 0),
        windowEnd: DateTime(2026, 9, 2, 0),
        busyBlocks: [
          ImportedCalendarBusyBlock(
            id: 'event-1',
            startAt: DateTime(2026, 8, 20, 9),
            endAt: DateTime(2026, 8, 20, 10),
            allDay: false,
          ),
        ],
      );
      await service.connect();

      final snapshot = await service.disconnect();

      expect(
        snapshot.connectionState,
        CalendarImportConnectionState.disconnected,
      );
      expect(snapshot.importedEventCount, 1);
    });

    test('deleteImportedData clears retained blocks', () async {
      bridge.authorizationStatus = AppleCalendarAuthorizationStatus.authorized;
      bridge.fetchResult = AppleCalendarFetchResult(
        authorizationStatus: AppleCalendarAuthorizationStatus.authorized,
        windowStart: DateTime(2026, 8, 19, 0),
        windowEnd: DateTime(2026, 9, 2, 0),
        busyBlocks: [
          ImportedCalendarBusyBlock(
            id: 'event-1',
            startAt: DateTime(2026, 8, 20, 9),
            endAt: DateTime(2026, 8, 20, 10),
            allDay: false,
          ),
        ],
      );
      await service.connect();

      final snapshot = await service.deleteImportedData();

      expect(snapshot.importedEventCount, 0);
      expect(snapshot.lastSyncedAt, isNull);
    });

    test(
      'permission denial leaves the app usable without imported data',
      () async {
        bridge.authorizationStatus = AppleCalendarAuthorizationStatus.denied;
        bridge.fetchResult = const AppleCalendarFetchResult(
          authorizationStatus: AppleCalendarAuthorizationStatus.denied,
          busyBlocks: <ImportedCalendarBusyBlock>[],
        );

        final snapshot = await service.connect();

        expect(snapshot.isPermissionDenied, isTrue);
        expect(snapshot.importedEventCount, 0);
      },
    );
  });
}

class FakeAppleCalendarBridge implements AppleCalendarBridge {
  AppleCalendarAuthorizationStatus authorizationStatus =
      AppleCalendarAuthorizationStatus.notDetermined;
  AppleCalendarFetchResult fetchResult = const AppleCalendarFetchResult(
    authorizationStatus: AppleCalendarAuthorizationStatus.notDetermined,
    busyBlocks: <ImportedCalendarBusyBlock>[],
  );

  @override
  Future<AppleCalendarAuthorizationStatus> getAuthorizationStatus() async {
    return authorizationStatus;
  }

  @override
  Future<AppleCalendarFetchResult> requestAccessAndFetchEvents({
    required int lookAheadDays,
  }) async {
    return fetchResult;
  }

  @override
  Future<AppleCalendarFetchResult> fetchEvents({
    required int lookAheadDays,
  }) async {
    return fetchResult;
  }
}
