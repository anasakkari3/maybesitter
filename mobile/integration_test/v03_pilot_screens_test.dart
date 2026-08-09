import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/features/next_step/next_step_card.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Drives the real app on a device or simulator so the V03 pilot surfaces can
/// be screenshotted and eyeballed. Widget tests prove behaviour; this proves
/// the screens actually compose on a real viewport at real density.
///
/// Run against a booted simulator:
///
///   flutter test integration_test/v03_pilot_screens_test.dart -d DEVICE_ID
///
/// Screenshots are taken with `xcrun simctl io DEVICE_ID screenshot` from outside
/// the test, at the pauses below.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('V03 participant loop renders on a real device', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: MaybesitterApp()));
    await tester.pumpAndSettle(const Duration(seconds: 2));

    // Today, leading with the one-next-step card.
    expect(find.byType(NextStepCard), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));

    // Trust centre.
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Trust & privacy'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 3));

    // What MaybeSitter knows.
    await tester.tap(find.text('What MaybeSitter knows'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 3));
  });
}
