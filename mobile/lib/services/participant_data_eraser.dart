import 'contracts/awareness_state_store.dart';
import 'contracts/calendar_import_service.dart';
import 'contracts/notification_service.dart';
import 'pilot_presence_snapshot_publisher.dart';

/// Removes everything this device holds for the participant.
///
/// Dropping the credential ends a session; it does not erase anything. What is
/// on the device outlives it: the imported calendar, the snapshot the widget
/// and the watch read, the record of what was acknowledged, and the reminders
/// iOS is already holding. "Delete my data" has to reach all of them, or it
/// deleted a token and left the data.
class ParticipantDataEraser {
  final CalendarImportService calendarImportService;
  final NotificationService notificationService;
  final AwarenessStateStore awarenessStateStore;
  final PilotPresenceSnapshotPublisher snapshotPublisher;

  const ParticipantDataEraser({
    required this.calendarImportService,
    required this.notificationService,
    required this.awarenessStateStore,
    required this.snapshotPublisher,
  });

  /// Erase every local store, continuing past any one that fails.
  ///
  /// A store that refuses must not shelter the others: a partial deletion that
  /// stops at the first error is how data survives a deletion request.
  Future<void> eraseEverything() async {
    await _attempt(calendarImportService.deleteImportedData);
    await _attempt(snapshotPublisher.clearWidgetSnapshot);
    await _attempt(() => awarenessStateStore.retainOnly(const {}));
    await _attempt(notificationService.cancelAll);
  }

  Future<void> _attempt(Future<void> Function() step) async {
    try {
      await step();
    } catch (_) {}
  }
}
