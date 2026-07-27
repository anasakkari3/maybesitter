import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
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

class _CaptureComposerScreenState
    extends ConsumerState<CaptureComposerScreen> {
  late TextEditingController _textController;

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

  void _handleSubmit() async {
    final text = _textController.text.trim();
    if (text.isEmpty) return;

    final notifier = ref.read(captureControllerProvider.notifier);
    await notifier.submitIntent(text);

    if (!mounted) return;

    final state = ref.read(captureControllerProvider);
    switch (state.status) {
      case CaptureStatus.needsConfirmation:
        context.push('/capture/review');
        break;
      case CaptureStatus.needsClarification:
        context.push('/capture/clarification');
        break;
      case CaptureStatus.noCommitment:
        context.push('/capture/review');
        break;
      case CaptureStatus.extractionFailed:
        context.push('/capture/review');
        break;
      default:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final captureState = ref.watch(captureControllerProvider);
    final isSubmitting = captureState.status == CaptureStatus.submitting;

    return MaybesitterScaffold(
      appBar: AppBar(
        title: const Text('New Intent'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => context.pop(),
        ),
      ),
      body: isSubmitting
          ? const Center(child: ProcessingIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Try Example Lightbulb Banner
                  InkWell(
                    onTap: () {
                      _textController.text =
                          'Tomorrow I will go to the doctor and then work.';
                    },
                    borderRadius: AppRadius.control,
                    child: Container(
                      padding: const EdgeInsets.all(AppSpacing.md),
                      decoration: BoxDecoration(
                        color: colors.brandPrimary.withValues(alpha: 0.1),
                        borderRadius: AppRadius.control,
                        border: Border.all(
                          color: colors.brandPrimary.withValues(alpha: 0.3),
                        ),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            Icons.lightbulb_outline,
                            size: 20,
                            color: colors.brandPrimary,
                          ),
                          const SizedBox(width: AppSpacing.sm),
                          Expanded(
                            child: RichText(
                              text: TextSpan(
                                style: TextStyle(
                                  fontSize: 13,
                                  color: colors.textPrimary,
                                ),
                                children: [
                                  TextSpan(
                                    text: 'Try demo: ',
                                    style: TextStyle(
                                      fontWeight: FontWeight.w700,
                                      color: colors.brandPrimary,
                                    ),
                                  ),
                                  const TextSpan(
                                    text:
                                        '"Tomorrow I will go to the doctor and then work."',
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),

                  const SizedBox(height: AppSpacing.lg),

                  // Text Area Composer Input
                  Container(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    decoration: BoxDecoration(
                      color: colors.surface,
                      borderRadius: AppRadius.card,
                      border: Border.all(color: colors.border, width: 1.5),
                    ),
                    child: Column(
                      children: [
                        TextField(
                          controller: _textController,
                          maxLines: 5,
                          autofocus: true,
                          style: TextStyle(
                            fontSize: 16,
                            color: colors.textPrimary,
                            height: 1.4,
                          ),
                          decoration: InputDecoration(
                            hintText:
                                'What would you like to plan or get done?',
                            hintStyle: TextStyle(
                              fontSize: 16,
                              color: colors.textMuted,
                            ),
                            border: InputBorder.none,
                          ),
                        ),
                        const Divider(),
                        Row(
                          children: [
                            IconButton(
                              icon: Icon(Icons.mic, color: colors.brandPrimary),
                              onPressed: () {},
                              tooltip: 'Voice capture',
                            ),
                            IconButton(
                              icon: Icon(
                                Icons.calendar_today,
                                color: colors.textSecondary,
                              ),
                              onPressed: () {},
                              tooltip: 'Set Date',
                            ),
                            IconButton(
                              icon: Icon(
                                Icons.priority_high,
                                color: colors.textSecondary,
                              ),
                              onPressed: () {},
                              tooltip: 'Priority',
                            ),
                            const Spacer(),
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
                      Icon(Icons.lock_outline, size: 14, color: colors.textMuted),
                      const SizedBox(width: 4),
                      Text(
                        'Your plan is analyzed privately with Quiet Intelligence.',
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.textMuted,
                        ),
                      ),
                    ],
                  ),

                  const SizedBox(height: AppSpacing.xl),

                  // Analyze Button
                  PrimaryButton(
                    label: 'Analyze',
                    icon: Icons.auto_awesome,
                    onPressed: _handleSubmit,
                  ),

                  const SizedBox(height: AppSpacing.xxl),

                  // Dev Fixture State Switcher
                  ExpansionTile(
                    title: Text(
                      'Dev Fixture Previews',
                      style: TextStyle(
                        fontSize: 13,
                        color: colors.textMuted,
                      ),
                    ),
                    children: [
                      Wrap(
                        spacing: 8,
                        children: [
                          OutlinedButton(
                            onPressed: () {
                              ref
                                  .read(captureControllerProvider.notifier)
                                  .previewState(CaptureStatus.needsConfirmation);
                              context.push('/capture/review');
                            },
                            child: const Text('2 Items Review'),
                          ),
                          OutlinedButton(
                            onPressed: () {
                              ref
                                  .read(captureControllerProvider.notifier)
                                  .previewState(CaptureStatus.needsClarification);
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
