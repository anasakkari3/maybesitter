import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/services/mock/mock_capture_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  group('AppConfig default capture mode', () {
    test('default apiMode (plain constructor) is localBackend, not mock', () {
      const config = AppConfig();
      expect(config.apiMode, ApiMode.localBackend);
    });

    test(
      'AppConfig.fromEnvironment defaults to localBackend against localhost '
      'when API_BASE_URL is not set at build time',
      () {
        const config = AppConfig.fromEnvironment();
        expect(config.apiMode, ApiMode.localBackend);
        expect(config.baseUrl, 'http://localhost:3000');
        expect(config.isLocalBackend, isTrue);
      },
    );
  });

  group('captureServiceProvider selection', () {
    test('resolves to ApiCaptureService by default (no overrides)', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final service = container.read(captureServiceProvider);

      expect(service, isA<ApiCaptureService>());
    });

    test(
      'falls back to MockCaptureService only when explicitly configured',
      () {
        final container = ProviderContainer(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(apiMode: ApiMode.mock),
            ),
          ],
        );
        addTearDown(container.dispose);

        final service = container.read(captureServiceProvider);

        expect(service, isA<MockCaptureService>());
      },
    );
  });
}
