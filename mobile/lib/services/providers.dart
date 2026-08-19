import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../config/app_config.dart';
import '../models/app_settings.dart';
import '../models/commitment.dart';
import '../models/activity_event.dart';
import 'api/api_client.dart';
import 'api/api_alpha_feedback_service.dart';
import 'api/api_capture_service.dart';
import 'api/api_feedback_history_service.dart';
import 'api/api_commitment_repository.dart';
import 'api/api_next_step_service.dart';
import 'api/api_pilot_trust_service.dart';
import 'auth/pilot_credential_store.dart';
import 'contracts/commitment_repository.dart';
import 'contracts/capture_service.dart';
import 'contracts/feedback_history_service.dart';
import 'contracts/activity_repository.dart';
import 'contracts/next_step_service.dart';
import 'contracts/notification_service.dart';
import 'contracts/connectivity_service.dart';
import 'contracts/pilot_trust_service.dart';
import 'contracts/timezone_service.dart';
import 'timezone_service_impl.dart';
import 'mock/commitment_state_store.dart';
import 'mock/in_memory_commitment_repository.dart';
import 'mock/mock_capture_service.dart';
import 'mock/mock_activity_repository.dart';
import 'mock/mock_feedback_history_service.dart';
import 'mock/mock_next_step_service.dart';
import 'mock/mock_notification_service.dart';
import 'mock/mock_connectivity_service.dart';
import 'mock/mock_pilot_trust_service.dart';
import '../features/pilot/pilot_session_controller.dart';

final timezoneServiceProvider = Provider<TimezoneService>((ref) {
  return DefaultTimezoneService();
});

final appConfigProvider = StateProvider<AppConfig>((ref) {
  return const AppConfig.fromEnvironment();
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final config = ref.watch(appConfigProvider);
  final credentialStore = ref.watch(pilotCredentialStoreProvider);
  return ApiClient(
    baseUrl: config.baseUrl,
    authTokenProvider: credentialStore.readToken,
  );
});

final commitmentRepositoryProvider = Provider<CommitmentRepository>((ref) {
  final config = ref.watch(appConfigProvider);
  if (config.isLocalBackend) {
    final client = ref.watch(apiClientProvider);
    return ApiCommitmentRepository(
      apiClient: client,
      supportsSafeCommitmentPatch: config.supportsSafeCommitmentPatch,
    );
  }
  // Mock mode is what a person running the app without a backend actually
  // gets, so it persists what they do and records it in Activity. Without the
  // store, completing everything and relaunching brought it all back; without
  // the activity repository, completing and postponing left no trace.
  return InMemoryCommitmentRepository(
    activityRepository: ref.watch(activityRepositoryProvider),
    stateStore: PreferencesStateStore(),
  );
});

final captureServiceProvider = Provider<CaptureService>((ref) {
  final config = ref.watch(appConfigProvider);
  if (config.isLocalBackend) {
    final client = ref.watch(apiClientProvider);
    return ApiCaptureService(
      apiClient: client,
      defaultScopeId: config.scopeId,
      defaultTimezone: config.timezone,
    );
  }
  return MockCaptureService();
});

final activityRepositoryProvider = Provider<ActivityRepository>((ref) {
  return MockActivityRepository();
});

/// Shared mock trust store. The mock recommendation service reads exposure
/// from this same instance, so toggling quiet mode or revoking in mock mode
/// blocks the recommendation exactly as the server would.
final _mockPilotTrustServiceProvider = Provider<MockPilotTrustService>((ref) {
  return MockPilotTrustService();
});

final pilotTrustServiceProvider = Provider<PilotTrustService>((ref) {
  final config = ref.watch(appConfigProvider);
  if (config.isLocalBackend) {
    return ApiPilotTrustService(apiClient: ref.watch(apiClientProvider));
  }
  return ref.watch(_mockPilotTrustServiceProvider);
});

final nextStepServiceProvider = Provider<NextStepService>((ref) {
  final config = ref.watch(appConfigProvider);
  if (config.isLocalBackend) {
    return ApiNextStepService(apiClient: ref.watch(apiClientProvider));
  }
  return MockNextStepService(
    trustService: ref.watch(_mockPilotTrustServiceProvider),
    proposal: MockNextStepService.defaultProposal,
  );
});

/// Alpha feedback flag service. Only meaningful with a local backend and
/// MAYBESITTER_ALPHA_FEEDBACK_ENABLED=true; otherwise calls are no-ops/403s.
final alphaFeedbackServiceProvider = Provider<ApiAlphaFeedbackService>((ref) {
  return ApiAlphaFeedbackService(apiClient: ref.watch(apiClientProvider));
});

/// The behaviour record behind "What we noticed".
///
/// The mock is a working record, not a stub: revoking through it really stops
/// the entry being used, so mock mode shows the same behaviour the server gives
/// rather than a screen that merely looks correct.
final feedbackHistoryServiceProvider = Provider<FeedbackHistoryService>((ref) {
  final config = ref.watch(appConfigProvider);
  if (config.isLocalBackend) {
    return ApiFeedbackHistoryService(apiClient: ref.watch(apiClientProvider));
  }
  return MockFeedbackHistoryService();
});

final pilotCredentialStoreProvider = Provider<PilotCredentialStore>((ref) {
  return const SecurePilotCredentialStore();
});

final pilotSessionControllerProvider =
    StateNotifierProvider<PilotSessionNotifier, PilotSessionState>((ref) {
      return PilotSessionNotifier(
        config: ref.watch(appConfigProvider),
        credentialStore: ref.watch(pilotCredentialStoreProvider),
        trustService: ref.watch(pilotTrustServiceProvider),
      );
    });

final notificationServiceProvider = Provider<NotificationService>((ref) {
  return MockNotificationService();
});

final connectivityServiceProvider = Provider<ConnectivityService>((ref) {
  return MockConnectivityService();
});

final commitmentsStreamProvider = StreamProvider<List<Commitment>>((ref) async* {
  final repo = ref.watch(commitmentRepositoryProvider);

  // `watchCommitments()` is a broadcast stream with no replay: the in-memory
  // repository emits its seed data from its constructor, before anything is
  // listening, and the API repository only emits after an explicit fetch.
  // Either way nothing arrives until the first mutation, so a cold launch shows
  // an empty Today and the V03 loop never starts. Prime it with one read.
  final seen = <String>{};
  final initial = <Commitment>[];
  for (final commitment in [
    ...await repo.getToday(),
    ...await repo.getUpcoming(),
  ]) {
    if (seen.add(commitment.id)) initial.add(commitment);
  }
  yield initial;

  yield* repo.watchCommitments();
});

final todayCommitmentsProvider = Provider<List<Commitment>>((ref) {
  final asyncValue = ref.watch(commitmentsStreamProvider);
  final all = asyncValue.value ?? [];
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  return all.where((c) {
    if (c.scheduledDate == null) return false;
    final cDate = DateTime(
      c.scheduledDate!.year,
      c.scheduledDate!.month,
      c.scheduledDate!.day,
    );
    return cDate.isAtSameMomentAs(today) && !c.status.isCompleted;
  }).toList();
});

final upcomingCommitmentsProvider = Provider<List<Commitment>>((ref) {
  final asyncValue = ref.watch(commitmentsStreamProvider);
  final all = asyncValue.value ?? [];
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  return all.where((c) {
    if (c.scheduledDate == null) return false;
    final cDate = DateTime(
      c.scheduledDate!.year,
      c.scheduledDate!.month,
      c.scheduledDate!.day,
    );
    return cDate.isAfter(today) && !c.status.isCompleted;
  }).toList();
});

final noDateCommitmentsProvider = Provider<List<Commitment>>((ref) {
  final asyncValue = ref.watch(commitmentsStreamProvider);
  final all = asyncValue.value ?? [];
  return all
      .where((c) => c.scheduledDate == null && !c.status.isCompleted)
      .toList();
});

final overdueCommitmentsProvider = Provider<List<Commitment>>((ref) {
  final asyncValue = ref.watch(commitmentsStreamProvider);
  final all = asyncValue.value ?? [];
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  return all.where((c) {
    if (c.scheduledDate == null) return false;
    final cDate = DateTime(
      c.scheduledDate!.year,
      c.scheduledDate!.month,
      c.scheduledDate!.day,
    );
    return cDate.isBefore(today) && !c.status.isCompleted;
  }).toList();
});

final completedCommitmentsProvider = Provider<List<Commitment>>((ref) {
  final asyncValue = ref.watch(commitmentsStreamProvider);
  final all = asyncValue.value ?? [];
  return all.where((c) => c.status.isCompleted).toList();
});

final activityStreamProvider = StreamProvider<List<ActivityEvent>>((ref) {
  final repo = ref.watch(activityRepositoryProvider);
  return repo.watchActivity();
});

class AppSettingsNotifier extends StateNotifier<AppSettings> {
  static const String _localeKey = 'locale_option';
  static const String _themeKey = 'theme_mode';

  AppSettingsNotifier() : super(const AppSettings()) {
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final localeStr = prefs.getString(_localeKey);
      AppLocaleOption? loadedOption;
      if (localeStr != null) {
        switch (localeStr) {
          case 'en':
            loadedOption = AppLocaleOption.english;
            break;
          case 'ar':
            loadedOption = AppLocaleOption.arabic;
            break;
          case 'he':
            loadedOption = AppLocaleOption.hebrew;
            break;
          case 'system':
          default:
            loadedOption = AppLocaleOption.system;
            break;
        }
      }

      if (loadedOption != null) {
        state = state.copyWith(localeOption: loadedOption);
      }
    } catch (_) {
      // Memory fallback for test environment
    }
  }

  Future<void> updateThemeMode(AppThemeMode mode) async {
    state = state.copyWith(themeMode: mode);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_themeKey, mode.name);
    } catch (_) {}
  }

  Future<void> updateLocale(AppLocaleOption option) async {
    state = state.copyWith(localeOption: option);
    try {
      final prefs = await SharedPreferences.getInstance();
      final val = option.locale?.languageCode ?? 'system';
      await prefs.setString(_localeKey, val);
    } catch (_) {}
  }

  void toggleNotifications(bool enabled) {
    state = state.copyWith(notificationsEnabled: enabled);
  }

  void toggleHaptics(bool enabled) {
    state = state.copyWith(hapticFeedbackEnabled: enabled);
  }

  void completeOnboarding() {
    state = state.copyWith(hasCompletedOnboarding: true);
  }
}

final appSettingsProvider =
    StateNotifierProvider<AppSettingsNotifier, AppSettings>((ref) {
      return AppSettingsNotifier();
    });
