import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:maybesitter_mobile/models/next_step.dart';
import 'package:maybesitter_mobile/models/pilot_trust.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/api/api_next_step_service.dart';
import 'package:maybesitter_mobile/services/api/api_pilot_trust_service.dart';
import 'package:maybesitter_mobile/services/contracts/next_step_service.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_trust_service.dart';

/// These exercise the wire contract itself: the exact paths, query parameters
/// and bodies the Flutter client will send, and how it reads the responses the
/// backend already produces for `/api/next-step` and `/api/pilot/trust`.
void main() {
  late List<http.Request> sent;

  ApiClient clientReturning(
    Object body, {
    int status = 200,
  }) {
    sent = [];
    return ApiClient(
      baseUrl: 'http://localhost:3000',
      client: MockClient((request) async {
        sent.add(request);
        return http.Response(
          jsonEncode(body),
          status,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
  }

  Map<String, dynamic> readyProposal({String id = 'proposal-7'}) => {
    'version': '1.0.0',
    'proposalId': id,
    'state': 'ready',
    'locale': 'ar',
    'primaryStep': {'commitmentId': 'c-9', 'title': 'الاتصال بالعيادة'},
    'explanation': {
      'summary': 'مستحقّة اليوم',
      'evidenceLabels': ['due_today', 'confirmed_by_you'],
      'sensitiveInferenceUsed': false,
    },
    'availableActions': ['accept', 'edit', 'defer', 'dismiss', 'done'],
    'persistence': {'occurred': false, 'confirmationRequired': true},
  };

  group('recommendation endpoint', () {
    test('GET sends participantId and locale and maps a ready proposal', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning(readyProposal()),
      );

      final result = await service.getNextStep(
        participantId: 'p-42',
        locale: 'ar',
      );

      expect(sent.single.method, 'GET');
      expect(sent.single.url.path, '/api/mobile/recommendation');
      expect(sent.single.url.queryParameters, {
        'participantId': 'p-42',
        'locale': 'ar',
      });

      final recommendation = (result as NextStepAvailable).recommendation;
      expect(recommendation.proposalId, 'proposal-7');
      expect(recommendation.primaryStep!.title, 'الاتصال بالعيادة');
      expect(recommendation.explanation!.evidenceLabels, [
        'due_today',
        'confirmed_by_you',
      ]);
      expect(recommendation.persistenceOccurred, isFalse);
      expect(recommendation.confirmationRequired, isTrue);
      expect(recommendation.availableActions, hasLength(5));
    });

    test('a 403 becomes a typed blocked result carrying the reason', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning({
          'error': 'closed pilot recommendation unavailable',
          'reason': 'kill_switch_active',
        }, status: 403),
      );

      final result = await service.getNextStep(
        participantId: 'p-42',
        locale: 'en',
      );

      expect(
        (result as NextStepBlocked).reason,
        PilotStopReason.killSwitchActive,
      );
    });

    test('an unknown 403 reason fails closed rather than guessing', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning({
          'error': 'nope',
          'reason': 'something_new',
        }, status: 403),
      );

      final result = await service.getNextStep(
        participantId: 'p-42',
        locale: 'en',
      );
      expect((result as NextStepBlocked).reason, PilotStopReason.unknown);
    });

    test('an empty proposal is unavailable, not actionable', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning({
          'version': '1.0.0',
          'proposalId': 'proposal-empty',
          'state': 'empty',
          'locale': 'en',
          'primaryStep': null,
          'explanation': null,
          'availableActions': <String>[],
          'persistence': {'occurred': false, 'confirmationRequired': true},
        }),
      );

      final result = await service.getNextStep(
        participantId: 'p-42',
        locale: 'en',
      );
      expect((result as NextStepUnavailable).state, NextStepState.empty);
    });

    test('a ready state with no primary step is not treated as actionable', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning({
          'proposalId': 'proposal-broken',
          'state': 'ready',
          'locale': 'en',
          'primaryStep': null,
          'availableActions': ['accept'],
          'persistence': {'occurred': false, 'confirmationRequired': true},
        }),
      );

      final result = await service.getNextStep(
        participantId: 'p-42',
        locale: 'en',
      );
      expect(result, isA<NextStepUnavailable>());
    });

    test('POST echoes the proposal and sends the decision', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning({
          'version': '1.0.0',
          'proposalId': 'proposal-7',
          'decision': 'edit',
          'editedTitle': 'Call the clinic instead',
          'decidedAt': '2026-08-09T10:00:00.000Z',
        }),
      );

      final outcome = await service.recordDecision(
        participantId: 'p-42',
        locale: 'en',
        decision: NextStepDecision.edit,
        editedTitle: 'Call the clinic instead',
        recommendation: NextStepRecommendationDtoFixture.ready,
      );

      expect(sent.single.method, 'POST');
      expect(sent.single.url.path, '/api/mobile/recommendation');
      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      expect(body['participantId'], 'p-42');
      expect(body['decision'], 'edit');
      expect(body['editedTitle'], 'Call the clinic instead');

      // The server re-derives its own canonical proposal and compares ids, so
      // the proposal must be echoed exactly.
      final proposal = body['proposal'] as Map<String, dynamic>;
      expect(proposal['proposalId'], 'proposal-7');
      expect(proposal['state'], 'ready');
      expect(proposal['availableActions'], contains('edit'));
      expect(proposal['persistence'], {
        'occurred': false,
        'confirmationRequired': true,
      });

      expect(outcome.decision, NextStepDecision.edit);
      expect(outcome.editedTitle, 'Call the clinic instead');
    });

    test('a 409 surfaces as a stale proposal rather than a generic error', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning(
          {'error': 'proposal is stale or invalid'},
          status: 409,
        ),
      );

      expect(
        () => service.recordDecision(
          participantId: 'p-42',
          locale: 'en',
          decision: NextStepDecision.accept,
          recommendation: NextStepRecommendationDtoFixture.ready,
        ),
        throwsA(isA<StaleProposalException>()),
      );
    });

    test('a decision request never carries an experiment arm', () async {
      final service = ApiNextStepService(
        apiClient: clientReturning({
          'proposalId': 'proposal-7',
          'decision': 'accept',
          'decidedAt': '2026-08-09T10:00:00.000Z',
        }),
      );
      await service.recordDecision(
        participantId: 'p-42',
        locale: 'en',
        decision: NextStepDecision.accept,
        recommendation: NextStepRecommendationDtoFixture.ready,
      );

      final body = sent.single.body.toLowerCase();
      for (final leak in ['arm', 'variant', 'experiment', 'personalized']) {
        expect(
          body.contains(leak),
          isFalse,
          reason: 'client sent "$leak"; assignment must stay backend-owned',
        );
      }
    });
  });

  group('trust endpoint', () {
    Map<String, dynamic> snapshotBody({
      bool recommendationConsent = true,
      bool allowed = true,
      String reason = 'authorized',
      String? firstValueAt,
    }) => {
      'trust': {
        'version': 'v1',
        'participantId': 'p-42',
        'recommendationConsent': recommendationConsent,
        'analyticsConsent': false,
        'calendarConsent': false,
        'firstValueAt': firstValueAt,
        'quietMode': false,
        'revokedAt': null,
        'deletedAt': null,
        'updatedAt': '2026-08-09T10:00:00.000Z',
      },
      'exposure': {'allowed': allowed, 'reason': reason},
      'whatKnows': {
        'version': 'v1',
        'participantId': 'p-42',
        'confirmedCommitmentCount': 4,
        'recommendationConsent': recommendationConsent,
        'analyticsConsent': false,
        'calendarConnected': false,
        'privateMessageIngestion': false,
        'sensitiveInference': false,
        'medicalProfile': false,
      },
    };

    test('GET reads trust, exposure and whatKnows', () async {
      final service = ApiPilotTrustService(
        apiClient: clientReturning(snapshotBody()),
      );

      final snapshot = await service.getSnapshot(participantId: 'p-42');

      expect(sent.single.url.path, '/api/mobile/trust');
      expect(sent.single.url.queryParameters, {'participantId': 'p-42'});
      expect(snapshot.trust.recommendationConsent, isTrue);
      expect(snapshot.exposure.allowed, isTrue);
      expect(snapshot.exposure.reason, PilotStopReason.authorized);
      expect(snapshot.whatKnows.confirmedCommitmentCount, 4);
      expect(snapshot.whatKnows.privateMessageIngestion, isFalse);
      expect(snapshot.trust.mayOfferCalendarConsent, isFalse);
    });

    test('firstValueAt unlocks the calendar rung of the ladder', () async {
      final service = ApiPilotTrustService(
        apiClient: clientReturning(
          snapshotBody(firstValueAt: '2026-08-08T09:00:00.000Z'),
        ),
      );
      final snapshot = await service.getSnapshot(participantId: 'p-42');
      expect(snapshot.trust.hasReachedFirstValue, isTrue);
      expect(snapshot.trust.mayOfferCalendarConsent, isTrue);
    });

    test('each trust action posts its documented body', () async {
      final cases = <PilotTrustAction, Map<String, dynamic>>{
        const GrantRecommendationConsent(): {
          'type': 'grant_recommendation_consent',
        },
        const SetAnalyticsConsent(true): {
          'type': 'set_analytics_consent',
          'granted': true,
        },
        const SetCalendarConsent(false): {
          'type': 'set_calendar_consent',
          'granted': false,
        },
        const SetQuietMode(true): {'type': 'set_quiet_mode', 'enabled': true},
        const RevokeTrust(): {'type': 'revoke'},
        const DeletePilotData(): {'type': 'delete'},
      };

      for (final entry in cases.entries) {
        final service = ApiPilotTrustService(
          apiClient: clientReturning(snapshotBody()),
        );
        await service.apply(participantId: 'p-42', action: entry.key);

        final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
        expect(body['participantId'], 'p-42');
        expect(body['action'], entry.value);
      }
    });

    test('a 403 becomes a typed not-admitted failure', () async {
      final service = ApiPilotTrustService(
        apiClient: clientReturning({
          'error': 'participant is not admitted to this pilot instance',
          'reason': 'not_allowlisted',
        }, status: 403),
      );

      await expectLater(
        service.getSnapshot(participantId: 'p-42'),
        throwsA(
          isA<PilotNotAdmittedException>().having(
            (error) => error.reason,
            'reason',
            PilotStopReason.notAllowlisted,
          ),
        ),
      );
    });

    test('missing consent fields read as false, never as granted', () async {
      final service = ApiPilotTrustService(
        apiClient: clientReturning({
          'trust': {'participantId': 'p-42', 'updatedAt': '2026-08-09T10:00:00.000Z'},
          'exposure': {'allowed': true, 'reason': 'authorized'},
          'whatKnows': {'participantId': 'p-42'},
        }),
      );

      final snapshot = await service.getSnapshot(participantId: 'p-42');
      expect(snapshot.trust.recommendationConsent, isFalse);
      expect(snapshot.trust.analyticsConsent, isFalse);
      expect(snapshot.trust.calendarConsent, isFalse);
      // And a malformed whatKnows must not promise capabilities are off.
      expect(snapshot.whatKnows.privateMessageIngestion, isTrue);
      expect(snapshot.whatKnows.sensitiveInference, isTrue);
      expect(snapshot.whatKnows.medicalProfile, isTrue);
    });

    test('an exposure with an unrecognised reason is blocked', () async {
      final service = ApiPilotTrustService(
        apiClient: clientReturning(
          snapshotBody(allowed: true, reason: 'brand_new_state'),
        ),
      );
      final snapshot = await service.getSnapshot(participantId: 'p-42');
      expect(snapshot.exposure.allowed, isFalse);
      expect(snapshot.exposure.reason, PilotStopReason.unknown);
    });
  });
}

/// Fixture kept out of the test bodies so the wire assertions stay readable.
class NextStepRecommendationDtoFixture {
  static const ready = NextStepRecommendation(
    proposalId: 'proposal-7',
    state: NextStepState.ready,
    locale: 'en',
    primaryStep: NextStepPrimaryStep(
      commitmentId: 'c-9',
      title: 'Call the clinic',
    ),
    availableActions: [
      NextStepDecision.accept,
      NextStepDecision.edit,
      NextStepDecision.defer,
      NextStepDecision.dismiss,
      NextStepDecision.done,
    ],
  );
}
