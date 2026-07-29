import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/gradients.dart';
import '../tokens/spacing.dart';

/// Shown while the capture pipeline is thinking. A slow brand pulse — calm,
/// not a spinner race.
class ProcessingIndicator extends StatefulWidget {
  final String label;
  final String? helperText;

  const ProcessingIndicator({
    super.key,
    this.label = 'Analyzing your plan…',
    this.helperText = 'This stays on your device.',
  });

  @override
  State<ProcessingIndicator> createState() => _ProcessingIndicatorState();
}

class _ProcessingIndicatorState extends State<ProcessingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  )..repeat(reverse: true);

  late final Animation<double> _pulse = Tween<double>(
    begin: 0.92,
    end: 1.08,
  ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          ScaleTransition(
            scale: _pulse,
            child: Container(
              width: 96,
              height: 96,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: AppGradients.primary(colors),
                boxShadow: [
                  BoxShadow(
                    color: colors.brandPrimary.withValues(alpha: 0.30),
                    blurRadius: 28,
                    spreadRadius: 2,
                  ),
                ],
              ),
              child: const Icon(
                Icons.auto_awesome_rounded,
                size: 38,
                color: Colors.white,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          Text(
            widget.label,
            textAlign: TextAlign.center,
            style: context.text.heading2,
          ),
          if (widget.helperText != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              widget.helperText!,
              textAlign: TextAlign.center,
              style: context.text.supporting,
            ),
          ],
        ],
      ),
    );
  }
}
