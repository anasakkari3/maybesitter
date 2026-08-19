import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/timezone_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:maybesitter_mobile/services/routine_profile_notifier.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('RoutineProfileNotifier', () {
    test('skip stores a non-blocking skipped profile', () async {
      SharedPreferences.setMockInitialValues({});
      final container = ProviderContainer(
        overrides: [
          timezoneServiceProvider.overrideWithValue(
            _FakeTimezoneService('Asia/Hebron'),
          ),
        ],
      );
      addTearDown(container.dispose);

      await container.read(routineProfileProvider.notifier).skipSurvey();

      final profile = container.read(routineProfileProvider);
      expect(profile, isNotNull);
      expect(profile!.surveySkipped, isTrue);
      expect(profile.timezone, 'Asia/Hebron');
      expect(profile.sleepWindow, isNull);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(RoutineProfileStoreKeys.profileV1), isNotNull);
    });

    test(
      'saved profile immediately changes reminder policy decisions',
      () async {
        SharedPreferences.setMockInitialValues({});
        final container = ProviderContainer(
          overrides: [
            timezoneServiceProvider.overrideWithValue(
              _FakeTimezoneService('Asia/Hebron'),
            ),
          ],
        );
        addTearDown(container.dispose);

        expect(
          container.read(reminderPolicyProvider).maxIntensity,
          ReminderIntensity.softAwareness,
        );
        const commitment = Commitment(
          id: 'must-1',
          title: 'Leave for exam',
          priority: CommitmentPriority.must,
        );
        expect(
          container
              .read(reminderScheduleDecisionProvider(commitment))
              .intensity,
          ReminderIntensity.softAwareness,
        );

        await container
            .read(routineProfileProvider.notifier)
            .saveProfile(
              UserRoutineProfile(
                updatedAt: DateTime.utc(2026, 8, 19, 10),
                timezone: 'Asia/Hebron',
                sleepWindow: const RoutineTimeWindow(
                  start: '23:30',
                  end: '07:30',
                ),
                focusWindows: const [
                  RoutineTimeWindow(
                    start: '09:00',
                    end: '17:00',
                    label: 'work_study',
                  ),
                ],
                fixedCommitmentWindows: const [
                  RoutineTimeWindow(
                    start: '18:00',
                    end: '20:00',
                    label: 'fixed_commitments',
                  ),
                ],
                preferredReminderIntensity: ReminderIntensity.strongReminder,
                quietHours: const RoutineTimeWindow(
                  start: '22:30',
                  end: '07:30',
                ),
              ),
            );

        final policy = container.read(reminderPolicyProvider);
        expect(policy.maxIntensity, ReminderIntensity.strongReminder);
        expect(policy.strongRemindersRequireExplicitOptIn, isFalse);
        expect(policy.quietHoursRespectMode, QuietHoursRespectMode.alwaysDefer);
        final decision = container.read(
          reminderScheduleDecisionProvider(commitment),
        );
        expect(decision.intensity, ReminderIntensity.strongReminder);
        expect(decision.leadTime, const Duration(minutes: 10));
        expect(decision.respectsQuietHours, isTrue);
        expect(container.read(routineProfileProvider)!.surveySkipped, isFalse);
      },
    );

    test('policy mapping keeps stronger escalation behind explicit opt-in', () {
      const nice = Commitment(
        id: 'nice-1',
        title: 'Stretch',
        priority: CommitmentPriority.nice,
      );
      const should = Commitment(
        id: 'should-1',
        title: 'Reply to advisor',
        priority: CommitmentPriority.should,
      );
      const must = Commitment(
        id: 'must-1',
        title: 'Exam arrival',
        priority: CommitmentPriority.must,
      );

      const defaultPolicy = ReminderPolicy();
      expect(
        defaultPolicy.decisionFor(nice).intensity,
        ReminderIntensity.softAwareness,
      );
      expect(
        defaultPolicy.decisionFor(should).intensity,
        ReminderIntensity.softAwareness,
      );
      expect(
        defaultPolicy.decisionFor(must).intensity,
        ReminderIntensity.softAwareness,
      );

      final followUpPolicy = reminderPolicyForRoutineProfile(
        UserRoutineProfile(
          updatedAt: DateTime.utc(2026, 8, 19, 10),
          timezone: 'Asia/Hebron',
          preferredReminderIntensity: ReminderIntensity.followUp,
        ),
      );
      expect(
        followUpPolicy.decisionFor(nice).intensity,
        ReminderIntensity.softAwareness,
      );
      expect(
        followUpPolicy.decisionFor(should).intensity,
        ReminderIntensity.followUp,
      );
      expect(
        followUpPolicy.decisionFor(must).intensity,
        ReminderIntensity.followUp,
      );
      expect(
        followUpPolicy.decisionFor(must).requiresExplicitOptIn,
        isFalse,
      );

      final strongPolicy = reminderPolicyForRoutineProfile(
        UserRoutineProfile(
          updatedAt: DateTime.utc(2026, 8, 19, 10),
          timezone: 'Asia/Hebron',
          preferredReminderIntensity: ReminderIntensity.strongReminder,
        ),
      );
      expect(
        strongPolicy.decisionFor(nice).intensity,
        ReminderIntensity.softAwareness,
      );
      expect(
        strongPolicy.decisionFor(should).intensity,
        ReminderIntensity.followUp,
      );
      expect(
        strongPolicy.decisionFor(must).intensity,
        ReminderIntensity.strongReminder,
      );
      expect(
        strongPolicy.decisionFor(must).leadTime,
        const Duration(minutes: 10),
      );
      expect(
        strongPolicy.decisionFor(must).requiresExplicitOptIn,
        isFalse,
      );
    });
  });

  group('Routine survey localization', () {
    test('loads routine copy in English, Arabic, and Hebrew', () async {
      final en = await AppLocalizations.delegate.load(const Locale('en'));
      final ar = await AppLocalizations.delegate.load(const Locale('ar'));
      final he = await AppLocalizations.delegate.load(const Locale('he'));

      expect(en.routineSurveyTitle, 'Your daily routine');
      expect(ar.routineSurveyTitle, 'روتينك اليومي');
      expect(he.routineSurveyTitle, 'השגרה היומית שלך');
      expect(en.routineReminderStrong, isNotEmpty);
      expect(ar.routineReminderStrong, isNotEmpty);
      expect(he.routineReminderStrong, isNotEmpty);
    });
  });
}

class _FakeTimezoneService implements TimezoneService {
  final String timezone;

  const _FakeTimezoneService(this.timezone);

  @override
  Future<String?> getDeviceTimezone() async => timezone;

  @override
  Future<String> resolveTimezone({String? userTimezone}) async => timezone;
}
