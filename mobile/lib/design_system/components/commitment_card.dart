import 'package:flutter/material.dart';

import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/motion.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'priority_badge.dart';
import 'pressable.dart';

/// The primary row of the Today / Upcoming lists.
///
/// Reads as one calm block: a large tap-to-complete control, the title, then
/// a single metadata line. Priority is carried by a small dot plus the badge,
/// so it never shouts over the title.
class CommitmentCard extends StatelessWidget {
  final Commitment commitment;
  final ValueChanged<bool?>? onToggleComplete;
  final VoidCallback? onTap;
  final VoidCallback? onMoreTap;

  /// Renders the card in an "overdue" treatment.
  final bool isOverdue;

  const CommitmentCard({
    super.key,
    required this.commitment,
    this.onToggleComplete,
    this.onTap,
    this.onMoreTap,
    this.isOverdue = false,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isDone = commitment.status.isCompleted;
    final accent = PriorityBadge.foreground(colors, commitment.priority);

    final hasMeta =
        commitment.startTime != null ||
        commitment.location != null ||
        isOverdue;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.smd),
      child: Pressable(
        onTap: onTap,
        borderRadius: AppRadius.card,
        semanticLabel: commitment.title,
        child: AnimatedContainer(
          duration: AppMotion.fast,
          curve: AppMotion.decelerate,
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: colors.surface,
            borderRadius: AppRadius.card,
            border: Border.all(
              color: isOverdue && !isDone
                  ? colors.danger.withValues(alpha: 0.35)
                  : colors.border,
            ),
            boxShadow: isDone ? null : AppElevation.card(colors),
          ),
          child: Opacity(
            opacity: isDone ? 0.65 : 1.0,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _CompletionControl(
                  isDone: isDone,
                  accent: accent,
                  label: commitment.title,
                  onToggle: onToggleComplete == null
                      ? null
                      : () => onToggleComplete!(!isDone),
                ),
                const SizedBox(width: AppSpacing.smd),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                commitment.title,
                                style: context.text.cardTitle.copyWith(
                                  color: isDone
                                      ? colors.textMuted
                                      : colors.textPrimary,
                                  decoration: isDone
                                      ? TextDecoration.lineThrough
                                      : null,
                                  decorationColor: colors.textMuted,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: AppSpacing.sm),
                          PriorityBadge(priority: commitment.priority),
                        ],
                      ),
                      if (commitment.description != null &&
                          commitment.description!.isNotEmpty) ...[
                        const SizedBox(height: AppSpacing.xs + 2),
                        Text(
                          commitment.description!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: context.text.supporting,
                        ),
                      ],
                      if (hasMeta) ...[
                        const SizedBox(height: AppSpacing.smd - 2),
                        _MetaLine(
                          commitment: commitment,
                          isOverdue: isOverdue && !isDone,
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CompletionControl extends StatelessWidget {
  final bool isDone;
  final Color accent;
  final String label;
  final VoidCallback? onToggle;

  const _CompletionControl({
    required this.isDone,
    required this.accent,
    required this.label,
    this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Semantics(
      checked: isDone,
      label: isDone ? 'Mark "$label" as pending' : 'Mark "$label" as complete',
      child: InkResponse(
        onTap: onToggle,
        radius: 26,
        containedInkWell: false,
        child: SizedBox(
          width: AppSpacing.minTouchTarget - 12,
          height: AppSpacing.minTouchTarget - 12,
          child: Center(
            child: AnimatedContainer(
              duration: AppMotion.fast,
              curve: AppMotion.decelerate,
              width: 26,
              height: 26,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: isDone ? colors.successFill : Colors.transparent,
                border: Border.all(
                  color: isDone
                      ? colors.successFill
                      : accent.withValues(alpha: 0.55),
                  width: 2,
                ),
              ),
              child: isDone
                  ? const Icon(
                      Icons.check_rounded,
                      size: 16,
                      color: Colors.white,
                    )
                  : null,
            ),
          ),
        ),
      ),
    );
  }
}

class _MetaLine extends StatelessWidget {
  final Commitment commitment;
  final bool isOverdue;

  const _MetaLine({required this.commitment, required this.isOverdue});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tint = isOverdue ? colors.danger : colors.textMuted;

    final parts = <Widget>[
      if (isOverdue)
        _MetaItem(
          icon: Icons.error_outline_rounded,
          label: 'Overdue',
          tint: colors.danger,
          emphasise: true,
        ),
      if (commitment.startTime != null)
        _MetaItem(
          icon: Icons.schedule_rounded,
          label: commitment.startTime!,
          tint: tint,
        ),
      if (commitment.location != null)
        _MetaItem(
          icon: Icons.place_outlined,
          label: commitment.location!,
          tint: tint,
        ),
    ];

    return Wrap(
      spacing: AppSpacing.smd,
      runSpacing: AppSpacing.xs,
      children: parts,
    );
  }
}

class _MetaItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color tint;
  final bool emphasise;

  const _MetaItem({
    required this.icon,
    required this.label,
    required this.tint,
    this.emphasise = false,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 15, color: tint),
        const SizedBox(width: AppSpacing.xs + 1),
        Text(
          label,
          style: context.text.meta.copyWith(
            color: tint,
            fontWeight: emphasise ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ],
    );
  }
}
