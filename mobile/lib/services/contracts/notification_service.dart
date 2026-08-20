import 'package:flutter/foundation.dart';

import '../../models/pilot_presence.dart';

enum NotificationPermissionState { granted, denied, notDetermined }

enum NotificationActionType { aware, snooze, done }

@immutable
class ScheduledNotificationRequest {
  final String notificationId;
  final String commitmentId;
  final DateTime scheduledAt;
  final ReminderIntensity intensity;
  final List<NotificationActionType> actions;

  const ScheduledNotificationRequest({
    required this.notificationId,
    required this.commitmentId,
    required this.scheduledAt,
    required this.intensity,
    this.actions = const [
      NotificationActionType.aware,
      NotificationActionType.snooze,
      NotificationActionType.done,
    ],
  });
}

abstract interface class NotificationService {
  Future<NotificationPermissionState> permissionState();
  Future<NotificationPermissionState> requestPermission();
  Future<void> schedule(ScheduledNotificationRequest request);
  Future<void> cancelFor(String commitmentId);

  /// Cancel every reminder this app has pending with the platform.
  ///
  /// Needed for deletion, where the commitments whose ids [cancelFor] wants are
  /// themselves being erased.
  Future<void> cancelAll();
}
