import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/platform/platform_adaptive.dart';
import '../models/calendar_import.dart';
import '../models/pilot_loop_analytics.dart';
import 'contracts/calendar_import_service.dart';
import 'contracts/pilot_loop_analytics_service.dart';

enum AppleCalendarAuthorizationStatus {
  authorized,
  denied,
  notDetermined,
  restricted,
  unsupported,
  writeOnly,
}

@immutable
class AppleCalendarFetchResult {
  final AppleCalendarAuthorizationStatus authorizationStatus;
  final DateTime? windowStart;
  final DateTime? windowEnd;
  final List<ImportedCalendarBusyBlock> busyBlocks;

  const AppleCalendarFetchResult({
    required this.authorizationStatus,
    required this.busyBlocks,
    this.windowStart,
    this.windowEnd,
  });
}

abstract interface class AppleCalendarBridge {
  Future<AppleCalendarAuthorizationStatus> getAuthorizationStatus();

  Future<AppleCalendarFetchResult> requestAccessAndFetchEvents({
    required int lookAheadDays,
  });

  Future<AppleCalendarFetchResult> fetchEvents({required int lookAheadDays});
}

class MethodChannelAppleCalendarBridge implements AppleCalendarBridge {
  static const _channel = MethodChannel(
    'com.maybesitter.mobile/apple_calendar_import',
  );

  @override
  Future<AppleCalendarAuthorizationStatus> getAuthorizationStatus() async {
    if (!PlatformAdaptive.isIOS) {
      return AppleCalendarAuthorizationStatus.unsupported;
    }
    final raw = await _channel.invokeMethod<String>('authorizationStatus');
    return _statusFromWire(raw);
  }

  @override
  Future<AppleCalendarFetchResult> requestAccessAndFetchEvents({
    required int lookAheadDays,
  }) async {
    if (!PlatformAdaptive.isIOS) {
      return const AppleCalendarFetchResult(
        authorizationStatus: AppleCalendarAuthorizationStatus.unsupported,
        busyBlocks: <ImportedCalendarBusyBlock>[],
      );
    }
    final raw = await _channel.invokeMapMethod<String, dynamic>(
      'requestAccessAndFetchEvents',
      {'lookAheadDays': lookAheadDays},
    );
    return _resultFromWire(raw);
  }

  @override
  Future<AppleCalendarFetchResult> fetchEvents({
    required int lookAheadDays,
  }) async {
    if (!PlatformAdaptive.isIOS) {
      return const AppleCalendarFetchResult(
        authorizationStatus: AppleCalendarAuthorizationStatus.unsupported,
        busyBlocks: <ImportedCalendarBusyBlock>[],
      );
    }
    final raw = await _channel.invokeMapMethod<String, dynamic>('fetchEvents', {
      'lookAheadDays': lookAheadDays,
    });
    return _resultFromWire(raw);
  }

  AppleCalendarFetchResult _resultFromWire(Map<String, dynamic>? raw) {
    final events = (raw?['events'] as List<dynamic>? ?? const <dynamic>[])
        .whereType<Map<dynamic, dynamic>>()
        .map(
          (event) => ImportedCalendarBusyBlock.fromJson(
            event.map((key, value) => MapEntry(key.toString(), value)),
          ),
        )
        .toList(growable: false);
    return AppleCalendarFetchResult(
      authorizationStatus: _statusFromWire(raw?['status'] as String?),
      windowStart: _parseDate(raw?['windowStart'] as String?),
      windowEnd: _parseDate(raw?['windowEnd'] as String?),
      busyBlocks: events,
    );
  }

  AppleCalendarAuthorizationStatus _statusFromWire(String? raw) {
    switch (raw) {
      case 'authorized':
        return AppleCalendarAuthorizationStatus.authorized;
      case 'denied':
        return AppleCalendarAuthorizationStatus.denied;
      case 'not_determined':
        return AppleCalendarAuthorizationStatus.notDetermined;
      case 'restricted':
        return AppleCalendarAuthorizationStatus.restricted;
      case 'write_only':
        return AppleCalendarAuthorizationStatus.writeOnly;
      default:
        return AppleCalendarAuthorizationStatus.unsupported;
    }
  }

  DateTime? _parseDate(String? value) {
    if (value == null || value.isEmpty) return null;
    return DateTime.parse(value).toLocal();
  }
}

class AppleCalendarImportService implements CalendarImportService {
  static const int lookAheadDays = 14;
  static const _prefsKey = 'apple_calendar_import_snapshot_v1';

  final AppleCalendarBridge bridge;
  final Future<SharedPreferences> Function() sharedPreferences;
  final PilotLoopAnalyticsService? analyticsService;

  AppleCalendarImportService({
    AppleCalendarBridge? bridge,
    Future<SharedPreferences> Function()? sharedPreferences,
    this.analyticsService,
  }) : bridge = bridge ?? MethodChannelAppleCalendarBridge(),
       sharedPreferences = sharedPreferences ?? SharedPreferences.getInstance;

  @override
  Future<CalendarImportSnapshot> getSnapshot() async {
    final persisted = await _readSnapshot();
    final status = await bridge.getAuthorizationStatus();
    final normalized = _normalizeAuthorization(persisted, status);
    await _writeSnapshot(normalized);
    return normalized;
  }

  @override
  Future<CalendarImportSnapshot> connect() async {
    await analyticsService?.record(
      PilotLoopAnalyticsEvent.calendarConnectionStarted(
        provider: CalendarImportProvider.appleCalendar.analyticsValue,
      ),
    );
    final result = await bridge.requestAccessAndFetchEvents(
      lookAheadDays: lookAheadDays,
    );
    final snapshot = await _snapshotFromFetch(result);
    if (snapshot.isConnected) {
      await analyticsService?.record(
        PilotLoopAnalyticsEvent.calendarConnected(
          provider: CalendarImportProvider.appleCalendar.analyticsValue,
        ),
      );
    }
    return snapshot;
  }

  @override
  Future<CalendarImportSnapshot> refresh() async {
    final result = await bridge.fetchEvents(lookAheadDays: lookAheadDays);
    return _snapshotFromFetch(result);
  }

  @override
  Future<CalendarImportSnapshot> disconnect() async {
    final current = await _readSnapshot();
    final next = current.copyWith(
      connectionState: current.isSupported
          ? CalendarImportConnectionState.disconnected
          : CalendarImportConnectionState.unsupported,
    );
    await _writeSnapshot(next);
    return next;
  }

  @override
  Future<CalendarImportSnapshot> deleteImportedData() async {
    final current = await _readSnapshot();
    final next = current.copyWith(
      connectionState: current.isSupported
          ? CalendarImportConnectionState.disconnected
          : CalendarImportConnectionState.unsupported,
      retainedBusyBlocks: const <ImportedCalendarBusyBlock>[],
      clearLastSyncedAt: true,
      clearImportedWindowStart: true,
      clearImportedWindowEnd: true,
    );
    await _writeSnapshot(next);
    return next;
  }

  Future<CalendarImportSnapshot> _snapshotFromFetch(
    AppleCalendarFetchResult result,
  ) async {
    final current = await _readSnapshot();
    final next = switch (result.authorizationStatus) {
      AppleCalendarAuthorizationStatus.authorized => CalendarImportSnapshot(
        provider: CalendarImportProvider.appleCalendar,
        connectionState: CalendarImportConnectionState.connected,
        lastSyncedAt: DateTime.now().toLocal(),
        importedWindowStart: result.windowStart,
        importedWindowEnd: result.windowEnd,
        retainedBusyBlocks: result.busyBlocks,
      ),
      AppleCalendarAuthorizationStatus.denied ||
      AppleCalendarAuthorizationStatus.restricted ||
      AppleCalendarAuthorizationStatus.writeOnly => current.copyWith(
        connectionState: CalendarImportConnectionState.permissionDenied,
      ),
      AppleCalendarAuthorizationStatus.notDetermined => current.copyWith(
        connectionState: CalendarImportConnectionState.disconnected,
      ),
      AppleCalendarAuthorizationStatus.unsupported => current.copyWith(
        connectionState: CalendarImportConnectionState.unsupported,
      ),
    };
    await _writeSnapshot(next);
    return next;
  }

  CalendarImportSnapshot _normalizeAuthorization(
    CalendarImportSnapshot current,
    AppleCalendarAuthorizationStatus status,
  ) {
    switch (status) {
      case AppleCalendarAuthorizationStatus.authorized:
        return current.copyWith(
          connectionState: current.isConnected
              ? CalendarImportConnectionState.connected
              : CalendarImportConnectionState.disconnected,
        );
      case AppleCalendarAuthorizationStatus.denied:
      case AppleCalendarAuthorizationStatus.restricted:
      case AppleCalendarAuthorizationStatus.writeOnly:
        return current.copyWith(
          connectionState: CalendarImportConnectionState.permissionDenied,
        );
      case AppleCalendarAuthorizationStatus.notDetermined:
        return current.copyWith(
          connectionState: CalendarImportConnectionState.disconnected,
        );
      case AppleCalendarAuthorizationStatus.unsupported:
        return current.copyWith(
          connectionState: CalendarImportConnectionState.unsupported,
        );
    }
  }

  Future<CalendarImportSnapshot> _readSnapshot() async {
    final prefs = await sharedPreferences();
    final raw = prefs.getString(_prefsKey);
    if (raw == null || raw.isEmpty) {
      return const CalendarImportSnapshot(
        provider: CalendarImportProvider.appleCalendar,
        connectionState: CalendarImportConnectionState.disconnected,
        retainedBusyBlocks: <ImportedCalendarBusyBlock>[],
      );
    }
    return CalendarImportSnapshot.fromJson(
      jsonDecode(raw) as Map<String, dynamic>,
    );
  }

  Future<void> _writeSnapshot(CalendarImportSnapshot snapshot) async {
    final prefs = await sharedPreferences();
    await prefs.setString(_prefsKey, jsonEncode(snapshot.toJson()));
  }
}
