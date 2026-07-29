abstract class TimezoneService {
  /// Fetches the device IANA timezone identifier, returning null if invalid or an abbreviation.
  Future<String?> getDeviceTimezone();

  /// Resolves the timezone following the required resolution order:
  /// 1. Explicit, validated user-configured IANA identifier
  /// 2. Valid device IANA identifier
  /// 3. 'Asia/Jerusalem' fallback
  Future<String> resolveTimezone({String? userTimezone});

  /// Validates whether a timezone string is a valid IANA identifier.
  static bool isValidIana(String? timezone) {
    if (timezone == null || timezone.trim().isEmpty) return false;
    final tz = timezone.trim();

    // Reject abbreviations, UTC offsets, and Windows-style display names
    if (tz == 'UTC' || tz == 'GMT') return true;

    // Must match Area/Location or Area/SubArea/Location format (e.g. Asia/Jerusalem, America/Indiana/Indianapolis)
    final ianaRegex = RegExp(r'^[A-Za-z_]+/[A-Za-z_]+(?:/[A-Za-z_]+)?$');
    if (!ianaRegex.hasMatch(tz)) return false;

    // Explicitly reject known non-IANA abbreviation patterns
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
    if (invalidAbbreviations.contains(tz.toUpperCase())) return false;

    return true;
  }
}
