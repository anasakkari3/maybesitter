import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/services/providers.dart';

void main() {
  group('CaptureController Tests', () {
    late ProviderContainer container;

    setUp(() {
      container = ProviderContainer();
    });

    tearDown(() {
      container.dispose();
    });

    test('Initial state is idle', () {
      final state = container.read(captureControllerProvider);
      expect(state.status, CaptureStatus.idle);
      expect(state.extractedCommitments, isEmpty);
    });

    test('Submitting "doctor and work" extracts 2 commitments', () async {
      final notifier = container.read(captureControllerProvider.notifier);

      await notifier.submitIntent('Tomorrow I will go to the doctor and then work.');

      final state = container.read(captureControllerProvider);
      expect(state.status, CaptureStatus.needsConfirmation);
      expect(state.extractedCommitments.length, 2);
      expect(state.extractedCommitments[0].title, 'Go to the doctor');
      expect(state.extractedCommitments[1].title, 'Work afterward');
    });

    test('Confirm save persists to repository and sets saved state', () async {
      final notifier = container.read(captureControllerProvider.notifier);
      await notifier.submitIntent('Tomorrow I will go to the doctor and then work.');

      final success = await notifier.confirmSave();
      expect(success, isTrue);

      final state = container.read(captureControllerProvider);
      expect(state.status, CaptureStatus.saved);

      final repo = container.read(commitmentRepositoryProvider);
      final upcoming = await repo.getUpcoming();
      expect(
        upcoming.any((c) => c.title == 'Go to the doctor'),
        isTrue,
      );
    });
  });
}
