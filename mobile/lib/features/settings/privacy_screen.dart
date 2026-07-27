import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/utilities/l10n_extensions.dart';
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
    final l10n = context.l10n;
    final settings = ref.watch(appSettingsProvider);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.privacyTitle,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: l10n.backAction,
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MaybesitterSwitch(
              label: l10n.encryptionLabel,
              value: true,
              onChanged: (_) {},
            ),
            const SizedBox(height: AppSpacing.md),
            MaybesitterSwitch(
              label: l10n.analyticsLabel,
              value: settings.analyticsOptOut,
              onChanged: (_) {},
            ),
            const SizedBox(height: AppSpacing.xxl),
            DestructiveButton(
              label: l10n.deleteAllDataAction,
              icon: Icons.delete_forever,
              onPressed: () async {
                final confirm = await MaybesitterDialog.show(
                  context: context,
                  title: l10n.deleteAllDataTitle,
                  message: l10n.deleteAllDataMessage,
                  confirmLabel: l10n.deleteAllDataAction,
                  isDestructive: true,
                );
                if (confirm == true && context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(l10n.dataClearedMessage)),
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
