import 'package:flutter/material.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
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
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(AppSpacing.lg),
            decoration: BoxDecoration(
              color: colors.brandPrimary.withValues(alpha: 0.15),
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.notifications_active_outlined,
              size: 40,
              color: colors.brandPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          Text(
            l10n.notificationsTitle,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              color: colors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            l10n.notificationsSubtitle,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14,
              color: colors.textSecondary,
              height: 1.4,
            ),
          ),
          const SizedBox(height: AppSpacing.xl),
          PrimaryButton(
            label: l10n.notificationsEnabled,
            icon: Icons.check,
            onPressed: onRequestPermission,
          ),
          if (onSkip != null) ...[
            const SizedBox(height: AppSpacing.sm),
            TextButton(
              onPressed: onSkip,
              child: Text(
                l10n.skipAction,
                style: TextStyle(fontSize: 14, color: colors.textMuted),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
