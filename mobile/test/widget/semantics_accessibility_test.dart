import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/design_system/components/commitment_status_badge.dart';
import 'package:maybesitter_mobile/design_system/components/extraction_review_card.dart';
import 'package:maybesitter_mobile/design_system/components/maybesitter_buttons.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/commitment.dart';

Widget _wrapWithApp(Widget child, {Locale locale = const Locale('en')}) {
  return ProviderScope(
    child: MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    ),
  );
}

void main() {
  group('Accessibility & Widget Semantics Closure Tests', () {
    testWidgets(
      '1. Android & iOS tap target guidelines check for PrimaryButton',
      (tester) async {
        final SemanticsHandle handle = tester.ensureSemantics();
        await tester.pumpWidget(
          _wrapWithApp(
            Scaffold(
              body: Center(
                child: PrimaryButton(
                  label: 'Confirm 2 Commitments',
                  onPressed: () {},
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        handle.dispose();
      },
    );

    testWidgets('2. Analyze button has primary button semantics and label', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrapWithApp(
          PrimaryButton(
            label: 'Analyze',
            icon: Icons.auto_awesome,
            onPressed: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      final buttonFinder = find.byType(ElevatedButton);
      expect(buttonFinder, findsOneWidget);
      expect(find.text('Analyze'), findsOneWidget);
    });

    testWidgets('3. Disabled analyze button communicates disabled state', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrapWithApp(const PrimaryButton(label: 'Analyze', onPressed: null)),
      );
      await tester.pumpAndSettle();

      final elevatedButton = tester.widget<ElevatedButton>(
        find.byType(ElevatedButton),
      );
      expect(elevatedButton.onPressed, isNull);
    });

    testWidgets(
      '4. ExtractionReviewCard checkbox semantics reflect selected and disabled states',
      (tester) async {
        const validItem = Commitment(
          id: 'item-valid',
          title: 'Valid Commitment Title',
        );

        await tester.pumpWidget(
          _wrapWithApp(
            const Scaffold(
              body: ExtractionReviewCard(
                commitment: validItem,
                isSelected: true,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final checkbox = tester.widget<Checkbox>(find.byType(Checkbox));
        expect(checkbox.value, isTrue);

        const clarifyItem = Commitment(
          id: 'item-clarify',
          title: 'Clarification Needed Item',
          needsClarification: true,
        );

        await tester.pumpWidget(
          _wrapWithApp(
            const Scaffold(
              body: ExtractionReviewCard(
                commitment: clarifyItem,
                isSelected: true,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final disabledCheckbox = tester.widget<Checkbox>(find.byType(Checkbox));
        expect(disabledCheckbox.value, isFalse);
        expect(disabledCheckbox.onChanged, isNull);
      },
    );

    testWidgets(
      '5. CommitmentStatusBadge handles Pending, Completed, and Unknown statuses cleanly',
      (tester) async {
        await tester.pumpWidget(
          _wrapWithApp(
            const Scaffold(
              body: Column(
                children: [
                  CommitmentStatusBadge(status: CommitmentStatus.pending),
                  CommitmentStatusBadge(status: CommitmentStatus.completed),
                  CommitmentStatusBadge(status: CommitmentStatus.unknown),
                ],
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Pending'), findsOneWidget);
        expect(find.text('Completed'), findsOneWidget);
        expect(find.text('Unknown'), findsOneWidget);
      },
    );

    testWidgets(
      '6. Capture composer voice button is disabled with coming-soon tooltip',
      (tester) async {
        await tester.pumpWidget(_wrapWithApp(const CaptureComposerScreen()));
        await tester.pumpAndSettle();

        final tooltipFinder = find.byTooltip('Voice Capture (Coming soon)');
        expect(tooltipFinder, findsOneWidget);

        final iconButtonFinder = find.ancestor(
          of: find.byIcon(Icons.mic_none),
          matching: find.byType(IconButton),
        );
        expect(iconButtonFinder, findsOneWidget);
        final iconButton = tester.widget<IconButton>(iconButtonFinder);
        expect(iconButton.onPressed, isNull);
      },
    );

    testWidgets(
      '8. Text contrast guideline check across major screens and states',
      (tester) async {
        final SemanticsHandle handle = tester.ensureSemantics();
        await tester.pumpWidget(_wrapWithApp(const CaptureComposerScreen()));
        await tester.pumpAndSettle();

        await expectLater(tester, meetsGuideline(textContrastGuideline));
        handle.dispose();
      },
    );
  });
}
