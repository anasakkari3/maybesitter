import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/processing_indicator.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/capture_result.dart';
import 'capture_controller.dart';

class CaptureComposerScreen extends ConsumerStatefulWidget {
  const CaptureComposerScreen({super.key});

  @override
  ConsumerState<CaptureComposerScreen> createState() =>
      _CaptureComposerScreenState();
}

class _CaptureComposerScreenState extends ConsumerState<CaptureComposerScreen> {
  late TextEditingController _textController;
  bool _isVoiceRecording = false;

  @override
  void initState() {
    super.initState();
    _textController = TextEditingController(
      text: 'Tomorrow I will go to the doctor and then work.',
    );
  }

  @override
  void dispose() {
    _textController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final captureState = ref.watch(captureControllerProvider);
    final captureNotifier = ref.read(captureControllerProvider.notifier);

    final isSubmitting = captureState.status == CaptureStatus.submitting;

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: 'New Intent',
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () {
            captureNotifier.reset();
            context.pop();
          },
        ),
      ),
      body: isSubmitting
          ? const Center(
              child: ProcessingIndicator(
                label: 'Analyzing your plan with Quiet Intelligence...',
              ),
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Hint banner
                  Container(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    decoration: BoxDecoration(
                      color: colors.brandSecondary.withValues(alpha: 0.15),
                      borderRadius: AppRadius.card,
                      border: Border.all(
                        color: colors.brandSecondary.withValues(alpha: 0.3),
                      ),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          Icons.auto_awesome,
                          color: colors.brandSecondary,
                          size: 20,
                        ),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: Text(
                            'Type or speak freely. Maybesitter extracts commitments, times, and priorities automatically.',
                            style: TextStyle(
                              fontSize: 13,
                              color: colors.textPrimary,
                              height: 1.3,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: AppSpacing.lg),

                  // Text area container
                  Container(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    decoration: BoxDecoration(
                      color: colors.surface,
                      borderRadius: AppRadius.card,
                      border: Border.all(
                        color: colors.borderStrong,
                        width: 1.5,
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        TextField(
                          controller: _textController,
                          maxLines: 6,
                          style: TextStyle(
                            fontSize: 16,
                            color: colors.textPrimary,
                            height: 1.4,
                          ),
                          decoration: InputDecoration(
                            hintText:
                                'e.g. "Tomorrow morning at 9am doctor visit, then meet Sarah for coffee at 2pm..."',
                            hintStyle: TextStyle(
                              color: colors.textMuted,
                              fontSize: 15,
                            ),
                            border: InputBorder.none,
                          ),
                        ),
                        const Divider(),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            // Voice toggle button
                            IconButton(
                              onPressed: () {
                                setState(() {
                                  _isVoiceRecording = !_isVoiceRecording;
                                });
                              },
                              icon: Icon(
                                _isVoiceRecording ? Icons.mic : Icons.mic_none,
                                color: _isVoiceRecording
                                    ? colors.brandPrimary
                                    : colors.textSecondary,
                              ),
                              tooltip: _isVoiceRecording
                                  ? 'Stop Recording'
                                  : 'Voice Capture',
                            ),
                            Text(
                              '${_textController.text.length} chars',
                              style: TextStyle(
                                fontSize: 12,
                                color: colors.textMuted,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: AppSpacing.md),

                  // Privacy Note
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.lock_outline,
                        size: 14,
                        color: colors.textMuted,
                      ),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          'Your plan is analyzed privately with Quiet Intelligence.',
                          style: TextStyle(
                            fontSize: 12,
                            color: colors.textMuted,
                          ),
                        ),
                      ),
                    ],
                  ),

                  const SizedBox(height: AppSpacing.xl),

                  // Submit Action Button
                  PrimaryButton(
                    label: 'Analyze',
                    icon: Icons.auto_awesome,
                    isLoading: isSubmitting,
                    onPressed: () async {
                      final input = _textController.text.trim();
                      if (input.isEmpty) return;

                      final router = GoRouter.of(context);
                      await captureNotifier.submitIntent(input);

                      if (!mounted) return;
                      final state = ref.read(captureControllerProvider);

                      if (state.status == CaptureStatus.needsClarification) {
                        router.push('/capture/clarification');
                      } else {
                        router.push('/capture/review');
                      }
                    },
                  ),

                  const SizedBox(height: AppSpacing.xxl),

                  // Dev Fixture Switcher (development preview only)
                  ExpansionTile(
                    title: Text(
                      'Dev Fixture Previews',
                      style: TextStyle(fontSize: 13, color: colors.textMuted),
                    ),
                    children: [
                      Wrap(
                        spacing: 8,
                        children: [
                          OutlinedButton(
                            onPressed: () {
                              ref
                                  .read(captureControllerProvider.notifier)
                                  .previewState(
                                    CaptureStatus.needsConfirmation,
                                  );
                              context.push('/capture/review');
                            },
                            child: const Text('2 Items Review'),
                          ),
                          OutlinedButton(
                            onPressed: () {
                              ref
                                  .read(captureControllerProvider.notifier)
                                  .previewState(
                                    CaptureStatus.needsClarification,
                                  );
                              context.push('/capture/clarification');
                            },
                            child: const Text('Clarification'),
                          ),
                          OutlinedButton(
                            onPressed: () {
                              ref
                                  .read(captureControllerProvider.notifier)
                                  .previewState(CaptureStatus.noCommitment);
                              context.push('/capture/review');
                            },
                            child: const Text('Nothing Found'),
                          ),
                          OutlinedButton(
                            onPressed: () {
                              ref
                                  .read(captureControllerProvider.notifier)
                                  .previewState(CaptureStatus.extractionFailed);
                              context.push('/capture/review');
                            },
                            child: const Text('Extraction Failed'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ),
    );
  }
}
