import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class MaybesitterDivider extends StatelessWidget {
  const MaybesitterDivider({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Divider(color: colors.border, thickness: 1, height: 1);
  }
}
