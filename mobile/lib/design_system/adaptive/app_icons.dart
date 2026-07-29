import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'adaptive_platform.dart';

/// The app's icon vocabulary, resolved per platform.
///
/// One concept, one entry. Screens ask for `AppIcons.of(context).complete`
/// rather than naming a glyph, which is what keeps a single platform's icons
/// from drifting into a mix of families.
///
/// iOS resolves to Cupertino glyphs (shipped with `cupertino_icons`); Android
/// resolves to Material rounded glyphs, which are already bundled with
/// Flutter. Apple-only symbols are never shown on Android.
class AppIcons {
  final bool _cupertino;

  const AppIcons._(this._cupertino);

  static AppIcons of(BuildContext context) =>
      AppIcons._(Adaptive.isCupertino(context));

  IconData _pick(IconData cupertino, IconData material) =>
      _cupertino ? cupertino : material;

  // --- Destinations -------------------------------------------------------
  IconData get today => _pick(CupertinoIcons.sun_max, Icons.wb_sunny_rounded);
  IconData get todayOutline =>
      _pick(CupertinoIcons.sun_max, Icons.wb_sunny_outlined);
  IconData get upcoming =>
      _pick(CupertinoIcons.calendar, Icons.calendar_month_rounded);
  IconData get upcomingOutline =>
      _pick(CupertinoIcons.calendar, Icons.calendar_month_outlined);
  IconData get activity =>
      _pick(CupertinoIcons.clock_fill, Icons.history_rounded);
  IconData get activityOutline =>
      _pick(CupertinoIcons.clock, Icons.history_rounded);
  IconData get settings =>
      _pick(CupertinoIcons.settings_solid, Icons.settings_rounded);
  IconData get settingsOutline =>
      _pick(CupertinoIcons.settings, Icons.settings_outlined);

  // --- Actions ------------------------------------------------------------
  IconData get capture =>
      _pick(CupertinoIcons.sparkles, Icons.auto_awesome_rounded);
  IconData get complete =>
      _pick(CupertinoIcons.check_mark_circled, Icons.check_circle_rounded);
  IconData get check => _pick(CupertinoIcons.check_mark, Icons.check_rounded);
  IconData get postpone => _pick(CupertinoIcons.clock, Icons.schedule_rounded);
  IconData get delete => _pick(CupertinoIcons.delete, Icons.delete_outline);
  IconData get edit => _pick(CupertinoIcons.pencil, Icons.edit_outlined);
  IconData get more =>
      _pick(CupertinoIcons.ellipsis_circle, Icons.more_horiz_rounded);
  IconData get close => _pick(CupertinoIcons.xmark, Icons.close_rounded);

  // --- Attributes ---------------------------------------------------------
  IconData get reminder => _pick(CupertinoIcons.bell, Icons.notifications_none);
  IconData get priority => _pick(CupertinoIcons.flag, Icons.flag_outlined);
  IconData get calendar =>
      _pick(CupertinoIcons.calendar_today, Icons.event_rounded);
  IconData get time => _pick(CupertinoIcons.time, Icons.schedule_rounded);
  IconData get location => _pick(CupertinoIcons.location, Icons.place_outlined);
}
