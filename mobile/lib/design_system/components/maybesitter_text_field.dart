import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

class MaybesitterTextField extends StatelessWidget {
  final String? label;
  final String? hint;
  final TextEditingController? controller;
  final ValueChanged<String>? onChanged;
  final int maxLines;
  final bool autofocus;
  final Widget? prefixIcon;
  final Widget? suffixIcon;

  const MaybesitterTextField({
    super.key,
    this.label,
    this.hint,
    this.controller,
    this.onChanged,
    this.maxLines = 1,
    this.autofocus = false,
    this.prefixIcon,
    this.suffixIcon,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null) ...[
          Text(
            label!,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: colors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
        ],
        TextField(
          controller: controller,
          onChanged: onChanged,
          maxLines: maxLines,
          autofocus: autofocus,
          style: TextStyle(
            fontSize: 15,
            color: colors.textPrimary,
          ),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: TextStyle(
              fontSize: 15,
              color: colors.textMuted,
            ),
            filled: true,
            fillColor: colors.surface,
            prefixIcon: prefixIcon,
            suffixIcon: suffixIcon,
            contentPadding: const EdgeInsets.all(AppSpacing.md),
            enabledBorder: OutlineInputBorder(
              borderRadius: AppRadius.control,
              borderSide: BorderSide(color: colors.border),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: AppRadius.control,
              borderSide: BorderSide(color: colors.brandPrimary, width: 1.5),
            ),
          ),
        ),
      ],
    );
  }
}
