import 'package:flutter/material.dart';
import '../../models/commitment.dart';
import '../theme/app_theme.dart';
import '../tokens/colors.dart';
import '../tokens/radius.dart';
import '../tokens/spacing.dart';
import 'priority_badge.dart';

class CommitmentCard extends StatefulWidget {
  final Commitment commitment;
  final ValueChanged<bool?>? onToggleComplete;
  final VoidCallback? onTap;
  final VoidCallback? onMoreTap;

  const CommitmentCard({
    super.key,
    required this.commitment,
    this.onToggleComplete,
    this.onTap,
    this.onMoreTap,
  });

  @override
  State<CommitmentCard> createState() => _CommitmentCardState();
}

class _CommitmentCardState extends State<CommitmentCard> {
  bool _isPressed = false;

  Color _getAccentColor(SemanticColors colors) {
    switch (widget.commitment.priority) {
      case CommitmentPriority.must:
        return colors.mustPriority;
      case CommitmentPriority.should:
        return colors.shouldPriority;
      case CommitmentPriority.nice:
        return colors.nicePriority;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isDone = widget.commitment.status.isCompleted;
    final accentColor = _getAccentColor(colors);

    return AnimatedScale(
      scale: _isPressed ? 0.98 : 1.0,
      duration: const Duration(milliseconds: 100),
      child: Container(
        margin: const EdgeInsets.only(bottom: AppSpacing.sm),
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: AppRadius.card,
          border: Border.all(color: colors.border, width: 1),
        ),
        child: ClipRRect(
          borderRadius: AppRadius.card,
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Left Priority Accent Bar
                Container(
                  width: 4,
                  color: isDone ? colors.textMuted : accentColor,
                ),
                Expanded(
                  child: InkWell(
                    onTapDown: (_) => setState(() => _isPressed = true),
                    onTapUp: (_) => setState(() => _isPressed = false),
                    onTapCancel: () => setState(() => _isPressed = false),
                    onTap: widget.onTap,
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.md),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              // Completion Checkbox
                              InkWell(
                                onTap: () =>
                                    widget.onToggleComplete?.call(!isDone),
                                borderRadius: BorderRadius.circular(20),
                                child: Container(
                                  width: 24,
                                  height: 24,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: isDone
                                        ? colors.success
                                        : Colors.transparent,
                                    border: Border.all(
                                      color: isDone
                                          ? colors.success
                                          : colors.borderStrong,
                                      width: 2,
                                    ),
                                  ),
                                  child: isDone
                                      ? const Icon(
                                          Icons.check,
                                          size: 16,
                                          color: Colors.white,
                                        )
                                      : null,
                                ),
                              ),
                              const SizedBox(width: AppSpacing.md),
                              // Title and Time/Location
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      widget.commitment.title,
                                      style: TextStyle(
                                        fontSize: 16,
                                        fontWeight: FontWeight.w600,
                                        color: isDone
                                            ? colors.textMuted
                                            : colors.textPrimary,
                                        decoration: isDone
                                            ? TextDecoration.lineThrough
                                            : null,
                                      ),
                                    ),
                                    if (widget.commitment.startTime != null ||
                                        widget.commitment.location != null) ...[
                                      const SizedBox(height: 4),
                                      Wrap(
                                        spacing: AppSpacing.sm,
                                        runSpacing: 4,
                                        crossAxisAlignment:
                                            WrapCrossAlignment.center,
                                        children: [
                                          if (widget.commitment.startTime !=
                                              null)
                                            InlineTimeChip(
                                              time:
                                                  widget.commitment.startTime!,
                                              color: colors.textSecondary,
                                              iconColor: colors.textMuted,
                                            ),
                                          if (widget.commitment.location !=
                                              null)
                                            InlineLocationChip(
                                              location:
                                                  widget.commitment.location!,
                                              color: colors.textSecondary,
                                              iconColor: colors.textMuted,
                                            ),
                                        ],
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                              const SizedBox(width: AppSpacing.xs),
                              PriorityBadge(
                                priority: widget.commitment.priority,
                              ),
                            ],
                          ),
                          if (widget.commitment.description != null &&
                              widget.commitment.description!.isNotEmpty) ...[
                            const SizedBox(height: AppSpacing.sm),
                            Padding(
                              padding: const EdgeInsets.only(left: 36.0),
                              child: Text(
                                widget.commitment.description!,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 13,
                                  color: colors.textSecondary,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class InlineTimeChip extends StatelessWidget {
  final String time;
  final Color color;
  final Color iconColor;

  const InlineTimeChip({
    super.key,
    required this.time,
    required this.color,
    required this.iconColor,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 160),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.schedule, size: 14, color: iconColor),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              time,
              style: TextStyle(
                fontSize: 13,
                color: color,
                fontWeight: FontWeight.w500,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class InlineLocationChip extends StatelessWidget {
  final String location;
  final Color color;
  final Color iconColor;

  const InlineLocationChip({
    super.key,
    required this.location,
    required this.color,
    required this.iconColor,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 160),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.location_on_outlined, size: 14, color: iconColor),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              location,
              style: TextStyle(fontSize: 13, color: color),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}
