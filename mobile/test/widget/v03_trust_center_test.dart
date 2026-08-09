import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/design_system/components/maybesitter_buttons.dart';
import 'package:maybesitter_mobile/features/trust/trust_center_screen.dart';
import 'package:maybesitter_mobile/features/trust/what_maybesitter_knows_screen.dart';
import 'package:maybesitter_mobile/models/pilot_trust.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_trust_service.dart';

import '../support/v03_pilot_harness.dart';

void main() {
  final l10n = l10nFor('en');

  Finder switchFor(String label) => find.ancestor(
    of: find.text(label),
    matching: find.byType(Row),
  );

  /// The "Stopping" section sits below the fold on a phone-sized surface, so
  /// scroll it into view before tapping rather than tapping a clipped centre.
  Future<void> tapVisible(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  Future<void> toggle(WidgetTester tester, String label) async {
    final row = switchFor(label).first;
    await tester.tap(
      find.descendant(of: row, matching: find.byType(Switch)).first,
    );
    await tester.pumpAndSettle();
  }

  group('V03 trust centre', () {
    testWidgets('shows every participant control', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      expect(find.text(l10n.trustRecommendationConsentLabel), findsOneWidget);
      expect(find.text(l10n.trustAnalyticsConsentLabel), findsOneWidget);
      expect(find.text(l10n.trustQuietModeLabel), findsOneWidget);
      expect(find.text(l10n.trustWhatWeKnowAction), findsOneWidget);
      expect(find.text(l10n.trustRevokeTitle), findsWidgets);
      expect(find.text(l10n.trustDeleteTitle), findsWidgets);
    });

    testWidgets('analytics consent toggles independently of product use', (
      tester,
    ) async {
      final harness = V03Harness(analyticsConsent: false);
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      await toggle(tester, l10n.trustAnalyticsConsentLabel);

      final snapshot = await harness.trust.getSnapshot();
      expect(snapshot.trust.analyticsConsent, isTrue);
      // Refusing or granting analytics never changes exposure.
      expect(snapshot.exposure.allowed, isTrue);
    });

    testWidgets('Suggestions OFF stops suggestions without revoking anything else', (
      tester,
    ) async {
      final harness = V03Harness(
        recommendationConsent: true,
        analyticsConsent: true,
        calendarConsent: true,
        firstValueAt: DateTime.utc(2026, 8, 5),
      );
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      await toggle(tester, l10n.trustRecommendationConsentLabel);

      final snapshot = await harness.trust.getSnapshot();
      expect(snapshot.trust.recommendationConsent, isFalse);
      expect(snapshot.exposure.reason, PilotStopReason.consentRequired);

      // The switch is not a revoke: nothing else the participant consented to
      // may be withdrawn on their behalf.
      expect(snapshot.trust.isRevoked, isFalse);
      expect(snapshot.trust.revokedAt, isNull);
      expect(snapshot.trust.analyticsConsent, isTrue);
      expect(snapshot.trust.calendarConsent, isTrue);
      expect(snapshot.trust.isDeleted, isFalse);
      expect(snapshot.whatKnows.confirmedCommitmentCount, 3);
    });

    testWidgets('Suggestions ON again restores exposure', (tester) async {
      final harness = V03Harness(recommendationConsent: false);
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      await toggle(tester, l10n.trustRecommendationConsentLabel);

      final snapshot = await harness.trust.getSnapshot();
      expect(snapshot.trust.recommendationConsent, isTrue);
      expect(snapshot.exposure.allowed, isTrue);
    });

    test('the Suggestions switch and full revoke send different actions', () {
      // Guards the correction at the wire level: if these ever serialise the
      // same way, the switch has silently become a revoke again.
      expect(const SetRecommendationConsent(false).toJson(), {
        'type': 'set_recommendation_consent',
        'granted': false,
      });
      expect(const RevokeTrust().toJson(), {'type': 'revoke'});
      expect(
        const SetRecommendationConsent(false).toJson(),
        isNot(equals(const RevokeTrust().toJson())),
      );
    });

    testWidgets('quiet mode turns on and blocks exposure without deleting', (
      tester,
    ) async {
      final harness = V03Harness(quietMode: false);
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      await toggle(tester, l10n.trustQuietModeLabel);

      final snapshot = await harness.trust.getSnapshot();
      expect(snapshot.trust.quietMode, isTrue);
      expect(snapshot.exposure.allowed, isFalse);
      // Commitments survive quiet mode.
      expect(snapshot.whatKnows.confirmedCommitmentCount, 3);
      expect(snapshot.trust.isDeleted, isFalse);
    });

    testWidgets('revoke is confirmed, clears consents and keeps commitments', (
      tester,
    ) async {
      final harness = V03Harness(analyticsConsent: true);
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      await tapVisible(
        tester,
        find.widgetWithText(SecondaryButton, l10n.trustRevokeTitle),
      );
      expect(find.text(l10n.trustRevokeConfirmTitle), findsOneWidget);
      expect(find.text(l10n.trustRevokeConfirmMessage), findsOneWidget);

      await tester.tap(find.widgetWithText(TextButton, l10n.trustRevokeTitle));
      await tester.pumpAndSettle();

      final snapshot = await harness.trust.getSnapshot();
      expect(snapshot.trust.recommendationConsent, isFalse);
      expect(snapshot.trust.analyticsConsent, isFalse);
      expect(snapshot.trust.calendarConsent, isFalse);
      expect(snapshot.trust.isRevoked, isTrue);
      expect(snapshot.trust.isDeleted, isFalse);
      expect(snapshot.whatKnows.confirmedCommitmentCount, 3);
    });

    testWidgets('cancelling the revoke dialog changes nothing', (tester) async {
      final harness = V03Harness(analyticsConsent: true);
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      await tapVisible(
        tester,
        find.widgetWithText(SecondaryButton, l10n.trustRevokeTitle),
      );
      await tapVisible(tester, find.widgetWithText(TextButton, l10n.cancelAction));

      final snapshot = await harness.trust.getSnapshot();
      expect(snapshot.trust.isRevoked, isFalse);
      expect(snapshot.trust.analyticsConsent, isTrue);
    });

    testWidgets(
      'deletion needs an explicit acknowledgement before it can be confirmed',
      (tester) async {
        final harness = V03Harness();
        await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

        await tapVisible(
          tester,
          find.widgetWithText(DestructiveButton, l10n.trustDeleteTitle),
        );

        expect(find.text(l10n.trustDeleteConfirmTitle), findsOneWidget);
        expect(find.text(l10n.trustDeleteAcknowledge), findsOneWidget);

        // The destructive action is inert until the consequence is ticked.
        final confirm = tester.widget<TextButton>(
          find.widgetWithText(TextButton, l10n.trustDeleteTitle),
        );
        expect(confirm.onPressed, isNull);

        await tester.tap(find.byType(Checkbox));
        await tester.pumpAndSettle();

        final armed = tester.widget<TextButton>(
          find.widgetWithText(TextButton, l10n.trustDeleteTitle),
        );
        expect(armed.onPressed, isNotNull);

        await tester.tap(find.widgetWithText(TextButton, l10n.trustDeleteTitle));
        await tester.pumpAndSettle();

        final snapshot = await harness.trust.getSnapshot();
        expect(snapshot.trust.isDeleted, isTrue);
        expect(snapshot.whatKnows.confirmedCommitmentCount, 0);
      },
    );

    testWidgets('cancelling deletion deletes nothing', (tester) async {
      final harness = V03Harness();
      await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

      await tapVisible(
        tester,
        find.widgetWithText(DestructiveButton, l10n.trustDeleteTitle),
      );
      await tapVisible(tester, find.widgetWithText(TextButton, l10n.cancelAction));

      final snapshot = await harness.trust.getSnapshot();
      expect(snapshot.trust.isDeleted, isFalse);
      expect(snapshot.whatKnows.confirmedCommitmentCount, 3);
    });

    group('progressive calendar consent', () {
      testWidgets('is not offered before first value', (tester) async {
        final harness = V03Harness(firstValueAt: null);
        await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

        expect(find.text(l10n.trustCalendarConsentLabel), findsNothing);
        expect(find.text(l10n.trustCalendarLockedTitle), findsOneWidget);
        expect(find.text(l10n.trustCalendarLockedMessage), findsOneWidget);
      });

      testWidgets('appears once the product has produced value', (
        tester,
      ) async {
        final harness = V03Harness(firstValueAt: DateTime.utc(2026, 8, 5));
        await harness.pump(tester, const TrustCenterScreen(), isFullScreen: true);

        expect(find.text(l10n.trustCalendarConsentLabel), findsOneWidget);
        expect(find.text(l10n.trustCalendarLockedTitle), findsNothing);
      });

      testWidgets('cannot be granted early even if something asks', (
        tester,
      ) async {
        final harness = V03Harness(firstValueAt: null);
        await harness.trust.apply(action: const SetCalendarConsent(true),
        );
        final snapshot = await harness.trust.getSnapshot();
        expect(snapshot.trust.calendarConsent, isFalse);
      });
    });
  });

  group('What MaybeSitter knows', () {
    testWidgets('lists what is held and what is never collected', (
      tester,
    ) async {
      final harness = V03Harness(
        analyticsConsent: true,
        confirmedCommitmentCount: 2,
      );
      await harness.pump(
        tester,
        const WhatMaybeSitterKnowsScreen(),
        isFullScreen: true,
      );

      expect(find.text(l10n.knowsCommitmentsLabel), findsOneWidget);
      expect(find.text(l10n.knowsCommitmentsCount(2)), findsOneWidget);
      expect(find.text(l10n.knowsRecommendationLabel), findsOneWidget);
      expect(find.text(l10n.knowsAnalyticsLabel), findsOneWidget);
      expect(find.text(l10n.knowsCalendarLabel), findsOneWidget);
      expect(find.text(l10n.knowsNotConnected), findsOneWidget);

      expect(find.text(l10n.knowsNeverSectionTitle), findsOneWidget);
      expect(find.text(l10n.knowsNoMessages), findsOneWidget);
      expect(find.text(l10n.knowsNoSensitive), findsOneWidget);
      expect(find.text(l10n.knowsNoMedical), findsOneWidget);

      expect(find.text('pilot-participant'), findsOneWidget);
      expect(find.text(l10n.knowsParticipantNote), findsOneWidget);
    });

    testWidgets('reflects consent state rather than asserting it', (
      tester,
    ) async {
      final harness = V03Harness(
        recommendationConsent: false,
        analyticsConsent: false,
      );
      await harness.pump(
        tester,
        const WhatMaybeSitterKnowsScreen(),
        isFullScreen: true,
      );

      expect(find.text(l10n.knowsOff), findsNWidgets(2));
      expect(find.text(l10n.knowsOn), findsNothing);
    });
  });
}
