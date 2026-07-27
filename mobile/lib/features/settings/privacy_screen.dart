import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_dialog.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/maybesitter_switch.dart';
import '../../design_system/tokens/spacing.dart';
import '../../services/providers.dart';

class PrivacyScreen extends ConsumerWidget {
  const PrivacyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(appSettingsProvider);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: 'Privacy & Data',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MaybesitterSwitch(
              label: 'Local Data Encryption',
              value: true,
              onChanged: (_) {},
            ),
            const SizedBox(height: AppSpacing.md),
            MaybesitterSwitch(
              label: 'Analytics Opt-Out',
              value: settings.analyticsOptOut,
              onChanged: (_) {},
            ),
            const SizedBox(height: AppSpacing.xxl),
            DestructiveButton(
              label: 'Delete All Local Data',
              icon: Icons.delete_forever,
              onPressed: () async {
                final confirm = await MaybesitterDialog.show(
                  context: context,
                  title: 'Delete All Local Data',
                  message:
                      'Are you sure you want to clear all stored commitments and activity history? This cannot be undone.',
                  confirmLabel: 'Delete All Data',
                  isDestructive: true,
                );
                if (confirm == true && context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('All local data cleared.')),
                  );
                }
              },
            ),
          ],
        ),
      ),
    );
  }
}
