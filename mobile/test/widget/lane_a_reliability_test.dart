import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/features/capture/success_save_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';

Widget _buildLocalizedApp(Widget home) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: home,
  );
}

void main() {
  group('Lane A reliability regressions', () {
    testWidgets(
      'Capture composer opens empty, not prefilled with fixture text',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          ProviderScope(
            child: _buildLocalizedApp(const CaptureComposerScreen()),
          ),
        );
        await tester.pumpAndSettle();

        // A participant must start with a blank writing surface, not a demo
        // sentence they have to delete first.
        final textField = tester.widget<TextField>(find.byType(TextField));
        expect(textField.controller?.text, isEmpty);
        expect(
          find.text('Tomorrow I will go to the doctor and then work.'),
          findsNothing,
        );
      },
    );

    testWidgets(
      'Success screen reports only the commitments that were actually saved',
      (WidgetTester tester) async {
        final container = ProviderContainer();
        addTearDown(container.dispose);

        final notifier = container.read(captureControllerProvider.notifier);
        // Two items extracted, but the participant deselected the second one
        // before confirming, so only one should be persisted and reported.
        notifier.previewState(CaptureStatus.needsConfirmation);
        notifier.toggleItemSelection('prev-2');
        // `confirmSave` awaits a real `Future.delayed` inside the mock
        // capture service. Inside `testWidgets`, timers only fire once the
        // binding's clock is advanced via `tester.pump`, and nothing has
        // pumped yet at this point - so calling this directly would hang
        // forever. `runAsync` escapes to the real timer zone so the delay
        // actually elapses.
        await tester.runAsync(() => notifier.confirmSave());

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: _buildLocalizedApp(const SuccessSaveScreen()),
          ),
        );
        // Bounded pumps: the success screen runs a looping animation that never
        // settles, so pumpAndSettle would time out.
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pump(const Duration(milliseconds: 400));

        expect(find.text('Added 1 commitment for Tomorrow.'), findsOneWidget);
        expect(find.text('Go to the doctor'), findsOneWidget);
        // The deselected item was never saved, so it must not appear as saved.
        expect(find.text('Work afterward'), findsNothing);
      },
    );
  });
}
