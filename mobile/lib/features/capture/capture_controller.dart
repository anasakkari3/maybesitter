import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models/activity_event.dart';
import '../../models/capture_result.dart';
import '../../models/commitment.dart';
import '../../services/api/dtos/proposal_dtos.dart';
import '../../services/providers.dart';

class CaptureState {
  final CaptureStatus status;
  final String? proposalId;
  final String scopeId;
  final String rawInput;
  final List<Commitment> extractedCommitments;
  final Set<String> selectedItemIds;
  final Set<String> persistedItemIds;
  final List<FailedProposalItemDto> failedItems;
  final ExtractionConfidence confidence;
  final String? clarificationPrompt;
  final List<ClarificationOption> clarificationOptions;
  final String? errorMessage;
  final String? analysisNote;

  const CaptureState({
    this.status = CaptureStatus.idle,
    this.proposalId,
    this.scopeId = 'default',
    this.rawInput = '',
    this.extractedCommitments = const [],
    this.selectedItemIds = const {},
    this.persistedItemIds = const {},
    this.failedItems = const [],
    this.confidence = ExtractionConfidence.high,
    this.clarificationPrompt,
    this.clarificationOptions = const [],
    this.errorMessage,
    this.analysisNote,
  });

  bool get isSubmitting =>
      status == CaptureStatus.analyzing ||
      status == CaptureStatus.submitting ||
      status == CaptureStatus.confirming;

  CaptureState copyWith({
    CaptureStatus? status,
    String? proposalId,
    String? scopeId,
    String? rawInput,
    List<Commitment>? extractedCommitments,
    Set<String>? selectedItemIds,
    Set<String>? persistedItemIds,
    List<FailedProposalItemDto>? failedItems,
    ExtractionConfidence? confidence,
    String? clarificationPrompt,
    List<ClarificationOption>? clarificationOptions,
    String? errorMessage,
    String? analysisNote,
  }) {
    return CaptureState(
      status: status ?? this.status,
      proposalId: proposalId ?? this.proposalId,
      scopeId: scopeId ?? this.scopeId,
      rawInput: rawInput ?? this.rawInput,
      extractedCommitments: extractedCommitments ?? this.extractedCommitments,
      selectedItemIds: selectedItemIds ?? this.selectedItemIds,
      persistedItemIds: persistedItemIds ?? this.persistedItemIds,
      failedItems: failedItems ?? this.failedItems,
      confidence: confidence ?? this.confidence,
      clarificationPrompt: clarificationPrompt ?? this.clarificationPrompt,
      clarificationOptions: clarificationOptions ?? this.clarificationOptions,
      errorMessage: errorMessage ?? this.errorMessage,
      analysisNote: analysisNote ?? this.analysisNote,
    );
  }
}

class CaptureNotifier extends StateNotifier<CaptureState> {
  final Ref ref;

  CaptureNotifier(this.ref) : super(const CaptureState());

  void setInputText(String text) {
    state = state.copyWith(
      rawInput: text,
      status: state.isSubmitting
          ? state.status
          : (text.isNotEmpty ? CaptureStatus.editing : CaptureStatus.idle),
    );
  }

  Future<void> submitIntent([String? customText]) async {
    final text = (customText ?? state.rawInput).trim();
    if (text.isEmpty || state.isSubmitting) return;

    final config = ref.read(appConfigProvider);

    state = state.copyWith(
      status: CaptureStatus.analyzing,
      rawInput: text,
      scopeId: config.scopeId,
      errorMessage: null,
    );

    final captureService = ref.read(captureServiceProvider);
    final result = await captureService.capture(
      CaptureRequest(
        rawInput: text,
        capturedAt: DateTime.now(),
        timezone: config.timezone,
        scopeId: config.scopeId,
      ),
    );

    // Valid items (not requiring clarification) are selected by default
    final initialSelections = result.extractedCommitments
        .where((c) => !c.needsClarification)
        .map((c) => c.id)
        .toSet();

    state = state.copyWith(
      status: result.status,
      proposalId: result.proposalId,
      scopeId: result.scopeId,
      extractedCommitments: result.extractedCommitments,
      selectedItemIds: initialSelections,
      persistedItemIds: const {},
      failedItems: const [],
      confidence: result.confidence,
      clarificationPrompt: result.clarificationPrompt,
      clarificationOptions: result.clarificationOptions,
      errorMessage: result.errorMessage,
      analysisNote: result.analysisNote,
    );
  }

  void toggleItemSelection(String itemId) {
    if (state.isSubmitting) return;
    // Persisted items cannot be reselected
    if (state.persistedItemIds.contains(itemId)) return;

    final item = state.extractedCommitments.firstWhere(
      (c) => c.id == itemId,
      orElse: () => Commitment(id: itemId, title: ''),
    );
    // Items failing validation cannot be selected
    if (!item.canBeSelected) return;

    final updated = Set<String>.from(state.selectedItemIds);
    if (updated.contains(itemId)) {
      updated.remove(itemId);
    } else {
      updated.add(itemId);
    }
    state = state.copyWith(selectedItemIds: updated);
  }

  void updateCommitment(Commitment commitment) {
    final exists = state.extractedCommitments.any((c) => c.id == commitment.id);
    final updatedList = exists
        ? state.extractedCommitments
              .map((c) => c.id == commitment.id ? commitment : c)
              .toList()
        : [...state.extractedCommitments, commitment];

    final updatedSelections = Set<String>.from(state.selectedItemIds);
    if (!commitment.canBeSelected) {
      updatedSelections.remove(commitment.id);
    } else {
      updatedSelections.add(commitment.id);
    }

    state = state.copyWith(
      extractedCommitments: updatedList,
      selectedItemIds: updatedSelections,
    );
  }

  void removeCommitment(String id) {
    final updatedList = state.extractedCommitments
        .where((c) => c.id != id)
        .toList();
    final updatedSelections = Set<String>.from(state.selectedItemIds)
      ..remove(id);

    if (updatedList.isEmpty) {
      state = state.copyWith(
        status: CaptureStatus.noCommitment,
        extractedCommitments: [],
        selectedItemIds: {},
        analysisNote: 'All extracted commitments were removed.',
      );
    } else {
      state = state.copyWith(
        extractedCommitments: updatedList,
        selectedItemIds: updatedSelections,
      );
    }
  }

  /// Applies a clarification answer to the items already extracted from the
  /// participant's real input, then proceeds to review.
  ///
  /// This must never discard what the participant actually typed: earlier,
  /// this simply loaded unrelated fixture/preview data regardless of what
  /// was extracted or which option was picked. There is no backend endpoint
  /// to interpret [option] semantically yet, so the honest behavior is to
  /// unblock the items that were waiting on clarification and let the
  /// participant confirm what was really extracted - not invent a plan they
  /// never entered.
  void resolveClarification(ClarificationOption option) {
    if (state.isSubmitting) return;

    final resolved = state.extractedCommitments
        .map(
          (c) => c.needsClarification
              ? c.copyWith(needsClarification: false)
              : c,
        )
        .toList();
    final initialSelections = resolved
        .where((c) => c.canBeSelected)
        .map((c) => c.id)
        .toSet();

    state = state.copyWith(
      status: CaptureStatus.needsConfirmation,
      extractedCommitments: resolved,
      selectedItemIds: initialSelections,
    );
  }

  void updatePriority(String id, CommitmentPriority priority) {
    final updatedList = state.extractedCommitments.map((c) {
      return c.id == id ? c.copyWith(priority: priority) : c;
    }).toList();

    state = state.copyWith(extractedCommitments: updatedList);
  }

  Future<bool> confirmSave() async {
    if (state.selectedItemIds.isEmpty || state.isSubmitting) return false;

    state = state.copyWith(status: CaptureStatus.confirming);

    try {
      final config = ref.read(appConfigProvider);
      final captureService = ref.read(captureServiceProvider);

      if (config.isLocalBackend || state.proposalId != null) {
        final confirmResult = await captureService.confirmProposal(
          proposalId: state.proposalId ?? 'prop-mock',
          scopeId: state.scopeId,
          itemIds: state.selectedItemIds.toList(),
          referenceTime: DateTime.now(),
        );

        final newlyPersisted = confirmResult.persisted
            .map((p) => p.itemId)
            .toSet();
        final allPersisted = {...state.persistedItemIds, ...newlyPersisted};
        final shouldRefreshCommitments = newlyPersisted.isNotEmpty;

        if (confirmResult.success && confirmResult.failed.isEmpty) {
          // 1. Full Success
          state = state.copyWith(
            status: CaptureStatus.saved,
            persistedItemIds: allPersisted,
            failedItems: [],
          );
        } else if (newlyPersisted.isNotEmpty &&
            confirmResult.failed.isNotEmpty) {
          // 2. Partial Success
          final failedIds = confirmResult.failed.map((f) => f.itemId).toSet();
          state = state.copyWith(
            status: CaptureStatus.partiallySaved,
            persistedItemIds: allPersisted,
            selectedItemIds: failedIds,
            failedItems: confirmResult.failed,
            errorMessage:
                'Saved ${newlyPersisted.length} item(s). ${confirmResult.failed.length} item(s) failed.',
          );
        } else {
          // 3. Complete Failure
          state = state.copyWith(
            status: CaptureStatus.saveFailed,
            failedItems: confirmResult.failed,
            errorMessage: 'Failed to confirm proposal on server.',
          );
          return false;
        }

        if (shouldRefreshCommitments && ref.exists(commitmentsStreamProvider)) {
          ref.invalidate(commitmentsStreamProvider);
        }
      } else {
        final repo = ref.read(commitmentRepositoryProvider);
        final selectedItems = state.extractedCommitments
            .where((c) => state.selectedItemIds.contains(c.id))
            .toList();
        await repo.saveAll(selectedItems);

        state = state.copyWith(
          status: CaptureStatus.saved,
          persistedItemIds: state.selectedItemIds,
          failedItems: [],
        );
      }

      final activityRepo = ref.read(activityRepositoryProvider);
      await activityRepo.logEvent(
        ActivityEvent(
          id: 'act-${DateTime.now().millisecondsSinceEpoch}',
          type: ActivityEventType.aiCaptureExtracted,
          title: 'Plan Extracted & Saved',
          description: 'Added ${state.persistedItemIds.length} commitments.',
          timestamp: DateTime.now(),
        ),
      );

      return state.status == CaptureStatus.saved ||
          state.status == CaptureStatus.partiallySaved;
    } catch (e) {
      state = state.copyWith(
        status: CaptureStatus.saveFailed,
        errorMessage: 'Failed to persist commitments.',
      );
      return false;
    }
  }

  void reset() {
    state = const CaptureState();
  }

  // Preview / fixture helpers for testing all UI states
  void previewState(CaptureStatus previewStatus) {
    final now = DateTime.now();
    final tomorrow = now.add(const Duration(days: 1));

    switch (previewStatus) {
      case CaptureStatus.needsConfirmation:
        state = CaptureState(
          status: CaptureStatus.needsConfirmation,
          proposalId: 'prev-prop-1',
          rawInput: 'Tomorrow I will go to the doctor and then work.',
          extractedCommitments: [
            Commitment(
              id: 'prev-1',
              title: 'Go to the doctor',
              description:
                  'Extracted from: "Tomorrow I will go to the doctor..."',
              scheduledDate: tomorrow,
              startTime: '09:00 AM',
              endTime: '11:00 AM',
              location: 'General Clinic',
              priority: CommitmentPriority.must,
            ),
            Commitment(
              id: 'prev-2',
              title: 'Work afterward',
              description: 'Extracted from: "...and then work."',
              scheduledDate: tomorrow,
              startTime: '11:30 AM',
              endTime: '05:00 PM',
              priority: CommitmentPriority.should,
            ),
          ],
          selectedItemIds: {'prev-1', 'prev-2'},
        );
        break;
      case CaptureStatus.needsClarification:
        state = CaptureState(
          status: CaptureStatus.needsClarification,
          rawInput: 'I have a doctor visit and work tomorrow...',
          // Mirrors what the real backend sends: items already extracted
          // from the participant's own input, some flagged as needing one
          // more detail rather than fully replaced by canned data.
          extractedCommitments: [
            Commitment(
              id: 'clarify-1',
              title: 'Doctor visit',
              scheduledDate: tomorrow,
              priority: CommitmentPriority.must,
            ),
            Commitment(
              id: 'clarify-2',
              title: 'Work',
              needsClarification: true,
            ),
          ],
          clarificationPrompt:
              'I understood that you have a doctor visit and work tomorrow. Should work be scheduled as a fixed time or flexible?',
          clarificationOptions: const [
            ClarificationOption(
              id: 'o1',
              text: 'Schedule work 11:30 AM – 5:00 PM',
              actionType: 'CONFIRM',
            ),
            ClarificationOption(
              id: 'o2',
              text: 'Keep work flexible (Full Day)',
              actionType: 'FLEXIBLE',
            ),
          ],
        );
        break;
      case CaptureStatus.noCommitment:
        state = const CaptureState(
          status: CaptureStatus.noCommitment,
          rawInput: 'Hello how are you today',
          analysisNote:
              'The AI scanned for dates, times, and specific actions but did not find an actionable commitment in this input.',
        );
        break;
      case CaptureStatus.unsupportedRequest:
        state = const CaptureState(
          status: CaptureStatus.unsupportedRequest,
          rawInput: 'What is the weather today?',
          errorMessage: 'The request could not be processed as a commitment.',
        );
        break;
      case CaptureStatus.extractionFailed:
        state = const CaptureState(
          status: CaptureStatus.extractionFailed,
          rawInput: 'Failed intent input',
          errorMessage: 'Unable to process intent. Connection timed out.',
        );
        break;
      case CaptureStatus.saved:
        state = CaptureState(
          status: CaptureStatus.saved,
          rawInput: 'Tomorrow I will go to the doctor and then work.',
          extractedCommitments: [
            Commitment(
              id: 'prev-1',
              title: 'Go to the doctor',
              scheduledDate: tomorrow,
              startTime: '09:00 AM',
              priority: CommitmentPriority.must,
            ),
            Commitment(
              id: 'prev-2',
              title: 'Work afterward',
              scheduledDate: tomorrow,
              startTime: '11:30 AM',
              priority: CommitmentPriority.should,
            ),
          ],
          selectedItemIds: {'prev-1', 'prev-2'},
          persistedItemIds: {'prev-1', 'prev-2'},
        );
        break;
      default:
        state = const CaptureState();
    }
  }
}

final captureControllerProvider =
    StateNotifierProvider<CaptureNotifier, CaptureState>((ref) {
      return CaptureNotifier(ref);
    });
