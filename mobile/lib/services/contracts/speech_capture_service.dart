enum SpeechCaptureFailureReason { permissionDenied, unavailable, failed }

class SpeechCaptureTranscript {
  final String text;
  final bool isFinal;

  const SpeechCaptureTranscript({required this.text, required this.isFinal});
}

class SpeechCaptureStartResult {
  final bool started;
  final SpeechCaptureFailureReason? failureReason;
  final String? message;

  const SpeechCaptureStartResult._({
    required this.started,
    this.failureReason,
    this.message,
  });

  const SpeechCaptureStartResult.started() : this._(started: true);

  const SpeechCaptureStartResult.failed(
    SpeechCaptureFailureReason reason, {
    String? message,
  }) : this._(started: false, failureReason: reason, message: message);
}

abstract class SpeechCaptureService {
  Future<SpeechCaptureStartResult> startListening({
    required String localeId,
    required void Function(SpeechCaptureTranscript transcript) onTranscript,
    required void Function(SpeechCaptureFailureReason reason, String? message)
    onFailure,
    required void Function() onDone,
  });

  Future<void> stopListening();

  Future<void> cancelListening();
}
