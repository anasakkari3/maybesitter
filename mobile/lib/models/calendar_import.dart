import 'package:flutter/foundation.dart';

enum CalendarImportProvider { appleCalendar }

extension CalendarImportProviderWire on CalendarImportProvider {
  String get analyticsValue {
    switch (this) {
      case CalendarImportProvider.appleCalendar:
        return 'apple_calendar';
    }
  }
}

enum CalendarImportConnectionState {
  disconnected,
  connected,
  permissionDenied,
  unsupported,
}

@immutable
class ImportedCalendarBusyBlock {
  final String id;
  final DateTime startAt;
  final DateTime endAt;
  final bool allDay;

  const ImportedCalendarBusyBlock({
    required this.id,
    required this.startAt,
    required this.endAt,
    required this.allDay,
  });

  Map<String, dynamic> toJson() => {
    'id': id,
    'startAt': startAt.toIso8601String(),
    'endAt': endAt.toIso8601String(),
    'allDay': allDay,
  };

  factory ImportedCalendarBusyBlock.fromJson(Map<String, dynamic> json) =>
      ImportedCalendarBusyBlock(
        id: json['id'] as String,
        startAt: DateTime.parse(json['startAt'] as String).toLocal(),
        endAt: DateTime.parse(json['endAt'] as String).toLocal(),
        allDay: json['allDay'] as bool? ?? false,
      );
}

@immutable
class CalendarImportSnapshot {
  final CalendarImportProvider provider;
  final CalendarImportConnectionState connectionState;
  final DateTime? lastSyncedAt;
  final DateTime? importedWindowStart;
  final DateTime? importedWindowEnd;
  final List<ImportedCalendarBusyBlock> retainedBusyBlocks;

  const CalendarImportSnapshot({
    required this.provider,
    required this.connectionState,
    required this.retainedBusyBlocks,
    this.lastSyncedAt,
    this.importedWindowStart,
    this.importedWindowEnd,
  });

  static const unsupported = CalendarImportSnapshot(
    provider: CalendarImportProvider.appleCalendar,
    connectionState: CalendarImportConnectionState.unsupported,
    retainedBusyBlocks: <ImportedCalendarBusyBlock>[],
  );

  bool get isConnected =>
      connectionState == CalendarImportConnectionState.connected;
  bool get isSupported =>
      connectionState != CalendarImportConnectionState.unsupported;
  bool get isPermissionDenied =>
      connectionState == CalendarImportConnectionState.permissionDenied;
  bool get hasRetainedData => retainedBusyBlocks.isNotEmpty;
  int get importedEventCount => retainedBusyBlocks.length;

  CalendarImportSnapshot copyWith({
    CalendarImportProvider? provider,
    CalendarImportConnectionState? connectionState,
    DateTime? lastSyncedAt,
    bool clearLastSyncedAt = false,
    DateTime? importedWindowStart,
    bool clearImportedWindowStart = false,
    DateTime? importedWindowEnd,
    bool clearImportedWindowEnd = false,
    List<ImportedCalendarBusyBlock>? retainedBusyBlocks,
  }) => CalendarImportSnapshot(
    provider: provider ?? this.provider,
    connectionState: connectionState ?? this.connectionState,
    lastSyncedAt: clearLastSyncedAt
        ? null
        : (lastSyncedAt ?? this.lastSyncedAt),
    importedWindowStart: clearImportedWindowStart
        ? null
        : (importedWindowStart ?? this.importedWindowStart),
    importedWindowEnd: clearImportedWindowEnd
        ? null
        : (importedWindowEnd ?? this.importedWindowEnd),
    retainedBusyBlocks: retainedBusyBlocks ?? this.retainedBusyBlocks,
  );

  Map<String, dynamic> toJson() => {
    'provider': provider.name,
    'connectionState': connectionState.name,
    'lastSyncedAt': lastSyncedAt?.toIso8601String(),
    'importedWindowStart': importedWindowStart?.toIso8601String(),
    'importedWindowEnd': importedWindowEnd?.toIso8601String(),
    'retainedBusyBlocks': retainedBusyBlocks
        .map((event) => event.toJson())
        .toList(),
  };

  factory CalendarImportSnapshot.fromJson(Map<String, dynamic> json) {
    final blocks =
        (json['retainedBusyBlocks'] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(ImportedCalendarBusyBlock.fromJson)
            .toList(growable: false);
    return CalendarImportSnapshot(
      provider: CalendarImportProvider.values.byName(
        json['provider'] as String? ??
            CalendarImportProvider.appleCalendar.name,
      ),
      connectionState: CalendarImportConnectionState.values.byName(
        json['connectionState'] as String? ??
            CalendarImportConnectionState.disconnected.name,
      ),
      lastSyncedAt: _parseDate(json['lastSyncedAt'] as String?),
      importedWindowStart: _parseDate(json['importedWindowStart'] as String?),
      importedWindowEnd: _parseDate(json['importedWindowEnd'] as String?),
      retainedBusyBlocks: blocks,
    );
  }

  static DateTime? _parseDate(String? value) {
    if (value == null || value.isEmpty) return null;
    return DateTime.parse(value).toLocal();
  }
}
