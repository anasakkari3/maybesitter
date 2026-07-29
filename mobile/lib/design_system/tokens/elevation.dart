import 'package:flutter/widgets.dart';

import 'colors.dart';

/// Elevation is deliberately soft: wide, low-opacity shadows that read as
/// depth rather than as a drop shadow. Never heavy, never "enterprise".
abstract class AppElevation {
  /// Resting card. Barely there — just enough to lift off the canvas.
  static List<BoxShadow> card(SemanticColors colors) => [
    BoxShadow(
      color: colors.shadow.withValues(alpha: 0.05),
      blurRadius: 14.0,
      offset: const Offset(0, 4),
    ),
  ];

  /// Selected card, popovers, segmented thumb.
  static List<BoxShadow> raised(SemanticColors colors) => [
    BoxShadow(
      color: colors.shadow.withValues(alpha: 0.08),
      blurRadius: 22.0,
      offset: const Offset(0, 8),
    ),
  ];

  /// Sticky action bars and the bottom navigation shelf.
  static List<BoxShadow> bar(SemanticColors colors) => [
    BoxShadow(
      color: colors.shadow.withValues(alpha: 0.07),
      blurRadius: 24.0,
      offset: const Offset(0, -6),
    ),
  ];

  /// Primary CTA / FAB — tinted with the brand so it glows rather than smudges.
  static List<BoxShadow> brand(SemanticColors colors) => [
    BoxShadow(
      color: colors.brandPrimary.withValues(alpha: 0.28),
      blurRadius: 20.0,
      offset: const Offset(0, 8),
    ),
  ];

  /// Legacy aliases kept so older call sites keep compiling.
  static const List<BoxShadow> low = [
    BoxShadow(color: Color(0x0D0F172A), blurRadius: 14.0, offset: Offset(0, 4)),
  ];

  static const List<BoxShadow> medium = [
    BoxShadow(color: Color(0x140F172A), blurRadius: 22.0, offset: Offset(0, 8)),
  ];

  static const List<BoxShadow> fabGlow = [
    BoxShadow(color: Color(0x476366F1), blurRadius: 20.0, offset: Offset(0, 8)),
  ];
}
