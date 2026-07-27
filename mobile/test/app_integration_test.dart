import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/models/app_settings.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  testWidgets(
    'Integration Test: Multilingual RTL and Locale Persistence Flow',
    (WidgetTester tester) async {
      final container = ProviderContainer();

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaybesitterApp(),
        ),
      );
      await tester.pump();
      await tester.pumpAndSettle();

      // 1. Launch in English
      expect(find.text('Maybesitter'), findsOneWidget);
      expect(find.text('Settings'), findsOneWidget);

      // 2. Open Settings & switch language to Arabic
      await tester.tap(find.byIcon(Icons.settings_outlined));
      await tester.pumpAndSettle();

      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.arabic);
      await tester.pumpAndSettle();

      // 3. Verify immediate RTL and Arabic UI copy
      expect(find.text('الإعدادات'), findsWidgets);
      final arDirectionality = tester.widget<Directionality>(
        find.byType(Directionality).first,
      );
      expect(arDirectionality.textDirection, equals(TextDirection.rtl));

      // 4. Return to Today tab & open Capture Composer
      final todayTab = find.byIcon(Icons.today_outlined);
      expect(todayTab, findsOneWidget);
      await tester.tap(todayTab);
      await tester.pumpAndSettle();

      final captureFab = find.byType(FloatingActionButton).first;
      expect(captureFab, findsOneWidget);
      await tester.tap(captureFab);
      await tester.pumpAndSettle();

      expect(find.byType(CaptureComposerScreen), findsOneWidget);

      // 5. Tap Analyze button (Arabic label: تحليل النص)
      final analyzeBtn = find.text('تحليل النص');
      expect(analyzeBtn, findsOneWidget);
      await tester.tap(analyzeBtn);
      await tester.pump(const Duration(milliseconds: 1000));
      await tester.pumpAndSettle();

      // 6. Verify Arabic Extraction Review screen & confirm
      expect(find.text('مراجعة خطتك'), findsOneWidget);
      expect(find.text('Go to the doctor'), findsOneWidget);
      expect(find.text('Work afterward'), findsOneWidget);

      final confirmBtn = find.text('تأكيد التزامين');
      expect(confirmBtn, findsOneWidget);
      await tester.tap(confirmBtn);
      await tester.pumpAndSettle();

      // 7. Verify Arabic Success Screen
      expect(find.text('تمت إضافة التزامين ليوم غد.'), findsOneWidget);

      // 8. Return to Settings via Bottom Navigation & switch to Hebrew
      final doneBtn = find.text('تم');
      expect(doneBtn, findsOneWidget);
      await tester.tap(doneBtn);
      await tester.pumpAndSettle();

      final settingsTabIcon = find.byIcon(Icons.settings_outlined);
      expect(settingsTabIcon, findsOneWidget);
      await tester.tap(settingsTabIcon);
      await tester.pumpAndSettle();

      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.hebrew);
      await tester.pumpAndSettle();

      // 9. Verify immediate Hebrew copy and RTL
      expect(find.text('הגדרות'), findsWidgets);
      final heDirectionality = tester.widget<Directionality>(
        find.byType(Directionality).first,
      );
      expect(heDirectionality.textDirection, equals(TextDirection.rtl));

      // 10. Verify locale persistence in notifier
      final currentSettings = container.read(appSettingsProvider);
      expect(currentSettings.localeOption, equals(AppLocaleOption.hebrew));

      // 11. Open Upcoming tab -> verify user commitment titles stay untouched
      final upcomingTabIcon = find.byIcon(Icons.calendar_month_outlined);
      expect(upcomingTabIcon, findsOneWidget);
      await tester.tap(upcomingTabIcon);
      await tester.pumpAndSettle();

      expect(find.text('Go to the doctor'), findsOneWidget);
    },
  );
}
