import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/success_panel.dart';
import '../../services/providers.dart';
import 'capture_controller.dart';

class SuccessSaveScreen extends ConsumerWidget {
  const SuccessSaveScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final captureState = ref.watch(captureControllerProvider);
    final notifier = ref.read(captureControllerProvider.notifier);

    // Only report/undo what the server actually confirmed persisted - not
    // every item that was extracted. A deselected or failed item must never
    // be shown here as saved, and Undo must never try to delete something
    // that was never written.
    final savedItems = captureState.extractedCommitments
        .where((c) => captureState.persistedItemIds.contains(c.id))
        .toList();

    return MaybesitterScaffold(
      body: Center(
        child: SingleChildScrollView(
          child: SuccessPanel(
            title: l10n.commitmentsAddedSuccess(
              savedItems.length,
              l10n.tomorrowGroupHeader,
            ),
            subtitle: l10n.quietIntelligenceSubtitle,
            savedCommitments: savedItems,
            onViewTomorrow: () {
              notifier.reset();
              context.go('/upcoming');
            },
            onDone: () {
              notifier.reset();
              context.go('/today');
            },
            onUndo: () async {
              final repo = ref.read(commitmentRepositoryProvider);
              for (final c in savedItems) {
                await repo.delete(c.id);
              }
              notifier.reset();
              if (context.mounted) {
                context.go('/today');
              }
            },
          ),
        ),
      ),
    );
  }
}
