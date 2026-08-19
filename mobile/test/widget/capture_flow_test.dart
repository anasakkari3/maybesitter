import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/config/app_config.dart';
import 'package:maybesitter_mobile/design_system/components/maybesitter_buttons.dart';
import 'package:maybesitter_mobile/features/capture/capture_composer_screen.dart';
import 'package:maybesitter_mobile/features/capture/capture_controller.dart';
import 'package:maybesitter_mobile/features/capture/capture_flow_launch.dart';
import 'package:maybesitter_mobile/features/capture/clarification_sheet_screen.dart';
import 'package:maybesitter_mobile/features/capture/extraction_review_screen.dart';
import 'package:maybesitter_mobile/features/capture/success_save_screen.dart';
import 'package:maybesitter_mobile/l10n/generated/app_localizations.dart';
import 'package:maybesitter_mobile/models/capture_result.dart';
import 'package:maybesitter_mobile/services/contracts/speech_capture_service.dart';
import 'package:maybesitter_mobile/services/providers.dart';

class FakeSpeechCaptureService implements SpeechCaptureService {
  SpeechCaptureStartResult startResult =
      const SpeechCaptureStartResult.started();
  void Function(SpeechCaptureTranscript transcript)? onTranscript;
  void Function()? onDone;
  int startCalls = 0;

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
    this.onDone = onDone;
    return startResult;
  }

  @override
  Future<void> stopListening() async {
    onDone?.call();
  }

  @override
  Future<void> cancelListening() async {}

  void emitTranscript(String text, {bool isFinal = false}) {
    onTranscript?.call(SpeechCaptureTranscript(text: text, isFinal: isFinal));
  }
}

Widget _buildLocalizedApp(Widget home) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: home,
  );
}

void main() {
  group('Capture Flow Widget Tests', () {
    testWidgets('Renders CaptureComposerScreen correctly', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(enablePilotVoice: true),
            ),
          ],
          child: _buildLocalizedApp(const CaptureComposerScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('New Intent'), findsOneWidget);
      expect(find.text('Speak what is on your mind'), findsOneWidget);
      expect(find.byTooltip('Voice Capture'), findsOneWidget);
    });

    testWidgets('Reviews and edits speech transcript before analysis', (
      WidgetTester tester,
    ) async {
      final speechService = FakeSpeechCaptureService();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(enablePilotVoice: true),
            ),
            speechCaptureServiceProvider.overrideWithValue(speechService),
          ],
          child: _buildLocalizedApp(const CaptureComposerScreen()),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Speak what is on your mind'));
      await tester.pumpAndSettle();
      speechService.emitTranscript('tomorrow doctor then work', isFinal: true);
      await tester.pumpAndSettle();

      expect(find.text('Review before analysis'), findsOneWidget);
      expect(find.text('tomorrow doctor then work'), findsOneWidget);

      await tester.enterText(
        find.byType(TextField),
        'Tomorrow I will go to the doctor and then work.',
      );
      await tester.pumpAndSettle();

      expect(find.text('Analyze'), findsOneWidget);
      expect(
        find.text('Tomorrow I will go to the doctor and then work.'),
        findsOneWidget,
      );
    });

    testWidgets('Permission denial leaves typed capture usable', (
      WidgetTester tester,
    ) async {
      final speechService = FakeSpeechCaptureService()
        ..startResult = const SpeechCaptureStartResult.failed(
          SpeechCaptureFailureReason.permissionDenied,
        );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(enablePilotVoice: true),
            ),
            speechCaptureServiceProvider.overrideWithValue(speechService),
          ],
          child: _buildLocalizedApp(const CaptureComposerScreen()),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Speak what is on your mind'));
      await tester.pumpAndSettle();

      expect(find.text('Speech access is off'), findsOneWidget);

      await tester.enterText(
        find.byType(TextField),
        'Tomorrow I will go to the doctor and then work.',
      );
      await tester.pumpAndSettle();

      expect(find.text('Analyze'), findsOneWidget);
      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNotNull,
      );
    });

    testWidgets('Widget voice launch deep-links to capture flow', (
      WidgetTester tester,
    ) async {
      final speechService = FakeSpeechCaptureService();

      expect(
        CaptureFlowLaunch.locationFromExternalUri(
          Uri.parse('maybesitter://capture?source=widget&input=voice'),
        ),
        '/capture?source=widget&input=voice',
      );
      expect(
        CaptureFlowLaunch.location(
          source: CaptureLaunchSource.widget,
          input: CaptureLaunchInput.spoken,
        ),
        '/capture?source=widget&input=voice',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            appConfigProvider.overrideWith(
              (ref) => const AppConfig(enablePilotVoice: true),
            ),
            speechCaptureServiceProvider.overrideWithValue(speechService),
          ],
          child: _buildLocalizedApp(
            const CaptureComposerScreen(
              launch: CaptureFlowLaunch(
                source: CaptureLaunchSource.widget,
                input: CaptureLaunchInput.spoken,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(speechService.startCalls, 1);
      expect(find.text('Listening'), findsOneWidget);
    });

    testWidgets('Renders ExtractionReviewScreen with proposed items', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.needsConfirmation);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: _buildLocalizedApp(const ExtractionReviewScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Review Your Plan'), findsOneWidget);
      expect(find.text('Go to the doctor'), findsOneWidget);
      expect(find.text('Work afterward'), findsOneWidget);
    });

    testWidgets('Renders ClarificationSheetScreen correctly', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.needsClarification);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: _buildLocalizedApp(const ClarificationSheetScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Clarification'), findsOneWidget);
      expect(find.text('Clarification Needed'), findsOneWidget);
    });

    testWidgets('Renders SuccessSaveScreen correctly', (
      WidgetTester tester,
    ) async {
      final container = ProviderContainer();
      container
          .read(captureControllerProvider.notifier)
          .previewState(CaptureStatus.saved);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: _buildLocalizedApp(const SuccessSaveScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Added 2 commitments for Tomorrow.'), findsOneWidget);
      expect(find.text('View Tomorrow'), findsOneWidget);
    });
  });
}
