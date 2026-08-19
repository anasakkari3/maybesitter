import 'package:intl/intl.dart';

import '../models/calendar_import.dart';
import '../models/commitment.dart';

class CalendarConflictSummary {
  final int commitmentCount;
  final int busyBlockCount;

  const CalendarConflictSummary({
    required this.commitmentCount,
    required this.busyBlockCount,
  });

  bool get hasConflicts => commitmentCount > 0;
}

CalendarConflictSummary summarizeCalendarConflicts({
  required List<Commitment> commitments,
  required CalendarImportSnapshot? calendar,
}) {
  if (calendar == null || !calendar.isConnected) {
    return const CalendarConflictSummary(commitmentCount: 0, busyBlockCount: 0);
  }

  final conflictingCommitmentIds = <String>{};
  final conflictingBusyBlockIds = <String>{};
  for (final commitment in commitments) {
    final interval = _commitmentInterval(commitment);
    if (interval == null) continue;
    for (final busyBlock in calendar.retainedBusyBlocks) {
      if (_overlaps(
        interval.$1,
        interval.$2,
        busyBlock.startAt,
        busyBlock.endAt,
      )) {
        conflictingCommitmentIds.add(commitment.id);
        conflictingBusyBlockIds.add(busyBlock.id);
      }
    }
  }

  return CalendarConflictSummary(
    commitmentCount: conflictingCommitmentIds.length,
    busyBlockCount: conflictingBusyBlockIds.length,
  );
}

bool _overlaps(
  DateTime aStart,
  DateTime aEnd,
  DateTime bStart,
  DateTime bEnd,
) => aStart.isBefore(bEnd) && bStart.isBefore(aEnd);

(DateTime, DateTime)? _commitmentInterval(Commitment commitment) {
  final scheduledDate = commitment.scheduledDate;
  if (scheduledDate == null || commitment.status.isCompleted) return null;

  if (commitment.timeGranularity == TimeGranularity.fullDay ||
      commitment.timeGranularity == TimeGranularity.dateOnly ||
      commitment.startTime == null) {
    final start = DateTime(
      scheduledDate.year,
      scheduledDate.month,
      scheduledDate.day,
    );
    return (start, start.add(const Duration(days: 1)));
  }

  final start = _clockOnDay(scheduledDate, commitment.startTime!);
  if (start == null) return null;
  final end =
      _clockOnDay(scheduledDate, commitment.endTime ?? '') ??
      start.add(const Duration(hours: 1));
  if (!end.isAfter(start)) {
    return (start, start.add(const Duration(hours: 1)));
  }
  return (start, end);
}

DateTime? _clockOnDay(DateTime day, String raw) {
  if (raw.trim().isEmpty) return null;
  for (final pattern in const ['hh:mm a', 'HH:mm']) {
    try {
      final parsed = DateFormat(pattern).parseStrict(raw);
      return DateTime(day.year, day.month, day.day, parsed.hour, parsed.minute);
    } catch (_) {
      continue;
    }
  }
  return null;
}
