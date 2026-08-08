import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// A labelled metadata row: icon tile, field label, value.
///
/// Used on the commitment details screen so date, time, timezone, location and
/// category all read as one consistent block.
class MetadataTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color? tint;
  final VoidCallback? onTap;

  const MetadataTile({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
    this.tint,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final accent = tint ?? colors.brandStrong;

    return InkWell(
      onTap: onTap,
      borderRadius: AppRadius.cardInner,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.smd + 2,
        ),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(AppRadius.sm),
              ),
              child: Icon(icon, size: 19, color: accent),
            ),
            const SizedBox(width: AppSpacing.smd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(label, style: context.text.caption),
                  const SizedBox(height: 2),
                  Text(
                    value,
                    style: context.text.cardTitle.copyWith(fontSize: 15),
                  ),
                ],
              ),
            ),
            if (onTap != null)
              Icon(
                Icons.chevron_right_rounded,
                size: 20,
                color: colors.textMuted,
              ),
          ],
        ),
      ),
    );
  }
}

/// Groups tiles into one rounded card with hairline separators.
class TileGroup extends StatelessWidget {
  final List<Widget> children;

  const TileGroup({super.key, required this.children});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final separated = <Widget>[];

    for (var i = 0; i < children.length; i++) {
      separated.add(children[i]);
      if (i != children.length - 1) {
        separated.add(
          Padding(
            padding: const EdgeInsets.only(
              left: AppSpacing.md + 38 + AppSpacing.smd,
            ),
            child: Divider(height: 1, color: colors.border),
          ),
        );
      }
    }

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
      ),
      child: Column(children: separated),
    );
  }
}

/// A navigational settings row: icon tile, title, supporting value, chevron.
class SettingsTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final Widget? trailing;
  final Color? tint;

  const SettingsTile({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.onTap,
    this.trailing,
    this.tint,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final accent = tint ?? colors.brandStrong;

    return InkWell(
      onTap: onTap,
      borderRadius: AppRadius.cardInner,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.smd + 2,
        ),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(AppRadius.sm),
              ),
              child: Icon(icon, size: 19, color: accent),
            ),
            const SizedBox(width: AppSpacing.smd),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: context.text.cardTitle.copyWith(fontSize: 15),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle!, style: context.text.caption),
                  ],
                ],
              ),
            ),
            if (trailing != null) trailing!,
            if (trailing == null && onTap != null)
              Icon(
                Icons.chevron_right_rounded,
                size: 20,
                color: colors.textMuted,
              ),
          ],
        ),
      ),
    );
  }
}
