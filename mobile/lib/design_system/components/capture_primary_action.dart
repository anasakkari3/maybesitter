import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/gradients.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'pressable.dart';

/// The capture FAB — the single deliberate action on the list screens.
///
/// Carries the brand gradient so it is unmistakably *the* thing to press.
class CapturePrimaryAction extends StatelessWidget {
  final VoidCallback onTap;

  /// Defaults to the localized "Capture Plan" action.
  final String? label;

  const CapturePrimaryAction({super.key, required this.onTap, this.label});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final displayLabel = label ?? context.l10n.capturePlanAction;

    return Pressable(
      onTap: onTap,
      borderRadius: AppRadius.chip,
      semanticLabel: displayLabel,
      excludeChildSemantics: true,
      child: Container(
        height: 56,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
        decoration: BoxDecoration(
          gradient: AppGradients.primary(colors),
          borderRadius: AppRadius.chip,
          boxShadow: AppElevation.brand(colors),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.auto_awesome_rounded,
              size: 21,
              color: Colors.white,
            ),
            const SizedBox(width: AppSpacing.sm + 2),
            Text(
              displayLabel,
              style: context.text.button.copyWith(color: Colors.white),
            ),
          ],
        ),
      ),
    );
  }
}
