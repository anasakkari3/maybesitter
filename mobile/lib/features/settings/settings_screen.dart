import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/app_settings.dart';
import '../../services/providers.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final l10n = context.l10n;
    final settings = ref.watch(appSettingsProvider);
    final settingsNotifier = ref.read(appSettingsProvider.notifier);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.settingsTitle,
        subtitle: l10n.settingsSubtitle,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          children: [
            Container(
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: AppRadius.card,
                border: Border.all(color: colors.border),
              ),
              child: Material(
                color: Colors.transparent,
                borderRadius: AppRadius.card,
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: [
                    ListTile(
                      leading: Icon(
                        Icons.palette_outlined,
                        color: colors.brandPrimary,
                      ),
                      title: Text(l10n.appearanceTitle),
                      subtitle: Text(
                        '${l10n.appearanceSubtitle} (${settings.themeMode.name.toUpperCase()})',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.push('/settings/appearance'),
                    ),
                    const Divider(),
                    ListTile(
                      leading: Icon(
                        Icons.language_outlined,
                        color: colors.brandPrimary,
                      ),
                      title: Text(l10n.languageTitle),
                      subtitle: Text(settings.localeOption.label),
                      trailing: DropdownButton<AppLocaleOption>(
                        value: settings.localeOption,
                        underline: const SizedBox(),
                        onChanged: (newOpt) {
                          if (newOpt != null) {
                            settingsNotifier.updateLocale(newOpt);
                          }
                        },
                        items: AppLocaleOption.values.map((opt) {
                          return DropdownMenuItem(
                            value: opt,
                            child: Text(opt.label),
                          );
                        }).toList(),
                      ),
                    ),
                    const Divider(),
                    ListTile(
                      leading: Icon(
                        Icons.notifications_none,
                        color: colors.brandPrimary,
                      ),
                      title: Text(l10n.notificationsTitle),
                      subtitle: Text(
                        settings.notificationsEnabled
                            ? l10n.notificationsEnabled
                            : l10n.notificationsDisabled,
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.push('/settings/notifications'),
                    ),
                    const Divider(),
                    ListTile(
                      leading: Icon(
                        Icons.privacy_tip_outlined,
                        color: colors.brandPrimary,
                      ),
                      title: Text(l10n.privacyTitle),
                      subtitle: Text(l10n.privacySubtitle),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.push('/settings/privacy'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              'Maybesitter Mobile v1.0.0 (Build 1)',
              style: context.text.caption.copyWith(color: colors.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}
