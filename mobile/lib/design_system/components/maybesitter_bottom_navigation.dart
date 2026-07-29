import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/motion.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

class _NavItem {
  final IconData icon;
  final IconData activeIcon;
  final String label;
  const _NavItem(this.icon, this.activeIcon, this.label);
}

/// Built per-frame so destination labels follow the active locale.
List<_NavItem> _navItems(BuildContext context) {
  final l10n = context.l10n;
  return [
    _NavItem(Icons.wb_sunny_outlined, Icons.wb_sunny_rounded, l10n.todayTab),
    _NavItem(
      Icons.calendar_month_outlined,
      Icons.calendar_month_rounded,
      l10n.upcomingTab,
    ),
    _NavItem(Icons.history_rounded, Icons.history_rounded, l10n.activityTab),
    _NavItem(Icons.settings_outlined, Icons.settings_rounded, l10n.settingsTab),
  ];
}

/// Bottom navigation shelf.
///
/// A soft surface that floats above the canvas, with a tinted pill behind the
/// active destination instead of Material's default underline.
class MaybesitterBottomNavigation extends StatelessWidget {
  final int currentIndex;
  final ValueChanged<int> onTap;

  const MaybesitterBottomNavigation({
    super.key,
    required this.currentIndex,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final items = _navItems(context);

    return Container(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.border)),
        boxShadow: AppElevation.bar(colors),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.sm,
            vertical: AppSpacing.sm,
          ),
          child: Row(
            children: List.generate(items.length, (index) {
              final item = items[index];
              final selected = index == currentIndex;

              return Expanded(
                child: Semantics(
                  button: true,
                  selected: selected,
                  label: item.label,
                  child: InkWell(
                    onTap: () => onTap(index),
                    borderRadius: AppRadius.chip,
                    child: AnimatedContainer(
                      duration: AppMotion.fast,
                      curve: AppMotion.decelerate,
                      constraints: const BoxConstraints(
                        minHeight: AppSpacing.minTouchTarget,
                      ),
                      padding: const EdgeInsets.symmetric(
                        vertical: AppSpacing.sm,
                      ),
                      decoration: BoxDecoration(
                        color: selected
                            ? colors.brandSubtle
                            : Colors.transparent,
                        borderRadius: AppRadius.chip,
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            selected ? item.activeIcon : item.icon,
                            size: 22,
                            color: selected
                                ? colors.brandStrong
                                : colors.textMuted,
                          ),
                          const SizedBox(height: AppSpacing.xs),
                          Text(
                            item.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: context.text.caption.copyWith(
                              color: selected
                                  ? colors.brandStrong
                                  : colors.textMuted,
                              fontWeight: selected
                                  ? FontWeight.w600
                                  : FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    );
  }
}
