import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../services/providers.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final settings = ref.watch(appSettingsProvider);

    return MaybesitterScaffold(
      appBar: const MaybesitterAppBar(
        title: 'Settings',
        subtitle: 'App preferences & account',
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
              child: Column(
                children: [
                  ListTile(
                    leading: Icon(Icons.palette_outlined, color: colors.brandPrimary),
                    title: const Text('Appearance'),
                    subtitle: Text('Theme: ${settings.themeMode.name.toUpperCase()}'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push('/settings/appearance'),
                  ),
                  const Divider(),
                  ListTile(
                    leading: Icon(Icons.notifications_none, color: colors.brandPrimary),
                    title: const Text('Notifications'),
                    subtitle: Text(
                      settings.notificationsEnabled ? 'Enabled' : 'Disabled',
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push('/settings/notifications'),
                  ),
                  const Divider(),
                  ListTile(
                    leading: Icon(Icons.privacy_tip_outlined, color: colors.brandPrimary),
                    title: const Text('Privacy & Data'),
                    subtitle: const Text('Local data & telemetry control'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push('/settings/privacy'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              'Maybesitter Mobile v1.0.0 (Build 1)',
              style: TextStyle(
                fontSize: 12,
                color: colors.textMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
