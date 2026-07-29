import 'package:flutter/animation.dart';

/// Motion is used sparingly: state changes and press feedback only.
abstract class AppMotion {
  static const Duration instant = Duration(milliseconds: 90);
  static const Duration fast = Duration(milliseconds: 150);
  static const Duration normal = Duration(milliseconds: 250);
  static const Duration slow = Duration(milliseconds: 400);

  static const Curve standard = Curves.easeInOutCubic;
  static const Curve decelerate = Curves.easeOutCubic;
  static const Curve spring = Cubic(0.34, 1.56, 0.64, 1.0);

  /// Scale applied while a card or button is held down.
  static const double pressScale = 0.975;
}
