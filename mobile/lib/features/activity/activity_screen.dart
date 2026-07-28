import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/empty_state.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/activity_event.dart';
import '../../services/providers.dart';

class ActivityScreen extends ConsumerWidget {
  const ActivityScreen({super.key});

  IconData _getEventIcon(ActivityEventType type) {
    switch (type) {
      case ActivityEventType.commitmentCreated:
        return Icons.add_circle_outline;
      case ActivityEventType.commitmentCompleted:
        return Icons.check_circle_outline;
      case ActivityEventType.commitmentPostponed:
        return Icons.schedule_send;
      case ActivityEventType.commitmentDeleted:
        return Icons.delete_outline;
      case ActivityEventType.aiCaptureExtracted:
        return Icons.auto_awesome;
      case ActivityEventType.aiClarificationResolved:
        return Icons.chat_bubble_outline;
      case ActivityEventType.permissionChanged:
        return Icons.tune;
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final l10n = context.l10n;
    final localeCode = context.currentLanguageCode;
    final config = ref.watch(appConfigProvider);
    final activityList = ref.watch(activityStreamProvider).value ?? [];

    final title = config.isLocalBackend
        ? l10n.reminderHistoryTitle
        : l10n.activityTitle;
    final subtitle = config.isLocalBackend
        ? l10n.reminderHistorySubtitle
        : l10n.activitySubtitle;

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(title: title, subtitle: subtitle),
      body: activityList.isEmpty
          ? EmptyState(
              icon: Icons.history,
              title: l10n.emptyActivityTitle,
              description: l10n.emptyActivityDescription,
            )
          : ListView.builder(
              padding: const EdgeInsets.all(AppSpacing.md),
              itemCount: activityList.length,
              itemBuilder: (context, index) {
                final event = activityList[index];
                return Container(
                  margin: const EdgeInsets.only(bottom: AppSpacing.sm),
                  padding: const EdgeInsets.all(AppSpacing.md),
                  decoration: BoxDecoration(
                    color: colors.surface,
                    borderRadius: AppRadius.card,
                    border: Border.all(color: colors.border),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.all(AppSpacing.sm),
                        decoration: BoxDecoration(
                          color: colors.brandPrimary.withValues(alpha: 0.15),
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          _getEventIcon(event.type),
                          size: 20,
                          color: colors.brandPrimary,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              event.title,
                              style: TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                                color: colors.textPrimary,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              event.description,
                              style: TextStyle(
                                fontSize: 13,
                                color: colors.textSecondary,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              DateFormat(
                                'MMM d, h:mm a',
                                localeCode,
                              ).format(event.timestamp),
                              style: TextStyle(
                                fontSize: 11,
                                color: colors.textMuted,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
    );
  }
}
