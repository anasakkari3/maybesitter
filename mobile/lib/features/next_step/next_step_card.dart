import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/status_banner.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/elevation.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/next_step.dart';
import '../pilot/pilot_state_notice.dart';
import 'edit_next_step_sheet.dart';
import 'evidence_labels.dart';
import 'next_step_controller.dart';

/// The V03 participant surface for the one-next-step loop.
///
/// Three rules are structural here, not stylistic:
///
///  1. **Exactly one step.** The card renders `primaryStep` and nothing else;
///     there is no list and no "see more".
///  2. **It is a proposal.** The card states that nothing has changed yet, and
///     it asserts that from `persistence.occurred` rather than from a hardcoded
///     string, so a backend that ever did persist could not be described here
///     as if it had not.
///  3. **Experiment-blind.** Nothing rendered depends on, or reveals, which
///     experiment arm produced the proposal. `proposalId` is never displayed.
class NextStepCard extends ConsumerStatefulWidget {
  const NextStepCard({super.key});

  @override
  ConsumerState<NextStepCard> createState() => _NextStepCardState();
}

class _NextStepCardState extends ConsumerState<NextStepCard> {
  var _requested = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_requested) return;
    _requested = true;
    // Deferred so the first frame is not blocked on a network round trip.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref
          .read(nextStepControllerProvider.notifier)
          .load(locale: context.currentLanguageCode);
    });
  }

  Future<void> _decide(NextStepDecision decision, {String? editedTitle}) async {
    await ref
        .read(nextStepControllerProvider.notifier)
        .decide(
          decision,
          locale: context.currentLanguageCode,
          editedTitle: editedTitle,
        );
  }

  Future<void> _edit(NextStepRecommendation recommendation) async {
    final edited = await EditNextStepSheet.show(
      context: context,
      initialTitle: recommendation.primaryStep?.title ?? '',
    );
    if (edited == null || !mounted) return;
    await _decide(NextStepDecision.edit, editedTitle: edited);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(nextStepControllerProvider);

    return switch (state.status) {
      NextStepStatus.idle ||
      NextStepStatus.loading => const _NextStepLoading(),
      NextStepStatus.blocked => PilotStateNotice(
        reason: state.blockedReason!,
        onRetry: () => ref
            .read(nextStepControllerProvider.notifier)
            .load(locale: context.currentLanguageCode),
      ),
      NextStepStatus.failed => PilotStateNotice.transportFailure(
        onRetry: () => ref
            .read(nextStepControllerProvider.notifier)
            .load(locale: context.currentLanguageCode),
      ),
      NextStepStatus.unavailable => _NextStepUnavailable(
        state: state.unavailableState ?? NextStepState.empty,
      ),
      NextStepStatus.decided => _NextStepDecided(
        decision: state.lastDecision!,
        onShowAnother: () => ref
            .read(nextStepControllerProvider.notifier)
            .next(locale: context.currentLanguageCode),
      ),
      NextStepStatus.ready ||
      NextStepStatus.submitting => _NextStepProposal(
        recommendation: state.recommendation!,
        busy: state.status == NextStepStatus.submitting,
        showStaleNotice: state.staleProposal,
        onDecide: _decide,
        onEdit: _edit,
      ),
    };
  }
}

class _NextStepShell extends StatelessWidget {
  final Widget child;
  const _NextStepShell({required this.child});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.smd,
        AppSpacing.gutter,
        AppSpacing.sm,
      ),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpacing.lg),
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: AppRadius.card,
          border: Border.all(color: colors.border),
          boxShadow: AppElevation.card(colors),
        ),
        child: child,
      ),
    );
  }
}

class _NextStepLoading extends StatelessWidget {
  const _NextStepLoading();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return _NextStepShell(
      child: Semantics(
        label: l10n.nextStepLoadingLabel,
        liveRegion: true,
        child: Row(
          children: [
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: AppSpacing.smd),
            Expanded(
              child: Text(
                l10n.nextStepLoadingLabel,
                style: context.text.supporting,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NextStepUnavailable extends StatelessWidget {
  final NextStepState state;
  const _NextStepUnavailable({required this.state});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final insufficient = state == NextStepState.insufficientEvidence;
    return _NextStepShell(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            insufficient
                ? l10n.nextStepInsufficientTitle
                : l10n.nextStepEmptyTitle,
            style: context.text.cardTitle,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            insufficient
                ? l10n.nextStepInsufficientMessage
                : l10n.nextStepEmptyMessage,
            style: context.text.supporting,
          ),
        ],
      ),
    );
  }
}

class _NextStepDecided extends StatelessWidget {
  final NextStepDecision decision;
  final VoidCallback onShowAnother;

  const _NextStepDecided({required this.decision, required this.onShowAnother});

  String _message(BuildContext context) {
    final l10n = context.l10n;
    return switch (decision) {
      NextStepDecision.accept => l10n.nextStepAcceptedMessage,
      NextStepDecision.edit => l10n.nextStepEditedMessage,
      NextStepDecision.defer => l10n.nextStepDeferredMessage,
      NextStepDecision.dismiss => l10n.nextStepDismissedMessage,
      NextStepDecision.done => l10n.nextStepDoneMessage,
    };
  }

  @override
  Widget build(BuildContext context) {
    final message = _message(context);
    return _NextStepShell(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Announced so a screen-reader user learns the decision landed
          // without having to hunt for the changed region.
          Semantics(
            liveRegion: true,
            child: StatusBanner(
              message: message,
              tone: StatusBannerTone.success,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          SecondaryButton(
            label: context.l10n.nextStepShowAnotherAction,
            icon: Icons.refresh_rounded,
            onPressed: onShowAnother,
            isFullWidth: false,
          ),
        ],
      ),
    );
  }
}

class _NextStepProposal extends StatelessWidget {
  final NextStepRecommendation recommendation;
  final bool busy;
  final bool showStaleNotice;
  final Future<void> Function(NextStepDecision decision, {String? editedTitle})
  onDecide;
  final Future<void> Function(NextStepRecommendation recommendation) onEdit;

  const _NextStepProposal({
    required this.recommendation,
    required this.busy,
    required this.showStaleNotice,
    required this.onDecide,
    required this.onEdit,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final colors = context.colors;
    final step = recommendation.primaryStep!;
    final explanation = recommendation.explanation;
    final evidence = explanation == null
        ? const <String>[]
        : localizeEvidenceLabels(l10n, explanation.evidenceLabels);

    return _NextStepShell(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (showStaleNotice) ...[
            StatusBanner(
              message: l10n.nextStepStaleMessage,
              tone: StatusBannerTone.info,
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          Text(
            l10n.nextStepSectionTitle,
            style: context.text.caption.copyWith(
              color: colors.textMuted,
              letterSpacing: 0.6,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),

          // The single proposed step. Header-level semantics so it is
          // reachable by heading navigation.
          Semantics(
            header: true,
            child: Text(step.title, style: context.text.heading2),
          ),

          // Stated from the contract, not from a constant: if a future backend
          // ever reported that it had persisted, this card would stop claiming
          // otherwise.
          if (!recommendation.persistenceOccurred) ...[
            const SizedBox(height: AppSpacing.sm),
            Row(
              children: [
                Icon(
                  Icons.lock_open_rounded,
                  size: 14,
                  color: colors.textMuted,
                ),
                const SizedBox(width: AppSpacing.xs),
                Expanded(
                  child: Text(
                    l10n.nextStepProposalNotice,
                    style: context.text.caption.copyWith(
                      color: colors.textMuted,
                    ),
                  ),
                ),
              ],
            ),
          ],

          if (explanation != null) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.smd),
              decoration: BoxDecoration(
                color: colors.surfaceMuted,
                borderRadius: AppRadius.cardInner,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    l10n.nextStepWhyTitle,
                    style: context.text.cardTitle.copyWith(fontSize: 13),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    explanation.summary,
                    style: context.text.supporting,
                  ),
                  if (evidence.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.sm),
                    Wrap(
                      spacing: AppSpacing.xs,
                      runSpacing: AppSpacing.xs,
                      children: [
                        for (final label in evidence)
                          _EvidencePill(label: label),
                      ],
                    ),
                  ],
                  if (!explanation.sensitiveInferenceUsed) ...[
                    const SizedBox(height: AppSpacing.sm),
                    Text(
                      l10n.nextStepNoSensitiveInference,
                      style: context.text.caption.copyWith(
                        color: colors.textMuted,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],

          const SizedBox(height: AppSpacing.lg),
          _DecisionActions(
            recommendation: recommendation,
            busy: busy,
            onDecide: onDecide,
            onEdit: onEdit,
          ),
        ],
      ),
    );
  }
}

class _EvidencePill extends StatelessWidget {
  final String label;
  const _EvidencePill({required this.label});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: 4,
      ),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: Border.all(color: colors.border),
      ),
      child: Text(label, style: context.text.caption),
    );
  }
}

/// Accept / Edit / Not now / Dismiss / Already done.
///
/// Rendered only for actions the server actually offered, so the participant is
/// never shown a control that would be rejected. Every one is an explicit tap:
/// there is no swipe, no timeout, and no implicit acceptance.
class _DecisionActions extends StatelessWidget {
  final NextStepRecommendation recommendation;
  final bool busy;
  final Future<void> Function(NextStepDecision decision, {String? editedTitle})
  onDecide;
  final Future<void> Function(NextStepRecommendation recommendation) onEdit;

  const _DecisionActions({
    required this.recommendation,
    required this.busy,
    required this.onDecide,
    required this.onEdit,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final allows = recommendation.allows;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (allows(NextStepDecision.accept))
          PrimaryButton(
            label: l10n.nextStepActionAccept,
            icon: Icons.check_rounded,
            onPressed: busy ? null : () => onDecide(NextStepDecision.accept),
          ),
        const SizedBox(height: AppSpacing.sm),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.sm,
          children: [
            if (allows(NextStepDecision.edit))
              SecondaryButton(
                label: l10n.nextStepActionEdit,
                icon: Icons.edit_outlined,
                onPressed: busy ? null : () => onEdit(recommendation),
                isFullWidth: false,
              ),
            if (allows(NextStepDecision.defer))
              SecondaryButton(
                label: l10n.nextStepActionDefer,
                icon: Icons.schedule_rounded,
                onPressed: busy ? null : () => onDecide(NextStepDecision.defer),
                isFullWidth: false,
              ),
            if (allows(NextStepDecision.done))
              SecondaryButton(
                label: l10n.nextStepActionDone,
                icon: Icons.task_alt_rounded,
                onPressed: busy ? null : () => onDecide(NextStepDecision.done),
                isFullWidth: false,
              ),
            if (allows(NextStepDecision.dismiss))
              TertiaryButton(
                label: l10n.nextStepActionDismiss,
                onPressed: busy
                    ? null
                    : () => onDecide(NextStepDecision.dismiss),
              ),
          ],
        ),
      ],
    );
  }
}
