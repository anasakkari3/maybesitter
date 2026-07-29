import 'package:flutter/material.dart';

/// Which platform idiom the UI should follow.
///
/// Read from the ambient [Theme] rather than `Platform.isIOS` so tests and
/// previews can force an idiom, and so a single widget tree can be exercised
/// under both without touching `dart:io`.
enum PlatformIdiom { cupertino, material }

extension PlatformIdiomX on PlatformIdiom {
  bool get isCupertino => this == PlatformIdiom.cupertino;
  bool get isMaterial => this == PlatformIdiom.material;
}

/// Platform and accessibility facts the adaptive layer needs.
///
/// Deliberately small: the branded content — cards, typography, spacing,
/// hierarchy — stays shared across platforms. Only *presentation containers*
/// (dialogs, sheets, pickers, menus, transitions) and feedback adapt.
abstract final class Adaptive {
  /// Overrides the detected idiom. Test-only.
  @visibleForTesting
  static PlatformIdiom? debugIdiomOverride;

  /// Overrides reduced-motion detection. Test-only.
  @visibleForTesting
  static bool? debugReduceMotionOverride;

  static PlatformIdiom idiomOf(BuildContext context) {
    final override = debugIdiomOverride;
    if (override != null) return override;

    return switch (Theme.of(context).platform) {
      TargetPlatform.iOS || TargetPlatform.macOS => PlatformIdiom.cupertino,
      _ => PlatformIdiom.material,
    };
  }

  static bool isCupertino(BuildContext context) => idiomOf(context).isCupertino;

  /// Whether the user has asked the system to reduce motion.
  ///
  /// Honoured by every non-essential transition in the app: they collapse to
  /// an instant cut rather than being merely shortened, because a fast
  /// animation is still motion.
  static bool reduceMotion(BuildContext context) {
    final override = debugReduceMotionOverride;
    if (override != null) return override;
    return MediaQuery.maybeDisableAnimationsOf(context) ?? false;
  }

  /// Scales a duration to respect reduced-motion, collapsing to [Duration.zero]
  /// when motion is disabled.
  static Duration motion(BuildContext context, Duration duration) =>
      reduceMotion(context) ? Duration.zero : duration;
}
