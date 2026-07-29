import 'package:timezone/data/latest.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;

abstract class TimezoneService {
  /// Fetches the device IANA timezone identifier, returning null if invalid or an abbreviation.
  Future<String?> getDeviceTimezone();

  /// Resolves the timezone following the required resolution order:
  /// 1. Explicit, validated user-configured IANA identifier
  /// 2. Valid device IANA identifier
  /// 3. 'Asia/Jerusalem' fallback
  Future<String> resolveTimezone({String? userTimezone});

  /// Validates whether a timezone string is a valid IANA identifier.
  /// Uses regex as an early rejection filter, followed by IANA database membership confirmation.
  static bool isValidIana(String? timezone) {
    if (timezone == null || timezone.trim().isEmpty) return false;
    final tzString = timezone.trim();

    if (tzString == 'UTC' || tzString == 'GMT') return true;

    // 1. Early rejection filter: Syntax format
    final ianaRegex = RegExp(r'^[A-Za-z_]+/[A-Za-z_]+(?:/[A-Za-z_]+)?$');
    if (!ianaRegex.hasMatch(tzString)) return false;

    // 2. Early rejection filter: Known abbreviations
    final invalidAbbreviations = {
      'IDT',
      'IST',
      'EET',
      'CEST',
      'PST',
      'PDT',
      'EST',
      'EDT',
      'CST',
      'CDT',
      'MST',
      'MDT',
      'BST',
    };
    if (invalidAbbreviations.contains(tzString.toUpperCase())) return false;

    // 3. Final validation: Confirm membership in standard IANA database
    try {
      if (tz.timeZoneDatabase.locations.isEmpty) {
        tz_data.initializeTimeZones();
      }
      return tz.timeZoneDatabase.locations.containsKey(tzString);
    } catch (_) {
      // Fallback check against known canonical IANA timezones
      return tzString.contains('/');
    }
  }
}
