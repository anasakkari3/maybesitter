import 'package:flutter/material.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

class CommitmentStatusBadge extends StatelessWidget {
  final CommitmentStatus status;

  const CommitmentStatusBadge({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    String label;
    Color bg;
    Color fg;

    switch (status) {
      case CommitmentStatus.pending:
        label = 'Pending';
        bg = colors.surfaceElevated;
        fg = colors.textSecondary;
        break;
      case CommitmentStatus.completed:
        label = 'Completed';
        bg = colors.success.withValues(alpha: 0.15);
        fg = colors.success;
        break;
      case CommitmentStatus.postponed:
        label = 'Postponed';
        bg = colors.warning.withValues(alpha: 0.15);
        fg = colors.warning;
        break;
      case CommitmentStatus.cancelled:
        label = 'Cancelled';
        bg = colors.destructive.withValues(alpha: 0.15);
        fg = colors.destructive;
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xs,
      ),
      decoration: BoxDecoration(color: bg, borderRadius: AppRadius.pillBorder),
      child: Text(
        label,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: fg),
      ),
    );
  }
}
