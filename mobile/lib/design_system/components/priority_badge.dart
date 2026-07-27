import 'package:flutter/material.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

class PriorityBadge extends StatelessWidget {
  final CommitmentPriority priority;

  const PriorityBadge({super.key, required this.priority});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    Color bg;
    Color fg;

    switch (priority) {
      case CommitmentPriority.must:
        bg = colors.mustPriorityContainer;
        fg = colors.mustPriority;
        break;
      case CommitmentPriority.should:
        bg = colors.shouldPriorityContainer;
        fg = colors.shouldPriority;
        break;
      case CommitmentPriority.nice:
        bg = colors.nicePriorityContainer;
        fg = colors.nicePriority;
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xs,
      ),
      decoration: BoxDecoration(color: bg, borderRadius: AppRadius.pillBorder),
      child: Text(
        priority.label,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
          color: fg,
        ),
      ),
    );
  }
}
