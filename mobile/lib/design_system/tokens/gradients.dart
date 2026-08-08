import 'package:flutter/widgets.dart';

import 'colors.dart';

/// Gradients are reserved for key calls to action and the brand mark.
/// Everything else stays flat so the CTA keeps its weight.
abstract class AppGradients {
  /// Indigo → violet. Used on the primary CTA and the capture FAB only.
  static LinearGradient primary(SemanticColors colors) => LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [colors.gradientStart, colors.gradientEnd],
  );

  /// A barely-there brand wash for hero/greeting panels.
  static LinearGradient brandWash(SemanticColors colors) => LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      colors.brandPrimary.withValues(alpha: 0.10),
      colors.gradientEnd.withValues(alpha: 0.04),
    ],
  );

  /// Fade used behind sticky bottom action bars so content dissolves under it.
  static LinearGradient scrimUp(SemanticColors colors) => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [
      colors.background.withValues(alpha: 0.0),
      colors.background.withValues(alpha: 0.9),
    ],
  );
}
