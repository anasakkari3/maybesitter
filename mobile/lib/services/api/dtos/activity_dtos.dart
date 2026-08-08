import 'package:flutter/foundation.dart';

@immutable
class ReminderAttemptDto {
  final String id;
  final String itemId;
  final String? userId;
  final String type; // 'reminder' | 'escalation'
  final String channel;
  final String status;
  final String idempotencyKey;
  final String scheduledFor;
  final String? sentAt;
  final int attemptNumber;
  final String? nextRetryAt;
  final int? escalationLevel;
  final String? error;

  const ReminderAttemptDto({
    required this.id,
    required this.itemId,
    this.userId,
    required this.type,
    required this.channel,
    required this.status,
    required this.idempotencyKey,
    required this.scheduledFor,
    this.sentAt,
    this.attemptNumber = 1,
    this.nextRetryAt,
    this.escalationLevel,
    this.error,
  });

  factory ReminderAttemptDto.fromJson(Map<String, dynamic> json) {
    return ReminderAttemptDto(
      id: json['id'] as String? ?? '',
      itemId: json['itemId'] as String? ?? '',
      userId: json['userId'] as String?,
      type: json['type'] as String? ?? 'reminder',
      channel: json['channel'] as String? ?? 'push',
      status: json['status'] as String? ?? 'sent',
      idempotencyKey: json['idempotencyKey'] as String? ?? '',
      scheduledFor:
          json['scheduledFor'] as String? ?? DateTime.now().toIso8601String(),
      sentAt: json['sentAt'] as String?,
      attemptNumber: json['attemptNumber'] as int? ?? 1,
      nextRetryAt: json['nextRetryAt'] as String?,
      escalationLevel: json['escalationLevel'] as int?,
      error: json['error'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'itemId': itemId,
    'userId': userId,
    'type': type,
    'channel': channel,
    'status': status,
    'idempotencyKey': idempotencyKey,
    'scheduledFor': scheduledFor,
    'sentAt': sentAt,
    'attemptNumber': attemptNumber,
    'nextRetryAt': nextRetryAt,
    'escalationLevel': escalationLevel,
    'error': error,
  };
}

@immutable
class ActivityListResponseDto {
  final List<ReminderAttemptDto> activity;

  const ActivityListResponseDto({required this.activity});

  factory ActivityListResponseDto.fromJson(Map<String, dynamic> json) {
    final rawActivity = json['activity'] as List<dynamic>? ?? [];
    return ActivityListResponseDto(
      activity: rawActivity
          .map((e) => ReminderAttemptDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    'activity': activity.map((e) => e.toJson()).toList(),
  };
}
