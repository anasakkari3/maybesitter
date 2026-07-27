import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

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
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return AppBar(
      leading: leading,
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (showLogo) ...[
                Icon(
                  Icons.check_circle_outline,
                  color: colors.brandPrimary,
                  size: 22,
                ),
                const SizedBox(width: 8),
              ],
              Text(
                title,
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: colors.textPrimary,
                ),
              ),
            ],
          ),
          if (subtitle != null)
            Text(
              subtitle!,
              style: TextStyle(
                fontSize: 12,
                color: colors.textMuted,
                fontWeight: FontWeight.w400,
              ),
            ),
        ],
      ),
      actions:
          actions ??
          [
            IconButton(
              icon: Icon(
                Icons.notifications_outlined,
                color: colors.textPrimary,
              ),
              onPressed: () {},
              tooltip: 'Notifications',
            ),
          ],
    );
  }
}
