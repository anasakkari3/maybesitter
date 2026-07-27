import 'package:flutter/material.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_bottom_sheet.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/tokens/spacing.dart';

class PostponeSheet extends StatelessWidget {
  final ValueChanged<DateTime> onPostponeSelected;

  const PostponeSheet({super.key, required this.onPostponeSelected});

  static Future<DateTime?> show(BuildContext context) {
    return showModalBottomSheet<DateTime>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => PostponeSheet(
        onPostponeSelected: (dateTime) => Navigator.pop(ctx, dateTime),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final now = DateTime.now();

    final options = [
      {
        'label': l10n.postponeOneHour,
        'date': now.add(const Duration(hours: 1)),
      },
      {
        'label': l10n.postponeThreeHours,
        'date': now.add(const Duration(hours: 3)),
      },
      {
        'label': l10n.postponeTomorrowMorning,
        'date': DateTime(now.year, now.month, now.day + 1, 9, 0),
      },
      {
        'label': l10n.postponeNextWeek,
        'date': now.add(const Duration(days: 7)),
      },
    ];

    return MaybesitterBottomSheet(
      title: l10n.postponeSheetTitle,
      child: Column(
        children: options.map((opt) {
          final label = opt['label'] as String;
          final date = opt['date'] as DateTime;
          return Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: SecondaryButton(
              label: label,
              onPressed: () => onPostponeSelected(date),
            ),
          );
        }).toList(),
      ),
    );
  }
}
