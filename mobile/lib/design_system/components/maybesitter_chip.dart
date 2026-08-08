import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/motion.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// Filter / selection pill.
class MaybesitterChip extends StatelessWidget {
  final String label;
  final bool isSelected;
  final VoidCallback? onTap;
  final IconData? icon;

  const MaybesitterChip({
    super.key,
    required this.label,
    this.isSelected = false,
    this.onTap,
    this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fg = isSelected ? Colors.white : colors.textSecondary;

    return Semantics(
      button: true,
      selected: isSelected,
      label: label,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: AppRadius.chip,
          child: AnimatedContainer(
            duration: AppMotion.fast,
            curve: AppMotion.decelerate,
            constraints: const BoxConstraints(minHeight: 38),
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: AppSpacing.sm,
            ),
            decoration: BoxDecoration(
              color: isSelected ? colors.brandFill : colors.surface,
              borderRadius: AppRadius.chip,
              border: Border.all(
                color: isSelected ? colors.brandFill : colors.border,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[
                  Icon(icon, size: 16, color: fg),
                  const SizedBox(width: AppSpacing.xs),
                ],
                Text(
                  label,
                  style: context.text.meta.copyWith(
                    color: fg,
                    fontWeight: isSelected ? FontWeight.w600 : FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A read-only metadata pill — date, time, timezone, category.
class MetaChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color? tint;

  const MetaChip({
    super.key,
    required this.icon,
    required this.label,
    this.tint,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final accent = tint ?? colors.textSecondary;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.smd,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceMuted,
        borderRadius: AppRadius.chip,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: accent),
          const SizedBox(width: AppSpacing.xs + 2),
          Text(
            label,
            style: context.text.meta.copyWith(
              color: accent,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}
