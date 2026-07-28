import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';
import '../../../models/commitment.dart';
import '../dtos/commitment_dtos.dart';

class CommitmentMapper {
  static Commitment mapToDomain(BackendCommitmentDto dto) {
    DateTime? date;
    String? timeStr;
    bool invalidDateFlag = false;

    final targetTimeStr = dto.timeSpec.remindAt ?? dto.timeSpec.dueAt;
    if (targetTimeStr != null && targetTimeStr.isNotEmpty) {
      try {
        final parsed = DateTime.parse(targetTimeStr);
        date = parsed;
        timeStr = DateFormat('hh:mm a').format(parsed);
      } catch (e) {
        invalidDateFlag = true;
        date = null;
        if (kDebugMode) {
          debugPrint(
            '[CommitmentMapper] Invalid date string "$targetTimeStr" for commitment ${dto.id}: $e',
          );
        }
      }
    }

    return Commitment(
      id: dto.id,
      title: dto.title,
      description: dto.description,
      scheduledDate: date,
      startTime: timeStr,
      priority: _mapPriorityLevel(dto.priority.level),
      status: _mapStatus(dto.status),
      location: null,
      category: dto.person != null ? 'Personal (${dto.person})' : null,
      hasInvalidDate: invalidDateFlag,
    );
  }

  static CommitmentPriority _mapPriorityLevel(String level) {
    switch (level.toLowerCase()) {
      case 'high':
        return CommitmentPriority.must;
      case 'low':
        return CommitmentPriority.nice;
      case 'normal':
      default:
        return CommitmentPriority.should;
    }
  }

  static String mapPriorityToBackendLevel(CommitmentPriority priority) {
    switch (priority) {
      case CommitmentPriority.must:
        return 'high';
      case CommitmentPriority.should:
        return 'normal';
      case CommitmentPriority.nice:
        return 'low';
    }
  }

  static CommitmentStatus _mapStatus(String status) {
    switch (status.toLowerCase()) {
      case 'completed':
        return CommitmentStatus.completed;
      case 'dropped':
      case 'cancelled':
      case 'archived':
        return CommitmentStatus.cancelled;
      case 'deferred':
      case 'postponed':
        return CommitmentStatus.postponed;
      case 'draft':
      case 'needs_clarification':
      case 'pending_confirmation':
      case 'active':
        return CommitmentStatus.pending;
      default:
        return CommitmentStatus.unknown;
    }
  }
}
