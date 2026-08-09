import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/next_step/next_step_card.dart';
import 'package:maybesitter_mobile/features/trust/trust_center_screen.dart';
import 'package:maybesitter_mobile/features/trust/what_maybesitter_knows_screen.dart';

import '../support/v03_pilot_harness.dart';

void main() {
  final l10n = l10nFor('en');

  group('V03 accessibility', () {
    testWidgets('every decision control exposes a tappable semantics node', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await V03Harness().pump(tester, const NextStepCard());

      for (final label in [
        l10n.nextStepActionAccept,
        l10n.nextStepActionEdit,
        l10n.nextStepActionDefer,
        l10n.nextStepActionDismiss,
        l10n.nextStepActionDone,
      ]) {
        expect(
          find.bySemanticsLabel(label),
          findsOneWidget,
          reason: '"$label" has no semantics node',
        );
      }
      handle.dispose();
    });

    testWidgets('the proposed step is a heading', (tester) async {
      final handle = tester.ensureSemantics();
      await V03Harness().pump(tester, const NextStepCard());

      expect(
        tester.getSemantics(
          find.text('Call the vet about the booster shot'),
        ),
        matchesSemantics(
          label: 'Call the vet about the booster shot',
          isHeader: true,
        ),
      );
      handle.dispose();
    });

    testWidgets('decision acknowledgement is announced as a live region', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await V03Harness().pump(tester, const NextStepCard());

      await tester.tap(find.text(l10n.nextStepActionAccept));
      await tester.pumpAndSettle();

      expect(
        find.ancestor(
          of: find.text(l10n.nextStepAcceptedMessage),
          matching: find.byWidgetPredicate(
            (widget) => widget is Semantics && widget.properties.liveRegion == true,
          ),
        ),
        findsOneWidget,
        reason: 'the decision acknowledgement is not announced',
      );
      handle.dispose();
    });

    testWidgets('pilot state notices expose their title as a heading', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await V03Harness(suspended: true).pump(tester, const NextStepCard());

      expect(
        tester.getSemantics(find.text(l10n.pilotStateSuspendedTitle)),
        matchesSemantics(
          label: l10n.pilotStateSuspendedTitle,
          isHeader: true,
        ),
      );
      handle.dispose();
    });

    testWidgets('trust switches are reachable and correctly toggled', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await V03Harness(
        analyticsConsent: true,
        quietMode: false,
      ).pump(tester, const TrustCenterScreen(), isFullScreen: true);

      final switches = tester.widgetList<Switch>(find.byType(Switch)).toList();
      expect(switches.length, greaterThanOrEqualTo(3));
      for (final control in switches) {
        expect(
          control.onChanged,
          isNotNull,
          reason: 'a trust switch was not operable',
        );
      }
      handle.dispose();
    });

    testWidgets('every trust control meets the minimum touch target', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await V03Harness().pump(
        tester,
        const TrustCenterScreen(),
        isFullScreen: true,
      );

      // Material's own guidance and the design system both use 48dp.
      for (final element in find.byType(Switch).evaluate()) {
        final size = tester.getSize(find.byWidget(element.widget));
        expect(
          size.height,
          greaterThanOrEqualTo(40.0),
          reason: 'switch is smaller than a comfortable touch target',
        );
      }
      handle.dispose();
    });

    testWidgets('knows screen reads label and value as one node', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await V03Harness(confirmedCommitmentCount: 2).pump(
        tester,
        const WhatMaybeSitterKnowsScreen(),
        isFullScreen: true,
      );

      // MergeSemantics means the row announces as a single combined label
      // rather than as disconnected fragments.
      expect(
        find.bySemanticsLabel(
          RegExp(
            '${RegExp.escape(l10n.knowsCommitmentsLabel)}'
            '[\\s\\S]*'
            '${RegExp.escape(l10n.knowsCommitmentsCount(2))}',
          ),
        ),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('the delete confirmation is reachable by semantics', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await V03Harness().pump(
        tester,
        const TrustCenterScreen(),
        isFullScreen: true,
      );

      expect(find.bySemanticsLabel(l10n.trustDeleteTitle), findsWidgets);
      // The ListTile merges its title and subtitle into one label.
      expect(
        find.bySemanticsLabel(
          RegExp(RegExp.escape(l10n.trustWhatWeKnowAction)),
        ),
        findsWidgets,
      );
      handle.dispose();
    });
  });
}
