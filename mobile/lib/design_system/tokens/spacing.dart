import 'package:flutter/widgets.dart';

/// Spacing scale: 4, 8, 12, 16, 20, 24, 32 (plus a 2px hairline nudge and a
/// 48px section break). Everything in the UI composes from these values —
/// no ad-hoc paddings.
abstract class AppSpacing {
  /// 2 — hairline nudges only.
  static const double xxs = 2.0;

  /// 4
  static const double xs = 4.0;

  /// 8
  static const double sm = 8.0;

  /// 12
  static const double smd = 12.0;

  /// 16 — default rhythm.
  static const double md = 16.0;

  /// 20
  static const double mdl = 20.0;

  /// 24
  static const double lg = 24.0;

  /// 32
  static const double xl = 32.0;

  /// 48 — major section break.
  static const double xxl = 48.0;

  /// Numeric aliases mirroring the design spec (4/8/12/16/20/24/32).
  static const double space1 = xs;
  static const double space2 = sm;
  static const double space3 = smd;
  static const double space4 = md;
  static const double space5 = mdl;
  static const double space6 = lg;
  static const double space8 = xl;

  /// Horizontal gutter used by every screen.
  static const double gutter = mdl;

  static const EdgeInsets screenPadding = EdgeInsets.symmetric(
    horizontal: gutter,
  );
  static const EdgeInsets screenPaddingAll = EdgeInsets.fromLTRB(
    gutter,
    md,
    gutter,
    xl,
  );
  static const EdgeInsets cardPadding = EdgeInsets.all(md);
  static const EdgeInsets cardPaddingLoose = EdgeInsets.all(mdl);
  static const EdgeInsets sheetPadding = EdgeInsets.all(lg);
  static const EdgeInsets listItemPadding = EdgeInsets.symmetric(
    horizontal: md,
    vertical: smd,
  );

  /// Clearance so the last list item is never hidden behind the FAB.
  static const double fabScrollClearance = 96.0;

  /// Minimum interactive size — keeps touch targets accessible.
  static const double minTouchTarget = 48.0;
}
