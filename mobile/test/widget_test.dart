import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('App renders MaybesitterApp successfully', (
    WidgetTester tester,
  ) async {
    SharedPreferences.setMockInitialValues({'has_completed_onboarding': true});

    await tester.pumpWidget(const ProviderScope(child: MaybesitterApp()));
    await tester.pumpAndSettle();

    expect(find.text('Maybesitter'), findsOneWidget);
  });
}
