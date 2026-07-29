import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/elevation.dart';
import '../tokens/gradients.dart';
import '../tokens/motion.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'pressable.dart';

const double _kButtonHeight = 54.0;

/// The one loud button on a screen.
///
/// Filled with the indigo → violet brand gradient. There should never be two
/// of these competing in the same viewport.
class PrimaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool isLoading;
  final bool isFullWidth;

  const PrimaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.isLoading = false,
    this.isFullWidth = true,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final enabled = onPressed != null && !isLoading;

    final content = isLoading
        ? const SizedBox(
            height: 22,
            width: 22,
            child: CircularProgressIndicator(
              strokeWidth: 2.4,
              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
            ),
          )
        : Row(
            mainAxisSize: isFullWidth ? MainAxisSize.max : MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 20, color: Colors.white),
                const SizedBox(width: AppSpacing.sm),
              ],
              Flexible(
                child: Text(
                  label,
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.button.copyWith(color: Colors.white),
                ),
              ),
            ],
          );

    final button = AnimatedContainer(
      duration: AppMotion.fast,
      curve: AppMotion.decelerate,
      height: _kButtonHeight,
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: enabled ? AppGradients.primary(colors) : null,
        color: enabled ? null : colors.surfaceMuted,
        borderRadius: AppRadius.control,
        boxShadow: enabled ? AppElevation.brand(colors) : null,
      ),
      child: DefaultTextStyle.merge(
        style: TextStyle(color: enabled ? Colors.white : colors.textMuted),
        child: IconTheme.merge(
          data: IconThemeData(
            color: enabled ? Colors.white : colors.textMuted,
          ),
          child: content,
        ),
      ),
    );

    final wrapped = Pressable(
      onTap: enabled ? onPressed : null,
      borderRadius: AppRadius.control,
      semanticLabel: label,
      excludeChildSemantics: true,
      isButton: true,
      isEnabled: enabled,
      child: button,
    );

    return isFullWidth
        ? SizedBox(width: double.infinity, child: wrapped)
        : wrapped;
  }
}

/// The quiet counterpart to [PrimaryButton] — outlined, on-surface.
class SecondaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool isFullWidth;

  const SecondaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.isFullWidth = true,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final enabled = onPressed != null;

    final button = Container(
      height: _kButtonHeight,
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.control,
        border: Border.all(color: colors.borderStrong, width: 1.5),
      ),
      child: Row(
        mainAxisSize: isFullWidth ? MainAxisSize.max : MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (icon != null) ...[
            Icon(
              icon,
              size: 20,
              color: enabled ? colors.textPrimary : colors.textMuted,
            ),
            const SizedBox(width: AppSpacing.sm),
          ],
          Flexible(
            child: Text(
              label,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.button.copyWith(
                color: enabled ? colors.textPrimary : colors.textMuted,
              ),
            ),
          ),
        ],
      ),
    );

    final wrapped = Pressable(
      onTap: onPressed,
      borderRadius: AppRadius.control,
      semanticLabel: label,
      excludeChildSemantics: true,
      child: button,
    );

    return isFullWidth
        ? SizedBox(width: double.infinity, child: wrapped)
        : wrapped;
  }
}

/// Low-emphasis inline action. No container, just a tinted label.
class TertiaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool isDestructive;

  const TertiaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.isDestructive = false,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tint = isDestructive ? colors.danger : colors.brandStrong;

    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: tint,
        minimumSize: const Size(0, AppSpacing.minTouchTarget),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.smd,
          vertical: AppSpacing.sm,
        ),
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.control),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 18, color: tint),
            const SizedBox(width: AppSpacing.sm),
          ],
          Text(
            label,
            style: context.text.button.copyWith(fontSize: 15, color: tint),
          ),
        ],
      ),
    );
  }
}

/// Irreversible actions only.
class DestructiveButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  const DestructiveButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return SizedBox(
      width: double.infinity,
      child: Pressable(
        onTap: onPressed,
        borderRadius: AppRadius.control,
        semanticLabel: label,
        excludeChildSemantics: true,
        child: Container(
          height: _kButtonHeight,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          decoration: BoxDecoration(
            color: colors.dangerSubtle,
            borderRadius: AppRadius.control,
            border: Border.all(color: colors.danger.withValues(alpha: 0.35)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 20, color: colors.danger),
                const SizedBox(width: AppSpacing.sm),
              ],
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.button.copyWith(color: colors.danger),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A circular icon action sized to a comfortable 48dp touch target.
class IconActionButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onPressed;
  final String tooltip;
  final Color? color;
  final bool filled;

  const IconActionButton({
    super.key,
    required this.icon,
    this.onPressed,
    required this.tooltip,
    this.color,
    this.filled = false,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tint = color ?? colors.textSecondary;

    return IconButton(
      icon: Icon(icon, size: 22, color: tint),
      onPressed: onPressed,
      tooltip: tooltip,
      style: IconButton.styleFrom(
        backgroundColor: filled ? colors.surfaceMuted : null,
        minimumSize: const Size(
          AppSpacing.minTouchTarget,
          AppSpacing.minTouchTarget,
        ),
        shape: const CircleBorder(),
      ),
    );
  }
}
