import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/spacing.dart';

class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Container(
      width: double.infinity,
      color: colors.warningSubtle,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.cloud_off_rounded, size: 16, color: colors.warning),
          const SizedBox(width: AppSpacing.sm),
          Flexible(
            child: Text(
              context.l10n.offlineBannerText,
              style: context.text.caption.copyWith(
                color: colors.warning,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
