import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/empty_state.dart';
import '../../design_system/components/error_state.dart';
import '../../design_system/components/extraction_review_card.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/capture_result.dart';
import 'capture_controller.dart';

class ExtractionReviewScreen extends ConsumerWidget {
  const ExtractionReviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final l10n = context.l10n;
    final captureState = ref.watch(captureControllerProvider);
    final notifier = ref.read(captureControllerProvider.notifier);

    if (captureState.status == CaptureStatus.extractionFailed) {
      return MaybesitterScaffold(
        appBar: AppBar(title: Text(l10n.extractionErrorTitle)),
        body: ErrorState(
          title: l10n.extractionErrorTitle,
          message: captureState.errorMessage ?? l10n.extractionErrorMessage,
          onRetry: () {
            notifier.submitIntent(captureState.rawInput);
          },
        ),
      );
    }

    if (captureState.status == CaptureStatus.unsupportedRequest) {
      return MaybesitterScaffold(
        appBar: AppBar(title: Text(l10n.unsupportedRequestTitle)),
        body: ErrorState(
          title: l10n.unsupportedRequestTitle,
          message: captureState.errorMessage ?? l10n.unsupportedRequestMessage,
          onRetry: () => context.pop(),
        ),
      );
    }

    if (captureState.status == CaptureStatus.noCommitment) {
      return MaybesitterScaffold(
        appBar: AppBar(title: Text(l10n.noCommitmentTitle)),
        body: EmptyState(
          icon: Icons.search_off,
          title: l10n.noCommitmentTitle,
          description: l10n.noCommitmentDescription,
          analysisNote: captureState.analysisNote,
          actionLabel: l10n.retryAction,
          onAction: () => context.pop(),
          secondaryActionLabel: l10n.cancelAction,
          onSecondaryAction: () {
            notifier.reset();
            context.go('/today');
          },
        ),
      );
    }

    final selectedCount = captureState.selectedItemIds.length;
    final isConfirming = captureState.status == CaptureStatus.confirming;
    final isPartiallySaved =
        captureState.status == CaptureStatus.partiallySaved;

    return MaybesitterScaffold(
      appBar: AppBar(
        title: Text(l10n.reviewPlanTitle),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            tooltip: l10n.closeAction,
            onPressed: () {
              notifier.reset();
              context.go('/today');
            },
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Notice: Proposed items are not yet saved
            Container(
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(
                color: colors.brandSecondary.withValues(alpha: 0.15),
                borderRadius: AppRadius.card,
                border: Border.all(
                  color: colors.brandSecondary.withValues(alpha: 0.4),
                ),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.info_outline,
                    color: colors.brandSecondary,
                    size: 20,
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      'These items are proposed. Select and review before saving.',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                        color: colors.textPrimary,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            if (isPartiallySaved) ...[
              const SizedBox(height: AppSpacing.md),
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: colors.warning.withValues(alpha: 0.15),
                  borderRadius: AppRadius.card,
                  border: Border.all(color: colors.warning),
                ),
                child: Row(
                  children: [
                    Icon(Icons.warning_amber_rounded, color: colors.warning),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Text(
                        captureState.errorMessage ??
                            'Saved ${captureState.persistedItemIds.length} item(s). Some items failed to save.',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: colors.warning,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            if (captureState.status == CaptureStatus.saveFailed) ...[
              const SizedBox(height: AppSpacing.md),
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: colors.destructive.withValues(alpha: 0.15),
                  borderRadius: AppRadius.card,
                  border: Border.all(color: colors.destructive),
                ),
                child: Row(
                  children: [
                    Icon(Icons.error_outline, color: colors.destructive),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Text(
                        captureState.errorMessage ?? l10n.confirmFailedMessage,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: colors.destructive,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: AppSpacing.lg),

            Text(
              l10n.proposedCommitmentsCount(
                captureState.extractedCommitments.length,
              ),
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: colors.textPrimary,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),

            // Extracted Commitments List
            Column(
              children: captureState.extractedCommitments.map((item) {
                final isSelected = captureState.selectedItemIds.contains(
                  item.id,
                );
                return ExtractionReviewCard(
                  commitment: item,
                  isSelected: isSelected,
                  onToggleSelect: (val) =>
                      notifier.toggleItemSelection(item.id),
                  onRemove: () => notifier.removeCommitment(item.id),
                  onEdit: () {
                    final editController = TextEditingController(
                      text: item.title,
                    );
                    showDialog(
                      context: context,
                      builder: (ctx) {
                        return AlertDialog(
                          title: Text(l10n.editCommitmentTitle),
                          content: TextField(
                            controller: editController,
                            decoration: InputDecoration(
                              labelText: l10n.commitmentDetailTitle,
                            ),
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(ctx),
                              child: Text(l10n.cancelAction),
                            ),
                            ElevatedButton(
                              onPressed: () {
                                notifier.updateCommitment(
                                  item.copyWith(
                                    title: editController.text,
                                    needsClarification: false,
                                  ),
                                );
                                Navigator.pop(ctx);
                              },
                              child: Text(l10n.saveAction),
                            ),
                          ],
                        );
                      },
                    );
                  },
                );
              }).toList(),
            ),

            const SizedBox(height: AppSpacing.xl),

            // Confirm Action
            PrimaryButton(
              label: l10n.confirmCommitmentsAction(selectedCount),
              icon: Icons.check_circle_outline,
              isLoading: isConfirming,
              onPressed: (selectedCount == 0 || isConfirming)
                  ? null
                  : () async {
                      final success = await notifier.confirmSave();
                      if (success && context.mounted) {
                        context.push('/capture/success');
                      }
                    },
            ),

            const SizedBox(height: AppSpacing.sm),

            SecondaryButton(
              label: l10n.cancelPlanAction,
              onPressed: () {
                notifier.reset();
                context.go('/today');
              },
            ),
          ],
        ),
      ),
    );
  }
}
