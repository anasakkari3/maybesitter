import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/spacing.dart';

/// Two-step confirmation for the one irreversible action in the pilot.
///
/// The confirm button stays disabled until the participant explicitly ticks
/// the acknowledgement. A single tap on a red button is too easy to do by
/// accident for something that cannot be undone, and the checkbox makes the
/// consequence something the participant has to read rather than dismiss.
class DeletePilotDataDialog extends StatefulWidget {
  const DeletePilotDataDialog({super.key});

  static Future<bool?> show(BuildContext context) => showDialog<bool>(
    context: context,
    builder: (_) => const DeletePilotDataDialog(),
  );

  @override
  State<DeletePilotDataDialog> createState() => _DeletePilotDataDialogState();
}

class _DeletePilotDataDialogState extends State<DeletePilotDataDialog> {
  bool _acknowledged = false;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final colors = context.colors;

    return AlertDialog(
      title: Text(l10n.trustDeleteConfirmTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.trustDeleteConfirmMessage, style: context.text.supporting),
          const SizedBox(height: AppSpacing.md),
          InkWell(
            onTap: () => setState(() => _acknowledged = !_acknowledged),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Checkbox(
                  value: _acknowledged,
                  onChanged: (value) =>
                      setState(() => _acknowledged = value ?? false),
                ),
                Expanded(
                  child: Text(
                    l10n.trustDeleteAcknowledge,
                    style: context.text.supporting,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(l10n.cancelAction),
        ),
        TextButton(
          onPressed: _acknowledged
              ? () => Navigator.of(context).pop(true)
              : null,
          style: TextButton.styleFrom(foregroundColor: colors.danger),
          child: Text(l10n.trustDeleteTitle),
        ),
      ],
    );
  }
}
