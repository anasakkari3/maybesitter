import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/motion.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// Single- or multi-line text input.
///
/// The container carries the state (border colour, tint) rather than the
/// Material underline, so focus reads clearly at a glance.
class MaybesitterTextField extends StatefulWidget {
  final String? label;
  final String? hint;
  final String? helperText;
  final TextEditingController? controller;
  final ValueChanged<String>? onChanged;
  final int maxLines;
  final int? minLines;
  final bool autofocus;
  final Widget? prefixIcon;
  final Widget? suffixIcon;
  final TextInputAction? textInputAction;

  const MaybesitterTextField({
    super.key,
    this.label,
    this.hint,
    this.helperText,
    this.controller,
    this.onChanged,
    this.maxLines = 1,
    this.minLines,
    this.autofocus = false,
    this.prefixIcon,
    this.suffixIcon,
    this.textInputAction,
  });

  @override
  State<MaybesitterTextField> createState() => _MaybesitterTextFieldState();
}

class _MaybesitterTextFieldState extends State<MaybesitterTextField> {
  late final FocusNode _focusNode = FocusNode()..addListener(_onFocusChange);
  bool _focused = false;

  void _onFocusChange() {
    if (!mounted) return;
    setState(() => _focused = _focusNode.hasFocus);
  }

  @override
  void dispose() {
    _focusNode
      ..removeListener(_onFocusChange)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.label != null) ...[
          Text(widget.label!, style: context.text.label),
          const SizedBox(height: AppSpacing.sm),
        ],
        AnimatedContainer(
          duration: AppMotion.fast,
          curve: AppMotion.decelerate,
          decoration: BoxDecoration(
            color: colors.surface,
            borderRadius: AppRadius.input,
            border: Border.all(
              color: _focused ? colors.focusRing : colors.border,
              width: _focused ? 2 : 1,
            ),
          ),
          child: TextField(
            controller: widget.controller,
            focusNode: _focusNode,
            onChanged: widget.onChanged,
            maxLines: widget.maxLines,
            minLines: widget.minLines,
            autofocus: widget.autofocus,
            textInputAction: widget.textInputAction,
            cursorColor: colors.brandStrong,
            cursorRadius: const Radius.circular(2),
            style: context.text.body,
            decoration: InputDecoration(
              hintText: widget.hint,
              hintStyle: context.text.body.copyWith(color: colors.textMuted),
              filled: false,
              isDense: false,
              prefixIcon: widget.prefixIcon,
              suffixIcon: widget.suffixIcon,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md,
                vertical: AppSpacing.md,
              ),
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              errorBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
            ),
          ),
        ),
        if (widget.helperText != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(widget.helperText!, style: context.text.caption),
        ],
      ],
    );
  }
}
