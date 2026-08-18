import 'package:intl/intl.dart';
import '../../l10n/generated/app_localizations.dart';

class DateFormatter {
  /// U+2066 LEFT-TO-RIGHT ISOLATE.
  static const String lri = '\u2066';

  /// U+2069 POP DIRECTIONAL ISOLATE.
  static const String pdi = '\u2069';

  /// Wraps [text] in a Unicode directional isolate so it always renders
  /// left-to-right and, crucially, is treated as a single opaque unit by the
  /// surrounding paragraph's bidi algorithm.
  ///
  /// Clock times are LTR tokens ("09:00 AM"). Dropped bare into an RTL
  /// paragraph, the algorithm reorders the run and a range renders as
  /// "AM — 11:30 AM 09:00". Isolating each token, and the range as a whole,
  /// keeps the digits in order and keeps start before end without reversing
  /// the semantic order.
  static String isolate(String text) {
    if (text.isEmpty) return text;
    return '$lri$text$pdi';
  }

  /// U+2068 FIRST STRONG ISOLATE.
  static const String fsi = '\u2068';

  /// Wraps [text] in a first-strong isolate: it is still one opaque unit to the
  /// surrounding paragraph, but its own direction is taken from its first
  /// strong character instead of being forced left-to-right.
  ///
  /// This is the right tool for anything whose direction depends on the locale,
  /// and a *locale-formatted date* is the clearest case. `DateFormat.yMMMd`
  /// produces "Aug 18, 2026" in English but "١٨ أغسطس ٢٠٢٦" in Arabic. Forcing
  /// the Arabic form left-to-right with [isolate] reorders its top-level runs
  /// and the day number lands at the far end of the line — "في أغسطس 2026 3:10
  /// م 18" instead of "في 18 أغسطس 2026 3:10 م". [isolate] stays correct for a
  /// genuinely LTR token such as a bare clock time; this one is for text that
  /// changes direction with the locale, and for user-supplied text whose script
  /// is unknown.
  static String isolateAuto(String text) {
    if (text.isEmpty) return text;
    return '$fsi$text$pdi';
  }

  /// Strips directional isolate marks. For tests and for any consumer that
  /// needs the bare value (comparison, persistence, semantics labels).
  static String stripIsolates(String text) =>
      text.replaceAll(lri, '').replaceAll(fsi, '').replaceAll(pdi, '');

  static String formatHeaderDate(DateTime? date, {String? locale}) {
    if (date == null) return 'No date set';
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
    DateTime? date,
    AppLocalizations l10n,
    String localeCode,
  ) {
    if (date == null) return l10n.noDateGroupHeader;
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

  static String formatShortDate(DateTime? date, {String? locale}) {
    if (date == null) return 'No date set';
    return DateFormat('MMM d', locale).format(date);
  }

  static String formatFullDate(DateTime? date, {String? locale}) {
    if (date == null) return 'No date set';
    return DateFormat('EEEE, MMMM d, yyyy', locale).format(date);
  }

  static String formatTime(String? time) {
    if (time == null || time.isEmpty) return 'Full day';
    return isolate(time);
  }

  /// Start — end, safe to embed in Arabic and Hebrew paragraphs.
  ///
  /// Each endpoint is isolated so its digits and any AM/PM marker stay in
  /// order, and the whole range is isolated so the separator cannot pull the
  /// endpoints apart or swap them.
  static String formatTimeRange(String? start, String? end) {
    if (start == null && end == null) return 'Full day';
    if (start != null && end != null) {
      return isolate('${isolate(start)} — ${isolate(end)}');
    }
    final single = start ?? end;
    return single == null ? 'Full day' : isolate(single);
  }

  static bool isSameDay(DateTime? a, DateTime? b) {
    if (a == null || b == null) return false;
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }

  static bool isToday(DateTime? date) {
    if (date == null) return false;
    return isSameDay(date, DateTime.now());
  }

  static bool isTomorrow(DateTime? date) {
    if (date == null) return false;
    final now = DateTime.now();
    return isSameDay(date, now.add(const Duration(days: 1)));
  }

  static bool isBeforeToday(DateTime? date) {
    if (date == null) return false;
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final target = DateTime(date.year, date.month, date.day);
    return target.isBefore(today);
  }

  static bool isThisWeek(DateTime? date) {
    if (date == null) return false;
    final now = DateTime.now();
    final startOfWeek = now.subtract(Duration(days: now.weekday - 1));
    final endOfWeek = startOfWeek.add(const Duration(days: 7));
    return date.isAfter(startOfWeek) && date.isBefore(endOfWeek);
  }
}
