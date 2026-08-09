import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/pilot/pilot_session_controller.dart';
import 'package:maybesitter_mobile/models/pilot_trust.dart';
import 'package:maybesitter_mobile/services/api/api_client.dart';
import 'package:maybesitter_mobile/services/auth/pilot_credential_store.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_trust_service.dart';

void main() {
  group('PilotSessionNotifier', () {
    test('starts at the access gate when no token is stored', () async {
      final store = InMemoryPilotCredentialStore();
      final notifier = PilotSessionNotifier(
        config: _backendConfig,
        credentialStore: store,
        trustService: _FakeTrustService(_snapshot()),
      );

      await _settle();

      expect(notifier.state.status, PilotSessionStatus.noCredential);
    });

    test('stored valid token authorizes the app after trust validation', () async {
      final store = InMemoryPilotCredentialStore('issued-token');
      final notifier = PilotSessionNotifier(
        config: _backendConfig,
        credentialStore: store,
        trustService: _FakeTrustService(_snapshot()),
      );

      await _settle();

      expect(notifier.state.status, PilotSessionStatus.authorized);
      expect(await store.readToken(), 'issued-token');
    });

    test('invalid token is rejected and removed after token entry', () async {
      final store = InMemoryPilotCredentialStore();
      final notifier = PilotSessionNotifier(
        config: _backendConfig,
        credentialStore: store,
        trustService: _ThrowingTrustService(
          const UnauthorizedException(
            'invalid_signature',
            body: {'reason': 'invalid_signature'},
          ),
        ),
      );

      await notifier.submitToken('bad-token');

      expect(notifier.state.status, PilotSessionStatus.unauthorized);
      expect(await store.readToken(), isNull);
    });

    test('invalid runtime configuration fails closed without deleting token', (
    ) async {
      final store = InMemoryPilotCredentialStore('issued-token');
      final notifier = PilotSessionNotifier(
        config: _backendConfig,
        credentialStore: store,
        trustService: _ThrowingTrustService(
          const OperatorConfigurationException(
            'invalid pilot runtime configuration',
          ),
        ),
      );

      await _settle();

      expect(
        notifier.state.status,
        PilotSessionStatus.invalidPilotRuntimeConfig,
      );
      expect(await store.readToken(), 'issued-token');
    });

    test('revoked and deleted snapshots are terminal states', () async {
      final revoked = PilotSessionNotifier(
        config: _backendConfig,
        credentialStore: InMemoryPilotCredentialStore('revoked-token'),
        trustService: _FakeTrustService(
          _snapshot(
            reason: PilotStopReason.revoked,
            revokedAt: DateTime.utc(2026, 8),
          ),
        ),
      );
      final deleted = PilotSessionNotifier(
        config: _backendConfig,
        credentialStore: InMemoryPilotCredentialStore('deleted-token'),
        trustService: _FakeTrustService(
          _snapshot(
            reason: PilotStopReason.deleted,
            deletedAt: DateTime.utc(2026, 8),
          ),
        ),
      );

      await _settle();

      expect(revoked.state.status, PilotSessionStatus.revoked);
      expect(deleted.state.status, PilotSessionStatus.deleted);
    });
  });
}

const _backendConfig = AppConfig(apiMode: ApiMode.localBackend);

Future<void> _settle() => Future<void>.delayed(Duration.zero);

PilotTrustSnapshot _snapshot({
  PilotStopReason reason = PilotStopReason.authorized,
  DateTime? revokedAt,
  DateTime? deletedAt,
}) {
  final allowed = reason == PilotStopReason.authorized;
  final trust = PilotTrustState(
    participantId: 'p-42',
    recommendationConsent: true,
    analyticsConsent: false,
    calendarConsent: false,
    quietMode: false,
    revokedAt: revokedAt,
    deletedAt: deletedAt,
    updatedAt: DateTime.utc(2026, 8, 9),
  );
  return PilotTrustSnapshot(
    trust: trust,
    exposure: PilotExposureDecision(allowed: allowed, reason: reason),
    whatKnows: const WhatMaybeSitterKnows(
      participantId: 'p-42',
      confirmedCommitmentCount: 0,
      recommendationConsent: true,
      analyticsConsent: false,
      calendarConnected: false,
    ),
  );
}

class _FakeTrustService implements PilotTrustService {
  final PilotTrustSnapshot snapshot;

  _FakeTrustService(this.snapshot);

  @override
  Future<PilotTrustSnapshot> getSnapshot() async => snapshot;

  @override
  Future<PilotTrustSnapshot> apply({required PilotTrustAction action}) async =>
      snapshot;
}

class _ThrowingTrustService implements PilotTrustService {
  final Object error;

  _ThrowingTrustService(this.error);

  @override
  Future<PilotTrustSnapshot> getSnapshot() async => throw error;

  @override
  Future<PilotTrustSnapshot> apply({required PilotTrustAction action}) async =>
      throw error;
}
