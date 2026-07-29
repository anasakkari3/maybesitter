import 'package:flutter/material.dart';

import '../../models/commitment.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/spacing.dart';
import 'compact_commitment_row.dart';
import 'maybesitter_buttons.dart';

/// Confirmation shown after a capture is saved.
class SuccessPanel extends StatelessWidget {
  final String title;
  final String subtitle;
  final List<Commitment> savedCommitments;
  final VoidCallback onViewTomorrow;
  final VoidCallback onDone;
  final VoidCallback? onUndo;

  const SuccessPanel({
    super.key,
    required this.title,
    required this.subtitle,
    required this.savedCommitments,
    required this.onViewTomorrow,
    required this.onDone,
    this.onUndo,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final l10n = context.l10n;

    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 88,
              height: 88,
              decoration: BoxDecoration(
                color: colors.successSubtle,
                shape: BoxShape.circle,
                border: Border.all(
                  color: colors.success.withValues(alpha: 0.25),
                  width: 2,
                ),
              ),
              child: Icon(Icons.check_rounded, size: 44, color: colors.success),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              title,
              textAlign: TextAlign.center,
              style: context.text.heading1,
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: context.text.supporting,
            ),
            const SizedBox(height: AppSpacing.lg),
            ...savedCommitments.map(
              (c) => CompactCommitmentRow(
                commitment: c,
                leadingIcon: c.category == 'Health'
                    ? Icons.medical_services_outlined
                    : Icons.work_outline_rounded,
              ),
            ),
            const SizedBox(height: AppSpacing.smd),
            PrimaryButton(
              label: l10n.viewTomorrowAction,
              icon: Icons.event_rounded,
              onPressed: onViewTomorrow,
            ),
            const SizedBox(height: AppSpacing.smd),
            SecondaryButton(label: l10n.doneAction, onPressed: onDone),
            if (onUndo != null) ...[
              const SizedBox(height: AppSpacing.sm),
              TertiaryButton(
                label: l10n.undoAction,
                icon: Icons.undo_rounded,
                onPressed: onUndo,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
