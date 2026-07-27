import 'package:intl/intl.dart';
import '../../l10n/generated/app_localizations.dart';

class DateFormatter {
  static String formatHeaderDate(DateTime date, {String? locale}) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final target = DateTime(date.year, date.month, date.day);

    final formattedDate = DateFormat('MMM d', locale).format(date);

    if (target == today) {
      return 'Today, $formattedDate';
    } else if (target == today.add(const Duration(days: 1))) {
      return 'Tomorrow, $formattedDate';
    } else {
      return DateFormat('EEEE, MMM d', locale).format(date);
    }
  }

  static String formatHeaderDateWithL10n(
    DateTime date,
    AppLocalizations l10n,
    String localeCode,
  ) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final target = DateTime(date.year, date.month, date.day);

    final formattedDate = DateFormat('MMM d', localeCode).format(date);

    if (target == today) {
      return '${l10n.todayTab}, $formattedDate';
    } else if (target == today.add(const Duration(days: 1))) {
      return '${l10n.tomorrowGroupHeader}, $formattedDate';
    } else {
      return DateFormat('EEEE, MMM d', localeCode).format(date);
    }
  }

  static String formatShortDate(DateTime date, {String? locale}) {
    return DateFormat('MMM d', locale).format(date);
  }

  static String formatFullDate(DateTime date, {String? locale}) {
    return DateFormat('EEEE, MMMM d, yyyy', locale).format(date);
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
