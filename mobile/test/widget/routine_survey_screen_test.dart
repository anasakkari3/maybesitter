import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/onboarding/routine_survey_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/pilot_presence.dart';
import 'package:maybesitter_mobile/services/contracts/timezone_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('fresh app launch shows routine survey before today', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final container = ProviderContainer(
      overrides: [
        timezoneServiceProvider.overrideWithValue(
          const _FakeTimezoneService('Asia/Hebron'),
        ),
        // MaybesitterApp reaches Today, whose NextStepCard fires a real
        // network fetch on its first frame -- explicit mock mode keeps this
        // settle-able without a live backend.
        appConfigProvider.overrideWith(
          (ref) => const AppConfig(apiMode: ApiMode.mock),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaybesitterApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Your daily routine'), findsOneWidget);
    expect(find.text('Today'), findsNothing);

    await tester.scrollUntilVisible(find.byKey(const Key('routine-skip')), 320);
    await tester.tap(find.byKey(const Key('routine-skip')));
    await tester.pumpAndSettle();

    expect(find.text('Today'), findsWidgets);
    expect(container.read(appSettingsProvider).hasCompletedOnboarding, isTrue);
    expect(container.read(routineProfileProvider)!.surveySkipped, isTrue);
  });

  testWidgets('completed onboarding launch goes straight to today', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({'has_completed_onboarding': true});
    final container = ProviderContainer(
      overrides: [
        timezoneServiceProvider.overrideWithValue(
          const _FakeTimezoneService('Asia/Hebron'),
        ),
        // MaybesitterApp reaches Today, whose NextStepCard fires a real
        // network fetch on its first frame -- explicit mock mode keeps this
        // settle-able without a live backend.
        appConfigProvider.overrideWith(
          (ref) => const AppConfig(apiMode: ApiMode.mock),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaybesitterApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Today'), findsWidgets);
    expect(find.text('Your daily routine'), findsNothing);
    expect(container.read(appSettingsProvider).hasCompletedOnboarding, isTrue);
  });

  testWidgets('onboarding skip saves skipped profile and continues to today', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final container = ProviderContainer(
      overrides: [
        timezoneServiceProvider.overrideWithValue(
          const _FakeTimezoneService('Asia/Hebron'),
        ),
        // MaybesitterApp reaches Today, whose NextStepCard fires a real
        // network fetch on its first frame -- explicit mock mode keeps this
        // settle-able without a live backend.
        appConfigProvider.overrideWith(
          (ref) => const AppConfig(apiMode: ApiMode.mock),
        ),
      ],
    );
    addTearDown(container.dispose);

    final router = GoRouter(
      initialLocation: '/onboarding',
      routes: [
        GoRoute(
          path: '/onboarding',
          builder: (_, __) =>
              const RoutineSurveyScreen(mode: RoutineSurveyMode.onboarding),
        ),
        GoRoute(
          path: '/today',
          builder: (_, __) => const Scaffold(body: Text('today-target')),
        ),
      ],
    );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: _LocalizedRouterApp(router: router),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.byKey(const Key('routine-skip')), 320);
    await tester.tap(find.byKey(const Key('routine-skip')));
    await tester.pumpAndSettle();

    expect(find.text('today-target'), findsOneWidget);
    expect(container.read(appSettingsProvider).hasCompletedOnboarding, isTrue);
    expect(container.read(routineProfileProvider)!.surveySkipped, isTrue);
  });

  testWidgets('settings edit saves routine choices and updates policy', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final container = ProviderContainer(
      overrides: [
        timezoneServiceProvider.overrideWithValue(
          const _FakeTimezoneService('Asia/Hebron'),
        ),
        // MaybesitterApp reaches Today, whose NextStepCard fires a real
        // network fetch on its first frame -- explicit mock mode keeps this
        // settle-able without a live backend.
        appConfigProvider.overrideWith(
          (ref) => const AppConfig(apiMode: ApiMode.mock),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: AppLocalizations.supportedLocales,
          routes: {
            '/': (_) => const Scaffold(body: Text('settings-return')),
            '/routine': (_) =>
                const RoutineSurveyScreen(mode: RoutineSurveyMode.settings),
          },
          initialRoute: '/routine',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Evening, 6:00 - 8:00'), 320);
    await tester.tap(find.text('Evening, 6:00 - 8:00'));
    await tester.scrollUntilVisible(find.text('Soft + follow-up'), 320);
    await tester.tap(find.text('Soft + follow-up'));
    await tester.scrollUntilVisible(find.byKey(const Key('routine-save')), 320);
    await tester.tap(find.byKey(const Key('routine-save')));
    await tester.pumpAndSettle();

    final profile = container.read(routineProfileProvider);
    expect(profile, isNotNull);
    expect(profile!.surveySkipped, isFalse);
    expect(profile.preferredReminderIntensity, ReminderIntensity.followUp);
    expect(profile.fixedCommitmentWindows.single.start, '18:00');
    expect(
      container.read(reminderPolicyProvider).maxIntensity,
      ReminderIntensity.followUp,
    );
    expect(find.text('settings-return'), findsOneWidget);
  });

  testWidgets('routine settings explain reminder escalation boundaries', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final container = ProviderContainer(
      overrides: [
        timezoneServiceProvider.overrideWithValue(
          const _FakeTimezoneService('Asia/Hebron'),
        ),
        // MaybesitterApp reaches Today, whose NextStepCard fires a real
        // network fetch on its first frame -- explicit mock mode keeps this
        // settle-able without a live backend.
        appConfigProvider.overrideWith(
          (ref) => const AppConfig(apiMode: ApiMode.mock),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: AppLocalizations.supportedLocales,
          home: const RoutineSurveyScreen(mode: RoutineSurveyMode.settings),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('How reminder strength works'), 320);
    expect(find.text('How reminder strength works'), findsOneWidget);
    expect(
      find.text('Nice items stay at soft awareness only.'),
      findsOneWidget,
    );
    expect(
      find.text('Should items stay soft with this setting.'),
      findsOneWidget,
    );
    expect(
      find.text(
        'MaybeSitter never uses fake phone calls or deceptive system UI.',
      ),
      findsOneWidget,
    );

    await tester.scrollUntilVisible(find.text('Strong when needed'), 320);
    await tester.tap(find.text('Strong when needed'));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'Must items can use a stronger reminder about 10 minutes before a timed item because you opted in.',
      ),
      findsOneWidget,
    );
  });
}

class _LocalizedRouterApp extends StatelessWidget {
  final GoRouter router;

  const _LocalizedRouterApp({required this.router});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      routerConfig: router,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
    );
  }
}

class _FakeTimezoneService implements TimezoneService {
  final String timezone;

  const _FakeTimezoneService(this.timezone);

  @override
  Future<String?> getDeviceTimezone() async => timezone;

  @override
  Future<String> resolveTimezone({String? userTimezone}) async => timezone;
}
