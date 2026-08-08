import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// Pending / Completed / Postponed / Cancelled, plus the `unknown` status the
/// backend contract can return for values this build does not recognise.
class CommitmentStatusBadge extends StatelessWidget {
  final CommitmentStatus status;

  const CommitmentStatusBadge({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final label = status.localizedStatusName(context.l10n);
    late final Color bg;
    late final Color fg;
    late final IconData icon;

    switch (status) {
      case CommitmentStatus.pending:
        bg = colors.surfaceMuted;
        fg = colors.textSecondary;
        icon = Icons.radio_button_unchecked;
        break;
      case CommitmentStatus.completed:
        bg = colors.successSubtle;
        fg = colors.success;
        icon = Icons.check_circle_rounded;
        break;
      case CommitmentStatus.postponed:
        bg = colors.warningSubtle;
        fg = colors.warning;
        icon = Icons.schedule_rounded;
        break;
      case CommitmentStatus.cancelled:
        bg = colors.dangerSubtle;
        fg = colors.danger;
        icon = Icons.cancel_rounded;
        break;
      case CommitmentStatus.unknown:
        bg = colors.surfaceMuted;
        fg = colors.textMuted;
        icon = Icons.help_outline_rounded;
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm + 2,
        vertical: AppSpacing.xs + 1,
      ),
      decoration: BoxDecoration(color: bg, borderRadius: AppRadius.chip),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: fg),
          const SizedBox(width: AppSpacing.xs + 1),
          Text(label, style: context.text.badge.copyWith(color: fg)),
        ],
      ),
    );
  }
}
