import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/permission_education_card.dart';
import '../../design_system/tokens/spacing.dart';
import '../../services/providers.dart';

class NotificationsPermissionScreen extends ConsumerWidget {
  const NotificationsPermissionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(appSettingsProvider.notifier);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: 'Notifications',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: PermissionEducationCard(
          onRequestPermission: () async {
            final service = ref.read(notificationServiceProvider);
            await service.requestPermission();
            notifier.toggleNotifications(true);
            if (context.mounted) Navigator.pop(context);
          },
          onSkip: () => Navigator.pop(context),
        ),
      ),
    );
  }
}
