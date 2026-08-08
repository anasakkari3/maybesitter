import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import 'adaptive_haptics.dart';
import 'adaptive_platform.dart';

/// A confirm/cancel decision, rendered in the platform's own idiom.
///
/// iOS gets a `CupertinoAlertDialog`; Android gets a Material 3 `AlertDialog`.
/// The copy, the destructive flag and the return contract are identical, so
/// call sites never branch on platform.
abstract final class AdaptiveAppDialog {
  /// Returns true if confirmed, false if cancelled, null if dismissed.
  ///
  /// Destructive dialogs are **not** barrier-dismissible: a stray tap outside
  /// must not be able to stand in for a deliberate answer.
  static Future<bool?> confirm({
    required BuildContext context,
    required String title,
    required String message,
    required String confirmLabel,
    String? cancelLabel,
    bool isDestructive = false,
  }) {
    final cancel = cancelLabel ?? context.l10n.cancelAction;

    if (isDestructive) AdaptiveHaptics.destructive();

    if (Adaptive.isCupertino(context)) {
      return showCupertinoDialog<bool>(
        context: context,
        barrierDismissible: !isDestructive,
        builder: (ctx) => CupertinoAlertDialog(
          title: Text(title),
          content: Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(message),
          ),
          actions: [
            CupertinoDialogAction(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(cancel),
            ),
            CupertinoDialogAction(
              isDestructiveAction: isDestructive,
              isDefaultAction: !isDestructive,
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(confirmLabel),
            ),
          ],
        ),
      );
    }

    final colors = Theme.of(context).colorScheme;
    return showDialog<bool>(
      context: context,
      barrierDismissible: !isDestructive,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(cancel),
          ),
          FilledButton(
            style: isDestructive
                ? FilledButton.styleFrom(
                    backgroundColor: colors.error,
                    foregroundColor: colors.onError,
                  )
                : null,
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
  }
}
