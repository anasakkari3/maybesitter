import '../../models/capture_result.dart';
import '../../models/commitment.dart';
import '../contracts/capture_service.dart';

class MockCaptureService implements CaptureService {
  @override
  Future<CaptureResult> capture(CaptureRequest request) async {
    // Simulate natural AI extraction delay (800ms)
    await Future.delayed(const Duration(milliseconds: 800));

    final inputLower = request.rawInput.trim().toLowerCase();
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final tomorrow = today.add(const Duration(days: 1));

    if (inputLower.contains('doctor') && inputLower.contains('work')) {
      return CaptureResult(
        requestId: 'cap-${DateTime.now().millisecondsSinceEpoch}',
        rawInput: request.rawInput,
        status: CaptureStatus.needsConfirmation,
        confidence: ExtractionConfidence.high,
        analysisNote:
            'The AI scanned for dates, times, and specific actions in your plan.',
        extractedCommitments: [
          Commitment(
            id: 'mock-doc-${DateTime.now().millisecondsSinceEpoch}',
            title: 'Go to the doctor',
            description: 'Extracted from: "${request.rawInput}"',
            scheduledDate: tomorrow,
            startTime: '09:00 AM',
            endTime: '11:00 AM',
            location: 'General Clinic',
            priority: CommitmentPriority.must,
            status: CommitmentStatus.pending,
            category: 'Health',
            confidenceScore: 0.98,
          ),
          Commitment(
            id: 'mock-work-${DateTime.now().millisecondsSinceEpoch}',
            title: 'Work afterward',
            description: 'Extracted from: "${request.rawInput}"',
            scheduledDate: tomorrow,
            startTime: '11:30 AM',
            endTime: '05:00 PM',
            priority: CommitmentPriority.should,
            status: CommitmentStatus.pending,
            category: 'Work',
            confidenceScore: 0.92,
          ),
        ],
      );
    }

    if (inputLower.contains('ambiguous') || inputLower.contains('unclear')) {
      return CaptureResult(
        requestId: 'cap-${DateTime.now().millisecondsSinceEpoch}',
        rawInput: request.rawInput,
        status: CaptureStatus.needsClarification,
        confidence: ExtractionConfidence.medium,
        clarificationPrompt:
            'I understood that you have a doctor visit and work tomorrow. Should work be scheduled as a fixed time or flexible?',
        clarificationOptions: const [
          ClarificationOption(
            id: 'opt-1',
            text: 'Schedule work 11:30 AM – 5:00 PM',
            actionType: 'CONFIRM_SCHEDULE',
          ),
          ClarificationOption(
            id: 'opt-2',
            text: 'Keep work flexible (Full Day)',
            actionType: 'FLEXIBLE_WORK',
          ),
          ClarificationOption(
            id: 'opt-3',
            text: 'Only add doctor visit',
            actionType: 'DOCTOR_ONLY',
          ),
        ],
      );
    }

    if (inputLower.contains('nothing') || inputLower.contains('no plan')) {
      return CaptureResult(
        requestId: 'cap-${DateTime.now().millisecondsSinceEpoch}',
        rawInput: request.rawInput,
        status: CaptureStatus.noCommitment,
        confidence: ExtractionConfidence.low,
        analysisNote:
            'The AI scanned for dates, times, and specific actions but did not find an actionable commitment in this input.',
      );
    }

    if (inputLower.contains('fail') || inputLower.contains('error')) {
      return CaptureResult(
        requestId: 'cap-${DateTime.now().millisecondsSinceEpoch}',
        rawInput: request.rawInput,
        status: CaptureStatus.extractionFailed,
        errorMessage:
            'Unable to process intent due to service timeout. Please try again.',
      );
    }

    // Generic fallback extraction for any other text input
    return CaptureResult(
      requestId: 'cap-${DateTime.now().millisecondsSinceEpoch}',
      rawInput: request.rawInput,
      status: CaptureStatus.needsConfirmation,
      confidence: ExtractionConfidence.high,
      analysisNote: 'Extracted plan from raw input text.',
      extractedCommitments: [
        Commitment(
          id: 'mock-gen-${DateTime.now().millisecondsSinceEpoch}',
          title: request.rawInput.length > 40
              ? '${request.rawInput.substring(0, 37)}...'
              : request.rawInput,
          description: 'Captured via text input',
          scheduledDate: tomorrow,
          startTime: '10:00 AM',
          priority: CommitmentPriority.should,
          status: CommitmentStatus.pending,
          category: 'Personal',
        ),
      ],
    );
  }
}
