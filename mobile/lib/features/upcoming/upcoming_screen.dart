import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/utilities/date_formatter.dart';
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
    final upcomingList = ref.watch(upcomingCommitmentsProvider);

    // Apply priority filter
    final filtered = upcomingList.where((c) {
      if (_selectedPriorityFilter == 'Must') {
        return c.priority == CommitmentPriority.must;
      }
      if (_selectedPriorityFilter == 'Should') {
        return c.priority == CommitmentPriority.should;
      }
      if (_selectedPriorityFilter == 'Nice') {
        return c.priority == CommitmentPriority.nice;
      }
      return true;
    }).toList();

    // Group by date
    final tomorrowItems =
        filtered.where((c) => DateFormatter.isTomorrow(c.scheduledDate)).toList();
    final thisWeekItems = filtered
        .where((c) =>
            DateFormatter.isThisWeek(c.scheduledDate) &&
            !DateFormatter.isTomorrow(c.scheduledDate))
        .toList();
    final laterItems = filtered
        .where((c) =>
            !DateFormatter.isThisWeek(c.scheduledDate) &&
            !DateFormatter.isTomorrow(c.scheduledDate))
        .toList();

    return MaybesitterScaffold(
      appBar: const MaybesitterAppBar(
        title: 'Upcoming Agenda',
        subtitle: 'Future commitments & reminders',
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
                  options: const {
                    ViewMode.agenda: 'Agenda',
                    ViewMode.calendar: 'Compact Calendar',
                  },
                  onSelected: (mode) => setState(() => _viewMode = mode),
                ),
                const SizedBox(height: AppSpacing.sm),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: ['All', 'Must', 'Should', 'Nice'].map((f) {
                      return Padding(
                        padding: const EdgeInsets.only(right: AppSpacing.xs),
                        child: MaybesitterChip(
                          label: f,
                          isSelected: _selectedPriorityFilter == f,
                          onTap: () => setState(() => _selectedPriorityFilter = f),
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
                    title: 'No Upcoming Commitments',
                    description:
                        'No plans scheduled for the selected filter.',
                    actionLabel: 'Capture New Plan',
                    onAction: () => context.push('/capture'),
                  )
                : CustomScrollView(
                    slivers: [
                      // Tomorrow Group
                      if (tomorrowItems.isNotEmpty) ...[
                        const SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: 'Tomorrow',
                            subtitle: 'Scheduled plans',
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate(
                              (context, index) {
                                final c = tomorrowItems[index];
                                return CommitmentCard(
                                  commitment: c,
                                  onToggleComplete: (_) {
                                    ref.read(commitmentRepositoryProvider).complete(c.id);
                                  },
                                  onTap: () => context.push('/commitments/${c.id}'),
                                );
                              },
                              childCount: tomorrowItems.length,
                            ),
                          ),
                        ),
                      ],

                      // This Week Group
                      if (thisWeekItems.isNotEmpty) ...[
                        const SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: 'This week',
                            subtitle: 'Upcoming days',
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate(
                              (context, index) {
                                final c = thisWeekItems[index];
                                return CommitmentCard(
                                  commitment: c,
                                  onToggleComplete: (_) {
                                    ref.read(commitmentRepositoryProvider).complete(c.id);
                                  },
                                  onTap: () => context.push('/commitments/${c.id}'),
                                );
                              },
                              childCount: thisWeekItems.length,
                            ),
                          ),
                        ),
                      ],

                      // Later Group
                      if (laterItems.isNotEmpty) ...[
                        const SliverToBoxAdapter(
                          child: DateGroupHeader(
                            title: 'Later',
                            subtitle: 'Future schedule',
                          ),
                        ),
                        SliverPadding(
                          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                          sliver: SliverList(
                            delegate: SliverChildBuilderDelegate(
                              (context, index) {
                                final c = laterItems[index];
                                return CommitmentCard(
                                  commitment: c,
                                  onToggleComplete: (_) {
                                    ref.read(commitmentRepositoryProvider).complete(c.id);
                                  },
                                  onTap: () => context.push('/commitments/${c.id}'),
                                );
                              },
                              childCount: laterItems.length,
                            ),
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
