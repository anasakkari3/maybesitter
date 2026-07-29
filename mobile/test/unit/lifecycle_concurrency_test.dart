import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/dtos/proposal_dtos.dart';
import 'package:maybesitter_mobile/services/contracts/capture_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

class SlowTestCaptureService implements CaptureService {
  int captureCallCount = 0;
  int confirmCallCount = 0;

  @override
  Future<CaptureResult> capture(CaptureRequest request) async {
    captureCallCount++;
    await Future.delayed(const Duration(milliseconds: 100));
    return CaptureResult(
      requestId: 'slow-req',
      proposalId: 'prop-slow',
      rawInput: request.rawInput,
      status: CaptureStatus.needsConfirmation,
      extractedCommitments: const [Commitment(id: 'c1', title: 'Slow item')],
    );
  }

  @override
  Future<ConfirmProposalResponseDto> confirmProposal({
    required String proposalId,
    required String scopeId,
    required List<String> itemIds,
    DateTime? referenceTime,
  }) async {
    confirmCallCount++;
    await Future.delayed(const Duration(milliseconds: 100));
    return ConfirmProposalResponseDto(
      success: true,
      persisted: itemIds
          .map(
            (id) => PersistedProposalItemDto(
              itemId: id,
              commitmentId: 'cid-$id',
              title: 'Item $id',
            ),
          )
          .toList(),
      failed: const [],
    );
  }
}

void main() {
  group('Lifecycle & Concurrency Safety Tests', () {
    test('Double-tapping submitIntent triggers only 1 network call', () async {
      final slowService = SlowTestCaptureService();
      final container = ProviderContainer(
        overrides: [captureServiceProvider.overrideWithValue(slowService)],
      );

      final notifier = container.read(captureControllerProvider.notifier);
      notifier.setInputText('Double tap test');

      // Trigger twice concurrently
      final f1 = notifier.submitIntent();
      final f2 = notifier.submitIntent();

      await Future.wait([f1, f2]);

      expect(slowService.captureCallCount, equals(1));
    });

    test(
      'Double-tapping confirmSave triggers only 1 confirm request',
      () async {
        final slowService = SlowTestCaptureService();
        final container = ProviderContainer(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(apiMode: ApiMode.localBackend),
            ),
            captureServiceProvider.overrideWithValue(slowService),
          ],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        notifier.updateCommitment(
          const Commitment(id: 'c1', title: 'Test Item'),
        );

        final f1 = notifier.confirmSave();
        final f2 = notifier.confirmSave();

        await Future.wait([f1, f2]);

        expect(slowService.confirmCallCount, equals(1));
      },
    );

    test(
      'User edits input while request is in flight preserves user input',
      () async {
        final slowService = SlowTestCaptureService();
        final container = ProviderContainer(
          overrides: [captureServiceProvider.overrideWithValue(slowService)],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        notifier.setInputText('Initial input');

        final future = notifier.submitIntent();
        // User types new text while request is in flight
        notifier.setInputText('Newer typed text');

        await future;

        final state = container.read(captureControllerProvider);
        expect(state.rawInput, equals('Newer typed text'));
      },
    );
  });
}
