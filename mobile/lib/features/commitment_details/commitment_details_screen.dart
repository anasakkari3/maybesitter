import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/date_formatter.dart';
import '../../design_system/components/commitment_status_badge.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_dialog.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
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
    final commitments = ref.watch(commitmentsStreamProvider).value ?? [];

    Commitment? commitment;
    try {
      commitment = commitments.firstWhere((c) => c.id == id);
    } catch (_) {
      commitment = null;
    }

    if (commitment == null) {
      return MaybesitterScaffold(
        appBar: AppBar(title: const Text('Not Found')),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('Commitment not found.'),
              const SizedBox(height: AppSpacing.md),
              PrimaryButton(
                label: 'Back to Today',
                isFullWidth: false,
                onPressed: () => context.go('/today'),
              ),
            ],
          ),
        ),
      );
    }

    final isDone = commitment.status.isCompleted;

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: 'Commitment Detail',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.delete_outline),
            color: colors.destructive,
            onPressed: () async {
              final confirm = await MaybesitterDialog.show(
                context: context,
                title: 'Delete Commitment',
                message:
                    'Are you sure you want to delete "${commitment!.title}"? This cannot be undone.',
                confirmLabel: 'Delete',
                isDestructive: true,
              );
              if (confirm == true) {
                await ref.read(commitmentRepositoryProvider).delete(id);
                if (context.mounted) context.pop();
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
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: colors.textPrimary,
                      decoration: isDone ? TextDecoration.lineThrough : null,
                    ),
                  ),
                  if (commitment.description != null &&
                      commitment.description!.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.md),
                    Text(
                      commitment.description!,
                      style: TextStyle(
                        fontSize: 15,
                        color: colors.textSecondary,
                        height: 1.4,
                      ),
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
                    title: const Text('Scheduled Date'),
                    subtitle: Text(
                      DateFormatter.formatFullDate(commitment.scheduledDate),
                    ),
                  ),
                  const Divider(),
                  ListTile(
                    leading: Icon(Icons.schedule, color: colors.brandPrimary),
                    title: const Text('Time'),
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
                      title: const Text('Location'),
                      subtitle: Text(commitment.location!),
                    ),
                  ],
                  if (commitment.category != null) ...[
                    const Divider(),
                    ListTile(
                      leading: Icon(Icons.category, color: colors.brandPrimary),
                      title: const Text('Category'),
                      subtitle: Text(commitment.category!),
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(height: AppSpacing.xl),

            // Main Actions
            PrimaryButton(
              label: isDone ? 'Mark as Pending' : 'Mark as Complete',
              icon: isDone ? Icons.undo : Icons.check_circle_outline,
              onPressed: () {
                if (isDone) {
                  ref
                      .read(commitmentRepositoryProvider)
                      .update(
                        commitment!.copyWith(status: CommitmentStatus.pending),
                      );
                } else {
                  ref.read(commitmentRepositoryProvider).complete(id);
                }
              },
            ),
            const SizedBox(height: AppSpacing.sm),
            SecondaryButton(
              label: 'Postpone Commitment',
              icon: Icons.schedule_send,
              onPressed: () async {
                final newDate = await PostponeSheet.show(context);
                if (newDate != null) {
                  await ref
                      .read(commitmentRepositoryProvider)
                      .postpone(id, newDate);
                }
              },
            ),
          ],
        ),
      ),
    );
  }
}
