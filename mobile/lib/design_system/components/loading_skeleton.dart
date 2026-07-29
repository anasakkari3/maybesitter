import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';

/// A single shimmering placeholder block.
class LoadingSkeleton extends StatefulWidget {
  final double height;
  final double width;
  final BorderRadius? borderRadius;

  const LoadingSkeleton({
    super.key,
    this.height = 20.0,
    this.width = double.infinity,
    this.borderRadius,
  });

  @override
  State<LoadingSkeleton> createState() => _LoadingSkeletonState();
}

class _LoadingSkeletonState extends State<LoadingSkeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);

  late final Animation<double> _animation = Tween<double>(
    begin: 0.45,
    end: 1.0,
  ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return FadeTransition(
      opacity: _animation,
      child: Container(
        height: widget.height,
        width: widget.width,
        decoration: BoxDecoration(
          color: colors.surfaceMuted,
          borderRadius: widget.borderRadius ?? AppRadius.cardInner,
        ),
      ),
    );
  }
}

/// Skeleton shaped like a [CommitmentCard], for list loading states.
class CommitmentCardSkeleton extends StatelessWidget {
  const CommitmentCardSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.smd),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const LoadingSkeleton(
            height: 26,
            width: 26,
            borderRadius: BorderRadius.all(Radius.circular(13)),
          ),
          const SizedBox(width: AppSpacing.smd),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: const [
                LoadingSkeleton(height: 16, width: 180),
                SizedBox(height: AppSpacing.sm),
                LoadingSkeleton(height: 12, width: 110),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A stack of [CommitmentCardSkeleton]s.
class CommitmentListSkeleton extends StatelessWidget {
  final int itemCount;

  const CommitmentListSkeleton({super.key, this.itemCount = 3});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
      child: Column(
        children: List.generate(
          itemCount,
          (_) => const CommitmentCardSkeleton(),
        ),
      ),
    );
  }
}
