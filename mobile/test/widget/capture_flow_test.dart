import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/features/capture/clarification_sheet_screen.dart';
import 'package:maybesitter_mobile/features/capture/extraction_review_screen.dart';
import 'package:maybesitter_mobile/features/capture/success_save_screen.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';

void main() {
  group('Capture Flow Widget Tests', () {
    testWidgets('Renders CaptureComposerScreen correctly', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        const ProviderScope(child: MaterialApp(home: CaptureComposerScreen())),
      );
      await tester.pumpAndSettle();

      expect(find.text('New Intent'), findsOneWidget);
      expect(find.text('Analyze'), findsOneWidget);
    });

    testWidgets('Renders ExtractionReviewScreen with proposed items', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.needsConfirmation);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: ExtractionReviewScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Review Your Plan'), findsOneWidget);
      expect(find.text('Go to the doctor'), findsOneWidget);
      expect(find.text('Work afterward'), findsOneWidget);
    });

    testWidgets('Renders ClarificationSheetScreen correctly', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.needsClarification);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: ClarificationSheetScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Clarification'), findsOneWidget);
      expect(find.text('Clarification Needed'), findsOneWidget);
    });

    testWidgets('Renders SuccessSaveScreen correctly', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.saved);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: SuccessSaveScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Added 2 commitments for tomorrow.'), findsOneWidget);
      expect(find.text('View Tomorrow'), findsOneWidget);
    });
  });
}
