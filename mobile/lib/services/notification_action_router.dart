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

  /// Actions already applied, so a redelivery cannot apply one twice.
  ///
  /// iOS can hand the same response to a relaunching app that already handled
  /// it live, and a single tap must not snooze a reminder twice.
  final Set<String> _appliedActions = <String>{};

  NotificationActionRouter({
    required this.dispatcher,
    this.snoozeDuration = const Duration(minutes: 15),
  });

  Future<void> handle(NativeNotificationActionEvent event) async {
    final fingerprint =
        '${event.notificationId}|${event.action.name}|'
        '${event.occurredAt.toUtc().millisecondsSinceEpoch}';
    if (!_appliedActions.add(fingerprint)) return;

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
