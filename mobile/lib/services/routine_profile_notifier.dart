import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/pilot_presence.dart';
import 'contracts/timezone_service.dart';

class RoutineProfileStoreKeys {
  static const profileV1 = 'user_routine_profile_v1';

  const RoutineProfileStoreKeys._();
}

class RoutineProfileNotifier extends StateNotifier<UserRoutineProfile?> {
  final TimezoneService timezoneService;
  final DateTime Function() now;
  bool _hasWritten = false;

  RoutineProfileNotifier({
    required this.timezoneService,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now,
       super(null) {
    _loadProfile();
  }

  Future<void> _loadProfile() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(RoutineProfileStoreKeys.profileV1);
      final profile = _decodeProfile(raw);
      if (!_hasWritten && profile != null) state = profile;
    } catch (_) {
      // Local settings should not block capture or app startup.
    }
  }

  Future<void> saveProfile(UserRoutineProfile profile) async {
    final timezone = await timezoneService.resolveTimezone(
      userTimezone: profile.timezone,
    );
    await _writeProfile(
      profile.copyWith(
        updatedAt: now().toUtc(),
        timezone: timezone,
        surveySkipped: false,
      ),
    );
  }

  Future<void> skipSurvey() async {
    final timezone = await timezoneService.resolveTimezone();
    await _writeProfile(
      UserRoutineProfile(
        updatedAt: now().toUtc(),
        timezone: timezone,
        surveySkipped: true,
      ),
    );
  }

  Future<void> _writeProfile(UserRoutineProfile profile) async {
    _hasWritten = true;
    state = profile;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        RoutineProfileStoreKeys.profileV1,
        jsonEncode(profile.toJson()),
      );
    } catch (_) {
      // Keep the in-memory state for this session even if disk is unavailable.
    }
  }

  UserRoutineProfile? _decodeProfile(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      return UserRoutineProfile.fromJson(Map<String, dynamic>.from(decoded));
    } catch (_) {
      return null;
    }
  }
}

ReminderPolicy reminderPolicyForRoutineProfile(UserRoutineProfile? profile) {
  const defaultPolicy = ReminderPolicy();
  if (profile == null) return defaultPolicy;

  return defaultPolicy.copyWith(
    maxIntensity: profile.preferredReminderIntensity,
    strongRemindersRequireExplicitOptIn:
        profile.preferredReminderIntensity != ReminderIntensity.strongReminder,
    quietHoursRespectMode:
        profile.quietHours == null && profile.sleepWindow == null
        ? QuietHoursRespectMode.deferUnlessMustAndAllowed
        : QuietHoursRespectMode.alwaysDefer,
  );
}
