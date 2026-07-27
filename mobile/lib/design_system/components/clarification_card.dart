import 'package:flutter/material.dart';
import '../../models/capture_result.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

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
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.brandSecondary.withValues(alpha: 0.4), width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(AppSpacing.xs),
                decoration: BoxDecoration(
                  color: colors.brandSecondary.withValues(alpha: 0.2),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.auto_awesome,
                  size: 20,
                  color: colors.brandSecondary,
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Text(
                'Clarification Needed',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: colors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            promptText,
            style: TextStyle(
              fontSize: 15,
              height: 1.4,
              color: colors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          Column(
            children: options.map((opt) {
              return Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: OutlinedButton(
                  onPressed: () => onSelectOption?.call(opt),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: colors.brandPrimary,
                    side: BorderSide(color: colors.borderStrong),
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.md,
                      vertical: AppSpacing.md,
                    ),
                    shape: const RoundedRectangleBorder(
                      borderRadius: AppRadius.control,
                    ),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          opt.text,
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                            color: colors.textPrimary,
                          ),
                        ),
                      ),
                      Icon(
                        Icons.chevron_right,
                        size: 20,
                        color: colors.brandPrimary,
                      ),
                    ],
                  ),
                ),
              );
            }).toList(),
          ),
        ],
      ),
    );
  }
}
