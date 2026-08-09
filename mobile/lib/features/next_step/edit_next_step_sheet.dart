import 'package:flutter/material.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_bottom_sheet.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_text_field.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/spacing.dart';

/// Lets the participant reword the proposed step before accepting it.
///
/// Editing is a first-class decision, not a correction of a mistake: the
/// participant knows what they will actually do better than the proposer does.
/// Returning null means they backed out, which records no decision at all.
class EditNextStepSheet extends StatefulWidget {
  final String initialTitle;

  const EditNextStepSheet({super.key, required this.initialTitle});

  static Future<String?> show({
    required BuildContext context,
    required String initialTitle,
  }) {
    return MaybesitterBottomSheet.show<String>(
      context: context,
      title: context.l10n.nextStepEditTitle,
      child: EditNextStepSheet(initialTitle: initialTitle),
    );
  }

  @override
  State<EditNextStepSheet> createState() => _EditNextStepSheetState();
}

class _EditNextStepSheetState extends State<EditNextStepSheet> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialTitle,
  );
  late String _value = widget.initialTitle;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _canSave {
    final trimmed = _value.trim();
    return trimmed.isNotEmpty && trimmed != widget.initialTitle.trim();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MaybesitterTextField(
          controller: _controller,
          label: l10n.nextStepEditFieldLabel,
          autofocus: true,
          maxLines: 3,
          onChanged: (value) => setState(() => _value = value),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(l10n.nextStepEditHelp, style: context.text.caption),
        const SizedBox(height: AppSpacing.lg),
        PrimaryButton(
          label: l10n.saveAction,
          icon: Icons.check_rounded,
          onPressed: _canSave
              ? () => Navigator.of(context).pop(_value.trim())
              : null,
        ),
        const SizedBox(height: AppSpacing.sm),
        TertiaryButton(
          label: l10n.cancelAction,
          onPressed: () => Navigator.of(context).pop(),
        ),
      ],
    );
  }
}
