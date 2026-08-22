import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maybesitter_mobile/app/app.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/services/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('App renders MaybesitterApp successfully', (
    WidgetTester tester,
  ) async {
    SharedPreferences.setMockInitialValues({'has_completed_onboarding': true});

    // This is a smoke test for the widget tree settling, not a test of real
    // backend integration -- explicit mock mode keeps it from making a real
    // HTTP call (e.g. the next-step card's post-frame fetch), which the
    // widget test sandbox cannot complete and which would otherwise time out
    // pumpAndSettle now that AppConfig's default is local-backend mode.
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appConfigProvider.overrideWith(
            (ref) => const AppConfig(apiMode: ApiMode.mock),
          ),
        ],
        child: const MaybesitterApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Maybesitter'), findsOneWidget);
  });
}
