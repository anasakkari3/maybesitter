import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/date_formatter.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/capture_primary_action.dart';
import '../../design_system/components/commitment_card.dart';
import '../../design_system/components/date_group_header.dart';
import '../../design_system/components/empty_state.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/elevation.dart';
import '../../design_system/tokens/gradients.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/commitment.dart';
import '../../services/providers.dart';
import '../next_step/next_step_card.dart';

class TodayScreen extends ConsumerWidget {
  const TodayScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final l10n = context.l10n;
    final localeCode = context.currentLanguageCode;
    final commitments = ref.watch(todayCommitmentsProvider);

    final mustItems = commitments
        .where(
          (c) => c.priority == CommitmentPriority.must && !c.status.isCompleted,
        )
        .toList();
    final shouldItems = commitments
        .where(
          (c) =>
              c.priority == CommitmentPriority.should && !c.status.isCompleted,
        )
        .toList();
    final niceItems = commitments
        .where(
          (c) => c.priority == CommitmentPriority.nice && !c.status.isCompleted,
        )
        .toList();
    final completedItems = commitments
        .where((c) => c.status.isCompleted)
        .toList();

    final totalActive =
        mustItems.length + shouldItems.length + niceItems.length;

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.appName,
        subtitle: DateFormatter.formatHeaderDateWithL10n(
          DateTime.now(),
          l10n,
          localeCode,
        ),
        showLogo: true,
      ),
      // The empty state already carries the capture CTA, so showing the FAB
      // too would put two identical actions - and two identical semantics
      // nodes - on the same screen.
      floatingActionButton: commitments.isEmpty
          ? null
          : CapturePrimaryAction(onTap: () => context.push('/capture')),
      body: commitments.isEmpty
          ? EmptyState(
              icon: Icons.event_available,
              title: l10n.noCommitmentsTodayTitle,
              description: l10n.noCommitmentsTodayDesc,
              actionLabel: l10n.capturePlanAction,
              onAction: () => context.push('/capture'),
            )
          : CustomScrollView(
              slivers: [
                // Today's Header Summary Card
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.gutter,
                      AppSpacing.smd,
                      AppSpacing.gutter,
                      AppSpacing.sm,
                    ),
                    child: Container(
                      padding: const EdgeInsets.all(AppSpacing.lg),
                      decoration: BoxDecoration(
                        gradient: AppGradients.brandWash(colors),
                        color: colors.surface,
                        borderRadius: AppRadius.card,
                        border: Border.all(
                          color: colors.brandPrimary.withValues(alpha: 0.16),
                        ),
                        boxShadow: AppElevation.card(colors),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            l10n.goodMorningUser('Alex'),
                            style: context.text.heading2,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            l10n.commitmentsCountToday(totalActive),
                            style: context.text.supporting,
                          ),
                          const SizedBox(height: AppSpacing.md),
                          // Progress Bar
                          ClipRRect(
                            borderRadius: BorderRadius.circular(4),
                            child: LinearProgressIndicator(
                              value: commitments.isEmpty
                                  ? 0
                                  : completedItems.length / commitments.length,
                              backgroundColor: colors.surfaceMuted,
                              color: colors.brandStrong,
                              minHeight: 8,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),

                // The V03 one-next-step loop. It sits directly under the
                // summary and above the lists, because it is the single thing
                // the participant is meant to act on — but only once there is
                // something confirmed to reason about. Manual capture stays
                // first: with no commitments the empty state above is shown
                // instead, and nothing is proposed.
                const SliverToBoxAdapter(child: NextStepCard()),

                // MUST Priority Section
                if (mustItems.isNotEmpty) ...[
                  SliverToBoxAdapter(
                    child: DateGroupHeader(
                      title: l10n.nowGroupHeader,
                      subtitle: l10n.itemsCountLabel(mustItems.length),
                    ),
                  ),
                  SliverPadding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.md,
                    ),
                    sliver: SliverList(
                      delegate: SliverChildBuilderDelegate((context, index) {
                        final c = mustItems[index];
                        return CommitmentCard(
                          commitment: c,
                          onToggleComplete: (_) {
                            ref
                                .read(commitmentRepositoryProvider)
                                .complete(c.id);
                          },
                          onTap: () => context.push('/commitments/${c.id}'),
                        );
                      }, childCount: mustItems.length),
                    ),
                  ),
                ],

                // SHOULD Priority Section
                if (shouldItems.isNotEmpty) ...[
                  SliverToBoxAdapter(
                    child: DateGroupHeader(
                      title: l10n.laterTodayGroupHeader,
                      subtitle: l10n.itemsCountLabel(shouldItems.length),
                    ),
                  ),
                  SliverPadding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.md,
                    ),
                    sliver: SliverList(
                      delegate: SliverChildBuilderDelegate((context, index) {
                        final c = shouldItems[index];
                        return CommitmentCard(
                          commitment: c,
                          onToggleComplete: (_) {
                            ref
                                .read(commitmentRepositoryProvider)
                                .complete(c.id);
                          },
                          onTap: () => context.push('/commitments/${c.id}'),
                        );
                      }, childCount: shouldItems.length),
                    ),
                  ),
                ],

                // NICE Priority Section
                if (niceItems.isNotEmpty) ...[
                  SliverToBoxAdapter(
                    child: DateGroupHeader(
                      title: l10n.optionalGroupHeader,
                      subtitle: l10n.itemsCountLabel(niceItems.length),
                    ),
                  ),
                  SliverPadding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.md,
                    ),
                    sliver: SliverList(
                      delegate: SliverChildBuilderDelegate((context, index) {
                        final c = niceItems[index];
                        return CommitmentCard(
                          commitment: c,
                          onToggleComplete: (_) {
                            ref
                                .read(commitmentRepositoryProvider)
                                .complete(c.id);
                          },
                          onTap: () => context.push('/commitments/${c.id}'),
                        );
                      }, childCount: niceItems.length),
                    ),
                  ),
                ],

                // Completed Section
                if (completedItems.isNotEmpty) ...[
                  SliverToBoxAdapter(
                    child: DateGroupHeader(
                      title: l10n.completedGroupHeader,
                      subtitle: l10n.doneCountLabel(completedItems.length),
                    ),
                  ),
                  SliverPadding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.md,
                    ),
                    sliver: SliverList(
                      delegate: SliverChildBuilderDelegate((context, index) {
                        final c = completedItems[index];
                        return CommitmentCard(
                          commitment: c,
                          onToggleComplete: (_) {
                            // Uncheck
                            ref
                                .read(commitmentRepositoryProvider)
                                .update(
                                  c.copyWith(status: CommitmentStatus.pending),
                                );
                          },
                          onTap: () => context.push('/commitments/${c.id}'),
                        );
                      }, childCount: completedItems.length),
                    ),
                  ),
                ],
                const SliverToBoxAdapter(child: SizedBox(height: 80)),
              ],
            ),
    );
  }
}
