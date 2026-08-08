import 'package:animations/animations.dart';
import 'package:flutter/cupertino.dart' show CupertinoPage;
import 'package:flutter/material.dart';

import 'adaptive_platform.dart';

/// Motion durations. Kept inside the ranges the design brief specifies so no
/// single transition can drift into feeling sluggish.
abstract final class AdaptiveMotion {
  /// Press feedback.
  static const Duration press = Duration(milliseconds: 100);

  /// A component changing state in place.
  static const Duration component = Duration(milliseconds: 200);

  /// A whole screen changing.
  static const Duration screen = Duration(milliseconds: 280);

  /// Hard ceiling for ordinary navigation.
  static const Duration maxNavigation = Duration(milliseconds: 400);
}

/// Route and destination transitions.
///
/// Every one of these collapses to an instant cut when the user has asked the
/// system to reduce motion — shortening is not enough, because a fast
/// animation is still animation.
abstract final class AdaptivePageTransition {
  /// Switching between bottom-navigation destinations: a fade-through, which
  /// reads as "different place, same level".
  static Widget destinationSwitcher({
    required BuildContext context,
    required Widget child,
  }) {
    final duration = Adaptive.motion(context, AdaptiveMotion.screen);

    return PageTransitionSwitcher(
      duration: duration,
      transitionBuilder: (child, primary, secondary) {
        if (duration == Duration.zero) return child;
        return FadeThroughTransition(
          animation: primary,
          secondaryAnimation: secondary,
          child: child,
        );
      },
      child: child,
    );
  }

  /// Advancing through a flow (Capture → Review → Success): a shared axis,
  /// which reads as "forward in the same task".
  static Widget flowStep({
    required BuildContext context,
    required Widget child,
    SharedAxisTransitionType type = SharedAxisTransitionType.horizontal,
  }) {
    final duration = Adaptive.motion(context, AdaptiveMotion.screen);

    return PageTransitionSwitcher(
      duration: duration,
      transitionBuilder: (child, primary, secondary) {
        if (duration == Duration.zero) return child;
        return SharedAxisTransition(
          animation: primary,
          secondaryAnimation: secondary,
          transitionType: type,
          child: child,
        );
      },
      child: child,
    );
  }

  /// A route builder for pushed pages.
  ///
  /// iOS keeps its native edge-swipe-back page transition, which users expect
  /// and which no custom animation should replace. Android gets a shared-axis
  /// transition. Reduced motion gets neither.
  static Page<T> page<T>({
    required BuildContext context,
    required LocalKey key,
    required Widget child,
  }) {
    if (Adaptive.reduceMotion(context)) {
      return NoTransitionPage<T>(key: key, child: child);
    }
    if (Adaptive.isCupertino(context)) {
      return CupertinoPage<T>(key: key, child: child);
    }
    return CustomTransitionPage<T>(
      key: key,
      transitionDuration: AdaptiveMotion.screen,
      reverseTransitionDuration: AdaptiveMotion.screen,
      child: child,
      transitionsBuilder: (context, animation, secondary, child) =>
          SharedAxisTransition(
            animation: animation,
            secondaryAnimation: secondary,
            transitionType: SharedAxisTransitionType.horizontal,
            child: child,
          ),
    );
  }
}

/// Minimal stand-ins so this file does not depend on go_router's page types
/// at the design-system layer.
class NoTransitionPage<T> extends MaterialPage<T> {
  const NoTransitionPage({required super.key, required super.child});

  @override
  Route<T> createRoute(BuildContext context) => PageRouteBuilder<T>(
    settings: this,
    transitionDuration: Duration.zero,
    reverseTransitionDuration: Duration.zero,
    pageBuilder: (_, _, _) => child,
  );
}

class CustomTransitionPage<T> extends Page<T> {
  final Widget child;
  final Duration transitionDuration;
  final Duration reverseTransitionDuration;
  final RouteTransitionsBuilder transitionsBuilder;

  const CustomTransitionPage({
    required super.key,
    required this.child,
    required this.transitionsBuilder,
    this.transitionDuration = AdaptiveMotion.screen,
    this.reverseTransitionDuration = AdaptiveMotion.screen,
  });

  @override
  Route<T> createRoute(BuildContext context) => PageRouteBuilder<T>(
    settings: this,
    transitionDuration: transitionDuration,
    reverseTransitionDuration: reverseTransitionDuration,
    pageBuilder: (_, _, _) => child,
    transitionsBuilder: transitionsBuilder,
  );
}
