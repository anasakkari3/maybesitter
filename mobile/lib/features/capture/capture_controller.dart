import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models/activity_event.dart';
import '../../models/capture_result.dart';
import '../../models/commitment.dart';
import '../../services/providers.dart';

class CaptureState {
  final CaptureStatus status;
  final String rawInput;
  final List<Commitment> extractedCommitments;
  final ExtractionConfidence confidence;
  final String? clarificationPrompt;
  final List<ClarificationOption> clarificationOptions;
  final String? errorMessage;
  final String? analysisNote;

  const CaptureState({
    this.status = CaptureStatus.idle,
    this.rawInput = '',
    this.extractedCommitments = const [],
    this.confidence = ExtractionConfidence.high,
    this.clarificationPrompt,
    this.clarificationOptions = const [],
    this.errorMessage,
    this.analysisNote,
  });

  CaptureState copyWith({
    CaptureStatus? status,
    String? rawInput,
    List<Commitment>? extractedCommitments,
    ExtractionConfidence? confidence,
    String? clarificationPrompt,
    List<ClarificationOption>? clarificationOptions,
    String? errorMessage,
    String? analysisNote,
  }) {
    return CaptureState(
      status: status ?? this.status,
      rawInput: rawInput ?? this.rawInput,
      extractedCommitments: extractedCommitments ?? this.extractedCommitments,
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

  Future<void> submitIntent(String text) async {
    if (text.trim().isEmpty) return;

    state = state.copyWith(
      status: CaptureStatus.submitting,
      rawInput: text,
      errorMessage: null,
    );

    final captureService = ref.read(captureServiceProvider);
    final result = await captureService.capture(
      CaptureRequest(rawInput: text, capturedAt: DateTime.now()),
    );

    state = state.copyWith(
      status: result.status,
      extractedCommitments: result.extractedCommitments,
      confidence: result.confidence,
      clarificationPrompt: result.clarificationPrompt,
      clarificationOptions: result.clarificationOptions,
      errorMessage: result.errorMessage,
      analysisNote: result.analysisNote,
    );
  }

  void updateCommitment(Commitment commitment) {
    final updatedList = state.extractedCommitments.map((c) {
      return c.id == commitment.id ? commitment : c;
    }).toList();

    state = state.copyWith(extractedCommitments: updatedList);
  }

  void removeCommitment(String id) {
    final updatedList = state.extractedCommitments
        .where((c) => c.id != id)
        .toList();

    if (updatedList.isEmpty) {
      state = state.copyWith(
        status: CaptureStatus.noCommitment,
        extractedCommitments: [],
        analysisNote: 'All extracted commitments were removed.',
      );
    } else {
      state = state.copyWith(extractedCommitments: updatedList);
    }
  }

  void updatePriority(String id, CommitmentPriority priority) {
    final updatedList = state.extractedCommitments.map((c) {
      return c.id == id ? c.copyWith(priority: priority) : c;
    }).toList();

    state = state.copyWith(extractedCommitments: updatedList);
  }

  Future<bool> confirmSave() async {
    if (state.extractedCommitments.isEmpty) return false;

    state = state.copyWith(status: CaptureStatus.submitting);

    try {
      final repo = ref.read(commitmentRepositoryProvider);
      await repo.saveAll(state.extractedCommitments);

      final activityRepo = ref.read(activityRepositoryProvider);
      await activityRepo.logEvent(
        ActivityEvent(
          id: 'act-${DateTime.now().millisecondsSinceEpoch}',
          type: ActivityEventType.aiCaptureExtracted,
          title: 'Plan Extracted & Saved',
          description:
              'Added ${state.extractedCommitments.length} commitments for tomorrow.',
          timestamp: DateTime.now(),
        ),
      );

      state = state.copyWith(status: CaptureStatus.saved);
      return true;
    } catch (e) {
      state = state.copyWith(
        status: CaptureStatus.saveFailed,
        errorMessage: 'Failed to persist commitments locally.',
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
        );
        break;
      case CaptureStatus.needsClarification:
        state = const CaptureState(
          status: CaptureStatus.needsClarification,
          rawInput: 'I have a doctor visit and work tomorrow...',
          clarificationPrompt:
              'I understood that you have a doctor visit and work tomorrow. Should work be scheduled as a fixed time or flexible?',
          clarificationOptions: [
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
