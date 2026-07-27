import 'package:flutter/foundation.dart';
import 'commitment.dart';

enum CaptureStatus {
  idle,
  submitting,
  needsConfirmation,
  needsClarification,
  noCommitment,
  extractionFailed,
  saveFailed,
  saved,
  cancelled,
}

enum ExtractionConfidence {
  high,
  medium,
  low;

  String get label {
    switch (this) {
      case ExtractionConfidence.high:
        return 'Extracted with high confidence';
      case ExtractionConfidence.medium:
        return 'Extracted with moderate confidence';
      case ExtractionConfidence.low:
        return 'Extracted with low confidence';
    }
  }
}

@immutable
class ClarificationOption {
  final String id;
  final String text;
  final String actionType;
  final Map<String, dynamic>? payload;

  const ClarificationOption({
    required this.id,
    required this.text,
    required this.actionType,
    this.payload,
  });
}

@immutable
class CaptureRequest {
  final String rawInput;
  final DateTime capturedAt;
  final String? clientLocale;

  const CaptureRequest({
    required this.rawInput,
    required this.capturedAt,
    this.clientLocale = 'en_US',
  });
}

@immutable
class CaptureResult {
  final String requestId;
  final String rawInput;
  final CaptureStatus status;
  final List<Commitment> extractedCommitments;
  final ExtractionConfidence confidence;
  final String? clarificationPrompt;
  final List<ClarificationOption> clarificationOptions;
  final String? errorMessage;
  final String? analysisNote;

  const CaptureResult({
    required this.requestId,
    required this.rawInput,
    required this.status,
    this.extractedCommitments = const [],
    this.confidence = ExtractionConfidence.high,
    this.clarificationPrompt,
    this.clarificationOptions = const [],
    this.errorMessage,
    this.analysisNote,
  });

  CaptureResult copyWith({
    String? requestId,
    String? rawInput,
    CaptureStatus? status,
    List<Commitment>? extractedCommitments,
    ExtractionConfidence? confidence,
    String? clarificationPrompt,
    List<ClarificationOption>? clarificationOptions,
    String? errorMessage,
    String? analysisNote,
  }) {
    return CaptureResult(
      requestId: requestId ?? this.requestId,
      rawInput: rawInput ?? this.rawInput,
      status: status ?? this.status,
      extractedCommitments: extractedCommitments ?? this.extractedCommitments,
      confidence: confidence ?? this.confidence,
      clarificationPrompt: clarificationPrompt ?? this.clarificationPrompt,
      clarificationOptions: clarificationOptions ?? this.clarificationOptions,
      errorMessage: errorMessage ?? this.errorMessage,
      analysisNote: analysisNote ?? this.analysisNote,
    );
  }
}
