import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/radius.dart';

class CapturePrimaryAction extends StatelessWidget {
  final VoidCallback onTap;
  final String label;

  const CapturePrimaryAction({
    super.key,
    required this.onTap,
    this.label = 'Capture Plan',
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        boxShadow: AppElevation.fabGlow,
      ),
      child: FloatingActionButton.extended(
        onPressed: onTap,
        backgroundColor: colors.brandPrimary,
        foregroundColor: colors.background,
        elevation: 4,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.pill),
        ),
        icon: const Icon(Icons.auto_awesome, size: 22),
        label: Text(
          label,
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w700,
            color: colors.background,
          ),
        ),
      ),
    );
  }
}
