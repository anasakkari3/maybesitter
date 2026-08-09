import '../services/contracts/timezone_service.dart';

enum ApiMode { mock, localBackend }

class AppConfig {
  static const _configuredBaseUrl = String.fromEnvironment('API_BASE_URL');
  static const _configuredParticipantId = String.fromEnvironment(
    'PILOT_PARTICIPANT_ID',
  );

  /// Used in mock mode and in tests. A real pilot build always supplies
  /// `--dart-define=PILOT_PARTICIPANT_ID=<random pseudonymous id>`; the
  /// runbook forbids sequential or guessable identifiers.
  static const mockParticipantId = 'pilot-participant';

  final ApiMode apiMode;
  final String baseUrl;
  final String scopeId;
  final String timezone;
  final bool enableSafeCommitmentPatch;

  /// The pseudonymous closed-pilot identity this build is bound to. It is the
  /// only participant identifier the client holds — no name, no account, no
  /// contact detail.
  final String participantId;

  const AppConfig({
    this.apiMode = ApiMode.mock,
    this.baseUrl = 'http://localhost:3000',
    this.scopeId = 'default',
    this.timezone = 'Asia/Jerusalem',
    this.participantId = mockParticipantId,
    this.enableSafeCommitmentPatch = const bool.fromEnvironment(
      'ENABLE_SAFE_COMMITMENT_PATCH',
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
      participantId = _configuredParticipantId == ''
          ? mockParticipantId
          : _configuredParticipantId,
      enableSafeCommitmentPatch = const bool.fromEnvironment(
        'ENABLE_SAFE_COMMITMENT_PATCH',
        defaultValue: false,
      );

  /// A real backend build must carry an explicitly configured participant id.
  /// Falling back to the mock identity against a live pilot instance would
  /// point every device at the same participant, so the app refuses instead.
  bool get hasValidPilotIdentity =>
      isMock || participantId != mockParticipantId;

  bool get isMock => apiMode == ApiMode.mock;
  bool get isLocalBackend => apiMode == ApiMode.localBackend;

  /// Capability flag protecting users from backend timezone offset data-corruption defect.
  /// Enabled for mock mode OR when explicit deployment capability ENABLE_SAFE_COMMITMENT_PATCH=true (paired with backend commit 87408da+).
  bool get supportsSafeCommitmentPatch => isMock || enableSafeCommitmentPatch;

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
    String? participantId,
    bool? enableSafeCommitmentPatch,
  }) {
    return AppConfig(
      apiMode: apiMode ?? this.apiMode,
      baseUrl: baseUrl ?? this.baseUrl,
      scopeId: scopeId ?? this.scopeId,
      timezone: timezone ?? this.timezone,
      participantId: participantId ?? this.participantId,
      enableSafeCommitmentPatch:
          enableSafeCommitmentPatch ?? this.enableSafeCommitmentPatch,
    );
  }
}
