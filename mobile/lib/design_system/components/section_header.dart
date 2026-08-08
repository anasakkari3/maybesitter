import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// The header that opens a grouped list section.
///
/// Optional [accent] paints a short bar before the title so priority groups
/// are scannable without reading the label.
class SectionHeader extends StatelessWidget {
  final String title;
  final String? trailingLabel;
  final Color? accent;
  final Widget? action;
  final EdgeInsetsGeometry padding;

  const SectionHeader({
    super.key,
    required this.title,
    this.trailingLabel,
    this.accent,
    this.action,
    this.padding = const EdgeInsets.fromLTRB(
      AppSpacing.gutter,
      AppSpacing.lg,
      AppSpacing.gutter,
      AppSpacing.smd,
    ),
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Padding(
      padding: padding,
      child: Row(
        children: [
          if (accent != null) ...[
            Container(
              width: 4,
              height: 18,
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(AppRadius.xs),
              ),
            ),
            const SizedBox(width: AppSpacing.sm + 2),
          ],
          Expanded(
            child: Text(
              title,
              style: context.text.sectionTitle,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (trailingLabel != null) ...[
            const SizedBox(width: AppSpacing.sm),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.sm + 2,
                vertical: AppSpacing.xs,
              ),
              decoration: BoxDecoration(
                color: colors.surfaceMuted,
                borderRadius: AppRadius.chip,
              ),
              child: Text(
                trailingLabel!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.text.caption,
              ),
            ),
          ],
          if (action != null) ...[
            const SizedBox(width: AppSpacing.sm),
            action!,
          ],
        ],
      ),
    );
  }
}
