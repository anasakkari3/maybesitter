import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/design_system/components/commitment_card.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/app_settings.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  group('Localization Widget Tests', () {
    testWidgets('Renders English Today Screen', (WidgetTester tester) async {
      await tester.pumpWidget(const ProviderScope(child: MaybesitterApp()));
      await tester.pumpAndSettle();

      expect(find.text('Maybesitter'), findsOneWidget);
      expect(find.text('Today'), findsWidgets);
    });

    testWidgets('Renders Arabic Today Screen in RTL', (
      WidgetTester tester,
    ) async {
      // The Today screen now leads with the V03 next-step card, so a default
      // 800px test viewport pushes the commitment list below the fold and its
      // lazy slivers are never built. Give this test a taller surface rather
      // than weakening what it asserts. 4200 (not 3600) because Today's
      // scroll viewport now reserves 96px of bottom clearance so the capture
      // FAB never overlaps real content (lane-a-full-audit) - that shrinks
      // the buildable region by the same amount, and 3600 had just enough
      // margin to leave this test passing only by accident.
      tester.view.physicalSize = const Size(1200, 4200);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final now = DateTime.now();
      final today = DateTime(now.year, now.month, now.day);
      final c = Commitment(
        id: 'ar-1',
        title: 'لقاء سارة',
        scheduledDate: today,
        priority: CommitmentPriority.must,
        status: CommitmentStatus.pending,
      );

      final container = ProviderContainer(
        overrides: [
          commitmentsStreamProvider.overrideWith((ref) => Stream.value([c])),
          todayCommitmentsProvider.overrideWithValue([c]),
        ],
      );
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.arabic);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaybesitterApp(),
        ),
      );
      await tester.pump(Duration.zero);
      await tester.pumpAndSettle();

      expect(find.text('اليوم'), findsWidgets);
      expect(find.text('ضروري'), findsWidgets);

      // Verify Directionality is RTL
      final directionality = tester.widget<Directionality>(
        find.byType(Directionality).first,
      );
      expect(directionality.textDirection, equals(TextDirection.rtl));
    });

    testWidgets('Renders Hebrew Today Screen in RTL', (
      WidgetTester tester,
    ) async {
      // The Today screen now leads with the V03 next-step card, so a default
      // 800px test viewport pushes the commitment list below the fold and its
      // lazy slivers are never built. Give this test a taller surface rather
      // than weakening what it asserts. 4200 (not 3600) because Today's
      // scroll viewport now reserves 96px of bottom clearance so the capture
      // FAB never overlaps real content (lane-a-full-audit) - that shrinks
      // the buildable region by the same amount, and 3600 had just enough
      // margin to leave this test passing only by accident.
      tester.view.physicalSize = const Size(1200, 4200);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final now = DateTime.now();
      final today = DateTime(now.year, now.month, now.day);
      final c = Commitment(
        id: 'he-1',
        title: 'פגישה עם שרה',
        scheduledDate: today,
        priority: CommitmentPriority.must,
        status: CommitmentStatus.pending,
      );

      final container = ProviderContainer(
        overrides: [
          commitmentsStreamProvider.overrideWith((ref) => Stream.value([c])),
          todayCommitmentsProvider.overrideWithValue([c]),
        ],
      );
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.hebrew);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaybesitterApp(),
        ),
      );
      await tester.pump(Duration.zero);
      await tester.pumpAndSettle();

      expect(find.text('היום'), findsWidgets);
      expect(find.text('חובה'), findsWidgets);

      final directionality = tester.widget<Directionality>(
        find.byType(Directionality).first,
      );
      expect(directionality.textDirection, equals(TextDirection.rtl));
    });

    testWidgets('Language switching in Settings without restart', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaybesitterApp(),
        ),
      );
      await tester.pumpAndSettle();

      // Navigate to Settings
      final settingsTab = find.text('Settings');
      expect(settingsTab, findsOneWidget);
      await tester.tap(settingsTab);
      await tester.pumpAndSettle();

      expect(find.text('App preferences & account'), findsOneWidget);

      // Switch language to Arabic
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.arabic);
      await tester.pumpAndSettle();

      // Copy updates to Arabic immediately
      expect(find.text('الإعدادات'), findsWidgets);
      expect(find.text('تفضيلات التطبيق والحساب'), findsOneWidget);
    });

    testWidgets('Arabic & Hebrew Accessibility Semantics & Tooltips', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.arabic);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaybesitterApp(),
        ),
      );
      await tester.pumpAndSettle();

      // Arabic bottom nav labels
      expect(find.text('اليوم'), findsWidgets);
      expect(find.text('القادمة'), findsWidgets);
      expect(find.text('النشاط'), findsWidgets);
      expect(find.text('الإعدادات'), findsWidgets);

      // Open settings to check Language selector semantics
      await tester.tap(find.text('الإعدادات').first);
      await tester.pumpAndSettle();
      expect(find.text('اللغة'), findsOneWidget);

      // Switch to Hebrew
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.hebrew);
      await tester.pumpAndSettle();

      // Hebrew bottom nav labels
      expect(find.text('היום'), findsWidgets);
      expect(find.text('בקרוב'), findsWidgets);
      expect(find.text('פעילות'), findsWidgets);
      expect(find.text('הגדרות'), findsWidgets);
      expect(find.text('שפה'), findsOneWidget);
    });

    testWidgets('Renders Mixed-Language Commitment Text cleanly', (
      WidgetTester tester,
    ) async {
      final c = Commitment(
        id: 'mixed-1',
        title: 'موعد مع Dr. Cohen غدًا الساعة 09:30',
        scheduledDate: DateTime.now(),
        priority: CommitmentPriority.must,
        status: CommitmentStatus.pending,
      );

      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('ar'),
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: Scaffold(body: CommitmentCard(commitment: c)),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('موعد مع Dr. Cohen غدًا الساعة 09:30'), findsOneWidget);
    });

    testWidgets('Arabic Large-Text 2.0x scale does not overflow', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.arabic);

      await tester.pumpWidget(
        MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2.0)),
          child: UncontrolledProviderScope(
            container: container,
            child: const MaybesitterApp(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.text('اليوم'), findsWidgets);
    });

    testWidgets('Hebrew Large-Text 2.0x scale does not overflow', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.hebrew);

      await tester.pumpWidget(
        MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2.0)),
          child: UncontrolledProviderScope(
            container: container,
            child: const MaybesitterApp(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.text('היום'), findsWidgets);
    });
  });
}
