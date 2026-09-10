import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/design_system/theme/app_theme.dart';
import 'package:maybesitter_mobile/design_system/tokens/colors.dart';
import 'package:maybesitter_mobile/design_system/typography/text_styles.dart';

/// Poppins carries no Arabic or Hebrew glyphs. Leaving those scripts to the
/// engine's implicit per-glyph fallback breaks the cursive joins *inside*
/// Arabic words, because a run can straddle two faces with different shaping
/// tables. Naming an Arabic-capable family explicitly keeps a whole Arabic run
/// on one font that shapes it correctly.
void main() {
  group('Arabic font fallback', () {
    test('every base style names the Arabic family as a fallback', () {
      final colors = SemanticColors.light;
      final styles = <String, dynamic>{
        'display': AppTextStyles.display(colors),
        'heading1': AppTextStyles.heading1(colors),
        'body': AppTextStyles.body(colors),
        'caption': AppTextStyles.caption(colors),
        'buttonText': AppTextStyles.buttonText(colors),
      };

      styles.forEach((name, style) {
        expect(
          style.fontFamily,
          AppTextStyles.fontFamily,
          reason: '$name should still prefer the bundled Latin family',
        );
        expect(
          style.fontFamilyFallback,
          contains(AppTextStyles.arabicFontFamily),
          reason: '$name must fall back to an Arabic-shaping family',
        );
      });
    });

    test('both themes carry the fallback through the text theme', () {
      for (final theme in <dynamic>[AppTheme.lightTheme, AppTheme.darkTheme]) {
        expect(
          theme.textTheme.bodyMedium?.fontFamilyFallback,
          contains(AppTextStyles.arabicFontFamily),
        );
      }
    });
  });
}
