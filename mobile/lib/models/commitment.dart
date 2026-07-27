import 'package:flutter/foundation.dart';

enum CommitmentPriority {
  must,
  should,
  nice;

  String get label {
    switch (this) {
      case CommitmentPriority.must:
        return 'MUST';
      case CommitmentPriority.should:
        return 'SHOULD';
      case CommitmentPriority.nice:
        return 'NICE';
    }
  }
}

enum CommitmentStatus {
  pending,
  completed,
  postponed,
  cancelled;

  bool get isCompleted => this == CommitmentStatus.completed;
}

enum TimeGranularity {
  exact,
  timeRange,
  dateOnly,
  fullDay;
}

@immutable
class Commitment {
  final String id;
  final String title;
  final String? description;
  final DateTime scheduledDate;
  final String? startTime;
  final String? endTime;
  final String? location;
  final CommitmentPriority priority;
  final CommitmentStatus status;
  final TimeGranularity timeGranularity;
  final DateTime? completedAt;
  final String? category;
  final double confidenceScore;

  const Commitment({
    required this.id,
    required this.title,
    this.description,
    required this.scheduledDate,
    this.startTime,
    this.endTime,
    this.location,
    this.priority = CommitmentPriority.should,
    this.status = CommitmentStatus.pending,
    this.timeGranularity = TimeGranularity.exact,
    this.completedAt,
    this.category,
    this.confidenceScore = 0.95,
  });

  Commitment copyWith({
    String? id,
    String? title,
    String? description,
    DateTime? scheduledDate,
    String? startTime,
    String? endTime,
    String? location,
    CommitmentPriority? priority,
    CommitmentStatus? status,
    TimeGranularity? timeGranularity,
    DateTime? completedAt,
    String? category,
    double? confidenceScore,
  }) {
    return Commitment(
      id: id ?? this.id,
      title: title ?? this.title,
      description: description ?? this.description,
      scheduledDate: scheduledDate ?? this.scheduledDate,
      startTime: startTime ?? this.startTime,
      endTime: endTime ?? this.endTime,
      location: location ?? this.location,
      priority: priority ?? this.priority,
      status: status ?? this.status,
      timeGranularity: timeGranularity ?? this.timeGranularity,
      completedAt: completedAt ?? this.completedAt,
      category: category ?? this.category,
      confidenceScore: confidenceScore ?? this.confidenceScore,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'description': description,
      'scheduledDate': scheduledDate.toIso8601String(),
      'startTime': startTime,
      'endTime': endTime,
      'location': location,
      'priority': priority.name,
      'status': status.name,
      'timeGranularity': timeGranularity.name,
      'completedAt': completedAt?.toIso8601String(),
      'category': category,
      'confidenceScore': confidenceScore,
    };
  }

  factory Commitment.fromJson(Map<String, dynamic> json) {
    return Commitment(
      id: json['id'] as String,
      title: json['title'] as String,
      description: json['description'] as String?,
      scheduledDate: DateTime.parse(json['scheduledDate'] as String),
      startTime: json['startTime'] as String?,
      endTime: json['endTime'] as String?,
      location: json['location'] as String?,
      priority: CommitmentPriority.values.byName(
        json['priority'] as String? ?? 'should',
      ),
      status: CommitmentStatus.values.byName(
        json['status'] as String? ?? 'pending',
      ),
      timeGranularity: TimeGranularity.values.byName(
        json['timeGranularity'] as String? ?? 'exact',
      ),
      completedAt: json['completedAt'] != null
          ? DateTime.parse(json['completedAt'] as String)
          : null,
      category: json['category'] as String?,
      confidenceScore: (json['confidenceScore'] as num?)?.toDouble() ?? 0.95,
    );
  }
}
