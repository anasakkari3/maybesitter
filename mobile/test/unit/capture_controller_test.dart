import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/features/capture/capture_flow_launch.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/models/pilot_loop_analytics.dart';
import 'package:maybesitter_mobile/services/contracts/pilot_loop_analytics_service.dart';
import 'package:maybesitter_mobile/services/contracts/speech_capture_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

class FakeSpeechCaptureService implements SpeechCaptureService {
  SpeechCaptureStartResult startResult =
      const SpeechCaptureStartResult.started();
  void Function(SpeechCaptureTranscript transcript)? onTranscript;
  void Function(SpeechCaptureFailureReason reason, String? message)? onFailure;
  void Function()? onDone;
  int startCalls = 0;
  int stopCalls = 0;

  @override
  Future<SpeechCaptureStartResult> startListening({
    required String localeId,
    required void Function(SpeechCaptureTranscript transcript) onTranscript,
    required void Function(SpeechCaptureFailureReason reason, String? message)
    onFailure,
    required void Function() onDone,
  }) async {
    startCalls += 1;
    this.onTranscript = onTranscript;
    this.onFailure = onFailure;
    this.onDone = onDone;
    return startResult;
  }

  @override
  Future<void> stopListening() async {
    stopCalls += 1;
    onDone?.call();
  }

  @override
  Future<void> cancelListening() async {}

  void emitTranscript(String text, {bool isFinal = false}) {
    onTranscript?.call(SpeechCaptureTranscript(text: text, isFinal: isFinal));
  }
}

class FakePilotLoopAnalyticsService implements PilotLoopAnalyticsService {
  final List<PilotLoopAnalyticsEvent> events = [];

  @override
  Future<void> record(PilotLoopAnalyticsEvent event) async {
    event.toJson();
    events.add(event);
  }
}

void main() {
  group('CaptureController Tests', () {
    late ProviderContainer container;
    late FakeSpeechCaptureService speechService;
    late FakePilotLoopAnalyticsService analyticsService;

    setUp(() {
      speechService = FakeSpeechCaptureService();
      analyticsService = FakePilotLoopAnalyticsService();
      container = ProviderContainer(
        overrides: [
          appConfigProvider.overrideWith(
            (ref) => const AppConfig(enablePilotVoice: true),
          ),
          speechCaptureServiceProvider.overrideWithValue(speechService),
          pilotLoopAnalyticsServiceProvider.overrideWithValue(analyticsService),
        ],
      );
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

      await notifier.submitIntent(
        'Tomorrow I will go to the doctor and then work',
      );

      final state = container.read(captureControllerProvider);
      expect(state.status, CaptureStatus.needsConfirmation);
      expect(state.extractedCommitments.length, 2);
      expect(state.extractedCommitments[0].title, 'go to the doctor');
      expect(state.extractedCommitments[1].title, 'work');
    });

    test('Confirm save persists to repository and sets saved state', () async {
      final notifier = container.read(captureControllerProvider.notifier);
      await notifier.submitIntent(
        'Tomorrow I will go to the doctor and then work',
      );

      final success = await notifier.confirmSave();
      expect(success, isTrue);

      final state = container.read(captureControllerProvider);
      expect(state.status, CaptureStatus.saved);

      final repo = container.read(commitmentRepositoryProvider);
      final upcoming = await repo.getUpcoming();
      expect(upcoming.any((c) => c.title == 'go to the doctor'), isTrue);
    });

    test('speech transcript is editable before analysis', () async {
      final notifier = container.read(captureControllerProvider.notifier);

      await notifier.startSpokenPrompt(localeId: 'en_US');
      speechService.emitTranscript('tomorrow doctor then work', isFinal: true);

      var state = container.read(captureControllerProvider);
      expect(state.rawInput, 'tomorrow doctor then work');
      expect(state.extractedCommitments, isEmpty);
      expect(state.spokenPromptStatus, SpokenPromptStatus.reviewingTranscript);

      notifier.setInputText('Tomorrow I will go to the doctor and then work.');

      state = container.read(captureControllerProvider);
      expect(state.rawInput, 'Tomorrow I will go to the doctor and then work.');
      expect(state.status, CaptureStatus.editing);
      expect(state.extractedCommitments, isEmpty);
    });

    test('speech transcript appends to existing typed capture text', () async {
      final notifier = container.read(captureControllerProvider.notifier);

      notifier.setInputText('Buy milk');
      await notifier.startSpokenPrompt(localeId: 'en_US');
      speechService.emitTranscript('and call Maya', isFinal: true);

      final state = container.read(captureControllerProvider);
      expect(state.rawInput, 'Buy milk and call Maya');
      expect(state.status, CaptureStatus.editing);
      expect(state.spokenPromptStatus, SpokenPromptStatus.reviewingTranscript);
    });

    test('speech capture records content-free pilot loop analytics', () async {
      final notifier = container.read(captureControllerProvider.notifier);

      await notifier.startSpokenPrompt(
        localeId: 'en_US',
        source: CaptureLaunchSource.widget,
      );
      speechService.emitTranscript('call Maya', isFinal: true);

      expect(analyticsService.events.map((event) => event.name), [
        PilotLoopAnalyticsEventName.voiceCaptureStarted,
        PilotLoopAnalyticsEventName.voiceCaptureCompleted,
      ]);
      expect(analyticsService.events.last.properties['inputLength'], 9);
      expect(analyticsService.events.last.properties['source'], 'widget');
      expect(
        analyticsService.events.last.properties,
        isNot(containsPair('rawText', 'call Maya')),
      );
    });

    test('cancelled speech capture records an abandoned event', () async {
      final notifier = container.read(captureControllerProvider.notifier);

      await notifier.startSpokenPrompt(localeId: 'en_US');
      await notifier.cancelSpokenPrompt();

      expect(
        analyticsService.events.last.name,
        PilotLoopAnalyticsEventName.voiceCaptureAbandoned,
      );
      expect(analyticsService.events.last.properties['reason'], 'cancelled');
    });

    test('clipboard import records privacy-safe intake analytics', () {
      final notifier = container.read(captureControllerProvider.notifier);

      notifier.noteSourceIntakeReviewed(
        importSource: 'clipboard',
        characterCount: 24,
      );
      notifier.applyImportedText(
        'Call the school and pack lunch',
        importSource: 'clipboard',
      );

      final state = container.read(captureControllerProvider);
      expect(state.rawInput, 'Call the school and pack lunch');
      expect(state.status, CaptureStatus.editing);
      expect(analyticsService.events.map((event) => event.name), [
        PilotLoopAnalyticsEventName.sourceIntakeReviewed,
        PilotLoopAnalyticsEventName.sourceIntakeConfirmed,
      ]);
      expect(
        analyticsService.events.last.properties,
        isNot(containsPair('rawText', 'Call the school and pack lunch')),
      );
    });

    test('speech permission denial keeps typed capture usable', () async {
      speechService.startResult = const SpeechCaptureStartResult.failed(
        SpeechCaptureFailureReason.permissionDenied,
      );
      final notifier = container.read(captureControllerProvider.notifier);

      await notifier.startSpokenPrompt(localeId: 'en_US');

      var state = container.read(captureControllerProvider);
      expect(state.spokenPromptStatus, SpokenPromptStatus.permissionDenied);
      expect(state.rawInput, isEmpty);

      notifier.setInputText('Tomorrow I will go to the doctor and then work.');
      await notifier.submitIntent();

      state = container.read(captureControllerProvider);
      expect(state.status, CaptureStatus.needsConfirmation);
      expect(state.extractedCommitments.length, 2);
    });

    test('speech kill switch prevents speech service access', () async {
      final scopedSpeech = FakeSpeechCaptureService();
      final scoped = ProviderContainer(
        overrides: [
          appConfigProvider.overrideWith(
            (ref) =>
                const AppConfig(enablePilotVoice: true, killPilotVoice: true),
          ),
          speechCaptureServiceProvider.overrideWithValue(scopedSpeech),
        ],
      );
      addTearDown(scoped.dispose);

      await scoped
          .read(captureControllerProvider.notifier)
          .startSpokenPrompt(localeId: 'en_US');

      expect(scopedSpeech.startCalls, 0);
      expect(
        scoped.read(captureControllerProvider).spokenPromptStatus,
        SpokenPromptStatus.unavailable,
      );
    });
  });
}
