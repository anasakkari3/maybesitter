import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/tokens/spacing.dart';
import '../../services/api/api_alpha_feedback_service.dart';
import '../../services/providers.dart';

/// Small "report a problem" affordance shown on the next-step card during
/// alpha dogfooding. Opens a sheet with the five feedback categories plus an
/// optional note, then POSTs to the alpha feedback endpoint.
///
/// The endpoint is disabled outside alpha (server 403s); in that case the
/// button still opens but the submit is a silent no-op with a hint snackbar.
class FeedbackFlagButton extends ConsumerWidget {
  const FeedbackFlagButton({super.key, required this.proposalId});

  final String proposalId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return TextButton.icon(
      onPressed: () => _openFlagSheet(context, ref),
      icon: const Icon(Icons.report_outlined, size: 16),
      label: Text(l10n.alphaFlagTooltip),
    );
  }

  Future<void> _openFlagSheet(BuildContext context, WidgetRef ref) async {
    final l10n = context.l10n;
    final service = ref.read(alphaFeedbackServiceProvider);
    final selectedCategory = ValueNotifier<String?>(null);
    final noteController = TextEditingController();

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) {
        return Padding(
          padding: EdgeInsets.only(
            left: AppSpacing.lg,
            right: AppSpacing.lg,
            top: AppSpacing.xs,
            bottom: MediaQuery.of(sheetContext).viewInsets.bottom + AppSpacing.lg,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(l10n.alphaFlagTitle, style: Theme.of(sheetContext).textTheme.titleMedium),
              const SizedBox(height: AppSpacing.md),
              RadioGroup<String>(
                groupValue: selectedCategory.value,
                onChanged: (value) => selectedCategory.value = value,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final category in ApiAlphaFeedbackService.categories)
                      RadioListTile<String>(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        title: Text(_categoryLabel(l10n, category)),
                        value: category,
                      ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              TextField(
                controller: noteController,
                maxLength: 500,
                maxLines: 2,
                decoration: InputDecoration(
                  labelText: l10n.alphaFlagNoteHint,
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () async {
                    final category = selectedCategory.value;
                    if (category == null) {
                      ScaffoldMessenger.of(sheetContext).showSnackBar(
                        SnackBar(content: Text(l10n.alphaFlagPickCategory)),
                      );
                      return;
                    }
                    final recorded = await service.flag(
                      proposalId: proposalId,
                      category: category,
                      note: noteController.text,
                    );
                    if (!sheetContext.mounted) return;
                    Navigator.of(sheetContext).pop();
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(recorded ? l10n.alphaFlagSent : l10n.alphaFlagDisabled)),
                    );
                  },
                  icon: const Icon(Icons.flag_outlined, size: 18),
                  label: Text(l10n.alphaFlagSubmit),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  String _categoryLabel(dynamic l10n, String category) {
    switch (category) {
      case 'recommendation_wrong':
        return l10n.alphaFlagCategoryWrong;
      case 'misunderstood_me':
        return l10n.alphaFlagCategoryMisunderstood;
      case 'not_useful':
        return l10n.alphaFlagCategoryNotUseful;
      case 'invasive':
        return l10n.alphaFlagCategoryInvasive;
      case 'technical_problem':
        return l10n.alphaFlagCategoryTechnical;
      default:
        return category;
    }
  }
}
