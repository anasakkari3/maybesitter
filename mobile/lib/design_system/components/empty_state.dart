import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/gradients.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'maybesitter_buttons.dart';
import 'status_banner.dart';

/// Friendly empty state — a soft brand-washed illustration tile, a warm
/// headline, and at most one obvious next step.
class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String description;
  final String? actionLabel;
  final VoidCallback? onAction;
  final String? secondaryActionLabel;
  final VoidCallback? onSecondaryAction;
  final String? analysisNote;

  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.description,
    this.actionLabel,
    this.onAction,
    this.secondaryActionLabel,
    this.onSecondaryAction,
    this.analysisNote,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.xl,
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 104,
                height: 104,
                decoration: BoxDecoration(
                  gradient: AppGradients.brandWash(colors),
                  borderRadius: BorderRadius.circular(AppRadius.xxxl),
                  border: Border.all(
                    color: colors.brandPrimary.withValues(alpha: 0.18),
                  ),
                ),
                child: Icon(icon, size: 44, color: colors.brandStrong),
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                title,
                textAlign: TextAlign.center,
                style: context.text.heading2,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                description,
                textAlign: TextAlign.center,
                style: context.text.supporting,
              ),
              if (analysisNote != null) ...[
                const SizedBox(height: AppSpacing.mdl),
                StatusBanner(message: analysisNote!),
              ],
              if (actionLabel != null) ...[
                const SizedBox(height: AppSpacing.xl),
                PrimaryButton(
                  label: actionLabel!,
                  onPressed: onAction,
                  isFullWidth: false,
                ),
              ],
              if (secondaryActionLabel != null) ...[
                const SizedBox(height: AppSpacing.smd),
                TertiaryButton(
                  label: secondaryActionLabel!,
                  onPressed: onSecondaryAction,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
