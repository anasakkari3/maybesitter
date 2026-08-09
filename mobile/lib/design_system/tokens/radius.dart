import 'package:flutter/widgets.dart';

/// Corner radii. Generous and consistent — rounded, calm, never boxy.
abstract class AppRadius {
  static const double xs = 6.0;
  static const double sm = 10.0;
  static const double md = 14.0;
  static const double lg = 16.0;
  static const double xl = 20.0;
  static const double xxl = 24.0;
  static const double xxxl = 28.0;
  static const double pill = 999.0;

  /// Cards, panels, grouped list containers.
  static const BorderRadius card = BorderRadius.all(Radius.circular(xl));

  /// Nested surfaces inside a card.
  static const BorderRadius cardInner = BorderRadius.all(Radius.circular(md));

  /// Buttons and other primary controls.
  static const BorderRadius control = BorderRadius.all(Radius.circular(lg));

  /// Text fields / multiline inputs.
  static const BorderRadius input = BorderRadius.all(Radius.circular(lg));

  /// Chips, badges, segmented pills.
  static const BorderRadius chip = BorderRadius.all(Radius.circular(pill));

  /// Modal bottom sheets.
  static const BorderRadius sheet = BorderRadius.only(
    topLeft: Radius.circular(xxxl),
    topRight: Radius.circular(xxxl),
  );

  static const BorderRadius pillBorder = BorderRadius.all(
    Radius.circular(pill),
  );
}
