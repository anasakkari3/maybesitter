import '../services/contracts/timezone_service.dart';

enum ApiMode { mock, localBackend }

class AppConfig {
  final ApiMode apiMode;
  final String baseUrl;
  final String scopeId;
  final String timezone;

  const AppConfig({
    this.apiMode = ApiMode.mock,
    this.baseUrl = 'http://localhost:3000',
    this.scopeId = 'default',
    this.timezone = 'Asia/Jerusalem',
  });

  bool get isMock => apiMode == ApiMode.mock;
  bool get isLocalBackend => apiMode == ApiMode.localBackend;

  static String resolveTimezone({
    String? userTimezone,
    String? deviceTimezone,
  }) {
    if (userTimezone != null && TimezoneService.isValidIana(userTimezone)) {
      return userTimezone.trim();
    }
    if (deviceTimezone != null && TimezoneService.isValidIana(deviceTimezone)) {
      return deviceTimezone.trim();
    }
    final deviceZoneName = DateTime.now().timeZoneName;
    if (TimezoneService.isValidIana(deviceZoneName)) {
      return deviceZoneName;
    }
    return 'Asia/Jerusalem';
  }

  AppConfig copyWith({
    ApiMode? apiMode,
    String? baseUrl,
    String? scopeId,
    String? timezone,
  }) {
    return AppConfig(
      apiMode: apiMode ?? this.apiMode,
      baseUrl: baseUrl ?? this.baseUrl,
      scopeId: scopeId ?? this.scopeId,
      timezone: timezone ?? this.timezone,
    );
  }
}
