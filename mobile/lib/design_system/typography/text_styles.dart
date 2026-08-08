import 'package:flutter/material.dart';

import '../tokens/colors.dart';

/// Poppins type scale.
///
/// Anchors from the approved direction:
/// * Heading 1 — Bold 24
/// * Heading 2 — SemiBold 20
/// * Body      — Regular 16
/// * Caption   — Medium 12
///
/// Nothing in the product sits below 12sp, and line heights are generous so
/// Arabic and Hebrew glyphs (which are taller than Latin) are never clipped.
///
/// Letter spacing is deliberately absent from running text: tracking pulls
/// apart the cursive joins in Arabic. The two styles that do carry tracking
/// ([overline] and [badge]) are stripped of it in RTL via `context.text`.
///
/// Poppins covers Latin only. Where a glyph is missing — Arabic, Hebrew — the
/// engine falls through to the platform font, exactly as the previous face
/// did, so those scripts keep rendering.
abstract class AppTextStyles {
  /// The bundled Latin family.
  static const String fontFamily = 'Poppins';

  static TextStyle _base({
    required double size,
    required FontWeight weight,
    required double height,
    required Color color,
    double? letterSpacing,
  }) {
    return TextStyle(
      // Bundled family (see pubspec). Arabic and Hebrew have no Poppins
      // coverage and fall through to the platform font automatically, which
      // is what we want for joining and glyph metrics.
      fontFamily: fontFamily,
      fontSize: size,
      fontWeight: weight,
      height: height,
      color: color,
      letterSpacing: letterSpacing,
    );
  }

  /// 30 / Bold — hero moments (onboarding, success).
  static TextStyle display(SemanticColors colors) => _base(
    size: 30.0,
    weight: FontWeight.w700,
    height: 1.28,
    color: colors.textPrimary,
  );

  /// 24 / Bold — Heading 1. Screen titles and greetings.
  static TextStyle heading1(SemanticColors colors) => _base(
    size: 24.0,
    weight: FontWeight.w700,
    height: 1.3,
    color: colors.textPrimary,
  );

  /// 20 / SemiBold — Heading 2.
  static TextStyle heading2(SemanticColors colors) => _base(
    size: 20.0,
    weight: FontWeight.w600,
    height: 1.35,
    color: colors.textPrimary,
  );

  /// Alias of [heading1] — the title rendered in an app bar.
  static TextStyle screenTitle(SemanticColors colors) => heading1(colors);

  /// Alias of [heading1].
  static TextStyle pageTitle(SemanticColors colors) => heading1(colors);

  /// 17 / SemiBold — a group heading inside a scroll view.
  static TextStyle sectionTitle(SemanticColors colors) => _base(
    size: 17.0,
    weight: FontWeight.w600,
    height: 1.35,
    color: colors.textPrimary,
  );

  /// 16 / SemiBold — the headline of a card or list row.
  static TextStyle cardTitle(SemanticColors colors) => _base(
    size: 16.0,
    weight: FontWeight.w600,
    height: 1.4,
    color: colors.textPrimary,
  );

  /// 16 / Regular — body copy.
  static TextStyle body(SemanticColors colors) => _base(
    size: 16.0,
    weight: FontWeight.w400,
    height: 1.5,
    color: colors.textPrimary,
  );

  /// 14 / Regular — supporting copy under a title.
  static TextStyle supportingBody(SemanticColors colors) => _base(
    size: 14.0,
    weight: FontWeight.w400,
    height: 1.45,
    color: colors.textSecondary,
  );

  /// 13 / Medium — metadata rows (time, location, counts).
  static TextStyle meta(SemanticColors colors) => _base(
    size: 13.0,
    weight: FontWeight.w500,
    height: 1.35,
    color: colors.textSecondary,
  );

  /// 13 / SemiBold — form field labels.
  static TextStyle label(SemanticColors colors) => _base(
    size: 13.0,
    weight: FontWeight.w600,
    height: 1.3,
    color: colors.textSecondary,
  );

  /// 12 / SemiBold, tracked — the eyebrow above a grouped section.
  static TextStyle overline(SemanticColors colors) => _base(
    size: 12.0,
    weight: FontWeight.w600,
    height: 1.3,
    color: colors.textMuted,
    letterSpacing: 0.8,
  );

  /// 12 / Medium — Caption. The smallest text in the product.
  static TextStyle caption(SemanticColors colors) => _base(
    size: 12.0,
    weight: FontWeight.w500,
    height: 1.35,
    color: colors.textMuted,
  );

  /// 12 / Bold, tracked — badge and chip text.
  static TextStyle badge(SemanticColors colors) => _base(
    size: 12.0,
    weight: FontWeight.w700,
    height: 1.2,
    color: colors.textPrimary,
    letterSpacing: 0.4,
  );

  /// 16 / SemiBold — button label.
  static TextStyle buttonText(SemanticColors colors) => _base(
    size: 16.0,
    weight: FontWeight.w600,
    height: 1.2,
    color: colors.textPrimary,
  );

  /// Builds the Material [TextTheme] from the scale above.
  static TextTheme textTheme(SemanticColors colors) => TextTheme(
    displaySmall: display(colors),
    headlineMedium: heading1(colors),
    headlineSmall: heading2(colors),
    titleLarge: heading2(colors),
    titleMedium: sectionTitle(colors),
    titleSmall: cardTitle(colors),
    bodyLarge: body(colors),
    bodyMedium: supportingBody(colors),
    bodySmall: caption(colors),
    labelLarge: buttonText(colors),
    labelMedium: label(colors),
    labelSmall: overline(colors),
  );
}
