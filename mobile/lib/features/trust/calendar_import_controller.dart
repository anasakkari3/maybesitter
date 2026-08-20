import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/calendar_import.dart';
import '../../services/contracts/calendar_import_service.dart';
import '../../services/providers.dart';

enum CalendarImportStatus { loading, ready, failed }

class CalendarImportUiState {
  final CalendarImportStatus status;
  final CalendarImportSnapshot? snapshot;
  final bool applying;

  const CalendarImportUiState({
    this.status = CalendarImportStatus.loading,
    this.snapshot,
    this.applying = false,
  });

  CalendarImportUiState copyWith({
    CalendarImportStatus? status,
    CalendarImportSnapshot? snapshot,
    bool? applying,
  }) => CalendarImportUiState(
    status: status ?? this.status,
    snapshot: snapshot ?? this.snapshot,
    applying: applying ?? this.applying,
  );
}

class CalendarImportNotifier extends StateNotifier<CalendarImportUiState> {
  final CalendarImportService service;

  CalendarImportNotifier({required this.service})
    : super(const CalendarImportUiState()) {
    load();
  }

  Future<void> load() async {
    state = state.copyWith(status: CalendarImportStatus.loading);
    try {
      final snapshot = await service.getSnapshot();
      if (!mounted) return;
      state = CalendarImportUiState(
        status: CalendarImportStatus.ready,
        snapshot: snapshot,
      );
    } catch (_) {
      if (!mounted) return;
      state = state.copyWith(
        status: CalendarImportStatus.failed,
        applying: false,
      );
    }
  }

  Future<CalendarImportSnapshot?> connect() => _run(service.connect);

  Future<CalendarImportSnapshot?> refresh() => _run(service.refresh);

  /// Stop syncing, and keep what was already imported.
  ///
  /// Distinct from [withdrawConsent]: disconnecting says "no more", not
  /// "you may not have had this".
  Future<CalendarImportSnapshot?> disconnect() => _run(service.disconnect);

  /// The user has taken back permission for the calendar.
  ///
  /// Consent is the basis for holding the imported busy blocks, so removing it
  /// removes them. Anything less keeps a copy of someone's calendar after they
  /// said it may not be kept, which is the same as never having asked.
  Future<CalendarImportSnapshot?> withdrawConsent() =>
      _run(service.deleteImportedData);

  Future<CalendarImportSnapshot?> deleteImportedData() =>
      _run(service.deleteImportedData);

  Future<CalendarImportSnapshot?> _run(
    Future<CalendarImportSnapshot> Function() operation,
  ) async {
    state = state.copyWith(applying: true);
    try {
      final snapshot = await operation();
      if (!mounted) return null;
      state = CalendarImportUiState(
        status: CalendarImportStatus.ready,
        snapshot: snapshot,
      );
      return snapshot;
    } catch (_) {
      if (!mounted) return null;
      state = state.copyWith(
        status: CalendarImportStatus.failed,
        applying: false,
      );
      return null;
    }
  }
}

final calendarImportControllerProvider =
    StateNotifierProvider<CalendarImportNotifier, CalendarImportUiState>((ref) {
      return CalendarImportNotifier(
        service: ref.watch(calendarImportServiceProvider),
      );
    });
