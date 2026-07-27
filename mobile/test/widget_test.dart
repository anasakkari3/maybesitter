import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maybesitter_mobile/app/app.dart';

void main() {
  testWidgets('App renders MaybesitterApp successfully', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const ProviderScope(child: MaybesitterApp()));
    await tester.pumpAndSettle();

    expect(find.text('Maybesitter'), findsOneWidget);
  });
}
