import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../components/maybesitter_buttons.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'adaptive_haptics.dart';
import 'adaptive_platform.dart';

/// Date and time selection in the platform's own idiom.
///
/// iOS gets the wheel pickers inside a sheet with an explicit confirm action;
/// Android gets the Material 3 calendar and clock dialogs. Both return the
/// same nullable value, and both fire a selection haptic only when the user
/// actually commits.
abstract final class AdaptiveDateTimePicker {
  static Future<DateTime?> pickDate({
    required BuildContext context,
    required DateTime initial,
    DateTime? firstDate,
    DateTime? lastDate,
  }) async {
    final first = firstDate ?? DateTime(initial.year - 2);
    final last = lastDate ?? DateTime(initial.year + 5);

    if (!Adaptive.isCupertino(context)) {
      final picked = await showDatePicker(
        context: context,
        initialDate: initial,
        firstDate: first,
        lastDate: last,
      );
      if (picked != null) AdaptiveHaptics.selection();
      return picked;
    }

    var draft = initial;
    final confirmed = await _showCupertinoPickerSheet(
      context: context,
      semanticsLabel: context.l10n.scheduledDateLabel,
      child: CupertinoDatePicker(
        mode: CupertinoDatePickerMode.date,
        initialDateTime: initial,
        minimumDate: first,
        maximumDate: last,
        onDateTimeChanged: (value) => draft = value,
      ),
    );
    if (confirmed != true) return null;
    AdaptiveHaptics.selection();
    return draft;
  }

  static Future<TimeOfDay?> pickTime({
    required BuildContext context,
    required TimeOfDay initial,
  }) async {
    if (!Adaptive.isCupertino(context)) {
      final picked = await showTimePicker(
        context: context,
        initialTime: initial,
      );
      if (picked != null) AdaptiveHaptics.selection();
      return picked;
    }

    final today = DateTime.now();
    var draft = DateTime(
      today.year,
      today.month,
      today.day,
      initial.hour,
      initial.minute,
    );

    final confirmed = await _showCupertinoPickerSheet(
      context: context,
      semanticsLabel: context.l10n.timeLabel,
      child: CupertinoDatePicker(
        mode: CupertinoDatePickerMode.time,
        initialDateTime: draft,
        onDateTimeChanged: (value) => draft = value,
      ),
    );
    if (confirmed != true) return null;
    AdaptiveHaptics.selection();
    return TimeOfDay(hour: draft.hour, minute: draft.minute);
  }

  /// A branded sheet hosting a Cupertino wheel, with an explicit confirm.
  ///
  /// The wheel alone has no commit affordance, and screen readers need a
  /// labelled action; a bare dismiss would leave "did that apply?" ambiguous.
  static Future<bool?> _showCupertinoPickerSheet({
    required BuildContext context,
    required String semanticsLabel,
    required Widget child,
  }) {
    final colors = context.colors;

    return showCupertinoModalPopup<bool>(
      context: context,
      builder: (ctx) => Container(
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: AppRadius.sheet,
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.gutter,
                  AppSpacing.md,
                  AppSpacing.gutter,
                  0,
                ),
                child: Text(semanticsLabel, style: ctx.text.sectionTitle),
              ),
              SizedBox(
                height: 216,
                child: Semantics(label: semanticsLabel, child: child),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.gutter,
                  0,
                  AppSpacing.gutter,
                  AppSpacing.smd,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    PrimaryButton(
                      label: ctx.l10n.saveAction,
                      onPressed: () => Navigator.of(ctx).pop(true),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    TertiaryButton(
                      label: ctx.l10n.cancelAction,
                      onPressed: () => Navigator.of(ctx).pop(false),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
