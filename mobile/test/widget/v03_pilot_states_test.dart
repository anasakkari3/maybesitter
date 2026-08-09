import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/design_system/components/maybesitter_buttons.dart';
import 'package:maybesitter_mobile/features/next_step/next_step_card.dart';
import 'package:maybesitter_mobile/features/pilot/pilot_state_notice.dart';
import 'package:maybesitter_mobile/models/pilot_trust.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';

import '../support/v03_pilot_harness.dart';

void main() {
  final l10n = l10nFor('en');

  /// Every blocked state must explain itself and must never leave a proposal
  /// on screen.
  Future<void> expectBlocked(
    WidgetTester tester,
    V03Harness harness, {
    required String title,
    required String message,
  }) async {
    await harness.pump(tester, const NextStepCard());
    expect(find.text(title), findsOneWidget);
    expect(find.text(message), findsOneWidget);
    expect(find.text('Call the vet about the booster shot'), findsNothing);
    expect(find.text(l10n.nextStepActionAccept), findsNothing);
  }

  group('V03 pilot states', () {
    testWidgets('participant not authorized', (tester) async {
      await expectBlocked(
        tester,
        V03Harness(allowlisted: false),
        title: l10n.pilotStateUnauthorizedTitle,
        message: l10n.pilotStateUnauthorizedMessage,
      );
      // Nothing the participant can press fixes an allowlist decision, so no
      // recovery button is offered.
      expect(find.byType(PrimaryButton), findsNothing);
    });

    testWidgets('participant suspended', (tester) async {
      await expectBlocked(
        tester,
        V03Harness(suspended: true),
        title: l10n.pilotStateSuspendedTitle,
        message: l10n.pilotStateSuspendedMessage,
      );
      expect(find.text(l10n.pilotStateUnauthorizedTitle), findsNothing);
    });

    testWidgets('pilot paused by the kill switch', (tester) async {
      await expectBlocked(
        tester,
        V03Harness(killSwitchActive: true),
        title: l10n.pilotStatePausedTitle,
        message: l10n.pilotStatePausedMessage,
      );
    });

    testWidgets('recommendation feature disabled', (tester) async {
      await expectBlocked(
        tester,
        V03Harness(featureEnabled: false),
        title: l10n.pilotStateDisabledTitle,
        message: l10n.pilotStateDisabledMessage,
      );
    });

    testWidgets('recommendation consent required, and grantable in place', (
      tester,
    ) async {
      final harness = V03Harness(recommendationConsent: false);
      await expectBlocked(
        tester,
        harness,
        title: l10n.pilotStateConsentRequiredTitle,
        message: l10n.pilotStateConsentRequiredMessage,
      );

      await tester.tap(find.text(l10n.pilotStateConsentRequiredAction));
      await tester.pumpAndSettle();

      final snapshot = await harness.trust.getSnapshot(
        participantId: 'pilot-participant',
      );
      expect(snapshot.trust.recommendationConsent, isTrue);
      expect(find.text('Call the vet about the booster shot'), findsOneWidget);
    });

    testWidgets('quiet mode blocks the proposal and can be turned off', (
      tester,
    ) async {
      final harness = V03Harness(quietMode: true);
      await expectBlocked(
        tester,
        harness,
        title: l10n.pilotStateQuietTitle,
        message: l10n.pilotStateQuietMessage,
      );

      await tester.tap(find.text(l10n.pilotStateQuietAction));
      await tester.pumpAndSettle();

      expect(find.text('Call the vet about the booster shot'), findsOneWidget);
    });

    testWidgets('revoked state offers a way back', (tester) async {
      final harness = V03Harness(
        recommendationConsent: false,
        revokedAt: DateTime.utc(2026, 8, 1),
      );
      await expectBlocked(
        tester,
        harness,
        title: l10n.pilotStateRevokedTitle,
        message: l10n.pilotStateRevokedMessage,
      );

      await tester.tap(find.text(l10n.pilotStateRevokedAction));
      await tester.pumpAndSettle();
      expect(find.text('Call the vet about the booster shot'), findsOneWidget);
    });

    testWidgets('deleted state offers no recovery action', (tester) async {
      await expectBlocked(
        tester,
        V03Harness(
          recommendationConsent: false,
          deletedAt: DateTime.utc(2026, 8, 1),
        ),
        title: l10n.pilotStateDeletedTitle,
        message: l10n.pilotStateDeletedMessage,
      );
      expect(find.byType(PrimaryButton), findsNothing);
    });

    testWidgets('backend or network failure is retryable and reassuring', (
      tester,
    ) async {
      final harness = V03Harness(
        failWith: const NetworkException('connection refused'),
      );
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.pilotStateOfflineTitle), findsOneWidget);
      expect(find.text(l10n.pilotStateOfflineMessage), findsOneWidget);
      expect(find.text(l10n.retryAction), findsOneWidget);
    });

    testWidgets('a server error is treated as a failure, not as authorized', (
      tester,
    ) async {
      final harness = V03Harness(
        failWith: const ServerException('boom', statusCode: 500),
      );
      await harness.pump(tester, const NextStepCard());

      expect(find.text(l10n.pilotStateOfflineTitle), findsOneWidget);
      expect(find.text('Call the vet about the booster shot'), findsNothing);
    });

    testWidgets('an unrecognised stop reason fails closed', (tester) async {
      final harness = V03Harness();
      await harness.pump(
        tester,
        const PilotStateNotice(reason: PilotStopReason.unknown),
      );

      expect(find.text(l10n.pilotStateUnknownTitle), findsOneWidget);
      expect(find.text(l10n.pilotStateUnknownMessage), findsOneWidget);
      // No recovery action is invented for a state the build cannot name.
      expect(find.byType(PrimaryButton), findsNothing);
    });

    // One pump per test: a single test that re-pumps several provider scopes
    // does not settle reliably, and per-state tests name the failure anyway.
    final legacySurfaces = <String, V03Harness Function()>{
      'not authorized': () => V03Harness(allowlisted: false),
      'suspended': () => V03Harness(suspended: true),
      'kill switch': () => V03Harness(killSwitchActive: true),
      'feature disabled': () => V03Harness(featureEnabled: false),
      'consent required': () => V03Harness(recommendationConsent: false),
      'quiet mode': () => V03Harness(quietMode: true),
    };

    legacySurfaces.forEach((name, build) {
      testWidgets('$name state never sends the participant to a browser', (
        tester,
      ) async {
        await build().pump(tester, const NextStepCard());
        final rendered = tester
            .widgetList<Text>(find.byType(Text))
            .map((text) => (text.data ?? '').toLowerCase())
            .join(' | ');
        for (final legacy in [
          'browser',
          'http',
          'localhost',
          '/assistant',
          'web app',
          'open the site',
        ]) {
          expect(
            rendered.contains(legacy),
            isFalse,
            reason: '$name state referred participants to "$legacy"',
          );
        }
      });
    });
  });
}
