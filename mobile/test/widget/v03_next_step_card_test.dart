import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/next_step/next_step_card.dart';
import 'package:maybesitter_mobile/models/next_step.dart';

import '../support/v03_pilot_harness.dart';

void main() {
  final l10n = l10nFor('en');

  group('V03 next-step card', () {
    testWidgets('renders exactly one proposed step', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.nextStepSectionTitle), findsOneWidget);
      expect(
        find.text('Call the vet about the booster shot'),
        findsOneWidget,
      );

      // One step means one accept affordance. A second would mean the card had
      // started behaving like a task list.
      expect(find.text(l10n.nextStepActionAccept), findsOneWidget);
    });

    testWidgets('renders the explanation, its evidence and the no-sensitive-inference note', (
      tester,
    ) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.nextStepWhyTitle), findsOneWidget);
      expect(
        find.text('This is due today and you confirmed it yourself.'),
        findsOneWidget,
      );
      // Evidence codes are localized, never echoed raw.
      expect(find.text(l10n.evidenceDueToday), findsOneWidget);
      expect(find.text(l10n.evidenceConfirmedByYou), findsOneWidget);
      expect(find.text('due_today'), findsNothing);
      expect(find.text(l10n.nextStepNoSensitiveInference), findsOneWidget);
    });

    testWidgets('states that nothing has been changed yet', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.nextStepProposalNotice), findsOneWidget);
    });

    testWidgets('never reveals the experiment arm or the proposal id', (
      tester,
    ) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      final rendered = tester
          .widgetList<Text>(find.byType(Text))
          .map((text) => (text.data ?? '').toLowerCase())
          .join(' | ');

      for (final leak in [
        'generic',
        'contextual',
        'personalized',
        'arm',
        'variant',
        'experiment',
        'baseline',
        'proposal-mock-1',
      ]) {
        expect(
          rendered.contains(leak),
          isFalse,
          reason: 'participant-visible text leaked "$leak"',
        );
      }
    });

    testWidgets('uses no guilt, command or judgement language', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      final rendered = tester
          .widgetList<Text>(find.byType(Text))
          .map((text) => (text.data ?? '').toLowerCase())
          .join(' | ');

      for (final forbidden in [
        'you must',
        'you should have',
        'failed',
        'behind',
        'overdue by',
        "don't forget",
      ]) {
        expect(
          rendered.contains(forbidden),
          isFalse,
          reason: 'participant-visible text used "$forbidden"',
        );
      }
    });

    testWidgets('accept records an accept decision and acknowledges it', (
      tester,
    ) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      await tester.tap(find.text(l10n.nextStepActionAccept));
      await tester.pumpAndSettle();

      expect(harness.nextStep.recordedDecisions, hasLength(1));
      expect(
        harness.nextStep.recordedDecisions.single.decision,
        NextStepDecision.accept,
      );
      expect(
        harness.nextStep.recordedDecisions.single.proposalId,
        'proposal-mock-1',
      );
      expect(find.text(l10n.nextStepAcceptedMessage), findsOneWidget);
    });

    testWidgets('edit sends the rewritten title with an edit decision', (
      tester,
    ) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      await tester.tap(find.text(l10n.nextStepActionEdit));
      await tester.pumpAndSettle();
      expect(find.text(l10n.nextStepEditTitle), findsWidgets);

      await tester.enterText(find.byType(TextField), 'Book the vet online');
      await tester.pumpAndSettle();
      await tester.tap(find.text(l10n.saveAction));
      await tester.pumpAndSettle();

      final decision = harness.nextStep.recordedDecisions.single;
      expect(decision.decision, NextStepDecision.edit);
      expect(decision.editedTitle, 'Book the vet online');
      expect(find.text(l10n.nextStepEditedMessage), findsOneWidget);
    });

    testWidgets('cancelling the edit sheet records no decision', (
      tester,
    ) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      await tester.tap(find.text(l10n.nextStepActionEdit));
      await tester.pumpAndSettle();
      await tester.tap(find.text(l10n.cancelAction));
      await tester.pumpAndSettle();

      expect(harness.nextStep.recordedDecisions, isEmpty);
      expect(find.text('Call the vet about the booster shot'), findsOneWidget);
    });

    testWidgets('defer records a defer decision', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      await tester.tap(find.text(l10n.nextStepActionDefer));
      await tester.pumpAndSettle();

      expect(
        harness.nextStep.recordedDecisions.single.decision,
        NextStepDecision.defer,
      );
      expect(find.text(l10n.nextStepDeferredMessage), findsOneWidget);
    });

    testWidgets('dismiss records a dismiss decision', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      await tester.tap(find.text(l10n.nextStepActionDismiss));
      await tester.pumpAndSettle();

      expect(
        harness.nextStep.recordedDecisions.single.decision,
        NextStepDecision.dismiss,
      );
      expect(find.text(l10n.nextStepDismissedMessage), findsOneWidget);
    });

    testWidgets('done records a done decision', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const NextStepCard());

      await tester.tap(find.text(l10n.nextStepActionDone));
      await tester.pumpAndSettle();

      expect(
        harness.nextStep.recordedDecisions.single.decision,
        NextStepDecision.done,
      );
      expect(find.text(l10n.nextStepDoneMessage), findsOneWidget);
    });

    testWidgets('only offers the actions the backend allowed', (tester) async {
      final harness = V03Harness(
        proposal: const NextStepRecommendation(
          proposalId: 'proposal-limited',
          state: NextStepState.ready,
          locale: 'en',
          primaryStep: NextStepPrimaryStep(
            commitmentId: 'c-1',
            title: 'Send the deposit',
          ),
          availableActions: [NextStepDecision.accept, NextStepDecision.dismiss],
        ),
      );
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.nextStepActionAccept), findsOneWidget);
      expect(find.text(l10n.nextStepActionDismiss), findsOneWidget);
      expect(find.text(l10n.nextStepActionEdit), findsNothing);
      expect(find.text(l10n.nextStepActionDefer), findsNothing);
      expect(find.text(l10n.nextStepActionDone), findsNothing);
    });

    testWidgets('shows the empty state when there is nothing to propose', (
      tester,
    ) async {
      final harness = V03Harness(proposal: null);
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.nextStepEmptyTitle), findsOneWidget);
      expect(find.text(l10n.nextStepActionAccept), findsNothing);
    });

    testWidgets('distinguishes insufficient evidence from empty', (
      tester,
    ) async {
      final harness = V03Harness(
        proposal: null,
        emptyState: NextStepState.insufficientEvidence,
      );
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.nextStepInsufficientTitle), findsOneWidget);
      expect(find.text(l10n.nextStepEmptyTitle), findsNothing);
    });
  });
}
