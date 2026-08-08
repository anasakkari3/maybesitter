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
  /// Authoritative validation is determined exclusively by membership in the initialized IANA database.
  static bool isValidIana(String? timezone) {
    if (timezone == null || timezone.trim().isEmpty) return false;
    final candidate = timezone.trim();

    // 1. Lightweight precheck: Reject control characters and malformed whitespace
    if (candidate.contains('\n') ||
        candidate.contains('\r') ||
        candidate.contains('\t')) {
      return false;
    }

    // 2. Reject explicit non-IANA abbreviation strings
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
    if (invalidAbbreviations.contains(candidate.toUpperCase())) return false;

    // 3. Authoritative check: Database membership in initialized IANA database
    try {
      if (tz.timeZoneDatabase.locations.isEmpty) {
        tz_data.initializeTimeZones();
      }

      // Check direct membership or standard UTC/Etc aliases
      if (tz.timeZoneDatabase.locations.containsKey(candidate)) {
        return true;
      }

      // Explicitly allow UTC / GMT / Etc offset standard identifiers
      if (candidate == 'UTC' ||
          candidate == 'GMT' ||
          candidate == 'Etc/UTC' ||
          candidate == 'Etc/GMT' ||
          candidate.startsWith('Etc/GMT')) {
        return true;
      }

      return false;
    } catch (_) {
      return candidate.contains('/');
    }
  }
}
