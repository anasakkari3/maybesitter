import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/commitment_card.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/processing_indicator.dart';
import '../../design_system/components/section_header.dart';
import '../../design_system/components/status_banner.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/elevation.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/capture_result.dart';
import '../../services/providers.dart';
import 'capture_controller.dart';

class CaptureComposerScreen extends ConsumerStatefulWidget {
  const CaptureComposerScreen({super.key});

  @override
  ConsumerState<CaptureComposerScreen> createState() =>
      _CaptureComposerScreenState();
}

class _CaptureComposerScreenState extends ConsumerState<CaptureComposerScreen> {
  late TextEditingController _textController;

  @override
  void initState() {
    super.initState();
    final captureState = ref.read(captureControllerProvider);
    _textController = TextEditingController(
      text: captureState.rawInput.isNotEmpty
          ? captureState.rawInput
          : 'Tomorrow I will go to the doctor and then work.',
    );
    _textController.addListener(_onTextChanged);
  }

  void _onTextChanged() {
    setState(() {});
    ref
        .read(captureControllerProvider.notifier)
        .setInputText(_textController.text);
  }

  @override
  void dispose() {
    _textController.removeListener(_onTextChanged);
    _textController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final l10n = context.l10n;
    final captureState = ref.watch(captureControllerProvider);
    final captureNotifier = ref.read(captureControllerProvider.notifier);
    final todayCommitments = ref.watch(todayCommitmentsProvider);

    final isSubmitting = captureState.isSubmitting;
    final trimmedInput = _textController.text.trim();
    final isAnalyzeDisabled = trimmedInput.isEmpty || isSubmitting;

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.newIntentTitle,
        leading: IconButton(
          icon: Icon(Icons.close_rounded, color: colors.textSecondary),
          tooltip: l10n.closeAction,
          onPressed: () {
            captureNotifier.reset();
            context.pop();
          },
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: SingleChildScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                AppSpacing.smd,
                AppSpacing.gutter,
                AppSpacing.xl,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  StatusBanner(
                    icon: Icons.auto_awesome,
                    message: l10n.captureHintText,
                  ),

                  const SizedBox(height: AppSpacing.lg),

                  // Text area container
                  Container(
                    padding: const EdgeInsets.all(AppSpacing.md),
                    decoration: BoxDecoration(
                      color: colors.surface,
                      borderRadius: AppRadius.card,
                      border: Border.all(color: colors.border, width: 1.5),
                      boxShadow: AppElevation.card(colors),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        TextField(
                          controller: _textController,
                          maxLines: 6,
                          enabled: !isSubmitting,
                          style: context.text.body.copyWith(height: 1.55),
                          decoration: InputDecoration(
                            hintText: l10n.composerInputHint,
                            hintStyle: context.text.body.copyWith(
                              color: colors.textMuted,
                            ),
                            border: InputBorder.none,
                          ),
                        ),
                        const Divider(),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            // Voice button safely gated as disabled coming-soon feature
                            IconButton(
                              onPressed: null,
                              icon: Icon(
                                Icons.mic_none,
                                color: colors.textMuted.withValues(alpha: 0.5),
                              ),
                              tooltip:
                                  '${l10n.voiceCaptureTooltip} (Coming soon)',
                            ),
                            Text(
                              '${_textController.text.length} chars',
                              style: context.text.caption.copyWith(
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
                          l10n.privacyNote,
                          style: context.text.caption.copyWith(
                            color: colors.textMuted,
                          ),
                        ),
                      ),
                    ],
                  ),

                  if (isSubmitting) ...[
                    const SizedBox(height: AppSpacing.md),
                    ProcessingIndicator(label: l10n.processingLabel),
                  ],

                  const SizedBox(height: AppSpacing.xxl),

                  // Recent commitments section
                  if (todayCommitments.isNotEmpty) ...[
                    const SectionHeader(
                      title: 'Recent Commitments',
                      padding: EdgeInsets.only(bottom: AppSpacing.smd),
                    ),
                    ...todayCommitments
                        .take(2)
                        .map(
                          (item) => Padding(
                            padding: const EdgeInsets.only(
                              bottom: AppSpacing.sm,
                            ),
                            child: CommitmentCard(commitment: item),
                          ),
                        ),
                  ],

                  // Dev Fixture Switcher (development preview only - debug mode)
                  if (kDebugMode) ...[
                    const SizedBox(height: AppSpacing.md),
                    ExpansionTile(
                      title: Text(
                        'Dev Fixture Previews',
                        style: context.text.meta.copyWith(
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
                                    .previewState(
                                      CaptureStatus.extractionFailed,
                                    );
                                context.push('/capture/review');
                              },
                              child: const Text('Extraction Failed'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
          // Pinned to the bottom of the body. The body is inset by
          // viewInsets, so the CTA stays above the software keyboard instead
          // of being pushed under it once the composer is focused.
          StickyActionBar(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                AppSpacing.smd,
                AppSpacing.gutter,
                AppSpacing.smd,
              ),
              child: PrimaryButton(
                label: l10n.analyzeAction,
                icon: Icons.auto_awesome,
                isLoading: isSubmitting,
                onPressed: isAnalyzeDisabled
                    ? null
                    : () async {
                        final router = GoRouter.of(context);
                        await captureNotifier.submitIntent(trimmedInput);

                        if (!mounted) return;
                        final state = ref.read(captureControllerProvider);

                        if (state.status == CaptureStatus.needsClarification) {
                          router.push('/capture/clarification');
                        } else {
                          router.push('/capture/review');
                        }
                      },
              ),
            ),
          ),
        ],
      ),
    );
  }
}
