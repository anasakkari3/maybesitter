import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../design_system/components/clarification_card.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/capture_result.dart';
import 'capture_controller.dart';

class ClarificationSheetScreen extends ConsumerWidget {
  const ClarificationSheetScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final captureState = ref.watch(captureControllerProvider);
    final notifier = ref.read(captureControllerProvider.notifier);

    return MaybesitterScaffold(
      appBar: AppBar(
        title: const Text('Clarification'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () {
            notifier.reset();
            context.go('/today');
          },
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          children: [
            ClarificationCard(
              promptText: captureState.clarificationPrompt ??
                  'Please select how you would like this plan scheduled:',
              options: captureState.clarificationOptions,
              onSelectOption: (opt) {
                // Resolve clarification option and proceed to review
                notifier.previewState(CaptureStatus.needsConfirmation);
                context.push('/capture/review');
              },
            ),
          ],
        ),
      ),
    );
  }
}
