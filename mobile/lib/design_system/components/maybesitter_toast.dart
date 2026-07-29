import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

class MaybesitterToast {
  static void show(
    BuildContext context,
    String message, {
    bool isError = false,
  }) {
    final colors = context.colors;

    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Row(
            children: [
              Icon(
                isError
                    ? Icons.error_outline_rounded
                    : Icons.check_circle_outline_rounded,
                size: 20,
                color: isError ? colors.danger : colors.brandSecondary,
              ),
              const SizedBox(width: AppSpacing.smd),
              Expanded(
                child: Text(
                  message,
                  style: context.text.supporting.copyWith(
                    color: colors.surface,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),
          backgroundColor: colors.textPrimary,
          behavior: SnackBarBehavior.floating,
          elevation: 0,
          shape: const RoundedRectangleBorder(
            borderRadius: AppRadius.cardInner,
          ),
          margin: const EdgeInsets.all(AppSpacing.md),
        ),
      );
  }
}
