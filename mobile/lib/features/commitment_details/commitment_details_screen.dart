import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/date_formatter.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/adaptive/adaptive_action_sheet.dart';
import '../../design_system/adaptive/adaptive_dialog.dart';
import '../../design_system/adaptive/adaptive_haptics.dart';
import '../../design_system/adaptive/app_icons.dart';
import '../../design_system/components/commitment_status_badge.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/maybesitter_text_field.dart';
import '../../design_system/components/priority_badge.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/commitment.dart';
import '../../services/providers.dart';
import '../reminders/postpone_sheet.dart';

class CommitmentDetailsScreen extends ConsumerWidget {
  final String id;

  const CommitmentDetailsScreen({super.key, required this.id});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final l10n = context.l10n;
    final icons = AppIcons.of(context);
    final localeCode = context.currentLanguageCode;
    final config = ref.watch(appConfigProvider);
    final commitments = ref.watch(commitmentsStreamProvider).value ?? [];

    Commitment? commitment;
    try {
      commitment = commitments.firstWhere((c) => c.id == id);
    } catch (_) {
      commitment = null;
    }

    if (commitment == null) {
      return MaybesitterScaffold(
        appBar: AppBar(title: Text(l10n.noCommitmentTitle)),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(l10n.noCommitmentDescription),
              const SizedBox(height: AppSpacing.md),
              PrimaryButton(
                label: l10n.todayTab,
                isFullWidth: false,
                onPressed: () => context.go('/today'),
              ),
            ],
          ),
        ),
      );
    }

    final isDone = commitment.status.isCompleted;

    Future<void> toggleComplete() async {
      AdaptiveHaptics.completion();
      if (isDone) {
        await ref
            .read(commitmentRepositoryProvider)
            .update(commitment!.copyWith(status: CommitmentStatus.pending));
      } else {
        await ref.read(commitmentRepositoryProvider).complete(id);
      }
    }

    Future<void> postpone() async {
      // Measured from where the commitment already sits, not from now — see
      // `postponeOptionsFor`.
      final newDate = await PostponeSheet.show(
        context,
        scheduledAt: commitment!.scheduledDate,
      );
      if (newDate != null) {
        await ref.read(commitmentRepositoryProvider).postpone(id, newDate);
      }
    }

    Future<void> editTitle() async {
      final editController = TextEditingController(text: commitment!.title);
      final newTitle = await showDialog<String>(
        context: context,
        builder: (ctx) {
          return AlertDialog(
            title: Text(l10n.editCommitmentTitle),
            content: MaybesitterTextField(
              controller: editController,
              label: l10n.commitmentDetailTitle,
              autofocus: true,
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: Text(l10n.cancelAction),
              ),
              ElevatedButton(
                onPressed: () => Navigator.pop(ctx, editController.text),
                child: Text(l10n.saveAction),
              ),
            ],
          );
        },
      );
      final trimmed = newTitle?.trim();
      if (trimmed != null && trimmed.isNotEmpty) {
        await ref
            .read(commitmentRepositoryProvider)
            .update(commitment!.copyWith(title: trimmed));
      }
    }

    Future<void> confirmDelete() async {
      // Platform-idiomatic and non-dismissible: deleting must be an explicit
      // answer, not a stray tap on the barrier.
      final confirm = await AdaptiveAppDialog.confirm(
        context: context,
        title: l10n.deleteConfirmationTitle,
        message: l10n.deleteConfirmationMessage(commitment!.title),
        confirmLabel: l10n.deleteAction,
        isDestructive: true,
      );
      if (confirm == true) {
        await ref.read(commitmentRepositoryProvider).delete(id);
        if (context.mounted) context.pop();
      }
    }

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.commitmentDetailTitle,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: l10n.backAction,
          onPressed: () => context.pop(),
        ),
        actions: [
          IconButton(
            icon: Icon(
              Icons.edit_outlined,
              color: config.supportsSafeCommitmentPatch
                  ? colors.textPrimary
                  : colors.textMuted.withValues(alpha: 0.5),
            ),
            tooltip: config.supportsSafeCommitmentPatch
                ? 'Edit'
                : l10n.editingDisabledExplanation,
            onPressed: () {
              if (config.supportsSafeCommitmentPatch) {
                editTitle();
              } else {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(l10n.editingDisabledExplanation),
                    duration: const Duration(seconds: 3),
                  ),
                );
              }
            },
          ),
          IconButton(
            icon: Icon(icons.more),
            color: colors.textSecondary,
            tooltip: l10n.moreActionsLabel,
            onPressed: () async {
              final choice = await AdaptiveActionSheet.show<String>(
                context: context,
                title: commitment!.title,
                actions: [
                  AdaptiveAction(
                    value: 'complete',
                    label: isDone
                        ? l10n.markPendingAction
                        : l10n.markCompleteAction,
                    icon: icons.complete,
                  ),
                  AdaptiveAction(
                    value: 'postpone',
                    label: l10n.postponeAction,
                    icon: icons.postpone,
                  ),
                  AdaptiveAction(
                    value: 'delete',
                    label: l10n.deleteAction,
                    icon: icons.delete,
                    isDestructive: true,
                  ),
                ],
              );
              switch (choice) {
                case 'complete':
                  await toggleComplete();
                case 'postpone':
                  await postpone();
                case 'delete':
                  await confirmDelete();
              }
            },
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Status & Priority Row
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                PriorityBadge(priority: commitment.priority),
                CommitmentStatusBadge(status: commitment.status),
              ],
            ),
            const SizedBox(height: AppSpacing.md),

            // Title Card
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.lg),
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: AppRadius.card,
                border: Border.all(color: colors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    commitment.title,
                    style: context.text.heading1.copyWith(
                      decoration: isDone ? TextDecoration.lineThrough : null,
                    ),
                  ),
                  if (commitment.description != null &&
                      commitment.description!.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.md),
                    Text(
                      commitment.description!,
                      style: context.text.supporting.copyWith(height: 1.5),
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(height: AppSpacing.lg),

            // Details List
            Container(
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: AppRadius.card,
                border: Border.all(color: colors.border),
              ),
              child: Column(
                children: [
                  ListTile(
                    leading: Icon(
                      Icons.calendar_today,
                      color: colors.brandPrimary,
                    ),
                    title: Text(l10n.scheduledDateLabel),
                    subtitle: Text(
                      DateFormatter.formatFullDate(
                        commitment.scheduledDate,
                        locale: localeCode,
                      ),
                    ),
                  ),
                  const Divider(),
                  ListTile(
                    leading: Icon(Icons.schedule, color: colors.brandPrimary),
                    title: Text(l10n.timeLabel),
                    subtitle: Text(
                      DateFormatter.formatTimeRange(
                        commitment.startTime,
                        commitment.endTime,
                      ),
                    ),
                  ),
                  if (commitment.location != null) ...[
                    const Divider(),
                    ListTile(
                      leading: Icon(
                        Icons.location_on,
                        color: colors.brandPrimary,
                      ),
                      title: Text(l10n.locationLabel),
                      subtitle: Text(commitment.location!),
                    ),
                  ],
                  if (commitment.category != null) ...[
                    const Divider(),
                    ListTile(
                      leading: Icon(Icons.category, color: colors.brandPrimary),
                      title: Text(l10n.categoryLabel),
                      subtitle: Text(commitment.category!),
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(height: AppSpacing.xl),

            // Main Actions
            PrimaryButton(
              label: isDone ? l10n.markPendingAction : l10n.markCompleteAction,
              icon: isDone ? Icons.undo : Icons.check_circle_outline,
              onPressed: toggleComplete,
            ),
            const SizedBox(height: AppSpacing.sm),
            SecondaryButton(
              label: l10n.postponeAction,
              icon: Icons.schedule_send,
              onPressed: postpone,
            ),
          ],
        ),
      ),
    );
  }
}
