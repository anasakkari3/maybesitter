import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/adaptive/adaptive_haptics.dart';
import '../../design_system/adaptive/adaptive_platform.dart';
import '../../design_system/components/commitment_card.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/processing_indicator.dart';
import '../../design_system/components/section_header.dart';
import '../../design_system/components/status_banner.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/elevation.dart';
import '../../design_system/tokens/motion.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/capture_result.dart';
import '../../services/providers.dart';
import 'capture_controller.dart';
import 'capture_flow_launch.dart';

class CaptureComposerScreen extends ConsumerStatefulWidget {
  final CaptureFlowLaunch launch;

  const CaptureComposerScreen({
    super.key,
    this.launch = const CaptureFlowLaunch(),
  });

  @override
  ConsumerState<CaptureComposerScreen> createState() =>
      _CaptureComposerScreenState();
}

class _CaptureComposerScreenState extends ConsumerState<CaptureComposerScreen> {
  late TextEditingController _textController;
  late final FocusNode _focusNode = FocusNode()..addListener(_onFocusChanged);
  bool _inputFocused = false;
  bool _didHandleLaunch = false;

  void _onFocusChanged() {
    if (!mounted) return;
    setState(() => _inputFocused = _focusNode.hasFocus);
  }

  @override
  void initState() {
    super.initState();
    final captureState = ref.read(captureControllerProvider);
    _textController = TextEditingController(
      text: captureState.rawInput.isNotEmpty ? captureState.rawInput : '',
    );
    _textController.addListener(_onTextChanged);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          _didHandleLaunch ||
          !widget.launch.shouldStartSpokenPrompt) {
        return;
      }
      _didHandleLaunch = true;
      _startSpokenPrompt();
    });
  }

  void _onTextChanged() {
    setState(() {});
    ref
        .read(captureControllerProvider.notifier)
        .setInputText(_textController.text);
  }

  Future<void> _startSpokenPrompt() async {
    FocusScope.of(context).unfocus();
    AdaptiveHaptics.selection();
    await ref
        .read(captureControllerProvider.notifier)
        .startSpokenPrompt(
          localeId: Localizations.localeOf(context).toLanguageTag(),
          source: widget.launch.source,
        );
  }

  Future<void> _stopSpokenPrompt() async {
    AdaptiveHaptics.selection();
    await ref.read(captureControllerProvider.notifier).stopSpokenPrompt();
  }

  @override
  void dispose() {
    _focusNode
      ..removeListener(_onFocusChanged)
      ..dispose();
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
    final voiceEnabled = ref.watch(pilotPresenceFeatureFlagsProvider).voice;

    ref.listen<CaptureState>(captureControllerProvider, (previous, next) {
      if (previous?.rawInput == next.rawInput ||
          _textController.text == next.rawInput) {
        return;
      }

      _textController.value = TextEditingValue(
        text: next.rawInput,
        selection: TextSelection.collapsed(offset: next.rawInput.length),
      );
    });

    final isSubmitting = captureState.isSubmitting;
    final isListeningToSpeech = captureState.isListeningToSpeech;
    final trimmedInput = _textController.text.trim();
    final isAnalyzeDisabled = trimmedInput.isEmpty || isSubmitting;
    final hasSpeechFailure =
        captureState.spokenPromptStatus ==
            SpokenPromptStatus.permissionDenied ||
        captureState.spokenPromptStatus == SpokenPromptStatus.unavailable ||
        captureState.spokenPromptStatus == SpokenPromptStatus.failed;
    final shouldOfferSpeechPrimary =
        voiceEnabled &&
        trimmedInput.isEmpty &&
        !isSubmitting &&
        !hasSpeechFailure;
    final primaryLabel = isListeningToSpeech
        ? l10n.spokenPromptStopAction
        : (shouldOfferSpeechPrimary
              ? l10n.spokenPromptPrimaryAction
              : l10n.analyzeAction);
    final primaryIcon = isListeningToSpeech
        ? Icons.stop_rounded
        : (shouldOfferSpeechPrimary ? Icons.mic_rounded : Icons.auto_awesome);
    final VoidCallback? primaryAction = isListeningToSpeech
        ? _stopSpokenPrompt
        : (shouldOfferSpeechPrimary
              ? _startSpokenPrompt
              : (isAnalyzeDisabled
                    ? null
                    : () async {
                        final router = GoRouter.of(context);
                        AdaptiveHaptics.success();
                        await captureNotifier.submitIntent(trimmedInput);

                        if (!mounted) return;
                        final state = ref.read(captureControllerProvider);

                        if (state.status == CaptureStatus.needsClarification) {
                          router.push('/capture/clarification');
                        } else {
                          router.push('/capture/review');
                        }
                      }));
    final speechBanner = _speechBanner(captureState);

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

                  if (speechBanner != null) ...[
                    const SizedBox(height: AppSpacing.smd),
                    speechBanner,
                  ],

                  const SizedBox(height: AppSpacing.lg),

                  // Text area container
                  AnimatedContainer(
                    duration: Adaptive.motion(context, AppMotion.fast),
                    curve: AppMotion.decelerate,
                    padding: const EdgeInsets.all(AppSpacing.md),
                    decoration: BoxDecoration(
                      color: colors.surface,
                      borderRadius: AppRadius.card,
                      // Focus reads as a stronger ring plus a small lift, so
                      // the writing surface is unmistakably live - without
                      // moving anything.
                      border: Border.all(
                        color: _inputFocused ? colors.focusRing : colors.border,
                        width: 1.5,
                      ),
                      boxShadow: _inputFocused
                          ? AppElevation.raised(colors)
                          : AppElevation.card(colors),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        TextField(
                          controller: _textController,
                          maxLines: 6,
                          enabled: !isSubmitting && !isListeningToSpeech,
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
                            // Secondary voice affordance for adding speech
                            // after the first prompt.
                            IconButton(
                              onPressed: isSubmitting || !voiceEnabled
                                  ? null
                                  : (isListeningToSpeech
                                        ? _stopSpokenPrompt
                                        : _startSpokenPrompt),
                              icon: Icon(
                                isListeningToSpeech
                                    ? Icons.stop_circle_outlined
                                    : Icons.mic_none,
                                color: isSubmitting || !voiceEnabled
                                    ? colors.textMuted.withValues(alpha: 0.5)
                                    : colors.brandStrong,
                              ),
                              tooltip: voiceEnabled
                                  ? (isListeningToSpeech
                                        ? l10n.voiceCaptureStopTooltip
                                        : l10n.voiceCaptureTooltip)
                                  : '${l10n.voiceCaptureTooltip} (Coming soon)',
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
                label: primaryLabel,
                icon: primaryIcon,
                isLoading: isSubmitting,
                onPressed: primaryAction,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget? _speechBanner(CaptureState state) {
    final l10n = context.l10n;

    return switch (state.spokenPromptStatus) {
      SpokenPromptStatus.requestingPermission => StatusBanner(
        icon: Icons.mic_rounded,
        title: l10n.spokenPromptListeningTitle,
        message: l10n.spokenPromptPermissionRequestMessage,
      ),
      SpokenPromptStatus.listening => StatusBanner(
        icon: Icons.mic_rounded,
        title: l10n.spokenPromptListeningTitle,
        message: l10n.spokenPromptListeningMessage,
      ),
      SpokenPromptStatus.reviewingTranscript => StatusBanner(
        icon: Icons.edit_note_rounded,
        tone: StatusBannerTone.success,
        title: l10n.spokenPromptReviewTitle,
        message: l10n.spokenPromptReviewMessage,
      ),
      SpokenPromptStatus.permissionDenied => StatusBanner(
        icon: Icons.mic_off_rounded,
        tone: StatusBannerTone.warning,
        title: l10n.spokenPromptPermissionDeniedTitle,
        message: l10n.spokenPromptPermissionDeniedMessage,
      ),
      SpokenPromptStatus.unavailable => StatusBanner(
        icon: Icons.mic_off_rounded,
        tone: StatusBannerTone.warning,
        title: l10n.spokenPromptUnavailableTitle,
        message: l10n.spokenPromptUnavailableMessage,
      ),
      SpokenPromptStatus.failed => StatusBanner(
        icon: Icons.error_outline_rounded,
        tone: StatusBannerTone.warning,
        title: l10n.spokenPromptFailureTitle,
        message: state.spokenPromptMessage ?? l10n.spokenPromptFailureMessage,
      ),
      SpokenPromptStatus.idle => null,
    };
  }
}
