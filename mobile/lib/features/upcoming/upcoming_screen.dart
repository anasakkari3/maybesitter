import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/date_formatter.dart';
import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/commitment_card.dart';
import '../../design_system/components/date_group_header.dart';
import '../../design_system/components/empty_state.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_chip.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/maybesitter_segmented_control.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/commitment.dart';
import '../../services/providers.dart';

enum ViewMode { agenda, calendar }

class UpcomingScreen extends ConsumerStatefulWidget {
  const UpcomingScreen({super.key});

  @override
  ConsumerState<UpcomingScreen> createState() => _UpcomingScreenState();
}

class _UpcomingScreenState extends ConsumerState<UpcomingScreen> {
  ViewMode _viewMode = ViewMode.agenda;
  String _selectedPriorityFilter = 'All';

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final upcomingList = ref.watch(upcomingCommitmentsProvider);
    final noDateList = ref.watch(noDateCommitmentsProvider);
    final overdueList = ref.watch(overdueCommitmentsProvider);

    final combinedList = [...overdueList, ...upcomingList, ...noDateList];

    // Apply priority filter
    final filtered = combinedList.where((c) {
      if (_selectedPriorityFilter == l10n.priorityMust ||
          _selectedPriorityFilter == 'Must') {
        return c.priority == CommitmentPriority.must;
      }
      if (_selectedPriorityFilter == l10n.priorityShould ||
          _selectedPriorityFilter == 'Should') {
        return c.priority == CommitmentPriority.should;
      }
      if (_selectedPriorityFilter == l10n.priorityNice ||
          _selectedPriorityFilter == 'Nice') {
        return c.priority == CommitmentPriority.nice;
      }
      return true;
    }).toList();

    // Grouping
    final overdueItems = filtered
        .where(
          (c) =>
              c.scheduledDate != null &&
              DateFormatter.isBeforeToday(c.scheduledDate!),
        )
        .toList();
    final tomorrowItems = filtered
        .where(
          (c) =>
              c.scheduledDate != null &&
              DateFormatter.isTomorrow(c.scheduledDate!),
        )
        .toList();
    final thisWeekItems = filtered
        .where(
          (c) =>
              c.scheduledDate != null &&
              DateFormatter.isThisWeek(c.scheduledDate!) &&
              !DateFormatter.isTomorrow(c.scheduledDate!) &&
              !DateFormatter.isBeforeToday(c.scheduledDate!),
        )
        .toList();
    final laterItems = filtered
        .where(
          (c) =>
              c.scheduledDate != null &&
              !DateFormatter.isThisWeek(c.scheduledDate!) &&
              !DateFormatter.isTomorrow(c.scheduledDate!) &&
              !DateFormatter.isBeforeToday(c.scheduledDate!),
        )
        .toList();
    final noDateItems = filtered.where((c) => c.scheduledDate == null).toList();

    final priorityFilters = [
      l10n.priorityFilterAll,
      l10n.priorityMust,
      l10n.priorityShould,
      l10n.priorityNice,
    ];

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.upcomingTab,
        subtitle: l10n.upcomingTab,
      ),
      body: Column(
        children: [
          // View Mode & Filter Controls
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: AppSpacing.sm,
            ),
            child: Column(
              children: [
                MaybesitterSegmentedControl<ViewMode>(
                  selectedValue: _viewMode,
                  options: {
                    ViewMode.agenda: l10n.agendaView,
                    ViewMode.calendar: l10n.compactCalendarView,
                  },
                  onSelected: (mode) => setState(() => _viewMode = mode),
                ),
                const SizedBox(height: AppSpacing.sm),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: priorityFilters.map((f) {
                      return Padding(
                        padding: const EdgeInsets.only(right: AppSpacing.xs),
                        child: MaybesitterChip(
                          label: f,
                          isSelected:
                              _selectedPriorityFilter == f ||
                              (_selectedPriorityFilter == 'All' &&
                                  f == l10n.priorityFilterAll),
                          onTap: () =>
                              setState(() => _selectedPriorityFilter = f),
                        ),
                      );
                    }).toList(),
                  ),
                ),
              ],
            ),
          ),

          Expanded(
            child: filtered.isEmpty
                ? EmptyState(
                    icon: Icons.calendar_month,
                    title: l10n.noUpcomingCommitmentsTitle,
                    description: l10n.noUpcomingCommitmentsDesc,
                    actionLabel: l10n.capturePlanAction,
                    onAction: () => context.push('/capture'),
                  )
                : CustomScrollView(
                    slivers: [
                      // Overdue Group
                      if (overdueItems.isNotEmpty) ...[
                        SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: l10n.overdueGroupHeader,
                            subtitle: l10n.itemsCountLabel(overdueItems.length),
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.md,
                          ),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate((
                              context,
                              index,
                            ) {
                              final c = overdueItems[index];
                              return CommitmentCard(
                                commitment: c,
                                onToggleComplete: (_) {
                                  ref
                                      .read(commitmentRepositoryProvider)
                                      .complete(c.id);
                                },
                                onTap: () =>
                                    context.push('/commitments/${c.id}'),
                              );
                            }, childCount: overdueItems.length),
                          ),
                        ),
                      ],

                      // Tomorrow Group
                      if (tomorrowItems.isNotEmpty) ...[
                        SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: l10n.tomorrowGroupHeader,
                            subtitle: l10n.itemsCountLabel(
                              tomorrowItems.length,
                            ),
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.md,
                          ),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate((
                              context,
                              index,
                            ) {
                              final c = tomorrowItems[index];
                              return CommitmentCard(
                                commitment: c,
                                onToggleComplete: (_) {
                                  ref
                                      .read(commitmentRepositoryProvider)
                                      .complete(c.id);
                                },
                                onTap: () =>
                                    context.push('/commitments/${c.id}'),
                              );
                            }, childCount: tomorrowItems.length),
                          ),
                        ),
                      ],

                      // This Week Group
                      if (thisWeekItems.isNotEmpty) ...[
                        SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: l10n.thisWeekGroupHeader,
                            subtitle: l10n.itemsCountLabel(
                              thisWeekItems.length,
                            ),
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.md,
                          ),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate((
                              context,
                              index,
                            ) {
                              final c = thisWeekItems[index];
                              return CommitmentCard(
                                commitment: c,
                                onToggleComplete: (_) {
                                  ref
                                      .read(commitmentRepositoryProvider)
                                      .complete(c.id);
                                },
                                onTap: () =>
                                    context.push('/commitments/${c.id}'),
                              );
                            }, childCount: thisWeekItems.length),
                          ),
                        ),
                      ],

                      // Later Group
                      if (laterItems.isNotEmpty) ...[
                        SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: l10n.laterGroupHeader,
                            subtitle: l10n.itemsCountLabel(laterItems.length),
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.md,
                          ),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate((
                              context,
                              index,
                            ) {
                              final c = laterItems[index];
                              return CommitmentCard(
                                commitment: c,
                                onToggleComplete: (_) {
                                  ref
                                      .read(commitmentRepositoryProvider)
                                      .complete(c.id);
                                },
                                onTap: () =>
                                    context.push('/commitments/${c.id}'),
                              );
                            }, childCount: laterItems.length),
                          ),
                        ),
                      ],

                      // No Date Group
                      if (noDateItems.isNotEmpty) ...[
                        SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: l10n.noDateGroupHeader,
                            subtitle: l10n.itemsCountLabel(noDateItems.length),
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.md,
                          ),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate((
                              context,
                              index,
                            ) {
                              final c = noDateItems[index];
                              return CommitmentCard(
                                commitment: c,
                                onToggleComplete: (_) {
                                  ref
                                      .read(commitmentRepositoryProvider)
                                      .complete(c.id);
                                },
                                onTap: () =>
                                    context.push('/commitments/${c.id}'),
                              );
                            }, childCount: noDateItems.length),
                          ),
                        ),
                      ],

                      const SliverToBoxAdapter(child: SizedBox(height: 40)),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
