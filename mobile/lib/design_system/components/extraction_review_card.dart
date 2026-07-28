import 'package:flutter/material.dart';
import '../../core/utilities/date_formatter.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'priority_badge.dart';

class ExtractionReviewCard extends StatelessWidget {
  final Commitment commitment;
  final bool isSelected;
  final ValueChanged<bool?>? onToggleSelect;
  final VoidCallback? onEdit;
  final VoidCallback? onRemove;
  final ValueChanged<CommitmentPriority>? onPriorityChanged;

  const ExtractionReviewCard({
    super.key,
    required this.commitment,
    this.isSelected = true,
    this.onToggleSelect,
    this.onEdit,
    this.onRemove,
    this.onPriorityChanged,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isDisabled = commitment.needsClarification;

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(
          color: commitment.needsClarification
              ? colors.warning
              : (isSelected
                    ? colors.brandPrimary.withValues(alpha: 0.6)
                    : colors.border),
          width: isSelected ? 2.0 : 1.0,
        ),
        boxShadow: [
          BoxShadow(
            color: colors.brandPrimary.withValues(
              alpha: isSelected ? 0.08 : 0.02,
            ),
            blurRadius: 10,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (commitment.needsClarification) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              margin: const EdgeInsets.only(bottom: AppSpacing.xs),
              decoration: BoxDecoration(
                color: colors.warning.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.warning_amber_rounded,
                    size: 16,
                    color: colors.warning,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'Clarification needed — edit before selection',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: colors.warning,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          Row(
            children: [
              Checkbox(
                value: isDisabled ? false : isSelected,
                onChanged: isDisabled ? null : onToggleSelect,
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Flexible(
                      child: PriorityBadge(priority: commitment.priority),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: const Icon(Icons.edit_outlined, size: 18),
                          onPressed: onEdit,
                          color: colors.textSecondary,
                          tooltip: 'Edit',
                          constraints: const BoxConstraints(),
                          padding: const EdgeInsets.all(6),
                        ),
                        IconButton(
                          icon: const Icon(Icons.delete_outline, size: 18),
                          onPressed: onRemove,
                          color: colors.destructive,
                          tooltip: 'Remove',
                          constraints: const BoxConstraints(),
                          padding: const EdgeInsets.all(6),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Padding(
            padding: const EdgeInsets.only(left: 40),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  commitment.title,
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    color: colors.textPrimary,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                Wrap(
                  spacing: AppSpacing.md,
                  runSpacing: AppSpacing.xs,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.calendar_today,
                          size: 14,
                          color: commitment.scheduledDate != null
                              ? colors.brandPrimary
                              : colors.textMuted,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          commitment.scheduledDate != null
                              ? DateFormatter.formatShortDate(
                                  commitment.scheduledDate!,
                                )
                              : 'No date set',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: commitment.scheduledDate != null
                                ? colors.brandPrimary
                                : colors.textMuted,
                          ),
                        ),
                      ],
                    ),
                    if (commitment.startTime != null)
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.schedule,
                            size: 14,
                            color: colors.textSecondary,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            commitment.startTime!,
                            style: TextStyle(
                              fontSize: 13,
                              color: colors.textSecondary,
                            ),
                          ),
                        ],
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
