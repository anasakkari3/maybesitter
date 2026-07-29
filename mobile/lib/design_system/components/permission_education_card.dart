import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/gradients.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'maybesitter_buttons.dart';

class PermissionEducationCard extends StatelessWidget {
  final VoidCallback onRequestPermission;
  final VoidCallback? onSkip;

  const PermissionEducationCard({
    super.key,
    required this.onRequestPermission,
    this.onSkip,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final l10n = context.l10n;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
        boxShadow: AppElevation.card(colors),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 88,
            height: 88,
            decoration: BoxDecoration(
              gradient: AppGradients.brandWash(colors),
              borderRadius: BorderRadius.circular(AppRadius.xxxl),
              border: Border.all(
                color: colors.brandPrimary.withValues(alpha: 0.18),
              ),
            ),
            child: Icon(
              Icons.notifications_active_outlined,
              size: 38,
              color: colors.brandStrong,
            ),
          ),
          const SizedBox(height: AppSpacing.mdl),
          Text(
            l10n.notificationsTitle,
            textAlign: TextAlign.center,
            style: context.text.heading2,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            l10n.notificationsSubtitle,
            textAlign: TextAlign.center,
            style: context.text.supporting,
          ),
          const SizedBox(height: AppSpacing.lg),
          PrimaryButton(
            label: l10n.notificationsEnabled,
            icon: Icons.check_rounded,
            onPressed: onRequestPermission,
          ),
          if (onSkip != null) ...[
            const SizedBox(height: AppSpacing.sm),
            TertiaryButton(label: l10n.skipAction, onPressed: onSkip),
          ],
        ],
      ),
    );
  }
}
