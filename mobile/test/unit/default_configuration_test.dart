import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/services/api/api_commitment_repository.dart';
import 'package:maybesitter_mobile/services/mock/mock_capture_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

/// Nothing here overrides a provider.
///
/// Almost every widget test injects `ApiMode.mock` so it can run without a
/// backend, which is reasonable in isolation and blinding in aggregate: when a
/// change moved the default build onto a pilot token screen, all 391 tests
/// stayed green and only launching the app revealed it. These assertions
/// exercise the configuration a real user gets.
void main() {
  group('the configuration a default build actually runs', () {
    test('fromEnvironment with no dart-defines is not mock mode', () {
      const config = AppConfig.fromEnvironment();
      expect(config.isMock, isFalse);
      expect(config.isLocalBackend, isTrue);
    });

    test('the default backend is local, and named explicitly', () {
      const config = AppConfig.fromEnvironment();
      expect(config.baseUrl, 'http://localhost:3000');
      expect(config.isLocalDevBackend, isTrue);
    });

    test('a default build is not gated behind a pilot token', () {
      // The gate is opt-in. A build that forgets to ask for it opens to the
      // app, and a pilot build that forgets to ask for it opens to everyone —
      // which is why config/pilot.json is checked in and separately tested.
      expect(const AppConfig.fromEnvironment().requirePilotAccessGate, isFalse);
    });

    test('a default build can edit commitments', () {
      expect(
        const AppConfig.fromEnvironment().supportsSafeCommitmentPatch,
        isTrue,
        reason: 'editing a title or a time must work against a local backend',
      );
    });

    test('capture resolves to the real extractor, not the fixture', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(captureServiceProvider), isA<ApiCaptureService>());
    });

    test('commitments resolve to the real repository, not the seed', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(
        container.read(commitmentRepositoryProvider),
        isA<ApiCommitmentRepository>(),
        reason: 'the default build must not serve demo seed data',
      );
    });

    test('mock mode happens only when it is asked for', () {
      final container = ProviderContainer(
        overrides: [
          appConfigProvider.overrideWith((ref) => const AppConfig(apiMode: ApiMode.mock)),
        ],
      );
      addTearDown(container.dispose);
      expect(container.read(captureServiceProvider), isA<MockCaptureService>());
    });
  });
}
