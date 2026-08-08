import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/design_system/adaptive/adaptive_action_sheet.dart';
import 'package:maybesitter_mobile/design_system/adaptive/adaptive_dialog.dart';
import 'package:maybesitter_mobile/design_system/adaptive/adaptive_haptics.dart';
import 'package:maybesitter_mobile/design_system/adaptive/adaptive_page_transition.dart';
import 'package:maybesitter_mobile/design_system/adaptive/adaptive_platform.dart';
import 'package:maybesitter_mobile/design_system/adaptive/app_icons.dart';
import 'package:maybesitter_mobile/design_system/components/extraction_review_card.dart';
import 'package:maybesitter_mobile/design_system/components/maybesitter_buttons.dart';
import 'package:maybesitter_mobile/design_system/theme/app_theme.dart';
import 'package:maybesitter_mobile/design_system/tokens/colors.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/today/today_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/commitment.dart';

Widget _wrap(
  Widget child, {
  TargetPlatform platform = TargetPlatform.iOS,
  bool disableAnimations = false,
  Locale locale = const Locale('en'),
  double textScale = 1.0,
}) {
  return ProviderScope(
    child: MaterialApp(
      locale: locale,
      theme: AppTheme.lightTheme.copyWith(platform: platform),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          disableAnimations: disableAnimations,
          textScaler: TextScaler.linear(textScale),
        ),
        child: child!,
      ),
      home: child,
    ),
  );
}

void main() {
  tearDown(() {
    Adaptive.debugIdiomOverride = null;
    Adaptive.debugReduceMotionOverride = null;
    AdaptiveHaptics.debugLog = null;
  });

  group('Premium polish', () {
    Future<void> openDialog(
      WidgetTester tester,
      TargetPlatform platform,
    ) async {
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (ctx) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => AdaptiveAppDialog.confirm(
                    context: ctx,
                    title: 'Delete',
                    message: 'Are you sure?',
                    confirmLabel: 'Delete',
                    isDestructive: true,
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
          platform: platform,
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('1a. adaptive dialog is Cupertino on iOS', (tester) async {
      await openDialog(tester, TargetPlatform.iOS);
      expect(find.byType(CupertinoAlertDialog), findsOneWidget);
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('1b. adaptive dialog is Material on Android', (tester) async {
      await openDialog(tester, TargetPlatform.android);
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.byType(CupertinoAlertDialog), findsNothing);
    });

    Future<void> openSheet(WidgetTester tester, TargetPlatform platform) async {
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (ctx) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => AdaptiveActionSheet.show<int>(
                    context: ctx,
                    actions: const [
                      AdaptiveAction(
                        value: 1,
                        label: 'Postpone',
                        icon: Icons.schedule,
                      ),
                    ],
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
          platform: platform,
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('2a. action sheet is Cupertino on iOS', (tester) async {
      await openSheet(tester, TargetPlatform.iOS);
      expect(find.byType(CupertinoActionSheet), findsOneWidget);
      expect(find.text('Postpone'), findsOneWidget);
    });

    testWidgets('2b. action sheet is a Material sheet on Android', (
      tester,
    ) async {
      await openSheet(tester, TargetPlatform.android);
      expect(find.byType(CupertinoActionSheet), findsNothing);
      expect(find.byType(ListTile), findsOneWidget);
      expect(find.text('Postpone'), findsOneWidget);
    });

    testWidgets('3. destructive dialogs are not barrier-dismissible', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (ctx) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => AdaptiveAppDialog.confirm(
                    context: ctx,
                    title: 'Delete',
                    message: 'Are you sure?',
                    confirmLabel: 'Delete',
                    isDestructive: true,
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.byType(CupertinoAlertDialog), findsOneWidget);

      // Tapping the barrier must not dismiss a destructive confirmation.
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      expect(find.byType(CupertinoAlertDialog), findsOneWidget);
    });

    testWidgets('4. proposal selection animates without losing state', (
      tester,
    ) async {
      var selected = true;
      const item = Commitment(id: 'p-1', title: 'Go to the doctor');

      await tester.pumpWidget(
        _wrap(
          StatefulBuilder(
            builder: (ctx, setState) => Scaffold(
              body: ExtractionReviewCard(
                commitment: item,
                isSelected: selected,
                onToggleSelect: (_) => setState(() => selected = !selected),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.bySemanticsLabel('Include in this save'));
      // Mid-animation the card must still be present and the state applied.
      await tester.pump(const Duration(milliseconds: 60));
      expect(selected, isFalse);
      expect(find.byType(ExtractionReviewCard), findsOneWidget);
      expect(find.text('Go to the doctor'), findsOneWidget);

      await tester.pumpAndSettle();
      expect(find.byType(ExtractionReviewCard), findsOneWidget);
    });

    testWidgets('5. blocked selection gives feedback beyond haptics', (
      tester,
    ) async {
      final log = <String>[];
      AdaptiveHaptics.debugLog = log;

      const blocked = Commitment(
        id: 'p-2',
        title: 'Ambiguous item',
        needsClarification: true,
      );

      await tester.pumpWidget(
        _wrap(const Scaffold(body: ExtractionReviewCard(commitment: blocked))),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.bySemanticsLabel('Needs clarification before it can be included'),
      );
      await tester.pumpAndSettle();

      expect(log, contains('rejected'));
      // The haptic is never the only signal.
      expect(
        find.text('Clarification needed — edit before selection'),
        findsOneWidget,
      );
    });

    testWidgets('6. reduced motion collapses transitions to zero', (
      tester,
    ) async {
      late BuildContext captured;
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (ctx) {
              captured = ctx;
              return const Scaffold(body: SizedBox());
            },
          ),
          disableAnimations: true,
        ),
      );
      await tester.pumpAndSettle();

      expect(Adaptive.reduceMotion(captured), isTrue);
      expect(
        Adaptive.motion(captured, AdaptiveMotion.screen),
        Duration.zero,
        reason: 'reduced motion must cut, not merely shorten',
      );
    });

    testWidgets('7. motion durations stay inside the agreed bands', (
      tester,
    ) async {
      expect(AdaptiveMotion.press.inMilliseconds, inInclusiveRange(80, 120));
      expect(
        AdaptiveMotion.component.inMilliseconds,
        inInclusiveRange(150, 220),
      );
      expect(AdaptiveMotion.screen.inMilliseconds, inInclusiveRange(220, 320));
      expect(
        AdaptiveMotion.screen.inMilliseconds,
        lessThanOrEqualTo(AdaptiveMotion.maxNavigation.inMilliseconds),
      );
    });

    test('8. icons resolve per platform and never mix families', () {
      // Exercises the resolver directly; the idiom override is exactly what
      // this hook exists for and avoids depending on element reuse.
      const cupertino = AppIcons.cupertino;
      const material = AppIcons.material;

      expect(cupertino.today.fontFamily, 'CupertinoIcons');
      expect(material.today.fontFamily, 'MaterialIcons');

      // No Apple-only glyph may leak onto Android.
      for (final icon in [
        material.today,
        material.upcoming,
        material.settings,
        material.complete,
        material.delete,
        material.edit,
        material.postpone,
        material.reminder,
      ]) {
        expect(icon.fontFamily, isNot('CupertinoIcons'));
      }
      // And the reverse: iOS stays in its own family.
      for (final icon in [
        cupertino.complete,
        cupertino.delete,
        cupertino.edit,
        cupertino.postpone,
      ]) {
        expect(icon.fontFamily, 'CupertinoIcons');
      }
    });

    testWidgets('9. dark-theme pressed state keeps text readable', (
      tester,
    ) async {
      // The press overlay darkens by 6% of the shadow colour. Verify the CTA
      // label still clears AA against the darkest gradient stop underneath.
      const dark = SemanticColors.dark;
      final pressed = Color.alphaBlend(
        dark.shadow.withValues(alpha: 0.06),
        dark.gradientStart,
      );

      double lum(Color c) {
        double ch(double v) => v <= 0.03928
            ? v / 12.92
            : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
      }

      // White is luminance 1.0, so the ratio is 1.05 / (bg + 0.05).
      final ratio = 1.05 / (lum(pressed) + 0.05);
      expect(
        ratio,
        greaterThanOrEqualTo(4.5),
        reason: 'white CTA label must stay AA while pressed in dark mode',
      );
    });

    testWidgets('10. Capture CTA stays above the keyboard', (tester) async {
      tester.view.physicalSize = const Size(1206, 2622);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _wrap(
          const MediaQuery(
            data: MediaQueryData(viewInsets: EdgeInsets.only(bottom: 335)),
            child: CaptureComposerScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final rect = tester.getRect(find.byType(PrimaryButton));
      const visibleBottom = 2622 / 3.0 - 335;
      expect(rect.bottom, lessThanOrEqualTo(visibleBottom + 0.5));
    });

    testWidgets('11. exactly one Capture Plan action in the empty state', (
      tester,
    ) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_wrap(const TodayScreen()));
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel('Capture Plan'), findsOneWidget);
      handle.dispose();
    });

    test('12. safe PATCH capability is unchanged by the polish wave', () {
      expect(const AppConfig().supportsSafeCommitmentPatch, isTrue);
      expect(
        const AppConfig(
          apiMode: ApiMode.localBackend,
          enableSafeCommitmentPatch: false,
        ).supportsSafeCommitmentPatch,
        isFalse,
      );
      expect(
        const AppConfig(
          apiMode: ApiMode.localBackend,
          enableSafeCommitmentPatch: true,
        ).supportsSafeCommitmentPatch,
        isTrue,
      );
    });

    testWidgets('13. Arabic and Hebrew build with the bundled font', (
      tester,
    ) async {
      for (final locale in const [Locale('ar'), Locale('he')]) {
        await tester.pumpWidget(
          _wrap(const Scaffold(body: SizedBox()), locale: locale),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      }
    });

    testWidgets('14. large text keeps the sticky action on screen', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1206, 2622);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _wrap(const CaptureComposerScreen(), textScale: 2.0),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final rect = tester.getRect(find.byType(PrimaryButton));
      expect(rect.bottom, lessThanOrEqualTo(2622 / 3.0 + 0.5));
    });
  });
}
