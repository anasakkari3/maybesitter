import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/maybesitter_segmented_control.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/app_settings.dart';
import '../../services/providers.dart';

class AppearanceScreen extends ConsumerWidget {
  const AppearanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final l10n = context.l10n;
    final settings = ref.watch(appSettingsProvider);
    final notifier = ref.read(appSettingsProvider.notifier);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.appearanceTitle,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: l10n.backAction,
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l10n.themeModeLabel,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: colors.textPrimary,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            MaybesitterSegmentedControl<AppThemeMode>(
              selectedValue: settings.themeMode,
              options: {
                AppThemeMode.system: l10n.themeSystem,
                AppThemeMode.light: l10n.themeLight,
                AppThemeMode.dark: l10n.themeDark,
              },
              onSelected: (mode) => notifier.updateThemeMode(mode),
            ),
          ],
        ),
      ),
    );
  }
}
