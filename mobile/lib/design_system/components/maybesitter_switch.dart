import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tokens/spacing.dart';

class MaybesitterSwitch extends StatelessWidget {
  final bool value;
  final ValueChanged<bool> onChanged;
  final String label;
  final String? description;

  const MaybesitterSwitch({
    super.key,
    required this.value,
    required this.onChanged,
    required this.label,
    this.description,
  });

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: AppSpacing.minTouchTarget),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: context.text.cardTitle.copyWith(fontSize: 15),
                ),
                if (description != null) ...[
                  const SizedBox(height: 2),
                  Text(description!, style: context.text.caption),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Switch.adaptive(value: value, onChanged: onChanged),
        ],
      ),
    );
  }
}
