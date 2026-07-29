import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

class UndoBanner extends StatelessWidget {
  final String message;
  final VoidCallback onUndo;

  const UndoBanner({super.key, required this.message, required this.onUndo});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Container(
      margin: const EdgeInsets.all(AppSpacing.md),
      padding: const EdgeInsets.only(left: AppSpacing.md, right: AppSpacing.sm),
      constraints: const BoxConstraints(minHeight: AppSpacing.minTouchTarget),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.cardInner,
        border: Border.all(color: colors.border),
        boxShadow: AppElevation.raised(colors),
      ),
      child: Row(
        children: [
          Expanded(child: Text(message, style: context.text.supporting)),
          TextButton(
            onPressed: onUndo,
            child: Text(
              'Undo',
              style: context.text.button.copyWith(
                fontSize: 15,
                color: colors.brandStrong,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
