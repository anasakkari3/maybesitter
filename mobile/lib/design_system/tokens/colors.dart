import 'package:flutter/material.dart';

/// Semantic colour tokens for MaybeSitter.
///
/// Light palette follows the approved brand direction:
/// primary `#6366F1`, secondary `#10B981`, accent `#F59E0B`,
/// background `#F8FAFC`, surface `#FFFFFF`, text `#0F172A`.
///
/// Every foreground/background pair used for text in the product meets
/// WCAG AA (>= 4.5:1). Where the raw brand hue would fall short, a
/// text-safe sibling token is provided (e.g. [brandStrong], [warning]).
@immutable
class SemanticColors extends ThemeExtension<SemanticColors> {
  /// Canvas behind all screens.
  final Color background;

  /// Default card / sheet surface.
  final Color surface;

  /// Raised surface (menus, selected segment).
  final Color surfaceElevated;

  /// Recessed surface (inputs, skeletons, tracks).
  final Color surfaceMuted;

  /// Very light brand wash for informational blocks.
  final Color surfaceBrandSubtle;

  /// Hairline used on translucent surfaces.
  final Color glassBorder;

  /// Highest-emphasis text.
  final Color textPrimary;

  /// Supporting text (>= 4.5:1).
  final Color textSecondary;

  /// Lowest-emphasis text still meeting 4.5:1.
  final Color textMuted;

  /// Text/icons placed on brand fills.
  final Color textOnBrand;

  /// Default hairline border.
  final Color border;

  /// Emphasised border / control outline.
  final Color borderStrong;

  /// Focus + active input outline.
  final Color focusRing;

  /// Brand indigo (#6366F1 in light).
  final Color brandPrimary;

  /// Text-safe brand indigo for labels on background.
  final Color brandStrong;

  /// Brand surface that always carries white foreground — selected chips,
  /// checked boxes, filled buttons. Distinct from [brandStrong], which is a
  /// *foreground* token and is therefore light in the dark theme.
  final Color brandFill;

  /// Success surface that always carries white foreground — completed ticks.
  /// Distinct from [success], which is a foreground token.
  final Color successFill;

  /// Brand green (#10B981 in light).
  final Color brandSecondary;

  /// Pressed/active brand state.
  final Color brandPressed;

  /// Brand tint container.
  final Color brandSubtle;

  /// Primary CTA gradient start.
  final Color gradientStart;

  /// Primary CTA gradient end.
  final Color gradientEnd;

  /// Amber accent (#F59E0B) for decorative fills.
  final Color accent;

  /// Text-safe success.
  final Color success;

  /// Success container.
  final Color successSubtle;

  /// Text-safe warning.
  final Color warning;

  /// Warning container.
  final Color warningSubtle;

  /// Text-safe danger.
  final Color danger;

  /// Alias of danger kept for existing call sites.
  final Color destructive;

  /// Danger container.
  final Color dangerSubtle;

  /// MUST priority foreground.
  final Color mustPriority;

  /// MUST priority container.
  final Color mustPriorityContainer;

  /// SHOULD priority foreground.
  final Color shouldPriority;

  /// SHOULD priority container.
  final Color shouldPriorityContainer;

  /// NICE priority foreground.
  final Color nicePriority;

  /// NICE priority container.
  final Color nicePriorityContainer;

  /// Base shadow colour for elevation tokens.
  final Color shadow;

  /// Scrim behind modals and sheets.
  final Color overlay;

  const SemanticColors({
    required this.background,
    required this.surface,
    required this.surfaceElevated,
    required this.surfaceMuted,
    required this.surfaceBrandSubtle,
    required this.glassBorder,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.textOnBrand,
    required this.border,
    required this.borderStrong,
    required this.focusRing,
    required this.brandPrimary,
    required this.brandStrong,
    required this.brandSecondary,
    required this.brandPressed,
    required this.brandSubtle,
    required this.brandFill,
    required this.successFill,
    required this.gradientStart,
    required this.gradientEnd,
    required this.accent,
    required this.success,
    required this.successSubtle,
    required this.warning,
    required this.warningSubtle,
    required this.danger,
    required this.destructive,
    required this.dangerSubtle,
    required this.mustPriority,
    required this.mustPriorityContainer,
    required this.shouldPriority,
    required this.shouldPriorityContainer,
    required this.nicePriority,
    required this.nicePriorityContainer,
    required this.shadow,
    required this.overlay,
  });

  /// Light theme — the primary product surface.
  static const light = SemanticColors(
    background: Color(0xFFF8FAFC),
    surface: Color(0xFFFFFFFF),
    surfaceElevated: Color(0xFFFFFFFF),
    surfaceMuted: Color(0xFFF1F5F9),
    surfaceBrandSubtle: Color(0xFFEEF2FF),
    glassBorder: Color(0x14000000),
    textPrimary: Color(0xFF0F172A),
    textSecondary: Color(0xFF475569),
    textMuted: Color(0xFF64748B),
    textOnBrand: Color(0xFFFFFFFF),
    border: Color(0xFFE2E8F0),
    borderStrong: Color(0xFFCBD5E1),
    focusRing: Color(0xFF6366F1),
    brandPrimary: Color(0xFF6366F1),
    brandStrong: Color(0xFF4F46E5),
    brandSecondary: Color(0xFF10B981),
    brandPressed: Color(0xFF4338CA),
    brandSubtle: Color(0xFFEEF2FF),
    brandFill: Color(0xFF4F46E5),
    successFill: Color(0xFF047857),
    gradientStart: Color(0xFF4F46E5),
    gradientEnd: Color(0xFF7C3AED),
    accent: Color(0xFFF59E0B),
    success: Color(0xFF047857),
    successSubtle: Color(0xFFD1FAE5),
    warning: Color(0xFFB45309),
    warningSubtle: Color(0xFFFEF3C7),
    danger: Color(0xFFB91C1C),
    destructive: Color(0xFFB91C1C),
    dangerSubtle: Color(0xFFFEE2E2),
    mustPriority: Color(0xFFBE123C),
    mustPriorityContainer: Color(0xFFFFE4E6),
    shouldPriority: Color(0xFF4338CA),
    shouldPriorityContainer: Color(0xFFE0E7FF),
    nicePriority: Color(0xFFB45309),
    nicePriorityContainer: Color(0xFFFEF3C7),
    shadow: Color(0xFF0F172A),
    overlay: Color(0x800F172A),
  );

  /// Dark theme — deep navy/indigo counterpart of the light palette.
  static const dark = SemanticColors(
    background: Color(0xFF0B1020),
    surface: Color(0xFF151A2E),
    surfaceElevated: Color(0xFF1E2438),
    surfaceMuted: Color(0xFF11162A),
    surfaceBrandSubtle: Color(0xFF1E2144),
    glassBorder: Color(0x1FFFFFFF),
    textPrimary: Color(0xFFF1F5F9),
    textSecondary: Color(0xFFCBD5E1),
    textMuted: Color(0xFF94A3B8),
    textOnBrand: Color(0xFF0B1020),
    border: Color(0xFF262C42),
    borderStrong: Color(0xFF38405C),
    focusRing: Color(0xFF818CF8),
    brandPrimary: Color(0xFF818CF8),
    brandStrong: Color(0xFFA5B4FC),
    brandSecondary: Color(0xFF34D399),
    brandPressed: Color(0xFF6366F1),
    brandSubtle: Color(0xFF1E2144),
    brandFill: Color(0xFF5B54E8),
    successFill: Color(0xFF047857),
    gradientStart: Color(0xFF5B54E8),
    gradientEnd: Color(0xFF7C3AED),
    accent: Color(0xFFFBBF24),
    success: Color(0xFF34D399),
    successSubtle: Color(0xFF10301F),
    warning: Color(0xFFFBBF24),
    warningSubtle: Color(0xFF3A2A08),
    danger: Color(0xFFF87171),
    destructive: Color(0xFFF87171),
    dangerSubtle: Color(0xFF3B1416),
    mustPriority: Color(0xFFFB7185),
    mustPriorityContainer: Color(0xFF3B1220),
    shouldPriority: Color(0xFFA5B4FC),
    shouldPriorityContainer: Color(0xFF1E2144),
    nicePriority: Color(0xFFFBBF24),
    nicePriorityContainer: Color(0xFF3A2A08),
    shadow: Color(0xFF000000),
    overlay: Color(0xB3000000),
  );

  @override
  SemanticColors copyWith({
    Color? background,
    Color? surface,
    Color? surfaceElevated,
    Color? surfaceMuted,
    Color? surfaceBrandSubtle,
    Color? glassBorder,
    Color? textPrimary,
    Color? textSecondary,
    Color? textMuted,
    Color? textOnBrand,
    Color? border,
    Color? borderStrong,
    Color? focusRing,
    Color? brandPrimary,
    Color? brandStrong,
    Color? brandSecondary,
    Color? brandPressed,
    Color? brandSubtle,
    Color? brandFill,
    Color? successFill,
    Color? gradientStart,
    Color? gradientEnd,
    Color? accent,
    Color? success,
    Color? successSubtle,
    Color? warning,
    Color? warningSubtle,
    Color? danger,
    Color? destructive,
    Color? dangerSubtle,
    Color? mustPriority,
    Color? mustPriorityContainer,
    Color? shouldPriority,
    Color? shouldPriorityContainer,
    Color? nicePriority,
    Color? nicePriorityContainer,
    Color? shadow,
    Color? overlay,
  }) {
    return SemanticColors(
      background: background ?? this.background,
      surface: surface ?? this.surface,
      surfaceElevated: surfaceElevated ?? this.surfaceElevated,
      surfaceMuted: surfaceMuted ?? this.surfaceMuted,
      surfaceBrandSubtle: surfaceBrandSubtle ?? this.surfaceBrandSubtle,
      glassBorder: glassBorder ?? this.glassBorder,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textMuted: textMuted ?? this.textMuted,
      textOnBrand: textOnBrand ?? this.textOnBrand,
      border: border ?? this.border,
      borderStrong: borderStrong ?? this.borderStrong,
      focusRing: focusRing ?? this.focusRing,
      brandPrimary: brandPrimary ?? this.brandPrimary,
      brandStrong: brandStrong ?? this.brandStrong,
      brandSecondary: brandSecondary ?? this.brandSecondary,
      brandPressed: brandPressed ?? this.brandPressed,
      brandSubtle: brandSubtle ?? this.brandSubtle,
      brandFill: brandFill ?? this.brandFill,
      successFill: successFill ?? this.successFill,
      gradientStart: gradientStart ?? this.gradientStart,
      gradientEnd: gradientEnd ?? this.gradientEnd,
      accent: accent ?? this.accent,
      success: success ?? this.success,
      successSubtle: successSubtle ?? this.successSubtle,
      warning: warning ?? this.warning,
      warningSubtle: warningSubtle ?? this.warningSubtle,
      danger: danger ?? this.danger,
      destructive: destructive ?? this.destructive,
      dangerSubtle: dangerSubtle ?? this.dangerSubtle,
      mustPriority: mustPriority ?? this.mustPriority,
      mustPriorityContainer: mustPriorityContainer ?? this.mustPriorityContainer,
      shouldPriority: shouldPriority ?? this.shouldPriority,
      shouldPriorityContainer: shouldPriorityContainer ?? this.shouldPriorityContainer,
      nicePriority: nicePriority ?? this.nicePriority,
      nicePriorityContainer: nicePriorityContainer ?? this.nicePriorityContainer,
      shadow: shadow ?? this.shadow,
      overlay: overlay ?? this.overlay,
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
      surfaceBrandSubtle: Color.lerp(surfaceBrandSubtle, other.surfaceBrandSubtle, t)!,
      glassBorder: Color.lerp(glassBorder, other.glassBorder, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textMuted: Color.lerp(textMuted, other.textMuted, t)!,
      textOnBrand: Color.lerp(textOnBrand, other.textOnBrand, t)!,
      border: Color.lerp(border, other.border, t)!,
      borderStrong: Color.lerp(borderStrong, other.borderStrong, t)!,
      focusRing: Color.lerp(focusRing, other.focusRing, t)!,
      brandPrimary: Color.lerp(brandPrimary, other.brandPrimary, t)!,
      brandStrong: Color.lerp(brandStrong, other.brandStrong, t)!,
      brandSecondary: Color.lerp(brandSecondary, other.brandSecondary, t)!,
      brandPressed: Color.lerp(brandPressed, other.brandPressed, t)!,
      brandSubtle: Color.lerp(brandSubtle, other.brandSubtle, t)!,
      brandFill: Color.lerp(brandFill, other.brandFill, t)!,
      successFill: Color.lerp(successFill, other.successFill, t)!,
      gradientStart: Color.lerp(gradientStart, other.gradientStart, t)!,
      gradientEnd: Color.lerp(gradientEnd, other.gradientEnd, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      success: Color.lerp(success, other.success, t)!,
      successSubtle: Color.lerp(successSubtle, other.successSubtle, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningSubtle: Color.lerp(warningSubtle, other.warningSubtle, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      destructive: Color.lerp(destructive, other.destructive, t)!,
      dangerSubtle: Color.lerp(dangerSubtle, other.dangerSubtle, t)!,
      mustPriority: Color.lerp(mustPriority, other.mustPriority, t)!,
      mustPriorityContainer: Color.lerp(mustPriorityContainer, other.mustPriorityContainer, t)!,
      shouldPriority: Color.lerp(shouldPriority, other.shouldPriority, t)!,
      shouldPriorityContainer: Color.lerp(shouldPriorityContainer, other.shouldPriorityContainer, t)!,
      nicePriority: Color.lerp(nicePriority, other.nicePriority, t)!,
      nicePriorityContainer: Color.lerp(nicePriorityContainer, other.nicePriorityContainer, t)!,
      shadow: Color.lerp(shadow, other.shadow, t)!,
      overlay: Color.lerp(overlay, other.overlay, t)!,
    );
  }
}
