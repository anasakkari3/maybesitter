import 'package:flutter/material.dart';

/// Semantic colors for Maybesitter extracted directly from Google Stitch design.
@immutable
class SemanticColors extends ThemeExtension<SemanticColors> {
  final Color background;
  final Color surface;
  final Color surfaceElevated;
  final Color surfaceMuted;
  final Color glassBorder;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;
  final Color border;
  final Color borderStrong;
  final Color brandPrimary;
  final Color brandSecondary;
  final Color brandPressed;
  final Color success;
  final Color warning;
  final Color destructive;
  final Color mustPriority;
  final Color mustPriorityContainer;
  final Color shouldPriority;
  final Color shouldPriorityContainer;
  final Color nicePriority;
  final Color nicePriorityContainer;

  const SemanticColors({
    required this.background,
    required this.surface,
    required this.surfaceElevated,
    required this.surfaceMuted,
    required this.glassBorder,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.border,
    required this.borderStrong,
    required this.brandPrimary,
    required this.brandSecondary,
    required this.brandPressed,
    required this.success,
    required this.warning,
    required this.destructive,
    required this.mustPriority,
    required this.mustPriorityContainer,
    required this.shouldPriority,
    required this.shouldPriorityContainer,
    required this.nicePriority,
    required this.nicePriorityContainer,
  });

  /// Dark Theme (Primary Stitch dark palette)
  static const dark = SemanticColors(
    background: Color(0xFF1B1B21),
    surface: Color(0xFF25252B),
    surfaceElevated: Color(0xFF303036),
    surfaceMuted: Color(0xFF0F1014),
    glassBorder: Color(0x1AFFFFFF),
    textPrimary: Color(0xFFEFEDF4),
    textSecondary: Color(0xFFC6C5D3),
    textMuted: Color(0xFF767682),
    border: Color(0xFF303036),
    borderStrong: Color(0xFF454651),
    brandPrimary: Color(0xFF39B8FD),
    brandSecondary: Color(0xFF9EA9FF),
    brandPressed: Color(0xFF006591),
    success: Color(0xFF10B981),
    warning: Color(0xFFF29C06),
    destructive: Color(0xFFBA1A1A),
    mustPriority: Color(0xFFBA1A1A),
    mustPriorityContainer: Color(0xFF3B1212),
    shouldPriority: Color(0xFF39B8FD),
    shouldPriorityContainer: Color(0xFF00344D),
    nicePriority: Color(0xFFF29C06),
    nicePriorityContainer: Color(0xFF3D2700),
  );

  /// Light Theme (Stitch light palette)
  static const light = SemanticColors(
    background: Color(0xFFF7F9FB),
    surface: Color(0xFFFFFFFF),
    surfaceElevated: Color(0xFFF2EFF7),
    surfaceMuted: Color(0xFFE9E7EF),
    glassBorder: Color(0x1F000000),
    textPrimary: Color(0xFF191C1E),
    textSecondary: Color(0xFF454651),
    textMuted: Color(0xFF767682),
    border: Color(0xFFDBD9E1),
    borderStrong: Color(0xFFC6C5D3),
    brandPrimary: Color(0xFF006591),
    brandSecondary: Color(0xFF333F91),
    brandPressed: Color(0xFF004666),
    success: Color(0xFF006C49),
    warning: Color(0xFF653E00),
    destructive: Color(0xFFBA1A1A),
    mustPriority: Color(0xFFBA1A1A),
    mustPriorityContainer: Color(0xFFFFDAD6),
    shouldPriority: Color(0xFF006591),
    shouldPriorityContainer: Color(0xFFC9E6FF),
    nicePriority: Color(0xFF653E00),
    nicePriorityContainer: Color(0xFFFFDDB8),
  );

  @override
  SemanticColors copyWith({
    Color? background,
    Color? surface,
    Color? surfaceElevated,
    Color? surfaceMuted,
    Color? glassBorder,
    Color? textPrimary,
    Color? textSecondary,
    Color? textMuted,
    Color? border,
    Color? borderStrong,
    Color? brandPrimary,
    Color? brandSecondary,
    Color? brandPressed,
    Color? success,
    Color? warning,
    Color? destructive,
    Color? mustPriority,
    Color? mustPriorityContainer,
    Color? shouldPriority,
    Color? shouldPriorityContainer,
    Color? nicePriority,
    Color? nicePriorityContainer,
  }) {
    return SemanticColors(
      background: background ?? this.background,
      surface: surface ?? this.surface,
      surfaceElevated: surfaceElevated ?? this.surfaceElevated,
      surfaceMuted: surfaceMuted ?? this.surfaceMuted,
      glassBorder: glassBorder ?? this.glassBorder,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textMuted: textMuted ?? this.textMuted,
      border: border ?? this.border,
      borderStrong: borderStrong ?? this.borderStrong,
      brandPrimary: brandPrimary ?? this.brandPrimary,
      brandSecondary: brandSecondary ?? this.brandSecondary,
      brandPressed: brandPressed ?? this.brandPressed,
      success: success ?? this.success,
      warning: warning ?? this.warning,
      destructive: destructive ?? this.destructive,
      mustPriority: mustPriority ?? this.mustPriority,
      mustPriorityContainer:
          mustPriorityContainer ?? this.mustPriorityContainer,
      shouldPriority: shouldPriority ?? this.shouldPriority,
      shouldPriorityContainer:
          shouldPriorityContainer ?? this.shouldPriorityContainer,
      nicePriority: nicePriority ?? this.nicePriority,
      nicePriorityContainer:
          nicePriorityContainer ?? this.nicePriorityContainer,
    );
  }

  @override
  SemanticColors lerp(ThemeExtension<SemanticColors>? other, double t) {
    if (other is! SemanticColors) return this;
    return SemanticColors(
      background: Color.lerp(background, other.background, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceElevated: Color.lerp(surfaceElevated, other.surfaceElevated, t)!,
      surfaceMuted: Color.lerp(surfaceMuted, other.surfaceMuted, t)!,
      glassBorder: Color.lerp(glassBorder, other.glassBorder, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textMuted: Color.lerp(textMuted, other.textMuted, t)!,
      border: Color.lerp(border, other.border, t)!,
      borderStrong: Color.lerp(borderStrong, other.borderStrong, t)!,
      brandPrimary: Color.lerp(brandPrimary, other.brandPrimary, t)!,
      brandSecondary: Color.lerp(brandSecondary, other.brandSecondary, t)!,
      brandPressed: Color.lerp(brandPressed, other.brandPressed, t)!,
      success: Color.lerp(success, other.success, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      destructive: Color.lerp(destructive, other.destructive, t)!,
      mustPriority: Color.lerp(mustPriority, other.mustPriority, t)!,
      mustPriorityContainer: Color.lerp(
        mustPriorityContainer,
        other.mustPriorityContainer,
        t,
      )!,
      shouldPriority: Color.lerp(shouldPriority, other.shouldPriority, t)!,
      shouldPriorityContainer: Color.lerp(
        shouldPriorityContainer,
        other.shouldPriorityContainer,
        t,
      )!,
      nicePriority: Color.lerp(nicePriority, other.nicePriority, t)!,
      nicePriorityContainer: Color.lerp(
        nicePriorityContainer,
        other.nicePriorityContainer,
        t,
      )!,
    );
  }
}
