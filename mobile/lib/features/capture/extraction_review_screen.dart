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
            // Confidence & Raw Input Banner
            Container(
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: AppRadius.card,
                border: Border.all(color: colors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        Icons.psychology,
                        size: 20,
                        color: colors.brandPrimary,
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Flexible(
                        child: Text(
                          captureState.confidence.label,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: colors.brandPrimary,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    '"${captureState.rawInput}"',
                    style: TextStyle(
                      fontSize: 14,
                      fontStyle: FontStyle.italic,
                      color: colors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),

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
                return ExtractionReviewCard(
                  commitment: item,
                  onRemove: () => notifier.removeCommitment(item.id),
                  onEdit: () {
                    // Quick title edit modal
                    showDialog(
                      context: context,
                      builder: (ctx) {
                        final editController = TextEditingController(
                          text: item.title,
                        );
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
                                  item.copyWith(title: editController.text),
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

            // Actions
            PrimaryButton(
              label: l10n.confirmCommitmentsAction(
                captureState.extractedCommitments.length,
              ),
              icon: Icons.check_circle_outline,
              onPressed: () async {
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
