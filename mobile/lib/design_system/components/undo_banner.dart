import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

class UndoBanner extends StatelessWidget {
  final String message;
  final VoidCallback onUndo;

  const UndoBanner({
    super.key,
    required this.message,
    required this.onUndo,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.all(AppSpacing.md),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceElevated,
        borderRadius: AppRadius.control,
        border: Border.all(color: colors.border),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: TextStyle(
                fontSize: 13,
                color: colors.textPrimary,
              ),
            ),
          ),
          TextButton(
            onPressed: onUndo,
            child: Text(
              'Undo',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: colors.brandPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
