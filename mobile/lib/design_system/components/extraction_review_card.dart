import 'package:flutter/material.dart';

import '../../core/utilities/date_formatter.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'maybesitter_chip.dart';
import 'priority_badge.dart';
import 'status_banner.dart';

/// A proposed commitment awaiting confirmation.
///
/// Distinct from a saved CommitmentCard: brand-tinted rail, an interactive
/// selection control, and the metadata surfaced as chips so a date or time the
/// model guessed is easy to spot before saving.
///
/// Selection is real state, not decoration — the capture controller tracks
/// which proposals will be saved so a partial confirmation is possible. Items
/// that still need clarification cannot be selected until they are edited.
class ExtractionReviewCard extends StatelessWidget {
  final Commitment commitment;
  final bool isSelected;
  final ValueChanged<bool?>? onToggleSelect;
  final VoidCallback? onEdit;
  final VoidCallback? onRemove;
  final ValueChanged<CommitmentPriority>? onPriorityChanged;

  /// Optional override for the date chip. Falls back to the commitment's own
  /// scheduled date.
  final String? dateLabel;

  const ExtractionReviewCard({
    super.key,
    required this.commitment,
    this.isSelected = true,
    this.onToggleSelect,
    this.onEdit,
    this.onRemove,
    this.onPriorityChanged,
    this.dateLabel,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isDisabled = !commitment.canBeSelected;
    final effectivelySelected = isDisabled ? false : isSelected;

    final resolvedDate =
        dateLabel ??
        (commitment.scheduledDate != null
            ? DateFormatter.formatShortDate(commitment.scheduledDate!)
            : 'No date set');

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.smd),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(
          color: isDisabled
              ? colors.warning.withValues(alpha: 0.55)
              : effectivelySelected
              ? colors.brandPrimary.withValues(alpha: 0.35)
              : colors.border,
          width: effectivelySelected || isDisabled ? 1.5 : 1,
        ),
        boxShadow: AppElevation.card(colors),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (commitment.needsClarification)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md,
                AppSpacing.md,
                AppSpacing.md,
                0,
              ),
              child: const StatusBanner(
                tone: StatusBannerTone.warning,
                message: 'Clarification needed — edit before selection',
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md,
              AppSpacing.md,
              AppSpacing.sm,
              AppSpacing.sm,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _SelectionControl(
                  isSelected: effectivelySelected,
                  isDisabled: isDisabled,
                  onChanged: isDisabled ? null : onToggleSelect,
                ),
                const SizedBox(width: AppSpacing.smd),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      commitment.title,
                      style: context.text.cardTitle,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                PriorityBadge(priority: commitment.priority),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md + 26 + AppSpacing.smd,
              0,
              AppSpacing.md,
              AppSpacing.smd,
            ),
            child: Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                MetaChip(
                  icon: Icons.event_rounded,
                  label: resolvedDate,
                  tint: commitment.scheduledDate != null
                      ? colors.brandStrong
                      : colors.textMuted,
                ),
                if (commitment.startTime != null)
                  MetaChip(
                    icon: Icons.schedule_rounded,
                    label: commitment.startTime!,
                  ),
                if (commitment.location != null)
                  MetaChip(
                    icon: Icons.place_outlined,
                    label: commitment.location!,
                  ),
              ],
            ),
          ),
          Divider(height: 1, color: colors.border),
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.sm,
              vertical: AppSpacing.xs,
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton.icon(
                  onPressed: onEdit,
                  icon: const Icon(Icons.edit_outlined, size: 18),
                  label: const Text('Edit'),
                  style: TextButton.styleFrom(
                    foregroundColor: colors.textSecondary,
                  ),
                ),
                TextButton.icon(
                  onPressed: onRemove,
                  icon: const Icon(Icons.close_rounded, size: 18),
                  label: const Text('Remove'),
                  style: TextButton.styleFrom(foregroundColor: colors.danger),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Interactive include/exclude control. Reads as a checkbox to screen readers
/// and exposes its disabled state when the proposal still needs clarification.
class _SelectionControl extends StatelessWidget {
  final bool isSelected;
  final bool isDisabled;
  final ValueChanged<bool?>? onChanged;

  const _SelectionControl({
    required this.isSelected,
    required this.isDisabled,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Semantics(
      checked: isSelected,
      enabled: !isDisabled,
      label: isDisabled
          ? 'Needs clarification before it can be included'
          : 'Include in this save',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onChanged == null ? null : () => onChanged!(!isSelected),
        child: SizedBox(
          width: AppSpacing.minTouchTarget,
          height: AppSpacing.minTouchTarget,
          child: Center(
            child: Container(
              width: 26,
              height: 26,
              decoration: BoxDecoration(
                color: isSelected ? colors.brandFill : Colors.transparent,
                shape: BoxShape.circle,
                border: Border.all(
                  color: isDisabled
                      ? colors.warning
                      : isSelected
                      ? colors.brandFill
                      : colors.borderStrong,
                  width: 2,
                ),
              ),
              child: isSelected
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
