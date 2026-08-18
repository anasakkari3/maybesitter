import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/features/capture/clarification_sheet_screen.dart';
import 'package:maybesitter_mobile/features/capture/extraction_review_screen.dart';
import 'package:maybesitter_mobile/features/capture/success_save_screen.dart';
import 'package:maybesitter_mobile/features/commitment_details/commitment_details_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/services/providers.dart';

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

    testWidgets(
      'Resolving a clarification keeps the real extracted items, not fixture data',
      (WidgetTester tester) async {
        final container = ProviderContainer();
        addTearDown(container.dispose);

        container
            .read(captureControllerProvider.notifier)
            .previewState(CaptureStatus.needsClarification);

        final router = GoRouter(
          initialLocation: '/capture/clarification',
          routes: [
            GoRoute(
              path: '/capture/clarification',
              builder: (context, state) => const ClarificationSheetScreen(),
            ),
            GoRoute(
              path: '/capture/review',
              builder: (context, state) => const ExtractionReviewScreen(),
            ),
          ],
        );

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp.router(
              debugShowCheckedModeBanner: false,
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: const [
                AppLocalizations.delegate,
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              routerConfig: router,
            ),
          ),
        );
        await tester.pumpAndSettle();

        // Answer the clarification prompt with its first option.
        await tester.tap(find.text('Schedule work 11:30 AM – 5:00 PM'));
        await tester.pumpAndSettle();

        // Must land on review still carrying what was actually extracted
        // from the participant's own input...
        expect(find.text('Review Your Plan'), findsOneWidget);
        expect(find.text('Doctor visit'), findsOneWidget);
        expect(find.text('Work'), findsOneWidget);
        // ...never silently swapped for unrelated placeholder commitments.
        expect(find.text('Go to the doctor'), findsNothing);
        expect(find.text('Work afterward'), findsNothing);
      },
    );

    testWidgets(
      'Edit icon on commitment details actually lets the participant edit',
      (WidgetTester tester) async {
        final container = ProviderContainer();
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: _buildLocalizedApp(
              const CommitmentDetailsScreen(id: 'c-today-1'),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Pet-Sitter Briefing'), findsOneWidget);

        // The pencil icon renders fully enabled (not greyed out) in mock
        // mode, so tapping it must do *something* - not silently no-op.
        await tester.tap(find.byIcon(Icons.edit_outlined));
        await tester.pumpAndSettle();

        expect(
          find.text('Edit Commitment'),
          findsOneWidget,
          reason:
              'Tapping the enabled-looking edit icon must open an editor, '
              'not do nothing.',
        );

        await tester.enterText(
          find.widgetWithText(TextField, 'Pet-Sitter Briefing'),
          'Updated briefing title',
        );
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();

        expect(find.text('Updated briefing title'), findsOneWidget);
        expect(
          container
              .read(commitmentsStreamProvider)
              .value!
              .firstWhere((c) => c.id == 'c-today-1')
              .title,
          'Updated briefing title',
        );
      },
    );
  });
}
