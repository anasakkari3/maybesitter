import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/next_step/next_step_card.dart';
import 'package:maybesitter_mobile/features/trust/trust_center_screen.dart';
import 'package:maybesitter_mobile/features/trust/what_maybesitter_knows_screen.dart';
import 'package:maybesitter_mobile/models/next_step.dart';

import '../support/v03_pilot_harness.dart';

void main() {
  /// A proposal whose step title is in the tested language, so RTL cases are
  /// not silently passing on Latin text inside an RTL frame.
  NextStepRecommendation proposalIn(String locale, String title) =>
      NextStepRecommendation(
        proposalId: 'proposal-$locale',
        state: NextStepState.ready,
        locale: locale,
        primaryStep: NextStepPrimaryStep(commitmentId: 'c-1', title: title),
        explanation: const NextStepExplanation(
          summary: '...',
          evidenceLabels: ['due_today', 'confirmed_by_you'],
        ),
        availableActions: const [
          NextStepDecision.accept,
          NextStepDecision.edit,
          NextStepDecision.defer,
          NextStepDecision.dismiss,
          NextStepDecision.done,
        ],
      );

  TextDirection directionOf(WidgetTester tester) => tester
      .widget<Directionality>(find.byType(Directionality).first)
      .textDirection;

  group('V03 surfaces in English', () {
    final l10n = l10nFor('en');

    testWidgets('recommendation renders LTR with English labels', (
      tester,
    ) async {
      await V03Harness(
        proposal: proposalIn('en', 'Call the vet'),
      ).pump(tester, const NextStepCard());

      expect(directionOf(tester), TextDirection.ltr);
      expect(find.text('Call the vet'), findsOneWidget);
      expect(find.text(l10n.nextStepActionAccept), findsOneWidget);
      expect(find.text(l10n.evidenceDueToday), findsOneWidget);
    });

    testWidgets('trust centre renders English labels', (tester) async {
      await V03Harness().pump(
        tester,
        const TrustCenterScreen(),
        isFullScreen: true,
      );
      expect(find.text(l10n.trustQuietModeLabel), findsOneWidget);
      expect(find.text(l10n.trustRecommendationConsentLabel), findsOneWidget);
    });
  });

  group('V03 surfaces in Arabic (RTL)', () {
    final l10n = l10nFor('ar');
    const locale = Locale('ar');

    testWidgets('recommendation renders RTL with Arabic labels', (
      tester,
    ) async {
      await V03Harness(
        proposal: proposalIn('ar', 'الاتصال بالطبيب البيطري'),
      ).pump(tester, const NextStepCard(), locale: locale);

      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text('الاتصال بالطبيب البيطري'), findsOneWidget);
      expect(find.text(l10n.nextStepSectionTitle), findsOneWidget);
      expect(find.text(l10n.nextStepActionAccept), findsOneWidget);
      expect(find.text(l10n.nextStepActionDismiss), findsOneWidget);
      // The proposal-only promise must survive translation.
      expect(find.text(l10n.nextStepProposalNotice), findsOneWidget);
      expect(find.text(l10n.evidenceDueToday), findsOneWidget);
    });

    testWidgets('pilot states render RTL Arabic copy', (tester) async {
      await V03Harness(
        quietMode: true,
      ).pump(tester, const NextStepCard(), locale: locale);

      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text(l10n.pilotStateQuietTitle), findsOneWidget);
      expect(find.text(l10n.pilotStateQuietAction), findsOneWidget);
    });

    testWidgets('trust centre renders RTL Arabic copy', (tester) async {
      await V03Harness().pump(
        tester,
        const TrustCenterScreen(),
        locale: locale,
        isFullScreen: true,
      );
      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text(l10n.trustCenterTitle), findsOneWidget);
      expect(find.text(l10n.trustQuietModeLabel), findsOneWidget);
      expect(find.text(l10n.trustCalendarLockedTitle), findsOneWidget);
    });

    testWidgets('knows screen renders RTL Arabic copy', (tester) async {
      await V03Harness().pump(
        tester,
        const WhatMaybeSitterKnowsScreen(),
        locale: locale,
        isFullScreen: true,
      );
      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text(l10n.knowsNeverSectionTitle), findsOneWidget);
      expect(find.text(l10n.knowsNoMedical), findsOneWidget);
    });

    testWidgets('Arabic copy at 2.0x text scale does not overflow', (
      tester,
    ) async {
      final harness = V03Harness(
        proposal: proposalIn('ar', 'دفع فاتورة الكهرباء'),
      );
      await harness.pump(
        tester,
        const MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(2.0)),
          child: NextStepCard(),
        ),
        locale: locale,
        surface: const Size(420, 2400),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('دفع فاتورة الكهرباء'), findsOneWidget);
    });
  });

  group('V03 surfaces in Hebrew (RTL)', () {
    final l10n = l10nFor('he');
    const locale = Locale('he');

    testWidgets('recommendation renders RTL with Hebrew labels', (
      tester,
    ) async {
      await V03Harness(
        proposal: proposalIn('he', 'להתקשר לווטרינר'),
      ).pump(tester, const NextStepCard(), locale: locale);

      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text('להתקשר לווטרינר'), findsOneWidget);
      expect(find.text(l10n.nextStepSectionTitle), findsOneWidget);
      expect(find.text(l10n.nextStepActionAccept), findsOneWidget);
      expect(find.text(l10n.nextStepProposalNotice), findsOneWidget);
      expect(find.text(l10n.evidenceConfirmedByYou), findsOneWidget);
    });

    testWidgets('pilot states render RTL Hebrew copy', (tester) async {
      await V03Harness(
        suspended: true,
      ).pump(tester, const NextStepCard(), locale: locale);

      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text(l10n.pilotStateSuspendedTitle), findsOneWidget);
      expect(find.text(l10n.pilotStateSuspendedMessage), findsOneWidget);
    });

    testWidgets('trust centre renders RTL Hebrew copy', (tester) async {
      await V03Harness().pump(
        tester,
        const TrustCenterScreen(),
        locale: locale,
        isFullScreen: true,
      );
      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text(l10n.trustCenterTitle), findsOneWidget);
      expect(find.text(l10n.trustDeleteTitle), findsWidgets);
    });

    testWidgets('knows screen renders RTL Hebrew copy', (tester) async {
      await V03Harness().pump(
        tester,
        const WhatMaybeSitterKnowsScreen(),
        locale: locale,
        isFullScreen: true,
      );
      expect(directionOf(tester), TextDirection.rtl);
      expect(find.text(l10n.knowsNeverSectionTitle), findsOneWidget);
      expect(find.text(l10n.knowsNoMessages), findsOneWidget);
    });
  });

  group('translation completeness', () {
    testWidgets('no V03 string falls back to English in Arabic or Hebrew', (
      tester,
    ) async {
      final en = l10nFor('en');
      for (final l10n in [l10nFor('ar'), l10nFor('he')]) {
        // A representative sample across every V03 surface. If a key were
        // missing from an .arb, gen-l10n would emit the English text and these
        // would compare equal.
        final pairs = <String, List<String>>{
          'nextStepSectionTitle': [en.nextStepSectionTitle, l10n.nextStepSectionTitle],
          'nextStepProposalNotice': [en.nextStepProposalNotice, l10n.nextStepProposalNotice],
          'nextStepWhyTitle': [en.nextStepWhyTitle, l10n.nextStepWhyTitle],
          'nextStepActionAccept': [en.nextStepActionAccept, l10n.nextStepActionAccept],
          'nextStepActionDismiss': [en.nextStepActionDismiss, l10n.nextStepActionDismiss],
          'evidenceDueToday': [en.evidenceDueToday, l10n.evidenceDueToday],
          'pilotStateSuspendedTitle': [en.pilotStateSuspendedTitle, l10n.pilotStateSuspendedTitle],
          'pilotStatePausedTitle': [en.pilotStatePausedTitle, l10n.pilotStatePausedTitle],
          'pilotStateUnauthorizedTitle': [en.pilotStateUnauthorizedTitle, l10n.pilotStateUnauthorizedTitle],
          'pilotStateConsentRequiredTitle': [en.pilotStateConsentRequiredTitle, l10n.pilotStateConsentRequiredTitle],
          'trustCenterTitle': [en.trustCenterTitle, l10n.trustCenterTitle],
          'trustQuietModeLabel': [en.trustQuietModeLabel, l10n.trustQuietModeLabel],
          'trustDeleteAcknowledge': [en.trustDeleteAcknowledge, l10n.trustDeleteAcknowledge],
          'trustCalendarLockedTitle': [en.trustCalendarLockedTitle, l10n.trustCalendarLockedTitle],
          'knowsTitle': [en.knowsTitle, l10n.knowsTitle],
          'knowsNoMedical': [en.knowsNoMedical, l10n.knowsNoMedical],
        };
        pairs.forEach((key, values) {
          expect(
            values[1],
            isNot(equals(values[0])),
            reason: '$key is untranslated in ${l10n.localeName}',
          );
          expect(values[1].trim(), isNotEmpty, reason: '$key is empty');
        });
      }
    });
  });
}
