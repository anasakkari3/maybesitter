import 'package:intl/intl.dart';

class BackendTimeMapper {
  static DateTime parseAbsoluteIsoToLocal(String value) {
    return DateTime.parse(value).toLocal();
  }

  static String formatLocalClock(DateTime value) {
    return DateFormat('hh:mm a').format(value);
  }

  /// A local date plus a wall-clock string as one explicit UTC instant.
  ///
  /// `DateTime.toIso8601String()` on a local value emits no offset, which left
  /// the server resolving it against its own zone — the same edit stored a
  /// different instant on a developer's machine than on a UTC host. Everything
  /// this client sends names its instant outright.
  ///
  /// Returns null only when there is no date to anchor to. A clock string that
  /// cannot be parsed costs the time of day, never the whole edit.
  static String? instantFrom(DateTime? date, String? clockTime) {
    if (date == null) return null;

    var local = DateTime(date.year, date.month, date.day);
    final clock = clockTime?.trim();
    if (clock != null && clock.isNotEmpty) {
      for (final pattern in const ['h:mm a', 'H:mm']) {
        try {
          final parsed = DateFormat(pattern).parseLoose(clock);
          local = DateTime(date.year, date.month, date.day, parsed.hour, parsed.minute);
          break;
        } catch (_) {
          // Try the next shape before giving up on the time.
        }
      }
    }
    return local.toUtc().toIso8601String();
  }
}
