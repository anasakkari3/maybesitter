import 'package:flutter_timezone/flutter_timezone.dart';
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

      // Approved platform resolution via flutter_timezone plugin (retrieves native local device IANA timezone)
      final nativeZone = (await FlutterTimezone.getLocalTimezone()).identifier;
      if (TimezoneService.isValidIana(nativeZone)) {
        return nativeZone;
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
