import 'package:flutter/foundation.dart';

@immutable
class BackendCommitmentPriorityDto {
  final String level; // 'low' | 'normal' | 'high'
  final String source; // 'default' | 'inferred' | 'user_explicit'
  final bool pressureAllowed;
  final String pressureLevel; // 'none' | 'gentle' | 'firm'

  const BackendCommitmentPriorityDto({
    required this.level,
    this.source = 'default',
    this.pressureAllowed = false,
    this.pressureLevel = 'none',
  });

  factory BackendCommitmentPriorityDto.fromJson(Map<String, dynamic> json) {
    return BackendCommitmentPriorityDto(
      level: json['level'] as String? ?? 'normal',
      source: json['source'] as String? ?? 'default',
      pressureAllowed: json['pressureAllowed'] as bool? ?? false,
      pressureLevel: json['pressureLevel'] as String? ?? 'none',
    );
  }

  Map<String, dynamic> toJson() => {
    'level': level,
    'source': source,
    'pressureAllowed': pressureAllowed,
    'pressureLevel': pressureLevel,
  };
}

@immutable
class BackendTimeSpecDto {
  final String kind; // 'unscheduled' | 'due_by' | 'scheduled_event'
  final String? dueAt;
  final String? remindAt;
  final String timezone;

  const BackendTimeSpecDto({
    required this.kind,
    this.dueAt,
    this.remindAt,
    this.timezone = 'Asia/Jerusalem',
  });

  factory BackendTimeSpecDto.fromJson(Map<String, dynamic> json) {
    return BackendTimeSpecDto(
      kind: json['kind'] as String? ?? 'unscheduled',
      dueAt: json['dueAt'] as String?,
      remindAt: json['remindAt'] as String?,
      timezone: json['timezone'] as String? ?? 'Asia/Jerusalem',
    );
  }

  Map<String, dynamic> toJson() => {
    'kind': kind,
    'dueAt': dueAt,
    'remindAt': remindAt,
    'timezone': timezone,
  };
}

@immutable
class BackendCommitmentDto {
  final String id;
  final String kind; // 'task' | 'follow_up'
  final String title;
  final String? description;
  final String? person;
  final String
  status; // 'draft'|'needs_clarification'|'pending_confirmation'|'active'|'deferred'|'completed'|'dropped'|'missed'|'archived'
  final BackendCommitmentPriorityDto priority;
  final BackendTimeSpecDto timeSpec;
  final String currentAckState;
  final String? postponedUntil;
  final String createdAt;
  final String updatedAt;
  final String? confirmedAt;
  final String? completedAt;
  final String? droppedAt;

  const BackendCommitmentDto({
    required this.id,
    this.kind = 'task',
    required this.title,
    this.description,
    this.person,
    required this.status,
    required this.priority,
    required this.timeSpec,
    this.currentAckState = 'not_seen',
    this.postponedUntil,
    required this.createdAt,
    required this.updatedAt,
    this.confirmedAt,
    this.completedAt,
    this.droppedAt,
  });

  factory BackendCommitmentDto.fromJson(Map<String, dynamic> json) {
    final rawPriority = json['priority'] as Map<String, dynamic>? ?? {};
    final rawTimeSpec = json['timeSpec'] as Map<String, dynamic>? ?? {};

    return BackendCommitmentDto(
      id: json['id'] as String? ?? '',
      kind: json['kind'] as String? ?? 'task',
      title: json['title'] as String? ?? '',
      description: json['description'] as String?,
      person: json['person'] as String?,
      status: json['status'] as String? ?? 'active',
      priority: BackendCommitmentPriorityDto.fromJson(rawPriority),
      timeSpec: BackendTimeSpecDto.fromJson(rawTimeSpec),
      currentAckState: json['currentAckState'] as String? ?? 'not_seen',
      postponedUntil: json['postponedUntil'] as String?,
      createdAt:
          json['createdAt'] as String? ?? DateTime.now().toIso8601String(),
      updatedAt:
          json['updatedAt'] as String? ?? DateTime.now().toIso8601String(),
      confirmedAt: json['confirmedAt'] as String?,
      completedAt: json['completedAt'] as String?,
      droppedAt: json['droppedAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind,
    'title': title,
    'description': description,
    'person': person,
    'status': status,
    'priority': priority.toJson(),
    'timeSpec': timeSpec.toJson(),
    'currentAckState': currentAckState,
    'postponedUntil': postponedUntil,
    'createdAt': createdAt,
    'updatedAt': updatedAt,
    'confirmedAt': confirmedAt,
    'completedAt': completedAt,
    'droppedAt': droppedAt,
  };
}

@immutable
class CommitmentListResponseDto {
  final List<BackendCommitmentDto> items;

  const CommitmentListResponseDto({required this.items});

  factory CommitmentListResponseDto.fromJson(Map<String, dynamic> json) {
    final rawItems = json['items'] as List<dynamic>? ?? [];
    return CommitmentListResponseDto(
      items: rawItems
          .map((e) => BackendCommitmentDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    'items': items.map((e) => e.toJson()).toList(),
  };
}

@immutable
class SoftDeleteResponseDto {
  final bool success;
  final String id;
  final bool deleted;
  final bool softDeleted;
  final String status;

  const SoftDeleteResponseDto({
    required this.success,
    required this.id,
    required this.deleted,
    required this.softDeleted,
    required this.status,
  });

  factory SoftDeleteResponseDto.fromJson(Map<String, dynamic> json) {
    return SoftDeleteResponseDto(
      success: json['success'] as bool? ?? false,
      id: json['id'] as String? ?? '',
      deleted: json['deleted'] as bool? ?? false,
      softDeleted: json['softDeleted'] as bool? ?? true,
      status: json['status'] as String? ?? 'dropped',
    );
  }

  Map<String, dynamic> toJson() => {
    'success': success,
    'id': id,
    'deleted': deleted,
    'softDeleted': softDeleted,
    'status': status,
  };
}

@immutable
class CommitmentActionRequestDto {
  final String action; // 'complete' | 'postpone' | 'cancel'
  final String? postponedUntil;
  final String? referenceTime;

  const CommitmentActionRequestDto({
    required this.action,
    this.postponedUntil,
    this.referenceTime,
  });

  Map<String, dynamic> toJson() => {
    'action': action,
    if (postponedUntil != null) 'postponedUntil': postponedUntil,
    if (referenceTime != null) 'referenceTime': referenceTime,
  };
}

@immutable
class CommitmentActionResponseDto {
  final bool success;
  final String id;
  final BackendCommitmentDto commitment;

  const CommitmentActionResponseDto({
    required this.success,
    required this.id,
    required this.commitment,
  });

  factory CommitmentActionResponseDto.fromJson(Map<String, dynamic> json) {
    final rawCommitment = json['commitment'] as Map<String, dynamic>? ?? {};
    return CommitmentActionResponseDto(
      success: json['success'] as bool? ?? false,
      id: json['id'] as String? ?? '',
      commitment: BackendCommitmentDto.fromJson(rawCommitment),
    );
  }

  Map<String, dynamic> toJson() => {
    'success': success,
    'id': id,
    'commitment': commitment.toJson(),
  };
}

@immutable
class PatchCommitmentRequestDto {
  final String? title;
  final String? description;
  final String? priority; // 'low' | 'normal' | 'high'
  final String? dueDate;
  final String? reminderTime;
  final String? state;

  const PatchCommitmentRequestDto({
    this.title,
    this.description,
    this.priority,
    this.dueDate,
    this.reminderTime,
    this.state,
  });

  Map<String, dynamic> toJson() => {
    if (title != null) 'title': title,
    if (description != null) 'description': description,
    if (priority != null) 'priority': priority,
    if (dueDate != null) 'dueDate': dueDate,
    if (reminderTime != null) 'reminderTime': reminderTime,
    if (state != null) 'state': state,
  };
}
