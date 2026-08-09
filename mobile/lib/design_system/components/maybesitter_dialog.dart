import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'maybesitter_buttons.dart';

class MaybesitterDialog extends StatelessWidget {
  final String title;
  final String message;

  final String confirmLabel;

  /// Defaults to the localized cancel action when not supplied.
  final String? cancelLabel;
  final VoidCallback onConfirm;
  final bool isDestructive;

  const MaybesitterDialog({
    super.key,
    required this.title,
    required this.message,
    this.confirmLabel = 'Confirm',
    this.cancelLabel,
    required this.onConfirm,
    this.isDestructive = false,
  });

  static Future<bool?> show({
    required BuildContext context,
    required String title,
    required String message,
    String confirmLabel = 'Confirm',
    String? cancelLabel,
    bool isDestructive = false,
  }) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => MaybesitterDialog(
        title: title,
        message: message,
        confirmLabel: confirmLabel,
        cancelLabel: cancelLabel,
        isDestructive: isDestructive,
        onConfirm: () => Navigator.of(ctx).pop(true),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final l10n = context.l10n;
    final displayCancelLabel = cancelLabel ?? l10n.cancelAction;

    return Dialog(
      backgroundColor: colors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(AppSpacing.lg),
      shape: const RoundedRectangleBorder(borderRadius: AppRadius.card),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: isDestructive ? colors.dangerSubtle : colors.brandSubtle,
                borderRadius: BorderRadius.circular(AppRadius.md),
              ),
              child: Icon(
                isDestructive
                    ? Icons.warning_amber_rounded
                    : Icons.help_outline_rounded,
                size: 22,
                color: isDestructive ? colors.danger : colors.brandStrong,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(title, style: context.text.heading2),
            const SizedBox(height: AppSpacing.sm),
            Text(message, style: context.text.supporting),
            const SizedBox(height: AppSpacing.lg),
            if (isDestructive)
              DestructiveButton(label: confirmLabel, onPressed: onConfirm)
            else
              PrimaryButton(label: confirmLabel, onPressed: onConfirm),
            const SizedBox(height: AppSpacing.sm),
            SizedBox(
              width: double.infinity,
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                style: TextButton.styleFrom(
                  foregroundColor: colors.textSecondary,
                  minimumSize: const Size(0, AppSpacing.minTouchTarget),
                ),
                child: Text(
                  displayCancelLabel,
                  style: context.text.button.copyWith(
                    fontSize: 15,
                    color: colors.textSecondary,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
