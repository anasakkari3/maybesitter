import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/app_settings.dart';
import '../models/commitment.dart';
import '../models/activity_event.dart';
import 'contracts/commitment_repository.dart';
import 'contracts/capture_service.dart';
import 'contracts/activity_repository.dart';
import 'contracts/notification_service.dart';
import 'contracts/connectivity_service.dart';
import 'mock/in_memory_commitment_repository.dart';
import 'mock/mock_capture_service.dart';
import 'mock/mock_activity_repository.dart';
import 'mock/mock_notification_service.dart';
import 'mock/mock_connectivity_service.dart';

final commitmentRepositoryProvider = Provider<CommitmentRepository>((ref) {
  return InMemoryCommitmentRepository();
});

final captureServiceProvider = Provider<CaptureService>((ref) {
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
    final cDate = DateTime(c.scheduledDate.year, c.scheduledDate.month, c.scheduledDate.day);
    return cDate.isAtSameMomentAs(today);
  }).toList();
});

final upcomingCommitmentsProvider = Provider<List<Commitment>>((ref) {
  final asyncValue = ref.watch(commitmentsStreamProvider);
  final all = asyncValue.value ?? [];
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  return all.where((c) {
    final cDate = DateTime(c.scheduledDate.year, c.scheduledDate.month, c.scheduledDate.day);
    return cDate.isAfter(today);
  }).toList();
});

final activityStreamProvider = StreamProvider<List<ActivityEvent>>((ref) {
  final repo = ref.watch(activityRepositoryProvider);
  return repo.watchActivity();
});

class AppSettingsNotifier extends StateNotifier<AppSettings> {
  AppSettingsNotifier() : super(const AppSettings());

  void updateThemeMode(AppThemeMode mode) {
    state = state.copyWith(themeMode: mode);
  }

  void updateLocale(AppLocaleOption option) {
    state = state.copyWith(localeOption: option);
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
