import 'package:flutter/material.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';

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
    final l10n = context.l10n;

    return BottomNavigationBar(
      currentIndex: currentIndex,
      onTap: onTap,
      backgroundColor: colors.surfaceMuted,
      selectedItemColor: colors.brandPrimary,
      unselectedItemColor: colors.textMuted,
      type: BottomNavigationBarType.fixed,
      items: [
        BottomNavigationBarItem(
          icon: const Icon(Icons.today_outlined),
          activeIcon: const Icon(Icons.today),
          label: l10n.todayTab,
        ),
        BottomNavigationBarItem(
          icon: const Icon(Icons.calendar_month_outlined),
          activeIcon: const Icon(Icons.calendar_month),
          label: l10n.upcomingTab,
        ),
        BottomNavigationBarItem(
          icon: const Icon(Icons.history_outlined),
          activeIcon: const Icon(Icons.history),
          label: l10n.activityTab,
        ),
        BottomNavigationBarItem(
          icon: const Icon(Icons.settings_outlined),
          activeIcon: const Icon(Icons.settings),
          label: l10n.settingsTab,
        ),
      ],
    );
  }
}
