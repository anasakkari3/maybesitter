import 'package:flutter/material.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/spacing.dart';

class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final l10n = context.l10n;

    return Container(
      width: double.infinity,
      color: colors.warning.withValues(alpha: 0.2),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.xs,
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.wifi_off, size: 16, color: colors.warning),
          const SizedBox(width: AppSpacing.sm),
          Text(
            l10n.offlineBannerText,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: colors.warning,
            ),
          ),
        ],
      ),
    );
  }
}
