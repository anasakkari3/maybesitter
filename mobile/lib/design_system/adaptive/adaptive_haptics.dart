import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Haptic vocabulary for the app.
///
/// Deliberately narrow. Haptics are reserved for moments where the user has
/// committed to something or been stopped from doing so — confirmation,
/// completion, rejection, destructive intent. They are never fired on
/// navigation, scrolling, ordinary typing or repeated list interactions,
/// where they degrade into noise.
///
/// Haptics are always *secondary* feedback: every action below also changes
/// something visible, so nothing is communicated by vibration alone.
abstract final class AdaptiveHaptics {
  /// Records calls instead of invoking the platform. Test-only.
  @visibleForTesting
  static List<String>? debugLog;

  static void _fire(String name, void Function() action) {
    final log = debugLog;
    if (log != null) {
      log.add(name);
      return;
    }
    action();
  }

  /// A proposal was confirmed, or a commitment saved.
  static void success() => _fire('success', HapticFeedback.mediumImpact);

  /// A commitment was completed.
  static void completion() => _fire('completion', HapticFeedback.lightImpact);

  /// The user tried something not currently allowed — selecting a proposal
  /// that still needs clarification, for example.
  static void rejected() => _fire('rejected', HapticFeedback.vibrate);

  /// A destructive confirmation was presented or accepted.
  static void destructive() => _fire('destructive', HapticFeedback.heavyImpact);

  /// A picker committed to a value.
  static void selection() => _fire('selection', HapticFeedback.selectionClick);
}
