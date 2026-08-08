import 'package:flutter/material.dart';

enum AppThemeMode {
  system,
  light,
  dark;

  ThemeMode get toThemeMode {
    switch (this) {
      case AppThemeMode.system:
        return ThemeMode.system;
      case AppThemeMode.light:
        return ThemeMode.light;
      case AppThemeMode.dark:
        return ThemeMode.dark;
    }
  }
}

enum AppLocaleOption {
  system(null, 'System Default'),
  english(Locale('en'), 'English'),
  arabic(Locale('ar'), 'العربية (Arabic)'),
  hebrew(Locale('he'), 'עברית (Hebrew)');

  final Locale? locale;
  final String label;

  const AppLocaleOption(this.locale, this.label);
}

@immutable
class AppSettings {
  final AppThemeMode themeMode;
  final AppLocaleOption localeOption;
  final bool notificationsEnabled;
  final bool soundEffectsEnabled;
  final bool hapticFeedbackEnabled;
  final bool analyticsOptOut;
  final bool hasCompletedOnboarding;

  const AppSettings({
    this.themeMode = AppThemeMode.system,
    this.localeOption = AppLocaleOption.system,
    this.notificationsEnabled = true,
    this.soundEffectsEnabled = true,
    this.hapticFeedbackEnabled = true,
    this.analyticsOptOut = true,
    this.hasCompletedOnboarding = false,
  });

  AppSettings copyWith({
    AppThemeMode? themeMode,
    AppLocaleOption? localeOption,
    bool? notificationsEnabled,
    bool? soundEffectsEnabled,
    bool? hapticFeedbackEnabled,
    bool? analyticsOptOut,
    bool? hasCompletedOnboarding,
  }) {
    return AppSettings(
      themeMode: themeMode ?? this.themeMode,
      localeOption: localeOption ?? this.localeOption,
      notificationsEnabled: notificationsEnabled ?? this.notificationsEnabled,
      soundEffectsEnabled: soundEffectsEnabled ?? this.soundEffectsEnabled,
      hapticFeedbackEnabled:
          hapticFeedbackEnabled ?? this.hapticFeedbackEnabled,
      analyticsOptOut: analyticsOptOut ?? this.analyticsOptOut,
      hasCompletedOnboarding:
          hasCompletedOnboarding ?? this.hasCompletedOnboarding,
    );
  }
}
