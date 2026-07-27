import 'package:flutter/widgets.dart';

abstract class AppElevation {
  static const List<BoxShadow> low = [
    BoxShadow(
      color: Color(0x1F000000),
      blurRadius: 8.0,
      offset: Offset(0, 2),
    ),
  ];

  static const List<BoxShadow> medium = [
    BoxShadow(
      color: Color(0x33000000),
      blurRadius: 16.0,
      offset: Offset(0, 4),
    ),
  ];

  static const List<BoxShadow> fabGlow = [
    BoxShadow(
      color: Color(0x2639B8FD),
      blurRadius: 20.0,
      spreadRadius: 2.0,
      offset: Offset(0, 4),
    ),
  ];
}
