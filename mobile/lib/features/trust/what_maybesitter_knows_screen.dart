import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/error_state.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/pilot_trust.dart';
import '../pilot/pilot_state_notice.dart';
import 'pilot_trust_controller.dart';

/// The "What MaybeSitter knows" inspection surface required by V03.
///
/// It is deliberately exhaustive and boring: a complete list of what is held,
/// followed by an explicit list of what is never collected. The second list
/// matters as much as the first — a participant cannot verify an absence, so
/// the app has to state it, and the values come from the server rather than
/// from hardcoded `false`s so the promise is reported, not assumed.
class WhatMaybeSitterKnowsScreen extends ConsumerWidget {
  const WhatMaybeSitterKnowsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final state = ref.watch(pilotTrustControllerProvider);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.knowsTitle,
        subtitle: l10n.knowsSubtitle,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          tooltip: l10n.backAction,
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: switch (state.status) {
        PilotTrustStatus.loading => const Center(
          child: CircularProgressIndicator(),
        ),
        PilotTrustStatus.notAdmitted => PilotStateNotice(
          reason: state.notAdmittedReason ?? PilotStopReason.unknown,
        ),
        PilotTrustStatus.failed when state.snapshot == null => ErrorState(
          title: l10n.trustLoadFailedTitle,
          message: l10n.pilotStateOfflineMessage,
          retryLabel: l10n.retryAction,
          onRetry: () => ref.read(pilotTrustControllerProvider.notifier).load(),
        ),
        _ => _KnowsBody(knows: state.snapshot!.whatKnows),
      },
    );
  }
}

class _KnowsBody extends StatelessWidget {
  final WhatMaybeSitterKnows knows;
  const _KnowsBody({required this.knows});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Card(
            children: [
              _Row(
                icon: Icons.checklist_rounded,
                label: l10n.knowsCommitmentsLabel,
                value: l10n.knowsCommitmentsCount(knows.confirmedCommitmentCount),
              ),
              _Row(
                icon: Icons.lightbulb_outline_rounded,
                label: l10n.knowsRecommendationLabel,
                value: knows.recommendationConsent ? l10n.knowsOn : l10n.knowsOff,
              ),
              _Row(
                icon: Icons.insights_outlined,
                label: l10n.knowsAnalyticsLabel,
                value: knows.analyticsConsent ? l10n.knowsOn : l10n.knowsOff,
              ),
              _Row(
                icon: Icons.calendar_today_outlined,
                label: l10n.knowsCalendarLabel,
                value: knows.calendarConnected
                    ? l10n.knowsConnected
                    : l10n.knowsNotConnected,
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),

          Semantics(
            header: true,
            child: Text(
              l10n.knowsNeverSectionTitle,
              style: context.text.caption.copyWith(
                color: context.colors.textMuted,
                letterSpacing: 0.6,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          _Card(
            children: [
              // Rendered from the server's own values. If any of them ever came
              // back true, this screen would show it rather than keep promising
              // the capability is off.
              if (!knows.privateMessageIngestion)
                _NeverRow(label: l10n.knowsNoMessages),
              if (!knows.sensitiveInference)
                _NeverRow(label: l10n.knowsNoSensitive),
              if (!knows.medicalProfile) _NeverRow(label: l10n.knowsNoMedical),
            ],
          ),

          const SizedBox(height: AppSpacing.lg),
          _Card(
            children: [
              _Row(
                icon: Icons.badge_outlined,
                label: l10n.knowsParticipantLabel,
                value: knows.participantId,
              ),
              Text(
                l10n.knowsParticipantNote,
                style: context.text.caption.copyWith(
                  color: context.colors.textMuted,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  final List<Widget> children;
  const _Card({required this.children});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var index = 0; index < children.length; index++) ...[
            if (index > 0) const SizedBox(height: AppSpacing.md),
            children[index],
          ],
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _Row({required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    // Merged so a screen reader announces "label, value" as one item rather
    // than three disconnected fragments.
    return MergeSemantics(
      child: Row(
        children: [
          Icon(icon, size: 18, color: colors.textMuted),
          const SizedBox(width: AppSpacing.smd),
          Expanded(
            child: Text(
              label,
              style: context.text.cardTitle.copyWith(fontSize: 15),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Text(
            value,
            style: context.text.supporting.copyWith(
              color: colors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

class _NeverRow extends StatelessWidget {
  final String label;
  const _NeverRow({required this.label});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return MergeSemantics(
      child: Row(
        children: [
          Icon(Icons.block_rounded, size: 18, color: colors.textMuted),
          const SizedBox(width: AppSpacing.smd),
          Expanded(child: Text(label, style: context.text.supporting)),
        ],
      ),
    );
  }
}
