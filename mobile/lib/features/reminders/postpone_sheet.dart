import 'package:flutter/material.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_bottom_sheet.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/tokens/spacing.dart';

/// Which option a postpone choice is, independent of how it is worded.
///
/// The sheet needs the label from the localisations and the tests need the
/// arithmetic without a `BuildContext`, so the option carries a key and the
/// widget resolves it.
enum PostponeOptionKey { oneHour, threeHours, tomorrowMorning, nextWeek }

class PostponeOption {
  final PostponeOptionKey labelKey;
  final DateTime date;

  const PostponeOption(this.labelKey, this.date);
}

class PostponeOptions {
  final DateTime oneHour;
  final DateTime threeHours;
  final DateTime tomorrowMorning;
  final DateTime nextWeek;

  const PostponeOptions({
    required this.oneHour,
    required this.threeHours,
    required this.tomorrowMorning,
    required this.nextWeek,
  });

  List<PostponeOption> get all => [
    PostponeOption(PostponeOptionKey.oneHour, oneHour),
    PostponeOption(PostponeOptionKey.threeHours, threeHours),
    PostponeOption(PostponeOptionKey.tomorrowMorning, tomorrowMorning),
    PostponeOption(PostponeOptionKey.nextWeek, nextWeek),
  ];
}

/// The times a postpone offers, measured from the commitment being postponed.
///
/// This used to measure from `DateTime.now()`, which made "1 Hour Later" mean
/// "one hour from now" rather than "one hour later than this commitment". For
/// anything scheduled ahead of today that lands in the commitment's own past:
/// a checkup on Thursday 20 August, postponed on Wednesday the 19th, moved
/// *back* to the 19th. Postpone is a request to push something further away,
/// so it is measured from where the thing already sits.
///
/// The exception is a commitment whose time has already passed. Measuring from
/// an overdue commitment would offer another moment in the past, so an overdue
/// one is measured from `now` — the two rules meet at "later than both the
/// commitment and this moment", which is what the user is asking for either way.
PostponeOptions postponeOptionsFor({
  required DateTime? scheduledAt,
  required DateTime now,
}) {
  final anchor = (scheduledAt == null || scheduledAt.isBefore(now)) ? now : scheduledAt;
  return PostponeOptions(
    oneHour: anchor.add(const Duration(hours: 1)),
    threeHours: anchor.add(const Duration(hours: 3)),
    // The morning after the anchor's day, not after today's.
    tomorrowMorning: DateTime(anchor.year, anchor.month, anchor.day + 1, 9, 0),
    nextWeek: anchor.add(const Duration(days: 7)),
  );
}

class PostponeSheet extends StatelessWidget {
  final ValueChanged<DateTime> onPostponeSelected;

  /// When the commitment is currently scheduled. Null when it has no date, in
  /// which case there is nothing to measure from but the present.
  final DateTime? scheduledAt;

  const PostponeSheet({
    super.key,
    required this.onPostponeSelected,
    this.scheduledAt,
  });

  static Future<DateTime?> show(BuildContext context, {DateTime? scheduledAt}) {
    return showModalBottomSheet<DateTime>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => PostponeSheet(
        scheduledAt: scheduledAt,
        onPostponeSelected: (dateTime) => Navigator.pop(ctx, dateTime),
      ),
    );
  }

  String _label(BuildContext context, PostponeOptionKey key) {
    final l10n = context.l10n;
    switch (key) {
      case PostponeOptionKey.oneHour:
        return l10n.postponeOneHour;
      case PostponeOptionKey.threeHours:
        return l10n.postponeThreeHours;
      case PostponeOptionKey.tomorrowMorning:
        return l10n.postponeTomorrowMorning;
      case PostponeOptionKey.nextWeek:
        return l10n.postponeNextWeek;
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final options = postponeOptionsFor(
      scheduledAt: scheduledAt,
      now: DateTime.now(),
    );

    return MaybesitterBottomSheet(
      title: l10n.postponeSheetTitle,
      child: Column(
        children: options.all.map((option) {
          return Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: SecondaryButton(
              label: _label(context, option.labelKey),
              onPressed: () => onPostponeSelected(option.date),
            ),
          );
        }).toList(),
      ),
    );
  }
}
