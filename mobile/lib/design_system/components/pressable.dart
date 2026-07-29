import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/motion.dart';

/// Wraps any tappable surface with a subtle press-down scale.
///
/// Cheap, consistent feedback: one place decides how "pressed" feels, so
/// cards, buttons and rows all respond identically.
class Pressable extends StatefulWidget {
  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final BorderRadius borderRadius;
  final double scale;

  /// Optional semantics label for screen readers.
  final String? semanticLabel;

  /// Whether to dim the surface while held. Disable for surfaces that already
  /// have their own pressed treatment.
  final bool showOverlay;

  /// Collapse descendants into this one semantics node. Use on buttons, whose
  /// [semanticLabel] already repeats the visible text; leave off for cards,
  /// where the metadata inside is worth announcing.
  final bool excludeChildSemantics;

  /// Announce as a button. Defaults to "tappable means button". Buttons that
  /// are currently disabled should pass `true` explicitly so they still read
  /// as buttons while reporting themselves disabled.
  final bool? isButton;

  /// Report an enabled/disabled state. Left null for surfaces like cards that
  /// have no such state.
  final bool? isEnabled;

  const Pressable({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.borderRadius = BorderRadius.zero,
    this.scale = AppMotion.pressScale,
    this.semanticLabel,
    this.showOverlay = true,
    this.excludeChildSemantics = false,
    this.isButton,
    this.isEnabled,
  });

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _pressed = false;

  void _set(bool value) {
    if (_pressed == value || widget.onTap == null) return;
    setState(() => _pressed = value);
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: widget.isButton ?? (widget.onTap != null),
      enabled: widget.isEnabled,
      label: widget.semanticLabel,
      // Carry the action on the labelled node so screen readers offer
      // "activate" on the same node that announces the label.
      onTap: widget.onTap,
      excludeSemantics: widget.excludeChildSemantics,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _set(true),
        onTapUp: (_) => _set(false),
        onTapCancel: () => _set(false),
        onTap: widget.onTap,
        onLongPress: widget.onLongPress,
        child: AnimatedScale(
          scale: _pressed ? widget.scale : 1.0,
          duration: AppMotion.instant,
          curve: AppMotion.decelerate,
          child: Stack(
            // passthrough keeps the child's constraints identical to the ones
            // Pressable received, so wrapping never changes layout.
            fit: StackFit.passthrough,
            children: [
              widget.child,
              if (widget.showOverlay)
                Positioned.fill(
                  child: IgnorePointer(
                    child: AnimatedOpacity(
                      opacity: _pressed ? 1.0 : 0.0,
                      duration: AppMotion.instant,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: context.colors.shadow.withValues(alpha: 0.06),
                          borderRadius: widget.borderRadius,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
