import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/gradients.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// Screen header.
///
/// Title and subtitle are stacked with real hierarchy, and the optional brand
/// mark is a small gradient tile rather than a stray icon.
class MaybesitterAppBar extends StatelessWidget implements PreferredSizeWidget {
  final String title;
  final String? subtitle;
  final List<Widget>? actions;
  final Widget? leading;
  final bool showLogo;

  const MaybesitterAppBar({
    super.key,
    required this.title,
    this.subtitle,
    this.actions,
    this.leading,
    this.showLogo = false,
  });

  @override
  Size get preferredSize => const Size.fromHeight(72);

  /// The header is a fixed-height container, so its text scale is capped.
  /// Body content keeps the user's full scale — only this strip is clamped,
  /// which keeps large-text settings from clipping the title.
  static Widget _clampedHeader({required Widget child}) {
    return MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: child);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return AppBar(
      toolbarHeight: 72,
      leading: leading,
      leadingWidth: leading == null ? null : 56,
      titleSpacing: leading == null ? AppSpacing.gutter : 0,
      backgroundColor: colors.background,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      title: MaybesitterAppBar._clampedHeader(
        child: Row(
          children: [
            if (showLogo) ...[
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  gradient: AppGradients.primary(colors),
                  borderRadius: BorderRadius.circular(AppRadius.md),
                ),
                child: const Icon(
                  Icons.bolt_rounded,
                  color: Colors.white,
                  size: 20,
                ),
              ),
              const SizedBox(width: AppSpacing.smd),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.text.heading2,
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 1),
                    Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.text.caption,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        ...?actions,
        const SizedBox(width: AppSpacing.sm),
      ],
    );
  }
}
