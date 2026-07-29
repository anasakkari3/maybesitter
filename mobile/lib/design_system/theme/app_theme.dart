import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import '../tokens/colors.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import '../typography/text_styles.dart';

/// Builds the single Material theme both brightnesses share.
///
/// Every widget-level default lives here so screens never restate styling:
/// if a button, input, chip or sheet looks a certain way, it is because of
/// this file, not because a screen hard-coded it.
class AppTheme {
  static final ThemeData lightTheme = _build(SemanticColors.light, Brightness.light);
  static final ThemeData darkTheme = _build(SemanticColors.dark, Brightness.dark);

  static ThemeData _build(SemanticColors colors, Brightness brightness) {
    final textTheme = AppTextStyles.textTheme(colors);
    final isDark = brightness == Brightness.dark;

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      scaffoldBackgroundColor: colors.background,
      canvasColor: colors.background,
      extensions: <ThemeExtension<dynamic>>[colors],
      fontFamily: GoogleFonts.poppins().fontFamily,
      textTheme: textTheme,
      colorScheme: ColorScheme(
        brightness: brightness,
        primary: colors.brandPrimary,
        onPrimary: colors.textOnBrand,
        primaryContainer: colors.brandSubtle,
        onPrimaryContainer: colors.brandStrong,
        secondary: colors.brandSecondary,
        onSecondary: isDark ? colors.background : Colors.white,
        secondaryContainer: colors.successSubtle,
        onSecondaryContainer: colors.success,
        tertiary: colors.accent,
        onTertiary: isDark ? colors.background : Colors.white,
        error: colors.danger,
        onError: isDark ? colors.background : Colors.white,
        errorContainer: colors.dangerSubtle,
        onErrorContainer: colors.danger,
        surface: colors.surface,
        onSurface: colors.textPrimary,
        surfaceContainerHighest: colors.surfaceMuted,
        onSurfaceVariant: colors.textSecondary,
        outline: colors.borderStrong,
        outlineVariant: colors.border,
        shadow: colors.shadow,
        scrim: colors.overlay,
        inverseSurface: colors.textPrimary,
        onInverseSurface: colors.surface,
        inversePrimary: colors.brandStrong,
      ),

      appBarTheme: AppBarTheme(
        backgroundColor: colors.background,
        surfaceTintColor: Colors.transparent,
        foregroundColor: colors.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleSpacing: AppSpacing.gutter,
        titleTextStyle: AppTextStyles.heading2(colors),
        iconTheme: IconThemeData(color: colors.textPrimary, size: 24),
        actionsIconTheme: IconThemeData(color: colors.textSecondary, size: 24),
      ),

      cardTheme: CardThemeData(
        color: colors.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: AppRadius.card,
          side: BorderSide(color: colors.border),
        ),
      ),

      dividerTheme: DividerThemeData(
        color: colors.border,
        thickness: 1,
        space: 1,
      ),

      iconTheme: IconThemeData(color: colors.textSecondary, size: 22),

      listTileTheme: ListTileThemeData(
        iconColor: colors.textSecondary,
        textColor: colors.textPrimary,
        titleTextStyle: AppTextStyles.cardTitle(colors),
        subtitleTextStyle: AppTextStyles.meta(colors),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm,
        ),
        minVerticalPadding: AppSpacing.smd,
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.cardInner),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: colors.surface,
        hintStyle: AppTextStyles.body(colors).copyWith(color: colors.textMuted),
        labelStyle: AppTextStyles.label(colors),
        floatingLabelStyle: AppTextStyles.label(
          colors,
        ).copyWith(color: colors.brandStrong),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.smd,
        ),
        border: OutlineInputBorder(
          borderRadius: AppRadius.input,
          borderSide: BorderSide(color: colors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: AppRadius.input,
          borderSide: BorderSide(color: colors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: AppRadius.input,
          borderSide: BorderSide(color: colors.focusRing, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: AppRadius.input,
          borderSide: BorderSide(color: colors.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: AppRadius.input,
          borderSide: BorderSide(color: colors.danger, width: 2),
        ),
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: colors.brandFill,
          foregroundColor: Colors.white,
          disabledBackgroundColor: colors.surfaceMuted,
          disabledForegroundColor: colors.textMuted,
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          textStyle: AppTextStyles.buttonText(colors),
          shape: const RoundedRectangleBorder(borderRadius: AppRadius.control),
        ),
      ),

      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colors.brandFill,
          foregroundColor: Colors.white,
          disabledBackgroundColor: colors.surfaceMuted,
          disabledForegroundColor: colors.textMuted,
          elevation: 0,
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          textStyle: AppTextStyles.buttonText(colors),
          shape: const RoundedRectangleBorder(borderRadius: AppRadius.control),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: colors.textPrimary,
          backgroundColor: colors.surface,
          side: BorderSide(color: colors.borderStrong),
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          textStyle: AppTextStyles.buttonText(colors),
          shape: const RoundedRectangleBorder(borderRadius: AppRadius.control),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: colors.brandStrong,
          minimumSize: const Size(0, AppSpacing.minTouchTarget),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.smd),
          textStyle: AppTextStyles.buttonText(colors).copyWith(fontSize: 15),
          shape: const RoundedRectangleBorder(borderRadius: AppRadius.control),
        ),
      ),

      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          foregroundColor: colors.textSecondary,
          minimumSize: const Size(
            AppSpacing.minTouchTarget,
            AppSpacing.minTouchTarget,
          ),
        ),
      ),

      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: colors.brandFill,
        foregroundColor: Colors.white,
        elevation: 0,
        focusElevation: 0,
        hoverElevation: 0,
        highlightElevation: 0,
        extendedTextStyle: AppTextStyles.buttonText(
          colors,
        ).copyWith(color: Colors.white),
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.chip),
      ),

      chipTheme: ChipThemeData(
        backgroundColor: colors.surface,
        selectedColor: colors.brandSubtle,
        side: BorderSide(color: colors.border),
        labelStyle: AppTextStyles.meta(colors),
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.chip),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.smd,
          vertical: AppSpacing.sm,
        ),
      ),

      bottomNavigationBarTheme: BottomNavigationBarThemeData(
        backgroundColor: colors.surface,
        selectedItemColor: colors.brandStrong,
        unselectedItemColor: colors.textMuted,
        selectedLabelStyle: AppTextStyles.caption(
          colors,
        ).copyWith(fontWeight: FontWeight.w600, color: colors.brandStrong),
        unselectedLabelStyle: AppTextStyles.caption(colors),
        type: BottomNavigationBarType.fixed,
        elevation: 0,
      ),

      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: colors.surface,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: colors.surface,
        elevation: 0,
        modalElevation: 0,
        showDragHandle: false,
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.sheet),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: colors.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        titleTextStyle: AppTextStyles.heading2(colors),
        contentTextStyle: AppTextStyles.supportingBody(colors),
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.card),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: colors.textPrimary,
        contentTextStyle: AppTextStyles.supportingBody(
          colors,
        ).copyWith(color: colors.surface),
        behavior: SnackBarBehavior.floating,
        elevation: 0,
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.cardInner),
      ),

      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: colors.brandStrong,
        linearTrackColor: colors.surfaceMuted,
        circularTrackColor: colors.surfaceMuted,
        linearMinHeight: 8,
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? Colors.white
              : colors.surface,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? colors.brandFill
              : colors.surfaceMuted,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? Colors.transparent
              : colors.borderStrong,
        ),
      ),

      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? colors.brandFill
              : Colors.transparent,
        ),
        checkColor: const WidgetStatePropertyAll(Colors.white),
        side: BorderSide(color: colors.borderStrong, width: 2),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.xs),
        ),
      ),

      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: colors.textPrimary,
          borderRadius: BorderRadius.circular(AppRadius.sm),
        ),
        textStyle: AppTextStyles.caption(
          colors,
        ).copyWith(color: colors.surface),
      ),
    );
  }
}

/// `context.colors` — the single entry point to semantic colour tokens.
///
/// Falls back to the static palettes so widgets still render correctly when
/// pumped inside a bare `MaterialApp` (as the widget tests do).
extension BuildContextThemeExtension on BuildContext {
  SemanticColors get colors =>
      Theme.of(this).extension<SemanticColors>() ??
      (Theme.of(this).brightness == Brightness.dark
          ? SemanticColors.dark
          : SemanticColors.light);

  /// `context.text` — the Poppins scale bound to the active palette, with
  /// letter spacing dropped for RTL so Arabic joins stay intact.
  AppTextScale get text => AppTextScale(
    colors,
    isRtl: Directionality.maybeOf(this) == TextDirection.rtl,
  );
}

/// Thin wrapper so screens can write `context.text.heading1` instead of
/// threading [SemanticColors] through every call.
class AppTextScale {
  final SemanticColors _c;
  final bool isRtl;

  const AppTextScale(this._c, {this.isRtl = false});

  /// Tracking is a Latin nicety; in Arabic it visually breaks glyph joining.
  TextStyle _track(TextStyle style) =>
      isRtl ? style.copyWith(letterSpacing: 0) : style;

  TextStyle get display => AppTextStyles.display(_c);
  TextStyle get heading1 => AppTextStyles.heading1(_c);
  TextStyle get heading2 => AppTextStyles.heading2(_c);
  TextStyle get sectionTitle => AppTextStyles.sectionTitle(_c);
  TextStyle get cardTitle => AppTextStyles.cardTitle(_c);
  TextStyle get body => AppTextStyles.body(_c);
  TextStyle get supporting => AppTextStyles.supportingBody(_c);
  TextStyle get meta => AppTextStyles.meta(_c);
  TextStyle get label => AppTextStyles.label(_c);
  TextStyle get overline => _track(AppTextStyles.overline(_c));
  TextStyle get caption => AppTextStyles.caption(_c);
  TextStyle get badge => _track(AppTextStyles.badge(_c));
  TextStyle get button => AppTextStyles.buttonText(_c);
}
