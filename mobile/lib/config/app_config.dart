import '../services/contracts/timezone_service.dart';

enum ApiMode { mock, localBackend }

class PilotPresenceFeatureFlags {
  final bool widget;
  final bool voice;
  final bool awareness;
  final bool watch;
  final bool imports;

  const PilotPresenceFeatureFlags({
    required this.widget,
    required this.voice,
    required this.awareness,
    required this.watch,
    required this.imports,
  });

  Map<String, dynamic> toJson() {
    return {
      'widget': widget,
      'voice': voice,
      'awareness': awareness,
      'watch': watch,
      'imports': imports,
    };
  }
}

class AppConfig {
  static const _configuredBaseUrl = String.fromEnvironment('API_BASE_URL');

  static const mockParticipantId = 'pilot-participant';

  final ApiMode apiMode;
  final String baseUrl;
  final String scopeId;
  final String timezone;
  final bool enableSafeCommitmentPatch;
  final bool enablePilotWidget;
  final bool enablePilotVoice;
  final bool enablePilotAwareness;
  final bool enablePilotWatch;
  final bool enablePilotImports;
  final bool killPilotWidget;
  final bool killPilotVoice;
  final bool killPilotAwareness;
  final bool killPilotWatch;
  final bool killPilotImports;

  const AppConfig({
    this.apiMode = ApiMode.mock,
    this.baseUrl = 'http://localhost:3000',
    this.scopeId = 'default',
    this.timezone = 'Asia/Jerusalem',
    this.enableSafeCommitmentPatch = const bool.fromEnvironment(
      'ENABLE_SAFE_COMMITMENT_PATCH',
      defaultValue: false,
    ),
    this.enablePilotWidget = const bool.fromEnvironment(
      'ENABLE_PILOT_WIDGET',
      defaultValue: false,
    ),
    this.enablePilotVoice = const bool.fromEnvironment(
      'ENABLE_PILOT_VOICE',
      defaultValue: false,
    ),
    this.enablePilotAwareness = const bool.fromEnvironment(
      'ENABLE_PILOT_AWARENESS',
      defaultValue: false,
    ),
    this.enablePilotWatch = const bool.fromEnvironment(
      'ENABLE_PILOT_WATCH',
      defaultValue: false,
    ),
    this.enablePilotImports = const bool.fromEnvironment(
      'ENABLE_PILOT_IMPORTS',
      defaultValue: false,
    ),
    this.killPilotWidget = const bool.fromEnvironment(
      'KILL_SWITCH_PILOT_WIDGET',
      defaultValue: false,
    ),
    this.killPilotVoice = const bool.fromEnvironment(
      'KILL_SWITCH_PILOT_VOICE',
      defaultValue: false,
    ),
    this.killPilotAwareness = const bool.fromEnvironment(
      'KILL_SWITCH_PILOT_AWARENESS',
      defaultValue: false,
    ),
    this.killPilotWatch = const bool.fromEnvironment(
      'KILL_SWITCH_PILOT_WATCH',
      defaultValue: false,
    ),
    this.killPilotImports = const bool.fromEnvironment(
      'KILL_SWITCH_PILOT_IMPORTS',
      defaultValue: false,
    ),
  });

  const AppConfig.fromEnvironment()
    : apiMode = _configuredBaseUrl == '' ? ApiMode.mock : ApiMode.localBackend,
      baseUrl = _configuredBaseUrl == ''
          ? 'http://localhost:3000'
          : _configuredBaseUrl,
      scopeId = 'default',
      timezone = 'Asia/Jerusalem',
      enableSafeCommitmentPatch = const bool.fromEnvironment(
        'ENABLE_SAFE_COMMITMENT_PATCH',
        defaultValue: false,
      ),
      enablePilotWidget = const bool.fromEnvironment(
        'ENABLE_PILOT_WIDGET',
        defaultValue: false,
      ),
      enablePilotVoice = const bool.fromEnvironment(
        'ENABLE_PILOT_VOICE',
        defaultValue: false,
      ),
      enablePilotAwareness = const bool.fromEnvironment(
        'ENABLE_PILOT_AWARENESS',
        defaultValue: false,
      ),
      enablePilotWatch = const bool.fromEnvironment(
        'ENABLE_PILOT_WATCH',
        defaultValue: false,
      ),
      enablePilotImports = const bool.fromEnvironment(
        'ENABLE_PILOT_IMPORTS',
        defaultValue: false,
      ),
      killPilotWidget = const bool.fromEnvironment(
        'KILL_SWITCH_PILOT_WIDGET',
        defaultValue: false,
      ),
      killPilotVoice = const bool.fromEnvironment(
        'KILL_SWITCH_PILOT_VOICE',
        defaultValue: false,
      ),
      killPilotAwareness = const bool.fromEnvironment(
        'KILL_SWITCH_PILOT_AWARENESS',
        defaultValue: false,
      ),
      killPilotWatch = const bool.fromEnvironment(
        'KILL_SWITCH_PILOT_WATCH',
        defaultValue: false,
      ),
      killPilotImports = const bool.fromEnvironment(
        'KILL_SWITCH_PILOT_IMPORTS',
        defaultValue: false,
      );

  bool get isMock => apiMode == ApiMode.mock;
  bool get isLocalBackend => apiMode == ApiMode.localBackend;

  /// Capability flag protecting users from backend timezone offset data-corruption defect.
  /// Enabled for mock mode OR when explicit deployment capability ENABLE_SAFE_COMMITMENT_PATCH=true (paired with backend commit 87408da+).
  bool get supportsSafeCommitmentPatch => isMock || enableSafeCommitmentPatch;

  PilotPresenceFeatureFlags get pilotPresenceFlags {
    return PilotPresenceFeatureFlags(
      widget: enablePilotWidget && !killPilotWidget,
      voice: enablePilotVoice && !killPilotVoice,
      awareness: enablePilotAwareness && !killPilotAwareness,
      watch: enablePilotWatch && !killPilotWatch,
      imports: enablePilotImports && !killPilotImports,
    );
  }

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
    bool? enableSafeCommitmentPatch,
    bool? enablePilotWidget,
    bool? enablePilotVoice,
    bool? enablePilotAwareness,
    bool? enablePilotWatch,
    bool? enablePilotImports,
    bool? killPilotWidget,
    bool? killPilotVoice,
    bool? killPilotAwareness,
    bool? killPilotWatch,
    bool? killPilotImports,
  }) {
    return AppConfig(
      apiMode: apiMode ?? this.apiMode,
      baseUrl: baseUrl ?? this.baseUrl,
      scopeId: scopeId ?? this.scopeId,
      timezone: timezone ?? this.timezone,
      enableSafeCommitmentPatch:
          enableSafeCommitmentPatch ?? this.enableSafeCommitmentPatch,
      enablePilotWidget: enablePilotWidget ?? this.enablePilotWidget,
      enablePilotVoice: enablePilotVoice ?? this.enablePilotVoice,
      enablePilotAwareness: enablePilotAwareness ?? this.enablePilotAwareness,
      enablePilotWatch: enablePilotWatch ?? this.enablePilotWatch,
      enablePilotImports: enablePilotImports ?? this.enablePilotImports,
      killPilotWidget: killPilotWidget ?? this.killPilotWidget,
      killPilotVoice: killPilotVoice ?? this.killPilotVoice,
      killPilotAwareness: killPilotAwareness ?? this.killPilotAwareness,
      killPilotWatch: killPilotWatch ?? this.killPilotWatch,
      killPilotImports: killPilotImports ?? this.killPilotImports,
    );
  }
}
