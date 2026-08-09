import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/design_system/components/maybesitter_buttons.dart';
import 'package:maybesitter_mobile/design_system/theme/app_theme.dart';
import 'package:maybesitter_mobile/design_system/tokens/colors.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/today/today_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/app_settings.dart';
import 'package:maybesitter_mobile/services/providers.dart';

Widget _wrap(Widget child, {Locale locale = const Locale('en')}) {
  return ProviderScope(
    child: MaterialApp(
      locale: locale,
      theme: AppTheme.lightTheme,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    ),
  );
}

/// Relative luminance / contrast ratio per WCAG 2.1.
double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

double contrastRatio(Color fg, Color bg) {
  final l1 = _luminance(fg);
  final l2 = _luminance(bg);
  final hi = l1 > l2 ? l1 : l2;
  final lo = l1 > l2 ? l2 : l1;
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  group('Reconciliation regression', () {
    testWidgets('1. Exactly one Capture Plan CTA in the Today empty state', (
      tester,
    ) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_wrap(const TodayScreen()));
      await tester.pumpAndSettle();

      // The mock repository seeds nothing for today, so the empty state shows.
      expect(find.text('Capture Plan'), findsOneWidget);
      expect(find.bySemanticsLabel('Capture Plan'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('2. Analyze stays visible above a simulated keyboard', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1206, 2622);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _wrap(
          const MediaQuery(
            // 335dp of keyboard, as an iPhone reports it.
            data: MediaQueryData(viewInsets: EdgeInsets.only(bottom: 335)),
            child: CaptureComposerScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final analyze = find.byType(PrimaryButton);
      expect(analyze, findsOneWidget);

      final rect = tester.getRect(analyze);
      const screenHeight = 2622 / 3.0;
      const visibleBottom = screenHeight - 335;

      expect(
        rect.bottom,
        lessThanOrEqualTo(visibleBottom + 0.5),
        reason:
            'Analyze CTA (bottom ${rect.bottom}) must sit above the keyboard '
            'line ($visibleBottom), not behind it.',
      );
    });

    testWidgets('3. Capture input does not hold focus for Proposal Review', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap(const CaptureComposerScreen()));
      await tester.pumpAndSettle();

      // The composer must not grab focus on entry; if it did, the keyboard
      // would follow the pushed review route and cover its confirm bar.
      expect(find.byType(TextField), findsOneWidget);
      final editable = tester.widget<EditableText>(find.byType(EditableText));
      expect(
        editable.focusNode.hasFocus,
        isFalse,
        reason: 'Composer must not autofocus, so it cannot refocus on rebuild.',
      );

      // And it still does not hold focus after a rebuild, which is what
      // happens to this screen while Proposal Review sits on top of it.
      await tester.pump();
      final afterRebuild = tester.widget<EditableText>(
        find.byType(EditableText),
      );
      expect(afterRebuild.focusNode.hasFocus, isFalse);
    });

    testWidgets('4. Dark theme CTA labels meet contrast guidelines', (
      tester,
    ) async {
      const dark = SemanticColors.dark;
      // The CTA is a gradient carrying a white label.
      for (final stop in <Color>[dark.gradientStart, dark.gradientEnd]) {
        expect(
          contrastRatio(const Color(0xFFFFFFFF), stop),
          greaterThanOrEqualTo(4.5),
          reason: 'White CTA label on $stop must meet WCAG AA.',
        );
      }
      expect(
        contrastRatio(const Color(0xFFFFFFFF), dark.brandFill),
        greaterThanOrEqualTo(4.5),
        reason: 'White on dark-theme brandFill must meet WCAG AA.',
      );
    });

    testWidgets('5. Dark theme success surfaces meet contrast guidelines', (
      tester,
    ) async {
      const dark = SemanticColors.dark;
      expect(
        contrastRatio(const Color(0xFFFFFFFF), dark.successFill),
        greaterThanOrEqualTo(4.5),
        reason: 'White tick on dark-theme successFill must meet WCAG AA.',
      );
      expect(
        contrastRatio(dark.success, dark.successSubtle),
        greaterThanOrEqualTo(4.5),
        reason: 'Success text on its container must meet WCAG AA.',
      );
    });

    test('6. Safe PATCH capability remains functional', () {
      const mock = AppConfig();
      expect(mock.supportsSafeCommitmentPatch, isTrue);

      const backendWithout = AppConfig(
        apiMode: ApiMode.localBackend,
        enableSafeCommitmentPatch: false,
      );
      expect(backendWithout.supportsSafeCommitmentPatch, isFalse);

      const backendWith = AppConfig(
        apiMode: ApiMode.localBackend,
        enableSafeCommitmentPatch: true,
      );
      expect(backendWith.supportsSafeCommitmentPatch, isTrue);
    });

    test('7. API base URL still activates local-backend mode', () {
      const withUrl = AppConfig(
        apiMode: ApiMode.localBackend,
        baseUrl: 'http://192.168.1.20:3000',
      );
      expect(withUrl.isLocalBackend, isTrue);
      expect(withUrl.isMock, isFalse);
      expect(withUrl.baseUrl, 'http://192.168.1.20:3000');

      const noUrl = AppConfig();
      expect(noUrl.isMock, isTrue);
      expect(noUrl.apiMode, ApiMode.mock);
    });

    testWidgets('8. Arabic RTL layout builds', (tester) async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
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

      expect(tester.takeException(), isNull);
      final dir = tester.widget<Directionality>(
        find.byType(Directionality).first,
      );
      expect(dir.textDirection, TextDirection.rtl);
    });

    testWidgets('9. Hebrew RTL layout builds', (tester) async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container
          .read(appSettingsProvider.notifier)
          .updateLocale(AppLocaleOption.hebrew);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaybesitterApp(),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final dir = tester.widget<Directionality>(
        find.byType(Directionality).first,
      );
      expect(dir.textDirection, TextDirection.rtl);
    });

    testWidgets('10. Large text does not hide the primary action', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1206, 2622);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _wrap(
          const MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(2.0)),
            child: CaptureComposerScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);

      final analyze = find.byType(PrimaryButton);
      expect(analyze, findsOneWidget);

      final rect = tester.getRect(analyze);
      const screenHeight = 2622 / 3.0;
      expect(
        rect.bottom,
        lessThanOrEqualTo(screenHeight + 0.5),
        reason: 'Primary action must stay on screen at 2x text scale.',
      );
      expect(rect.height, greaterThan(0));
    });
  });
}
