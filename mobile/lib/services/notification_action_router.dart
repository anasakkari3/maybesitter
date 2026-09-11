import 'contracts/notification_service.dart';
import 'native_notification_service.dart';
import 'soft_awareness_reminder_engine.dart';

/// Turns a button press on a notification into a canonical command.
///
/// This is the only route from a native surface into app state. The phone's
/// notification, the Watch, and any in-app control all arrive here, so Aware
/// cannot come to mean one thing on one surface and something else on another.
/// Nothing here decides policy -- it translates and hands off.
class NotificationActionRouter {
  final SoftAwarenessCommandDispatcher dispatcher;
  final Duration snoozeDuration;

  /// How close together two identical actions must be to count as one tap.
  final Duration replayWindow;

  /// When each (notification, action) pair was last applied.
  ///
  /// iOS can hand the same response to a relaunching app that already handled
  /// it live. The two paths stamp their own clock readings, so the instant
  /// cannot identify a replay -- the notification and the action can. Pressing
  /// snooze again much later is a real second decision, so the match is
  /// bounded by [replayWindow] rather than lasting forever.
  final Map<String, DateTime> _lastAppliedAt = {};

  NotificationActionRouter({
    required this.dispatcher,
    this.snoozeDuration = const Duration(minutes: 15),
    this.replayWindow = const Duration(minutes: 1),
  });

  Future<void> handle(NativeNotificationActionEvent event) async {
    final key = '${event.notificationId}|${event.action.name}';
    final previous = _lastAppliedAt[key];
    if (previous != null &&
        event.occurredAt.difference(previous).abs() < replayWindow) {
      return;
    }
    _lastAppliedAt[key] = event.occurredAt;

    await dispatcher.dispatch(_commandFor(event));
  }

  SoftAwarenessCommand _commandFor(NativeNotificationActionEvent event) {
    return switch (event.action) {
      // Aware says the user knows, and nothing more. It must never imply the
      // commitment happened.
      NotificationActionType.aware => MarkAwareNotificationCommand(
        commitmentId: event.commitmentId,
        occurredAt: event.occurredAt,
        notificationId: event.notificationId,
      ),
      NotificationActionType.snooze => SnoozeNotificationCommand(
        commitmentId: event.commitmentId,
        occurredAt: event.occurredAt,
        snoozedUntil: event.occurredAt.add(snoozeDuration),
        notificationId: event.notificationId,
      ),
      NotificationActionType.done => DoneNotificationCommand(
        commitmentId: event.commitmentId,
        occurredAt: event.occurredAt,
        notificationId: event.notificationId,
      ),
    };
  }
}
