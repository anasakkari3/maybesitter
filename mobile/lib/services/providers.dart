import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../config/app_config.dart';
import '../models/app_settings.dart';
import '../models/commitment.dart';
import '../models/activity_event.dart';
import 'api/api_client.dart';
import 'api/api_capture_service.dart';
import 'api/api_commitment_repository.dart';
import 'contracts/commitment_repository.dart';
import 'contracts/capture_service.dart';
import 'contracts/activity_repository.dart';
import 'contracts/notification_service.dart';
import 'contracts/connectivity_service.dart';
import 'contracts/timezone_service.dart';
import 'timezone_service_impl.dart';
import 'mock/in_memory_commitment_repository.dart';
import 'mock/mock_capture_service.dart';
import 'mock/mock_activity_repository.dart';
import 'mock/mock_notification_service.dart';
import 'mock/mock_connectivity_service.dart';

final timezoneServiceProvider = Provider<TimezoneService>((ref) {
  return DefaultTimezoneService();
});

final appConfigProvider = StateProvider<AppConfig>((ref) {
  return const AppConfig.fromEnvironment();
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final config = ref.watch(appConfigProvider);
  return ApiClient(baseUrl: config.baseUrl);
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
  return InMemoryCommitmentRepository();
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

final notificationServiceProvider = Provider<NotificationService>((ref) {
  return MockNotificationService();
});

final connectivityServiceProvider = Provider<ConnectivityService>((ref) {
  return MockConnectivityService();
});

final commitmentsStreamProvider = StreamProvider<List<Commitment>>((ref) {
  final repo = ref.watch(commitmentRepositoryProvider);
  return repo.watchCommitments();
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
