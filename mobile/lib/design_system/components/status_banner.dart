import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/colors.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

enum StatusBannerTone { info, success, warning, danger }

/// Inline banner for errors, confirmations and advisory notes.
///
/// Colour alone never carries the meaning — each tone also has its own icon.
class StatusBanner extends StatelessWidget {
  final String message;
  final String? title;
  final StatusBannerTone tone;
  final IconData? icon;
  final Widget? action;

  const StatusBanner({
    super.key,
    required this.message,
    this.title,
    this.tone = StatusBannerTone.info,
    this.icon,
    this.action,
  });

  Color _foreground(SemanticColors colors) {
    switch (tone) {
      case StatusBannerTone.info:
        return colors.brandStrong;
      case StatusBannerTone.success:
        return colors.success;
      case StatusBannerTone.warning:
        return colors.warning;
      case StatusBannerTone.danger:
        return colors.danger;
    }
  }

  Color _background(SemanticColors colors) {
    switch (tone) {
      case StatusBannerTone.info:
        return colors.brandSubtle;
      case StatusBannerTone.success:
        return colors.successSubtle;
      case StatusBannerTone.warning:
        return colors.warningSubtle;
      case StatusBannerTone.danger:
        return colors.dangerSubtle;
    }
  }

  IconData get _defaultIcon {
    switch (tone) {
      case StatusBannerTone.info:
        return Icons.info_outline_rounded;
      case StatusBannerTone.success:
        return Icons.check_circle_outline_rounded;
      case StatusBannerTone.warning:
        return Icons.warning_amber_rounded;
      case StatusBannerTone.danger:
        return Icons.error_outline_rounded;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fg = _foreground(colors);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.smd + 2),
      decoration: BoxDecoration(
        color: _background(colors),
        borderRadius: AppRadius.cardInner,
        border: Border.all(color: fg.withValues(alpha: 0.22)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon ?? _defaultIcon, size: 20, color: fg),
          const SizedBox(width: AppSpacing.smd),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (title != null) ...[
                  Text(
                    title!,
                    style: context.text.cardTitle.copyWith(
                      fontSize: 14,
                      color: fg,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                ],
                Text(
                  message,
                  style: context.text.supporting.copyWith(
                    color: colors.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          if (action != null) ...[
            const SizedBox(width: AppSpacing.sm),
            action!,
          ],
        ],
      ),
    );
  }
}
