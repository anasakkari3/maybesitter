import 'package:flutter/material.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'priority_badge.dart';

class CompactCommitmentRow extends StatelessWidget {
  final Commitment commitment;
  final VoidCallback? onTap;

  const CompactCommitmentRow({super.key, required this.commitment, this.onTap});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.xs),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.control,
        border: Border.all(color: colors.border, width: 1),
      ),
      child: ListTile(
        dense: true,
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.xs,
        ),
        title: Text(
          commitment.title,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: colors.textPrimary,
          ),
        ),
        subtitle: commitment.startTime != null
            ? Text(
                commitment.startTime!,
                style: TextStyle(fontSize: 12, color: colors.textSecondary),
              )
            : null,
        trailing: PriorityBadge(priority: commitment.priority),
      ),
    );
  }
}
