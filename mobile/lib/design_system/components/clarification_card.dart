import 'package:flutter/material.dart';

import '../../models/capture_result.dart';
import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'pressable.dart';

/// Asks the user to resolve an ambiguity before saving.
///
/// Warm amber framing rather than an error red — nothing has gone wrong, the
/// model just needs one more detail.
class ClarificationCard extends StatelessWidget {
  final String promptText;
  final List<ClarificationOption> options;
  final ValueChanged<ClarificationOption>? onSelectOption;

  const ClarificationCard({
    super.key,
    required this.promptText,
    required this.options,
    this.onSelectOption,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.mdl),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.warning.withValues(alpha: 0.30)),
        boxShadow: AppElevation.card(colors),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: colors.warningSubtle,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                ),
                child: Icon(
                  Icons.help_outline_rounded,
                  size: 21,
                  color: colors.warning,
                ),
              ),
              const SizedBox(width: AppSpacing.smd),
              Expanded(
                child: Text(
                  'Clarification Needed',
                  style: context.text.heading2.copyWith(fontSize: 18),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Text(promptText, style: context.text.body),
          const SizedBox(height: AppSpacing.mdl),
          ...options.map(
            (opt) => Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.smd),
              child: Pressable(
                onTap: onSelectOption == null
                    ? null
                    : () => onSelectOption!(opt),
                borderRadius: AppRadius.control,
                semanticLabel: opt.text,
                excludeChildSemantics: true,
                child: Container(
                  constraints: const BoxConstraints(minHeight: 56),
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.md,
                    vertical: AppSpacing.smd,
                  ),
                  decoration: BoxDecoration(
                    color: colors.surfaceMuted,
                    borderRadius: AppRadius.control,
                    border: Border.all(color: colors.border),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          opt.text,
                          style: context.text.cardTitle.copyWith(fontSize: 15),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Icon(
                        Icons.arrow_forward_rounded,
                        size: 18,
                        color: colors.brandStrong,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
