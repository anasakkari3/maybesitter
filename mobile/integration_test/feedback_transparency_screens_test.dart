import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/models/app_settings.dart';

/// Drives "What we noticed" and the privacy screen on a real simulator so both
/// can be looked at rather than merely asserted about.
///
/// Widget tests prove the behaviour; they do not prove the screen composes at a
/// real viewport and density, and they cannot show an RTL layout going wrong.
/// The run walks English, then Arabic, then Hebrew, and revokes a row along the
/// way so the corrected state is on screen too.
///
/// Run against a booted simulator:
///
///   flutter test integration_test/feedback_transparency_screens_test.dart -d DEVICE_ID
///
/// Screenshots are taken from outside with `xcrun simctl io DEVICE_ID screenshot`
/// while this runs; the pauses below are the moments worth capturing.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  /// Long enough that an external screenshot loop lands inside the window.
  Future<void> hold(WidgetTester tester) async {
    await tester.pump(const Duration(seconds: 4));
  }

  /// Opens privacy then the history screen, pausing on each.
  ///
  /// The caller is already on Settings: after a locale change the settings
  /// title and the bottom-nav label are the same string, so tapping "Settings"
  /// again is ambiguous rather than harmless.
  Future<void> openHistory(
    WidgetTester tester,
    String privacyLabel,
    String historyLabel,
  ) async {
    await tester.tap(find.text(privacyLabel));
    await tester.pumpAndSettle();
    await hold(tester);

    await tester.tap(find.text(historyLabel));
    await tester.pumpAndSettle();
    await hold(tester);
  }

  /// These screens carry their own back affordance in MaybesitterAppBar rather
  /// than a Material BackButton, so `tester.pageBack()` finds nothing.
  Future<void> back(WidgetTester tester) async {
    await tester.tap(find.byIcon(Icons.arrow_back).first);
    await tester.pumpAndSettle();
  }

  testWidgets('feedback transparency screens render in en, ar and he', (
    tester,
  ) async {
    await tester.pumpWidget(const ProviderScope(child: MaybesitterApp()));
    await tester.pumpAndSettle(const Duration(seconds: 2));

    // ── English ──────────────────────────────────────────────────────
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await openHistory(tester, 'Privacy & Data', 'What we noticed');

    // Revoke the first row and hold on the corrected state: the row stays
    // listed, loses its control, and the snackbar reports what happened.
    await tester.tap(find.text("Don't learn from this").first);
    await tester.pumpAndSettle();
    await hold(tester);

    await back(tester);
    await back(tester);

    // ── Arabic ───────────────────────────────────────────────────────
    await tester.tap(find.byType(DropdownButton<AppLocaleOption>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('العربية (Arabic)').last);
    await tester.pumpAndSettle();
    await hold(tester);

    await openHistory(tester, 'الخصوصية والبيانات', 'ما لاحظناه');
    await back(tester);
    await back(tester);

    // ── Hebrew ───────────────────────────────────────────────────────
    await tester.tap(find.byType(DropdownButton<AppLocaleOption>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('עברית (Hebrew)').last);
    await tester.pumpAndSettle();
    await hold(tester);

    await openHistory(tester, 'פרטיות ונתונים', 'מה שמנו לב אליו');
    await hold(tester);
  });
}
