import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/utilities/date_formatter.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/empty_state.dart';
import '../../design_system/components/error_state.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/status_banner.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../l10n/generated/app_localizations.dart';
import '../../models/feedback_history.dart';
import 'feedback_history_controller.dart';

/// "What we noticed" — every moment the app observed, and the way to correct it.
///
/// Every line states an observation ("we saw you put this off"), never a
/// preference ("you prefer putting things off"). The first is a fact about one
/// moment; the second is a claim about the person, and a product that quietly
/// promotes one into the other is doing the thing this screen exists to expose.
///
/// Correcting a row is one tap. There is no confirmation step, no pre-ticked
/// box, and no styling that leans on the user to leave the record alone: the
/// only action offered is the one they came here for.
class FeedbackHistoryScreen extends ConsumerWidget {
  const FeedbackHistoryScreen({super.key});

  Future<void> _revoke(BuildContext context, WidgetRef ref, String id) async {
    final l10n = context.l10n;
    final succeeded = await ref
        .read(feedbackHistoryControllerProvider.notifier)
        .revoke(id);
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          succeeded ? l10n.feedbackRevokeDoneMessage : l10n.feedbackRevokeFailedMessage,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final state = ref.watch(feedbackHistoryControllerProvider);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.feedbackHistoryTitle,
        subtitle: l10n.feedbackHistorySubtitle,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: l10n.backAction,
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: switch (state.status) {
        FeedbackHistoryStatus.loading => const Center(
          child: CircularProgressIndicator(),
        ),

        // Not the same as an empty history, and never dressed up as one.
        FeedbackHistoryStatus.unavailable => Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: StatusBanner(
            title: l10n.feedbackHistoryUnavailableTitle,
            message: l10n.feedbackHistoryUnavailableMessage,
            icon: Icons.link_off_rounded,
          ),
        ),

        FeedbackHistoryStatus.failed => ErrorState(
          title: l10n.feedbackHistoryLoadFailedTitle,
          message: l10n.feedbackHistoryLoadFailedMessage,
          retryLabel: l10n.retryAction,
          onRetry: () =>
              ref.read(feedbackHistoryControllerProvider.notifier).load(),
        ),

        FeedbackHistoryStatus.ready => _HistoryBody(
          state: state,
          subjectTitles: ref.watch(feedbackSubjectTitlesProvider),
          onRevoke: (id) => _revoke(context, ref, id),
        ),
      },
    );
  }
}

class _HistoryBody extends StatelessWidget {
  final FeedbackHistoryUiState state;
  final Map<String, String> subjectTitles;
  final ValueChanged<String> onRevoke;

  const _HistoryBody({
    required this.state,
    required this.subjectTitles,
    required this.onRevoke,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final rows = state.history.rows;
    final baseline = state.history.baselineNotice;

    if (rows.isEmpty && (baseline == null || baseline.total == 0)) {
      return EmptyState(
        icon: Icons.visibility_outlined,
        title: l10n.feedbackHistoryEmptyTitle,
        description: l10n.feedbackHistoryEmptyMessage,
      );
    }

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: [
        Text(l10n.feedbackHistoryIntro, style: context.text.supporting),
        const SizedBox(height: AppSpacing.sm),
        Text(
          l10n.feedbackHistoryRevokeNote,
          style: context.text.caption.copyWith(color: context.colors.textMuted),
        ),
        const SizedBox(height: AppSpacing.lg),

        for (final row in rows) ...[
          _ObservationCard(
            row: row,
            subjectTitle: subjectTitles[row.subjectId],
            busy: state.revokingId == row.id,
            onRevoke: () => onRevoke(row.id),
          ),
          const SizedBox(height: AppSpacing.smd),
        ],

        if (baseline != null && baseline.total > 0) ...[
          const SizedBox(height: AppSpacing.md),
          _BaselineCard(baseline: baseline),
        ],
      ],
    );
  }
}

/// One observed moment.
class _ObservationCard extends StatelessWidget {
  final FeedbackHistoryRow row;

  /// The item's title, when the app still holds the item. Null once it is gone.
  final String? subjectTitle;

  final bool busy;
  final VoidCallback onRevoke;

  const _ObservationCard({
    required this.row,
    required this.subjectTitle,
    required this.busy,
    required this.onRevoke,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final colors = context.colors;
    final description = observationFor(l10n, row.outcome);
    final subjectLine = subjectTitle == null
        ? l10n.feedbackHistorySubjectUnknown
        // The title is the user's own text and may be in any script, so it is
        // isolated by first strong character rather than assumed to match the
        // direction of the sentence it sits in.
        : l10n.feedbackHistoryAboutItem(DateFormatter.isolateAuto(subjectTitle!));
    final locale = context.currentLanguageCode;

    return Semantics(
      container: true,
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: AppRadius.card,
          border: Border.all(color: colors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MergeSemantics(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(_iconFor(row.outcome), size: 18, color: colors.textMuted),
                  const SizedBox(width: AppSpacing.smd),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          description,
                          style: context.text.cardTitle.copyWith(fontSize: 15),
                        ),
                        const SizedBox(height: AppSpacing.xs),
                        Text(
                          l10n.feedbackHistoryWhen(_formatMoment(row.occurredAt, locale)),
                          style: context.text.caption.copyWith(
                            color: colors.textSecondary,
                          ),
                        ),
                        Text(
                          // The event log holds an id, not a name. Showing the
                          // id would look like disclosure while telling the
                          // user nothing they can act on, so an item we can no
                          // longer name says exactly that instead.
                          subjectLine,
                          style: context.text.caption.copyWith(color: colors.textMuted),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),

            if (row.isRevoked) ...[
              const SizedBox(height: AppSpacing.sm),
              MergeSemantics(
                child: Row(
                  children: [
                    Icon(Icons.block_rounded, size: 16, color: colors.textMuted),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            l10n.feedbackRevokedBadge,
                            style: context.text.caption.copyWith(
                              color: colors.textSecondary,
                            ),
                          ),
                          Text(
                            l10n.feedbackRevokedOn(
                              _formatMoment(row.revokedAt!, locale),
                            ),
                            style: context.text.caption.copyWith(
                              color: colors.textMuted,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ] else if (row.canRevoke) ...[
              const SizedBox(height: AppSpacing.xs),
              Align(
                // Directional so the control sits on the trailing edge in both
                // reading directions rather than pinned to the left.
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton(
                  onPressed: busy ? null : onRevoke,
                  child: Text(
                    l10n.feedbackRevokeAction,
                    // The visible label is short; the spoken one names the row
                    // it applies to, so a screen reader user is never asked to
                    // remember which entry the button belongs to. Isolate marks
                    // are stripped: they order glyphs, and nothing is being
                    // laid out here.
                    semanticsLabel: l10n.feedbackRevokeSemantics(
                      DateFormatter.stripIsolates('$description $subjectLine'),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  IconData _iconFor(FeedbackOutcome outcome) {
    switch (outcome) {
      case FeedbackOutcome.accept:
        return Icons.check_circle_outline;
      case FeedbackOutcome.edit:
        return Icons.edit_outlined;
      case FeedbackOutcome.reject:
        return Icons.not_interested_rounded;
      case FeedbackOutcome.defer:
        return Icons.schedule_rounded;
      case FeedbackOutcome.complete:
        return Icons.task_alt_rounded;
      case FeedbackOutcome.ignore:
        return Icons.hourglass_empty_rounded;
      case FeedbackOutcome.undo:
        return Icons.undo_rounded;
      case FeedbackOutcome.unknown:
        return Icons.help_outline_rounded;
    }
  }
}

/// Counters inherited from before the log kept dates.
class _BaselineCard extends StatelessWidget {
  final FeedbackBaselineNotice baseline;

  const _BaselineCard({required this.baseline});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final colors = context.colors;
    final locale = context.currentLanguageCode;

    final entries = <(String, int)>[
      (l10n.feedbackBaselineCompletedActions, baseline.completedActions),
      (l10n.feedbackBaselineDelayedActions, baseline.delayedActions),
      (l10n.feedbackBaselineIgnoredSuggestions, baseline.ignoredSuggestions),
      (l10n.feedbackBaselineClarificationSuccesses, baseline.clarificationSuccesses),
      (l10n.feedbackBaselineClarificationFailures, baseline.clarificationFailures),
    ].where((entry) => entry.$2 > 0).toList();

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surfaceMuted,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              l10n.feedbackBaselineTitle,
              style: context.text.cardTitle.copyWith(fontSize: 15),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            l10n.feedbackBaselineMessage,
            style: context.text.caption.copyWith(color: colors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.smd),
          for (final entry in entries)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.xs),
              child: MergeSemantics(
                child: Row(
                  children: [
                    Expanded(
                      child: Text(entry.$1, style: context.text.supporting),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(
                      DateFormatter.isolate('${entry.$2}'),
                      style: context.text.supporting.copyWith(
                        color: colors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (baseline.lastUpdatedAt != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              l10n.feedbackBaselineUpdated(
                _formatMoment(baseline.lastUpdatedAt!, locale),
              ),
              style: context.text.caption.copyWith(color: colors.textMuted),
            ),
          ],
        ],
      ),
    );
  }
}

/// The observation sentence for an outcome.
///
/// Every branch is phrased as something we saw happen once. None of them is
/// phrased as something the user is or prefers, and [FeedbackOutcome.unknown]
/// says plainly that we hold a record we cannot describe rather than guessing
/// at a friendlier label for it.
String observationFor(AppLocalizations l10n, FeedbackOutcome outcome) {
  switch (outcome) {
    case FeedbackOutcome.accept:
      return l10n.feedbackObservedAccept;
    case FeedbackOutcome.edit:
      return l10n.feedbackObservedEdit;
    case FeedbackOutcome.reject:
      return l10n.feedbackObservedReject;
    case FeedbackOutcome.defer:
      return l10n.feedbackObservedDefer;
    case FeedbackOutcome.complete:
      return l10n.feedbackObservedComplete;
    case FeedbackOutcome.ignore:
      return l10n.feedbackObservedIgnore;
    case FeedbackOutcome.undo:
      return l10n.feedbackObservedUndo;
    case FeedbackOutcome.unknown:
      return l10n.feedbackObservedUnknown;
  }
}

/// A date and time, kept whole inside the surrounding paragraph.
///
/// The isolate is first-strong rather than left-to-right. A localised date is
/// Arabic in Arabic and Hebrew in Hebrew, and forcing it LTR pulls the day
/// number out of the date and drops it at the end of the line — a defect that
/// is invisible in an English widget test and obvious on an RTL simulator.
String _formatMoment(DateTime moment, String locale) {
  String formatted;
  try {
    formatted = DateFormat.yMMMd(locale).add_jm().format(moment);
  } catch (_) {
    // Locale data can be missing before its delegate has loaded; a readable
    // fallback beats an exception on a screen about being trustworthy.
    formatted = DateFormat.yMMMd().add_jm().format(moment);
  }
  return DateFormatter.isolateAuto(formatted);
}
