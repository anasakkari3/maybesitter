import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../models/pilot_presence.dart';
import 'contracts/notification_service.dart';

/// What the operating system says about our permission to notify.
///
/// This is reported, never assumed. A product that tells the user reminders
/// are on when the OS has denied them is worse than one with no reminders.
enum NativeNotificationPermission { granted, denied, notDetermined }

/// A notification handed to the platform, in the platform's own terms.
@immutable
class ScheduledNativeNotification {
  /// The platform's integer handle. Derived from the stable notification id so
  /// re-scheduling replaces rather than duplicates.
  final int id;
  final String notificationId;
  final String commitmentId;
  final DateTime scheduledAt;
  final ReminderIntensity intensity;
  final List<NotificationActionType> actions;

  const ScheduledNativeNotification({
    required this.id,
    required this.notificationId,
    required this.commitmentId,
    required this.scheduledAt,
    required this.intensity,
    required this.actions,
  });
}

/// A user pressing Aware, Snooze, or Done on a delivered notification.
@immutable
class NativeNotificationActionEvent {
  final String commitmentId;
  final String notificationId;
  final NotificationActionType action;
  final DateTime occurredAt;

  const NativeNotificationActionEvent({
    required this.commitmentId,
    required this.notificationId,
    required this.action,
    required this.occurredAt,
  });
}

/// Read iOS's authorization booleans as one permission state.
///
/// Provisional authorization counts as granted. It is a real grant -- iOS
/// delivers the notification, quietly, without a prompt -- so reporting it as
/// denied would make the app refuse to schedule reminders that would have
/// arrived. Absent settings mean not determined, which is a question, not a no.
NativeNotificationPermission nativePermissionFrom({
  bool? isEnabled,
  bool? isProvisionalEnabled,
}) {
  if (isEnabled == null && isProvisionalEnabled == null) {
    return NativeNotificationPermission.notDetermined;
  }
  if (isEnabled == true || isProvisionalEnabled == true) {
    return NativeNotificationPermission.granted;
  }
  return NativeNotificationPermission.denied;
}

/// A notification the platform still has pending for us.
@immutable
class PendingNativeNotification {
  final int id;
  final String notificationId;
  final String commitmentId;

  const PendingNativeNotification({
    required this.id,
    required this.notificationId,
    required this.commitmentId,
  });
}

/// The seam between our reminder semantics and the notification plugin.
///
/// Everything platform-specific lives behind this so the scheduling rules can
/// be tested without a device, and so a second surface (Watch) consumes the
/// same action events rather than growing its own copy of the logic.
abstract interface class LocalNotificationsGateway {
  Future<void> initialize({
    required void Function(NativeNotificationActionEvent event) onAction,
  });
  Future<NativeNotificationPermission> checkPermission();
  Future<NativeNotificationPermission> requestPermission();
  Future<void> schedule(ScheduledNativeNotification notification);
  Future<void> cancel(int id);
  Future<List<PendingNativeNotification>> pending();

  /// An action that launched the app from a terminated state, if any.
  Future<NativeNotificationActionEvent?> takeLaunchAction();
}

/// Delivers reminders through the real operating system.
class NativeNotificationService implements NotificationService {
  final LocalNotificationsGateway gateway;

  /// Called when the platform refuses a request, so a silent failure to remind
  /// is visible instead of looking like a reminder that simply never fired.
  final void Function(String commitmentId, Object error)? onDeliveryFailure;

  /// Platform ids are integers, so we keep the mapping back to our own ids in
  /// order to cancel every stage a commitment owns.
  final Map<int, String> _commitmentIdByPlatformId = {};

  NativeNotificationService({required this.gateway, this.onDeliveryFailure});

  /// Rebuild our view of what is pending from the platform's own records.
  ///
  /// The platform outlives the process. After a relaunch the in-memory map is
  /// empty while the notifications are still scheduled, so without this a
  /// completed commitment would keep its reminder and fire anyway.
  Future<void> restoreFromPlatform() async {
    try {
      final pending = await gateway.pending();
      _commitmentIdByPlatformId
        ..clear()
        ..addEntries(
          pending.map(
            (notification) =>
                MapEntry(notification.id, notification.commitmentId),
          ),
        );
    } catch (error) {
      // A platform that cannot list its pending work is a reason to schedule
      // conservatively, not a reason to fail startup.
      onDeliveryFailure?.call('', error);
    }
  }

  @override
  Future<NotificationPermissionState> permissionState() async =>
      _translate(await gateway.checkPermission());

  @override
  Future<NotificationPermissionState> requestPermission() async =>
      _translate(await gateway.requestPermission());

  @override
  Future<void> schedule(ScheduledNotificationRequest request) async {
    // Asking the OS to schedule while denied would fail anyway; checking first
    // keeps the refusal honest rather than logging a platform error.
    if (await gateway.checkPermission() != NativeNotificationPermission.granted) {
      return;
    }

    final platformId = platformIdFor(request.notificationId);
    try {
      await gateway.schedule(
        ScheduledNativeNotification(
          id: platformId,
          notificationId: request.notificationId,
          commitmentId: request.commitmentId,
          scheduledAt: request.scheduledAt,
          intensity: request.intensity,
          actions: request.actions,
        ),
      );
      _commitmentIdByPlatformId[platformId] = request.commitmentId;
    } catch (error) {
      onDeliveryFailure?.call(request.commitmentId, error);
    }
  }

  @override
  Future<void> cancelFor(String commitmentId) async {
    final owned = _commitmentIdByPlatformId.entries
        .where((entry) => entry.value == commitmentId)
        .map((entry) => entry.key)
        .toList(growable: false);

    for (final platformId in owned) {
      try {
        await gateway.cancel(platformId);
        _commitmentIdByPlatformId.remove(platformId);
      } catch (error) {
        onDeliveryFailure?.call(commitmentId, error);
      }
    }
  }

  /// A stable 31-bit platform id for [notificationId].
  ///
  /// Stable so that re-syncing an unchanged commitment replaces its pending
  /// notification instead of adding a second one beside it.
  @visibleForTesting
  static int platformIdFor(String notificationId) {
    // FNV-1a, folded into the positive 31-bit range iOS and Android accept.
    var hash = 0x811c9dc5;
    for (final byte in utf8.encode(notificationId)) {
      hash ^= byte;
      hash = (hash * 0x01000193) & 0xffffffff;
    }
    return hash & 0x7fffffff;
  }

  NotificationPermissionState _translate(NativeNotificationPermission value) {
    return switch (value) {
      NativeNotificationPermission.granted =>
        NotificationPermissionState.granted,
      NativeNotificationPermission.denied => NotificationPermissionState.denied,
      NativeNotificationPermission.notDetermined =>
        NotificationPermissionState.notDetermined,
    };
  }
}
