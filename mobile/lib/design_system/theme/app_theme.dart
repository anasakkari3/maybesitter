import 'package:flutter/material.dart';
import '../tokens/colors.dart';
import '../tokens/radius.dart';

class AppTheme {
  static ThemeData get darkTheme {
    const colors = SemanticColors.dark;
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: colors.background,
      colorScheme: ColorScheme.dark(
        surface: colors.surface,
        primary: colors.brandPrimary,
        secondary: colors.brandSecondary,
        error: colors.destructive,
        onSurface: colors.textPrimary,
        onPrimary: colors.background,
      ),
      fontFamily: 'Manrope',
      extensions: const [colors],
      cardTheme: CardThemeData(
        color: colors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: AppRadius.card,
          side: BorderSide(color: colors.border, width: 1),
        ),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: colors.background,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        iconTheme: IconThemeData(color: colors.textPrimary),
      ),
      bottomNavigationBarTheme: BottomNavigationBarThemeData(
        backgroundColor: colors.surfaceMuted,
        selectedItemColor: colors.brandPrimary,
        unselectedItemColor: colors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 8,
      ),
      dividerTheme: DividerThemeData(
        color: colors.border,
        thickness: 1,
        space: 1,
      ),
    );
  }

  static ThemeData get lightTheme {
    const colors = SemanticColors.light;
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: colors.background,
      colorScheme: ColorScheme.light(
        surface: colors.surface,
        primary: colors.brandPrimary,
        secondary: colors.brandSecondary,
        error: colors.destructive,
        onSurface: colors.textPrimary,
        onPrimary: Colors.white,
      ),
      fontFamily: 'Manrope',
      extensions: const [colors],
      cardTheme: CardThemeData(
        color: colors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: AppRadius.card,
          side: BorderSide(color: colors.border, width: 1),
        ),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: colors.background,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        iconTheme: IconThemeData(color: colors.textPrimary),
      ),
      bottomNavigationBarTheme: BottomNavigationBarThemeData(
        backgroundColor: colors.surface,
        selectedItemColor: colors.brandPrimary,
        unselectedItemColor: colors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 8,
      ),
      dividerTheme: DividerThemeData(
        color: colors.border,
        thickness: 1,
        space: 1,
      ),
    );
  }
}

extension BuildContextThemeExtension on BuildContext {
  SemanticColors get colors =>
      Theme.of(this).extension<SemanticColors>() ??
      (Theme.of(this).brightness == Brightness.dark
          ? SemanticColors.dark
          : SemanticColors.light);
}
