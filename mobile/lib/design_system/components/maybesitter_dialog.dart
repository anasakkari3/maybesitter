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

    return AlertDialog(
      backgroundColor: colors.surface,
      shape: const RoundedRectangleBorder(borderRadius: AppRadius.card),
      title: Text(
        title,
        style: TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: colors.textPrimary,
        ),
      ),
      content: Text(
        message,
        style: TextStyle(fontSize: 14, color: colors.textSecondary),
      ),
      actionsPadding: const EdgeInsets.all(AppSpacing.md),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(
            displayCancelLabel,
            style: TextStyle(color: colors.textMuted),
          ),
        ),
        if (isDestructive)
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: colors.destructive,
              foregroundColor: Colors.white,
            ),
            onPressed: onConfirm,
            child: Text(confirmLabel),
          )
        else
          PrimaryButton(
            label: confirmLabel,
            onPressed: onConfirm,
            isFullWidth: false,
          ),
      ],
    );
  }
}
