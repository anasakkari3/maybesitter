import 'package:flutter/foundation.dart';

enum ActivityEventType {
  commitmentCreated,
  commitmentCompleted,
  commitmentPostponed,
  commitmentDeleted,
  aiCaptureExtracted,
  aiClarificationResolved,
  permissionChanged;

  String get defaultTitle {
    switch (this) {
      case ActivityEventType.commitmentCreated:
        return 'Commitment Created';
      case ActivityEventType.commitmentCompleted:
        return 'Commitment Completed';
      case ActivityEventType.commitmentPostponed:
        return 'Commitment Postponed';
      case ActivityEventType.commitmentDeleted:
        return 'Commitment Deleted';
      case ActivityEventType.aiCaptureExtracted:
        return 'Plan Extracted by AI';
      case ActivityEventType.aiClarificationResolved:
        return 'Clarification Resolved';
      case ActivityEventType.permissionChanged:
        return 'Settings Updated';
    }
  }
}

@immutable
class ActivityEvent {
  final String id;
  final ActivityEventType type;
  final String title;
  final String description;
  final DateTime timestamp;
  final String? relatedCommitmentId;
  final String? iconName;

  const ActivityEvent({
    required this.id,
    required this.type,
    required this.title,
    required this.description,
    required this.timestamp,
    this.relatedCommitmentId,
    this.iconName,
  });
}
