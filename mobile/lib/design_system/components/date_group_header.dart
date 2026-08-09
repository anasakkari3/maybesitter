import 'package:flutter/material.dart';

import 'section_header.dart';

/// Date/priority group header used by the Today and Upcoming lists.
///
/// Thin wrapper over [SectionHeader] so both screens stay in step.
class DateGroupHeader extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Color? accent;

  const DateGroupHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.accent,
  });

  @override
  Widget build(BuildContext context) {
    return SectionHeader(title: title, trailingLabel: subtitle, accent: accent);
  }
}
