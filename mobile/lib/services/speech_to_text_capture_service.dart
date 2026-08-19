import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import 'contracts/speech_capture_service.dart';

class SpeechToTextCaptureService implements SpeechCaptureService {
  final SpeechToText _speech;

  SpeechToTextCaptureService({SpeechToText? speech})
    : _speech = speech ?? SpeechToText();

  @override
  Future<SpeechCaptureStartResult> startListening({
    required String localeId,
    required void Function(SpeechCaptureTranscript transcript) onTranscript,
    required void Function(SpeechCaptureFailureReason reason, String? message)
    onFailure,
    required void Function() onDone,
  }) async {
    final available = await _speech.initialize(
      onError: (error) => _handleError(error, onFailure),
      onStatus: (status) {
        if (status == SpeechToText.doneStatus ||
            status == SpeechToText.notListeningStatus) {
          onDone();
        }
      },
    );

    if (!available) {
      final hasPermission = await _speech.hasPermission;
      return SpeechCaptureStartResult.failed(
        hasPermission
            ? SpeechCaptureFailureReason.unavailable
            : SpeechCaptureFailureReason.permissionDenied,
      );
    }

    await _speech.listen(
      onResult: (result) => _handleResult(result, onTranscript),
      listenOptions: SpeechListenOptions(
        localeId: localeId,
        listenMode: ListenMode.dictation,
        partialResults: true,
        cancelOnError: true,
      ),
    );

    return const SpeechCaptureStartResult.started();
  }

  @override
  Future<void> stopListening() => _speech.stop();

  @override
  Future<void> cancelListening() => _speech.cancel();

  void _handleResult(
    SpeechRecognitionResult result,
    void Function(SpeechCaptureTranscript transcript) onTranscript,
  ) {
    final text = result.recognizedWords.trim();
    if (text.isEmpty) return;

    onTranscript(
      SpeechCaptureTranscript(text: text, isFinal: result.finalResult),
    );
  }

  void _handleError(
    SpeechRecognitionError error,
    void Function(SpeechCaptureFailureReason reason, String? message) onFailure,
  ) {
    final normalized = error.errorMsg.toLowerCase();
    final reason =
        normalized.contains('permission') || normalized.contains('denied')
        ? SpeechCaptureFailureReason.permissionDenied
        : SpeechCaptureFailureReason.failed;
    onFailure(reason, error.errorMsg);
  }
}
