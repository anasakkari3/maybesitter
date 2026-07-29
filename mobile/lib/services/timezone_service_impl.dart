import 'contracts/timezone_service.dart';

class DefaultTimezoneService implements TimezoneService {
  final Future<String?> Function()? deviceTimezoneProvider;

  DefaultTimezoneService({this.deviceTimezoneProvider});

  @override
  Future<String?> getDeviceTimezone() async {
    try {
      final provider = deviceTimezoneProvider;
      if (provider != null) {
        final result = await provider();
        if (TimezoneService.isValidIana(result)) {
          return result;
        }
        return null;
      }

      // Default platform resolution via SystemChannels / DateTime native inspection
      final String rawZone = DateTime.now().timeZoneName;
      if (TimezoneService.isValidIana(rawZone)) {
        return rawZone;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<String> resolveTimezone({String? userTimezone}) async {
    // 1. Explicit, validated user-configured IANA identifier
    if (userTimezone != null && TimezoneService.isValidIana(userTimezone)) {
      return userTimezone.trim();
    }

    // 2. Valid device IANA identifier
    final deviceZone = await getDeviceTimezone();
    if (deviceZone != null && TimezoneService.isValidIana(deviceZone)) {
      return deviceZone;
    }

    // 3. Fallback
    return 'Asia/Jerusalem';
  }
}
