import 'package:flutter/material.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'maybesitter_buttons.dart';

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
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(AppSpacing.lg),
            decoration: BoxDecoration(
              color: colors.success.withValues(alpha: 0.15),
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.check_circle_outline,
              size: 54,
              color: colors.success,
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          Text(
            title,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: colors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            subtitle,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: colors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.lg),
          // List of saved commitments preview
          Column(
            children: savedCommitments.map((c) {
              return Container(
                margin: const EdgeInsets.only(bottom: AppSpacing.sm),
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: colors.surface,
                  borderRadius: AppRadius.card,
                  border: Border.all(color: colors.border),
                ),
                child: Row(
                  children: [
                    Icon(
                      c.category == 'Health'
                          ? Icons.medical_services_outlined
                          : Icons.work_outline,
                      color: colors.brandPrimary,
                      size: 20,
                    ),
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            c.title,
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: colors.textPrimary,
                            ),
                          ),
                          Text(
                            '${l10n.tomorrowGroupHeader}, ${c.startTime ?? "Full day"}',
                            style: TextStyle(
                              fontSize: 12,
                              color: colors.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      c.priority.localizedName(l10n),
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        color: colors.textMuted,
                      ),
                    ),
                  ],
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: AppSpacing.lg),
          PrimaryButton(
            label: l10n.viewTomorrowAction,
            icon: Icons.event,
            onPressed: onViewTomorrow,
          ),
          const SizedBox(height: AppSpacing.sm),
          SecondaryButton(label: l10n.doneAction, onPressed: onDone),
          if (onUndo != null) ...[
            const SizedBox(height: AppSpacing.sm),
            TextButton(
              onPressed: onUndo,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.undo, size: 16, color: colors.textSecondary),
                  const SizedBox(width: AppSpacing.xs),
                  Text(
                    l10n.undoAction,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: colors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
