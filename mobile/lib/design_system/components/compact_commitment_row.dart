import 'package:flutter/material.dart';

import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'priority_badge.dart';
import 'pressable.dart';

/// A slim preview row — used where a full CommitmentCard would be too heavy
/// (recent captures, success summaries).
class CompactCommitmentRow extends StatelessWidget {
  final Commitment commitment;
  final VoidCallback? onTap;
  final IconData? leadingIcon;

  const CompactCommitmentRow({
    super.key,
    required this.commitment,
    this.onTap,
    this.leadingIcon,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final accent = PriorityBadge.foreground(colors, commitment.priority);

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Pressable(
        onTap: onTap,
        borderRadius: AppRadius.cardInner,
        semanticLabel: commitment.title,
        child: Container(
          constraints: const BoxConstraints(
            minHeight: AppSpacing.minTouchTarget,
          ),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.smd,
            vertical: AppSpacing.smd,
          ),
          decoration: BoxDecoration(
            color: colors.surface,
            borderRadius: AppRadius.cardInner,
            border: Border.all(color: colors.border),
          ),
          child: Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(AppRadius.sm),
                ),
                child: Icon(
                  leadingIcon ?? Icons.task_alt_rounded,
                  size: 18,
                  color: accent,
                ),
              ),
              const SizedBox(width: AppSpacing.smd),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      commitment.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.text.cardTitle.copyWith(fontSize: 15),
                    ),
                    if (commitment.startTime != null) ...[
                      const SizedBox(height: 2),
                      Text(commitment.startTime!, style: context.text.caption),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              PriorityBadge(priority: commitment.priority),
            ],
          ),
        ),
      ),
    );
  }
}
