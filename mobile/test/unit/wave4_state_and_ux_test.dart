import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/commitment.dart';
import 'package:maybesitter_mobile/services/api/dtos/proposal_dtos.dart';
import 'package:maybesitter_mobile/services/contracts/capture_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

class TestCaptureService implements CaptureService {
  final CaptureResult? captureResponse;
  final ConfirmProposalResponseDto? confirmResponse;
  final Exception? captureException;
  final Exception? confirmException;

  TestCaptureService({
    this.captureResponse,
    this.confirmResponse,
    this.captureException,
    this.confirmException,
  });

  @override
  Future<CaptureResult> capture(CaptureRequest request) async {
    if (captureException != null) throw captureException!;
    return captureResponse ??
        CaptureResult(
          requestId: 'test-req',
          proposalId: 'prop-test',
          rawInput: request.rawInput,
          status: CaptureStatus.needsConfirmation,
          extractedCommitments: [
            const Commitment(id: 'item-1', title: 'Test Item 1'),
            const Commitment(id: 'item-2', title: 'Test Item 2'),
          ],
        );
  }

  @override
  Future<ConfirmProposalResponseDto> confirmProposal({
    required String proposalId,
    required String scopeId,
    required List<String> itemIds,
    DateTime? referenceTime,
  }) async {
    if (confirmException != null) throw confirmException!;
    return confirmResponse ??
        ConfirmProposalResponseDto(
          success: true,
          persisted: itemIds
              .map(
                (id) => PersistedProposalItemDto(
                  itemId: id,
                  commitmentId: 'cid-$id',
                  title: 'Persisted $id',
                ),
              )
              .toList(),
          failed: const [],
        );
  }
}

class CapturingTestCaptureService implements CaptureService {
  final List<List<String>> recordedConfirmItemIds = [];
  final List<ConfirmProposalResponseDto> confirmResponses;
  int _confirmCallCount = 0;

  CapturingTestCaptureService({required this.confirmResponses});

  @override
  Future<CaptureResult> capture(CaptureRequest request) async {
    return CaptureResult(
      requestId: 'test-req',
      proposalId: 'prop-test',
      rawInput: request.rawInput,
      status: CaptureStatus.needsConfirmation,
      extractedCommitments: const [
        Commitment(id: 'A', title: 'Item A'),
        Commitment(id: 'B', title: 'Item B'),
        Commitment(id: 'C', title: 'Item C'),
      ],
    );
  }

  @override
  Future<ConfirmProposalResponseDto> confirmProposal({
    required String proposalId,
    required String scopeId,
    required List<String> itemIds,
    DateTime? referenceTime,
  }) async {
    recordedConfirmItemIds.add(List<String>.from(itemIds));
    final resp = confirmResponses[_confirmCallCount % confirmResponses.length];
    _confirmCallCount++;
    return resp;
  }
}

void main() {
  group('Wave 4: Capture State Machine & UX Logic Tests', () {
    test(
      'State machine transitions cleanly through submission and selection',
      () async {
        final container = ProviderContainer(
          overrides: [
            captureServiceProvider.overrideWithValue(TestCaptureService()),
          ],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        expect(
          container.read(captureControllerProvider).status,
          equals(CaptureStatus.idle),
        );

        notifier.setInputText('Tomorrow doctor');
        expect(
          container.read(captureControllerProvider).status,
          equals(CaptureStatus.editing),
        );

        final future = notifier.submitIntent();
        expect(container.read(captureControllerProvider).isSubmitting, isTrue);

        await future;
        final state = container.read(captureControllerProvider);
        expect(state.status, equals(CaptureStatus.needsConfirmation));
        expect(state.proposalId, equals('prop-test'));
        expect(state.selectedItemIds, equals({'item-1', 'item-2'}));
      },
    );

    test(
      'Workstream 4: Clarification items are unselectable until resolved',
      () async {
        final container = ProviderContainer();
        final notifier = container.read(captureControllerProvider.notifier);

        notifier.previewState(CaptureStatus.needsConfirmation);
        final cClarify = const Commitment(
          id: 'item-clarify',
          title: 'Work tomorrow',
          needsClarification: true,
        );
        notifier.updateCommitment(cClarify);

        notifier.toggleItemSelection('item-clarify');
        expect(
          container
              .read(captureControllerProvider)
              .selectedItemIds
              .contains('item-clarify'),
          isFalse,
        );
      },
    );

    test(
      'Workstream 5: Full Confirmation Success transitions to saved',
      () async {
        final container = ProviderContainer(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(apiMode: ApiMode.localBackend),
            ),
            captureServiceProvider.overrideWithValue(
              TestCaptureService(
                confirmResponse: const ConfirmProposalResponseDto(
                  success: true,
                  persisted: [
                    PersistedProposalItemDto(
                      itemId: 'prev-1',
                      commitmentId: 'c1',
                      title: 'T1',
                    ),
                  ],
                  failed: [],
                ),
              ),
            ),
          ],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        notifier.previewState(CaptureStatus.needsConfirmation);

        final success = await notifier.confirmSave();
        expect(success, isTrue);

        final state = container.read(captureControllerProvider);
        expect(state.status, equals(CaptureStatus.saved));
        expect(state.persistedItemIds, contains('prev-1'));
      },
    );

    test(
      'Workstream 5: Partial Confirmation Success transitions to partiallySaved',
      () async {
        final container = ProviderContainer(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(apiMode: ApiMode.localBackend),
            ),
            captureServiceProvider.overrideWithValue(
              TestCaptureService(
                confirmResponse: const ConfirmProposalResponseDto(
                  success: true,
                  persisted: [
                    PersistedProposalItemDto(
                      itemId: 'prev-1',
                      commitmentId: 'c1',
                      title: 'T1',
                    ),
                  ],
                  failed: [
                    FailedProposalItemDto(
                      itemId: 'prev-2',
                      reason: 'validation_error',
                    ),
                  ],
                ),
              ),
            ),
          ],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        notifier.previewState(CaptureStatus.needsConfirmation);

        final success = await notifier.confirmSave();
        expect(success, isTrue);

        final state = container.read(captureControllerProvider);
        expect(state.status, equals(CaptureStatus.partiallySaved));
        expect(state.persistedItemIds, contains('prev-1'));
        expect(state.failedItems.length, equals(1));
      },
    );

    test('Workstream 6: Input preservation after network error', () async {
      final container = ProviderContainer(
        overrides: [
          captureServiceProvider.overrideWithValue(
            TestCaptureService(
              captureResponse: const CaptureResult(
                requestId: 'err-1',
                rawInput: 'Preserved user input',
                status: CaptureStatus.networkError,
                errorMessage: 'Network timeout',
              ),
            ),
          ),
        ],
      );

      final notifier = container.read(captureControllerProvider.notifier);
      await notifier.submitIntent('Preserved user input');

      final state = container.read(captureControllerProvider);
      expect(state.status, equals(CaptureStatus.networkError));
      expect(state.rawInput, equals('Preserved user input'));
    });

    test('Workstream 10: Timezone resolution order', () {
      expect(
        AppConfig.resolveTimezone(userTimezone: 'America/New_York'),
        equals('America/New_York'),
      );
      expect(AppConfig.resolveTimezone(userTimezone: null), isA<String>());
    });

    test(
      'Wave 4.1: Complete confirmation failure transitions to saveFailed and retains selected items',
      () async {
        final container = ProviderContainer(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(apiMode: ApiMode.localBackend),
            ),
            captureServiceProvider.overrideWithValue(
              TestCaptureService(
                confirmResponse: const ConfirmProposalResponseDto(
                  success: false,
                  persisted: [],
                  failed: [
                    FailedProposalItemDto(
                      itemId: 'prev-1',
                      reason: 'server_error',
                    ),
                    FailedProposalItemDto(
                      itemId: 'prev-2',
                      reason: 'server_error',
                    ),
                  ],
                ),
              ),
            ),
          ],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        notifier.previewState(CaptureStatus.needsConfirmation);

        final success = await notifier.confirmSave();
        expect(success, isFalse);

        final state = container.read(captureControllerProvider);
        expect(state.status, equals(CaptureStatus.saveFailed));
        expect(state.selectedItemIds, equals({'prev-1', 'prev-2'}));
        expect(state.failedItems.length, equals(2));
      },
    );

    test(
      'Wave 4.1: Proposal expiry retains original rawInput for re-analysis',
      () async {
        final container = ProviderContainer(
          overrides: [
            captureServiceProvider.overrideWithValue(
              TestCaptureService(
                captureResponse: const CaptureResult(
                  requestId: 'exp-1',
                  rawInput: 'Doctor appointment tomorrow at 9am',
                  status: CaptureStatus.proposalExpired,
                  errorMessage: 'Proposal expired',
                ),
              ),
            ),
          ],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        await notifier.submitIntent('Doctor appointment tomorrow at 9am');

        final state = container.read(captureControllerProvider);
        expect(state.status, equals(CaptureStatus.proposalExpired));
        expect(state.rawInput, equals('Doctor appointment tomorrow at 9am'));
      },
    );
    test(
      'Step 3: Partial-retry request sends exact failed itemIds on second request',
      () async {
        final capturingService = CapturingTestCaptureService(
          confirmResponses: [
            const ConfirmProposalResponseDto(
              success: true,
              persisted: [
                PersistedProposalItemDto(
                  itemId: 'A',
                  commitmentId: 'c-A',
                  title: 'A',
                ),
                PersistedProposalItemDto(
                  itemId: 'B',
                  commitmentId: 'c-B',
                  title: 'B',
                ),
              ],
              failed: [FailedProposalItemDto(itemId: 'C', reason: 'timeout')],
            ),
            const ConfirmProposalResponseDto(
              success: true,
              persisted: [
                PersistedProposalItemDto(
                  itemId: 'C',
                  commitmentId: 'c-C',
                  title: 'C',
                ),
              ],
              failed: [],
            ),
          ],
        );

        final container = ProviderContainer(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(apiMode: ApiMode.localBackend),
            ),
            captureServiceProvider.overrideWithValue(capturingService),
          ],
        );

        final notifier = container.read(captureControllerProvider.notifier);
        notifier.updateCommitment(const Commitment(id: 'A', title: 'Item A'));
        notifier.updateCommitment(const Commitment(id: 'B', title: 'Item B'));
        notifier.updateCommitment(const Commitment(id: 'C', title: 'Item C'));

        // First confirm request: itemIds [A, B, C]
        await notifier.confirmSave();
        expect(capturingService.recordedConfirmItemIds.length, equals(1));
        expect(
          capturingService.recordedConfirmItemIds[0],
          equals(['A', 'B', 'C']),
        );

        final stateAfterFirst = container.read(captureControllerProvider);
        expect(stateAfterFirst.status, equals(CaptureStatus.partiallySaved));
        expect(stateAfterFirst.persistedItemIds, equals({'A', 'B'}));

        // Retry confirm request: itemIds [C]
        await notifier.confirmSave();
        expect(capturingService.recordedConfirmItemIds.length, equals(2));
        expect(capturingService.recordedConfirmItemIds[1], equals(['C']));

        final stateAfterRetry = container.read(captureControllerProvider);
        expect(stateAfterRetry.status, equals(CaptureStatus.saved));
        expect(stateAfterRetry.persistedItemIds, equals({'A', 'B', 'C'}));
        expect(stateAfterRetry.failedItems, isEmpty);
      },
    );
  });
}
