import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/colors.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// MUST / SHOULD / NICE.
class PriorityBadge extends StatelessWidget {
  final CommitmentPriority priority;
  final bool compact;

  const PriorityBadge({
    super.key,
    required this.priority,
    this.compact = false,
  });

  static Color foreground(SemanticColors colors, CommitmentPriority priority) {
    switch (priority) {
      case CommitmentPriority.must:
        return colors.mustPriority;
      case CommitmentPriority.should:
        return colors.shouldPriority;
      case CommitmentPriority.nice:
        return colors.nicePriority;
    }
  }

  static Color container(SemanticColors colors, CommitmentPriority priority) {
    switch (priority) {
      case CommitmentPriority.must:
        return colors.mustPriorityContainer;
      case CommitmentPriority.should:
        return colors.shouldPriorityContainer;
      case CommitmentPriority.nice:
        return colors.nicePriorityContainer;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fg = foreground(colors, priority);
    final label = priority.localizedName(context.l10n);

    if (compact) {
      return Semantics(
        label: label,
        child: Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: fg, shape: BoxShape.circle),
        ),
      );
    }

    return Semantics(
      label: label,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.sm + 2,
          vertical: AppSpacing.xs + 1,
        ),
        decoration: BoxDecoration(
          color: container(colors, priority),
          borderRadius: AppRadius.chip,
        ),
        child: Text(label, style: context.text.badge.copyWith(color: fg)),
      ),
    );
  }
}
