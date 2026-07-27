import 'package:intl/intl.dart';

class DateFormatter {
  static String formatHeaderDate(DateTime date) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final target = DateTime(date.year, date.month, date.day);

    if (target == today) {
      return 'Today, ${DateFormat('MMM d').format(date)}';
    } else if (target == today.add(const Duration(days: 1))) {
      return 'Tomorrow, ${DateFormat('MMM d').format(date)}';
    } else {
      return DateFormat('EEEE, MMM d').format(date);
    }
  }

  static String formatShortDate(DateTime date) {
    return DateFormat('MMM d').format(date);
  }

  static String formatFullDate(DateTime date) {
    return DateFormat('EEEE, MMMM d, yyyy').format(date);
  }

  static String formatTime(String? time) {
    if (time == null || time.isEmpty) return 'Full day';
    return time;
  }

  static String formatTimeRange(String? start, String? end) {
    if (start == null && end == null) return 'Full day';
    if (start != null && end != null) return '$start — $end';
    return start ?? end ?? 'Full day';
  }

  static bool isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }

  static bool isToday(DateTime date) {
    return isSameDay(date, DateTime.now());
  }

  static bool isTomorrow(DateTime date) {
    final now = DateTime.now();
    return isSameDay(date, now.add(const Duration(days: 1)));
  }

  static bool isThisWeek(DateTime date) {
    final now = DateTime.now();
    final startOfWeek = now.subtract(Duration(days: now.weekday - 1));
    final endOfWeek = startOfWeek.add(const Duration(days: 7));
    return date.isAfter(startOfWeek) && date.isBefore(endOfWeek);
  }
}
