import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/pilot/pilot_session_controller.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/next_step.dart';
import 'package:maybesitter_mobile/models/pilot_trust.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:maybesitter_mobile/services/api/api_next_step_service.dart';
import 'package:maybesitter_mobile/services/api/api_pilot_trust_service.dart';
import 'package:maybesitter_mobile/services/auth/pilot_credential_store.dart';
import 'package:maybesitter_mobile/services/contracts/next_step_service.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_trust_service.dart';

void main() {
  group('Canonical Mobile API Integration Flow', () {
    final run = Platform.environment['RUN_CANONICAL_BACKEND_FLOW'] == 'true';
    final baseUrl =
        Platform.environment['CANONICAL_BACKEND_URL'] ??
        'http://127.0.0.1:4321';
    final pilotToken = Platform.environment['MAYBESITTER_TEST_PILOT_TOKEN'];
    final pilotTokenB = Platform.environment['MAYBESITTER_TEST_PILOT_TOKEN_B'];

    test(
      'executes authenticated pilot flow through real Flutter ApiClient',
      () async {
        final store = InMemoryPilotCredentialStore();
        final apiClient = ApiClient(
          baseUrl: baseUrl,
          authTokenProvider: store.readToken,
        );
        final trust = ApiPilotTrustService(apiClient: apiClient);
        final nextStep = ApiNextStepService(apiClient: apiClient);
        final capture = ApiCaptureService(
          apiClient: apiClient,
          defaultScopeId: 'spoofed-client-scope',
          defaultTimezone: 'UTC',
        );
        final repo = ApiCommitmentRepository(
          apiClient: apiClient,
          supportsSafeCommitmentPatch: true,
        );

        final session = PilotSessionNotifier(
          config: const AppConfig(apiMode: ApiMode.localBackend),
          credentialStore: store,
          trustService: trust,
        );
        await _waitForSession(session);
        expect(session.state.status, PilotSessionStatus.noCredential);

        await session.submitToken(pilotToken!);
        expect(session.state.status, PilotSessionStatus.authorized);

        await trust.apply(action: const SetRecommendationConsent(true));
        final initialTrust = await trust.getSnapshot();
        expect(initialTrust.trust.recommendationConsent, isTrue);

        final captureResult = await capture.capture(
          CaptureRequest(
            rawInput: 'Remind me to call Maya tomorrow at 3pm',
            capturedAt: DateTime.utc(2026, 8, 9, 8),
            timezone: 'UTC',
            scopeId: 'spoofed-client-scope',
          ),
        );
        expect(captureResult.status, CaptureStatus.needsConfirmation);
        final itemId = captureResult.extractedCommitments.first.id;

        final confirmResult = await capture.confirmProposal(
          proposalId: captureResult.proposalId!,
          scopeId: 'spoofed-client-scope',
          itemIds: [itemId],
          referenceTime: DateTime.utc(2026, 8, 9, 8),
        );
        expect(confirmResult.success, isTrue);
        final commitmentId = confirmResult.persisted.first.commitmentId;

        final today = await repo.getToday();
        final upcoming = await repo.getUpcoming();
        expect(
          [...today, ...upcoming].any((item) => item.id == commitmentId),
          isTrue,
        );

        final detail = await repo.getById(commitmentId);
        expect(detail, isNotNull);

        await repo.patchFields(commitmentId, title: 'Call Maya with update');
        final patched = await repo.getById(commitmentId);
        expect(patched!.title, contains('Maya'));

        final proposed = await nextStep.getNextStep(locale: 'en');
        expect(proposed, isA<NextStepAvailable>());
        final recommendation = (proposed as NextStepAvailable).recommendation;
        expect(recommendation.explanation, isNotNull);
        expect(recommendation.availableActions, contains(NextStepDecision.accept));

        final outcome = await nextStep.recordDecision(
          recommendation: recommendation,
          decision: NextStepDecision.accept,
          idempotencyKey: 'flutter-e2e-${DateTime.now().microsecondsSinceEpoch}',
          locale: 'en',
        );
        expect(outcome.decision, NextStepDecision.accept);

        await trust.apply(action: const SetRecommendationConsent(false));
        var snapshot = await trust.getSnapshot();
        expect(snapshot.trust.recommendationConsent, isFalse);
        expect(snapshot.trust.isRevoked, isFalse);

        await trust.apply(action: const SetRecommendationConsent(true));
        await trust.apply(action: const SetQuietMode(true));
        final quiet = await nextStep.getNextStep(locale: 'en');
        expect((quiet as NextStepBlocked).reason, PilotStopReason.quietMode);
        await trust.apply(action: const SetQuietMode(false));

        snapshot = await trust.getSnapshot();
        expect(snapshot.whatKnows.participantId, isNotEmpty);
        expect(snapshot.whatKnows.confirmedCommitmentCount, greaterThanOrEqualTo(1));

        ApiPilotTrustService? trustB;
        InMemoryPilotCredentialStore? storeB;
        if (pilotTokenB != null && pilotTokenB.isNotEmpty) {
          storeB = InMemoryPilotCredentialStore(pilotTokenB);
          final clientB = ApiClient(
            baseUrl: baseUrl,
            authTokenProvider: storeB.readToken,
          );
          final repoB = ApiCommitmentRepository(
            apiClient: clientB,
            supportsSafeCommitmentPatch: true,
          );
          trustB = ApiPilotTrustService(apiClient: clientB);
          expect(await repoB.getById(commitmentId), isNull);
        }

        await trust.apply(action: const RevokeTrust());
        final revoked = await nextStep.getNextStep(locale: 'en');
        expect((revoked as NextStepBlocked).reason, PilotStopReason.revoked);
        await session.markRevoked();
        expect(session.state.status, PilotSessionStatus.revoked);

        if (trustB != null && storeB != null) {
          final sessionB = PilotSessionNotifier(
            config: const AppConfig(apiMode: ApiMode.localBackend),
            credentialStore: storeB,
            trustService: trustB,
          );
          await _waitForSession(sessionB);
          expect(sessionB.state.status, PilotSessionStatus.authorized);
          await trustB.apply(action: const DeletePilotData());
          await sessionB.markDeleted();
          expect(await storeB.readToken(), isNull);
          expect(sessionB.state.status, PilotSessionStatus.deleted);
        }

        final invalidStore = InMemoryPilotCredentialStore();
        final invalidTrust = ApiPilotTrustService(
          apiClient: ApiClient(
            baseUrl: baseUrl,
            authTokenProvider: invalidStore.readToken,
          ),
        );
        final invalidSession = PilotSessionNotifier(
          config: const AppConfig(apiMode: ApiMode.localBackend),
          credentialStore: invalidStore,
          trustService: invalidTrust,
        );
        await invalidSession.submitToken('not-a-token');
        expect(invalidSession.state.status, PilotSessionStatus.unauthorized);
        expect(await invalidStore.readToken(), isNull);
      },
      skip: !run || pilotToken == null || pilotToken.isEmpty
          ? 'Set RUN_CANONICAL_BACKEND_FLOW=true and issued pilot token env vars.'
          : false,
    );
  });
}

Future<void> _waitForSession(PilotSessionNotifier session) async {
  for (var attempt = 0; attempt < 50; attempt++) {
    final status = session.state.status;
    if (status != PilotSessionStatus.loadingCredential &&
        status != PilotSessionStatus.validating) {
      return;
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}
