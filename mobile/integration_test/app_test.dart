import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maybesitter_mobile/app/app.dart';

void main() {
  testWidgets('Integration Test: Full Capture Demonstration Flow',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaybesitterApp(),
      ),
    );
    await tester.pumpAndSettle();

    // 1. Verify Home screen loads
    expect(find.text('Maybesitter'), findsOneWidget);

    // 2. Open Capture Composer
    final captureFab = find.bySemanticsLabel('Capture Plan');
    expect(captureFab, findsOneWidget);
    await tester.tap(captureFab);
    await tester.pumpAndSettle();

    // 3. Verify Composer is open with default text
    expect(find.text('New Intent'), findsOneWidget);

    // 4. Tap Analyze button
    final analyzeBtn = find.text('Analyze');
    expect(analyzeBtn, findsOneWidget);
    await tester.tap(analyzeBtn);
    await tester.pump(const Duration(milliseconds: 1000));
    await tester.pumpAndSettle();

    // 5. Verify Extraction Review screen shows 2 commitments
    expect(find.text('Review Your Plan'), findsOneWidget);
    expect(find.text('Go to the doctor'), findsOneWidget);
    expect(find.text('Work afterward'), findsOneWidget);

    // 6. Confirm commitments
    final confirmBtn = find.textContaining('Confirm 2 Commitments');
    expect(confirmBtn, findsOneWidget);
    await tester.tap(confirmBtn);
    await tester.pumpAndSettle();

    // 7. Verify Success Save screen
    expect(find.text('Added 2 commitments for tomorrow.'), findsOneWidget);

    // 8. Navigate to Upcoming screen
    final viewTomorrowBtn = find.text('View Tomorrow');
    expect(viewTomorrowBtn, findsOneWidget);
    await tester.tap(viewTomorrowBtn);
    await tester.pumpAndSettle();

    // 9. Verify commitments exist on Upcoming screen
    expect(find.text('Upcoming Agenda'), findsOneWidget);
    expect(find.text('Go to the doctor'), findsOneWidget);
    expect(find.text('Work afterward'), findsOneWidget);
  });
}
