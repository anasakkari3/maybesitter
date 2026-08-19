import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/timezone.dart' as tz;

import '../models/pilot_presence.dart';
import 'contracts/notification_service.dart';
import 'native_notification_service.dart';
import 'notification_payload.dart';

/// The real operating system, behind [LocalNotificationsGateway].
///
/// This class is the one place that talks to the notification plugin. It holds
/// no reminder policy of its own -- what to schedule and when is decided by the
/// engine, so the phone and the Watch cannot drift into disagreeing about what
/// Aware means. Its behaviour requires device verification; the rules it
/// carries out are unit-tested through [NativeNotificationService].
class FlutterLocalNotificationsGateway implements LocalNotificationsGateway {
  final FlutterLocalNotificationsPlugin _plugin;
  final String Function() localTimezoneName;

  FlutterLocalNotificationsGateway({
    FlutterLocalNotificationsPlugin? plugin,
    required this.localTimezoneName,
  }) : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  void Function(NativeNotificationActionEvent event)? _onAction;

  @override
  Future<void> initialize({
    required void Function(NativeNotificationActionEvent event) onAction,
  }) async {
    _onAction = onAction;

    final actions = [
      for (final action in NotificationActionType.values)
        DarwinNotificationAction.plain(
          notificationActionId(action),
          _actionTitle(action),
          options: {
            // Acting from the notification should not drag the user into the
            // app. The whole point of Aware is that it costs one tap.
            if (action == NotificationActionType.done)
              DarwinNotificationActionOption.destructive,
          },
        ),
    ];

    await _plugin.initialize(
      InitializationSettings(
        iOS: DarwinInitializationSettings(
          // Permission is requested explicitly, when the user has been told
          // why, rather than silently at startup.
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
          notificationCategories: [
            DarwinNotificationCategory(notificationCategoryId, actions: actions),
          ],
        ),
        android: const AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: _handleResponse,
    );
  }

  void _handleResponse(NotificationResponse response) {
    final action = notificationActionFromId(response.actionId);
    final payload = NotificationPayload.decode(response.payload);
    // Both must be known. An action without a commitment, or a commitment
    // without an action, is not something to guess at.
    if (action == null || payload == null) return;

    _onAction?.call(
      NativeNotificationActionEvent(
        commitmentId: payload.commitmentId,
        notificationId: payload.notificationId,
        action: action,
        occurredAt: DateTime.now(),
      ),
    );
  }

  @override
  Future<NativeNotificationPermission> checkPermission() async {
    final ios = _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >();
    if (ios == null) return NativeNotificationPermission.notDetermined;

    final options = await ios.checkPermissions();
    if (options == null) return NativeNotificationPermission.notDetermined;
    return options.isEnabled
        ? NativeNotificationPermission.granted
        : NativeNotificationPermission.denied;
  }

  @override
  Future<NativeNotificationPermission> requestPermission() async {
    final ios = _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >();
    if (ios == null) return NativeNotificationPermission.notDetermined;

    // The OS decides. We report what it says -- never a hopeful default.
    final granted = await ios.requestPermissions(
      alert: true,
      badge: true,
      sound: true,
    );
    if (granted == null) return NativeNotificationPermission.notDetermined;
    return granted
        ? NativeNotificationPermission.granted
        : NativeNotificationPermission.denied;
  }

  @override
  Future<void> schedule(ScheduledNativeNotification notification) async {
    final payload = NotificationPayload(
      commitmentId: notification.commitmentId,
      notificationId: notification.notificationId,
      intensity: notification.intensity,
    );

    await _plugin.zonedSchedule(
      notification.id,
      _title(notification.intensity),
      _body(notification.intensity),
      _inLocalZone(notification.scheduledAt),
      NotificationDetails(
        iOS: DarwinNotificationDetails(
          categoryIdentifier: notificationCategoryId,
          // A soft reminder should not behave like an alarm; escalation is the
          // only stage allowed to make noise.
          presentSound:
              notification.intensity != ReminderIntensity.softAwareness,
          interruptionLevel:
              notification.intensity == ReminderIntensity.strongReminder
              ? InterruptionLevel.timeSensitive
              : InterruptionLevel.active,
        ),
        android: AndroidNotificationDetails(
          'maybesitter_awareness',
          'Commitment reminders',
          importance: notification.intensity == ReminderIntensity.strongReminder
              ? Importance.high
              : Importance.defaultImportance,
        ),
      ),
      androidScheduleMode: AndroidScheduleMode.exactAllowWhileIdle,
      // Absolute time: the reminder is pinned to the instant the zone above
      // resolves, so a DST shift moves the notification with the wall clock
      // rather than leaving it an hour out.
      uiLocalNotificationDateInterpretation:
          UILocalNotificationDateInterpretation.absoluteTime,
      payload: payload.encode(),
    );
  }

  /// Interpret a wall-clock reminder time in the user's current zone.
  ///
  /// Reminders are anchored to local wall time: "one hour before the 15:00
  /// appointment" must stay one hour before it if the user flies somewhere or
  /// the clocks shift.
  tz.TZDateTime _inLocalZone(DateTime when) {
    final location = tz.getLocation(localTimezoneName());
    return tz.TZDateTime(
      location,
      when.year,
      when.month,
      when.day,
      when.hour,
      when.minute,
      when.second,
    );
  }

  @override
  Future<void> cancel(int id) => _plugin.cancel(id);

  @override
  Future<List<PendingNativeNotification>> pending() async {
    final requests = await _plugin.pendingNotificationRequests();
    final restored = <PendingNativeNotification>[];
    for (final request in requests) {
      final payload = NotificationPayload.decode(request.payload);
      if (payload == null) continue;
      restored.add(
        PendingNativeNotification(
          id: request.id,
          notificationId: payload.notificationId,
          commitmentId: payload.commitmentId,
        ),
      );
    }
    return restored;
  }

  @override
  Future<NativeNotificationActionEvent?> takeLaunchAction() async {
    final details = await _plugin.getNotificationAppLaunchDetails();
    final response = details?.notificationResponse;
    if (details?.didNotificationLaunchApp != true || response == null) {
      return null;
    }

    final action = notificationActionFromId(response.actionId);
    final payload = NotificationPayload.decode(response.payload);
    if (action == null || payload == null) return null;

    return NativeNotificationActionEvent(
      commitmentId: payload.commitmentId,
      notificationId: payload.notificationId,
      action: action,
      occurredAt: DateTime.now(),
    );
  }

  @visibleForTesting
  static String actionTitleFor(NotificationActionType action) =>
      _actionTitleOf(action);

  String _actionTitle(NotificationActionType action) => _actionTitleOf(action);

  static String _actionTitleOf(NotificationActionType action) {
    return switch (action) {
      NotificationActionType.aware => 'I know',
      NotificationActionType.snooze => 'Later',
      NotificationActionType.done => 'Done',
    };
  }

  String _title(ReminderIntensity intensity) {
    return switch (intensity) {
      ReminderIntensity.strongReminder => 'Starting soon',
      ReminderIntensity.followUp => 'Still coming up',
      _ => 'Coming up',
    };
  }

  /// Notification text never names the commitment.
  ///
  /// A reminder appears on a lock screen anyone nearby can read. The user opens
  /// the app to see what it is; the notification only says that something needs
  /// them.
  String _body(ReminderIntensity intensity) {
    return switch (intensity) {
      ReminderIntensity.strongReminder =>
        'Something important starts shortly. Open MaybeSitter for details.',
      ReminderIntensity.followUp =>
        'A commitment is still waiting on you. Open MaybeSitter for details.',
      _ => 'You have a commitment coming up. Open MaybeSitter for details.',
    };
  }
}
