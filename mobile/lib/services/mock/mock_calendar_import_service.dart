import '../../models/calendar_import.dart';
import '../contracts/calendar_import_service.dart';

class MockCalendarImportService implements CalendarImportService {
  CalendarImportSnapshot _snapshot;
  bool connectSucceeds;
  bool permissionDeniedOnConnect;

  MockCalendarImportService({
    CalendarImportSnapshot? snapshot,
    this.connectSucceeds = true,
    this.permissionDeniedOnConnect = false,
  }) : _snapshot =
           snapshot ??
           const CalendarImportSnapshot(
             provider: CalendarImportProvider.appleCalendar,
             connectionState: CalendarImportConnectionState.disconnected,
             retainedBusyBlocks: <ImportedCalendarBusyBlock>[],
           );

  @override
  Future<CalendarImportSnapshot> getSnapshot() async => _snapshot;

  @override
  Future<CalendarImportSnapshot> connect() async {
    if (permissionDeniedOnConnect) {
      _snapshot = _snapshot.copyWith(
        connectionState: CalendarImportConnectionState.permissionDenied,
      );
      return _snapshot;
    }
    if (!connectSucceeds) {
      throw Exception('calendar connect failed');
    }
    _snapshot = CalendarImportSnapshot(
      provider: CalendarImportProvider.appleCalendar,
      connectionState: CalendarImportConnectionState.connected,
      lastSyncedAt: DateTime.utc(2026, 8, 19, 9).toLocal(),
      importedWindowStart: DateTime.utc(2026, 8, 19).toLocal(),
      importedWindowEnd: DateTime.utc(2026, 9, 2).toLocal(),
      retainedBusyBlocks: _snapshot.retainedBusyBlocks.isEmpty
          ? <ImportedCalendarBusyBlock>[
              ImportedCalendarBusyBlock(
                id: 'event-1',
                startAt: DateTime.utc(2026, 8, 20, 9).toLocal(),
                endAt: DateTime.utc(2026, 8, 20, 10).toLocal(),
                allDay: false,
              ),
            ]
          : _snapshot.retainedBusyBlocks,
    );
    return _snapshot;
  }

  @override
  Future<CalendarImportSnapshot> refresh() async {
    if (_snapshot.isPermissionDenied || !_snapshot.isSupported) {
      return _snapshot;
    }
    _snapshot = _snapshot.copyWith(
      lastSyncedAt: DateTime.utc(2026, 8, 19, 10).toLocal(),
    );
    return _snapshot;
  }

  @override
  Future<CalendarImportSnapshot> disconnect() async {
    _snapshot = _snapshot.copyWith(
      connectionState: _snapshot.isSupported
          ? CalendarImportConnectionState.disconnected
          : CalendarImportConnectionState.unsupported,
    );
    return _snapshot;
  }

  @override
  Future<CalendarImportSnapshot> deleteImportedData() async {
    _snapshot = _snapshot.copyWith(
      connectionState: _snapshot.isSupported
          ? CalendarImportConnectionState.disconnected
          : CalendarImportConnectionState.unsupported,
      retainedBusyBlocks: const <ImportedCalendarBusyBlock>[],
      clearLastSyncedAt: true,
      clearImportedWindowStart: true,
      clearImportedWindowEnd: true,
    );
    return _snapshot;
  }
}
