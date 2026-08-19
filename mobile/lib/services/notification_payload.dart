import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../models/pilot_presence.dart';
import 'contracts/notification_service.dart';

/// What a notification carries so an action can be routed back to a commitment.
///
/// Deliberately identifiers only. The notification's visible text is built for
/// display and thrown away; the payload persists in the platform's notification
/// store, so putting a commitment title here would leak it somewhere the user's
/// privacy settings do not reach.
@immutable
class NotificationPayload {
  final String commitmentId;
  final String notificationId;
  final ReminderIntensity intensity;

  const NotificationPayload({
    required this.commitmentId,
    required this.notificationId,
    required this.intensity,
  });

  String encode() => jsonEncode({
    'commitmentId': commitmentId,
    'notificationId': notificationId,
    'intensity': intensity.name,
  });

  /// Decode [raw], or return null if it cannot be trusted.
  ///
  /// A payload we cannot read means we do not know which commitment the user
  /// acted on. Returning null drops the action; guessing would write the wrong
  /// commitment's state.
  static NotificationPayload? decode(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final commitmentId = decoded['commitmentId'];
      final notificationId = decoded['notificationId'];
      if (commitmentId is! String || commitmentId.isEmpty) return null;
      if (notificationId is! String || notificationId.isEmpty) return null;
      return NotificationPayload(
        commitmentId: commitmentId,
        notificationId: notificationId,
        intensity: ReminderIntensity.values.firstWhere(
          (value) => value.name == decoded['intensity'],
          orElse: () => ReminderIntensity.softAwareness,
        ),
      );
    } on FormatException {
      return null;
    }
  }
}

/// The identifier iOS uses for an action button.
String notificationActionId(NotificationActionType action) =>
    'com.maybesitter.notification.action.${action.name}';

/// The action a platform identifier refers to, or null if we do not know it.
///
/// Null is the honest answer for an unrecognised or absent identifier. Mapping
/// an unknown id onto a default would let a stray tap complete a commitment.
NotificationActionType? notificationActionFromId(String? id) {
  if (id == null) return null;
  for (final action in NotificationActionType.values) {
    if (notificationActionId(action) == id) return action;
  }
  return null;
}

/// The category grouping our three actions on a delivered notification.
const notificationCategoryId = 'com.maybesitter.notification.category.awareness';
