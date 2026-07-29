import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'adaptive_platform.dart';

/// One choice in an [AdaptiveActionSheet].
class AdaptiveAction<T> {
  final T value;
  final String label;
  final IconData icon;
  final bool isDestructive;

  const AdaptiveAction({
    required this.value,
    required this.label,
    required this.icon,
    this.isDestructive = false,
  });
}

/// A short list of actions, presented as an iOS action sheet or a Material
/// bottom sheet.
///
/// Both variants are keyboard-safe and SafeArea-aware, announce their items as
/// buttons, and lay out correctly under RTL because they use direction-aware
/// widgets throughout.
abstract final class AdaptiveActionSheet {
  static Future<T?> show<T>({
    required BuildContext context,
    required List<AdaptiveAction<T>> actions,
    String? title,
    String? cancelLabel,
  }) {
    final cancel = cancelLabel ?? context.l10n.cancelAction;

    if (Adaptive.isCupertino(context)) {
      return showCupertinoModalPopup<T>(
        context: context,
        builder: (ctx) => CupertinoActionSheet(
          title: title == null ? null : Text(title),
          actions: [
            for (final action in actions)
              CupertinoActionSheetAction(
                isDestructiveAction: action.isDestructive,
                onPressed: () => Navigator.of(ctx).pop(action.value),
                child: Text(action.label),
              ),
          ],
          cancelButton: CupertinoActionSheetAction(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(cancel),
          ),
        ),
      );
    }

    final colors = context.colors;
    return showModalBottomSheet<T>(
      context: context,
      backgroundColor: colors.surface,
      showDragHandle: true,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: AppRadius.sheet),
      builder: (ctx) => SafeArea(
        top: false,
        child: Padding(
          // Keyboard-safe: if anything below opens a field, the sheet lifts.
          padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(ctx).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (title != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.lg,
                    0,
                    AppSpacing.lg,
                    AppSpacing.smd,
                  ),
                  child: Text(title, style: ctx.text.sectionTitle),
                ),
              for (final action in actions)
                ListTile(
                  leading: Icon(
                    action.icon,
                    color: action.isDestructive
                        ? colors.danger
                        : colors.brandStrong,
                  ),
                  title: Text(
                    action.label,
                    style: ctx.text.body.copyWith(
                      color: action.isDestructive
                          ? colors.danger
                          : colors.textPrimary,
                    ),
                  ),
                  onTap: () => Navigator.of(ctx).pop(action.value),
                ),
              const SizedBox(height: AppSpacing.sm),
            ],
          ),
        ),
      ),
    );
  }
}
