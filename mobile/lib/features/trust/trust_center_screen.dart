import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/error_state.dart';
import '../../design_system/components/maybesitter_app_bar.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/components/maybesitter_scaffold.dart';
import '../../design_system/components/maybesitter_switch.dart';
import '../../design_system/components/status_banner.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../models/pilot_trust.dart';
import '../../services/contracts/pilot_trust_service.dart';
import '../pilot/pilot_state_notice.dart';
import 'delete_pilot_data_dialog.dart';
import 'pilot_trust_controller.dart';

/// The participant's single place to see and reverse every trust decision.
///
/// Everything here is reversible except deletion, and deletion says so before
/// it happens. Nothing is buried: consent, quiet mode, revoke and delete are on
/// one screen in escalating order of consequence.
class TrustCenterScreen extends ConsumerWidget {
  const TrustCenterScreen({super.key});

  Future<void> _apply(
    BuildContext context,
    WidgetRef ref,
    PilotTrustAction action, {
    String? successMessage,
  }) async {
    await ref.read(pilotTrustControllerProvider.notifier).apply(action);
    if (!context.mounted) return;
    final state = ref.read(pilotTrustControllerProvider);
    final message = state.status == PilotTrustStatus.failed
        ? context.l10n.trustActionFailedMessage
        : (successMessage ?? context.l10n.trustUpdatedMessage);
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final state = ref.watch(pilotTrustControllerProvider);

    return MaybesitterScaffold(
      appBar: MaybesitterAppBar(
        title: l10n.trustCenterTitle,
        subtitle: l10n.trustCenterSubtitle,
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
        // A failure with no snapshot means we never loaded; a failure with one
        // means a single action failed and the controls stay usable.
        PilotTrustStatus.failed when state.snapshot == null => ErrorState(
          title: l10n.trustLoadFailedTitle,
          message: l10n.pilotStateOfflineMessage,
          retryLabel: l10n.retryAction,
          onRetry: () => ref.read(pilotTrustControllerProvider.notifier).load(),
        ),
        _ => _TrustControls(
          snapshot: state.snapshot!,
          busy: state.applying,
          showActionFailure: state.status == PilotTrustStatus.failed,
          onApply: (action, {String? successMessage}) =>
              _apply(context, ref, action, successMessage: successMessage),
        ),
      },
    );
  }
}

typedef _ApplyAction =
    Future<void> Function(PilotTrustAction action, {String? successMessage});

class _TrustControls extends StatelessWidget {
  final PilotTrustSnapshot snapshot;
  final bool busy;
  final bool showActionFailure;
  final _ApplyAction onApply;

  const _TrustControls({
    required this.snapshot,
    required this.busy,
    required this.showActionFailure,
    required this.onApply,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final trust = snapshot.trust;
    final deleted = trust.isDeleted;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (showActionFailure) ...[
            StatusBanner(
              message: l10n.trustActionFailedMessage,
              tone: StatusBannerTone.danger,
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          if (deleted) ...[
            StatusBanner(
              title: l10n.pilotStateDeletedTitle,
              message: l10n.pilotStateDeletedMessage,
              tone: StatusBannerTone.info,
            ),
            const SizedBox(height: AppSpacing.md),
          ],

          _Section(
            title: l10n.trustSectionControls,
            children: [
              MaybesitterSwitch(
                label: l10n.trustRecommendationConsentLabel,
                description: l10n.trustRecommendationConsentDescription,
                value: trust.recommendationConsent,
                // Off means "stop suggesting", not "withdraw from everything".
                // Full revoke stays a separate, confirmed action below.
                onChanged: busy || deleted
                    ? (_) {}
                    : (granted) => onApply(SetRecommendationConsent(granted)),
              ),
              MaybesitterSwitch(
                label: l10n.trustAnalyticsConsentLabel,
                description: l10n.trustAnalyticsConsentDescription,
                value: trust.analyticsConsent,
                onChanged: busy || deleted
                    ? (_) {}
                    : (granted) => onApply(SetAnalyticsConsent(granted)),
              ),
              MaybesitterSwitch(
                label: l10n.trustQuietModeLabel,
                description: l10n.trustQuietModeDescription,
                value: trust.quietMode,
                onChanged: busy || deleted
                    ? (_) {}
                    : (enabled) => onApply(SetQuietMode(enabled)),
              ),

              // The calendar rung of the data-sharing ladder. Before first
              // value it is not a disabled switch but an explanation of when
              // it will appear — the app is not withholding a feature, it is
              // declining to ask too early.
              if (trust.mayOfferCalendarConsent)
                MaybesitterSwitch(
                  label: l10n.trustCalendarConsentLabel,
                  description: l10n.trustCalendarConsentDescription,
                  value: trust.calendarConsent,
                  onChanged: busy
                      ? (_) {}
                      : (granted) => onApply(SetCalendarConsent(granted)),
                )
              else
                StatusBanner(
                  title: l10n.trustCalendarLockedTitle,
                  message: l10n.trustCalendarLockedMessage,
                  icon: Icons.calendar_today_outlined,
                ),
            ],
          ),

          const SizedBox(height: AppSpacing.lg),
          _Section(
            children: [
              // ListTile paints its ink on the nearest Material ancestor, and
              // the section's decorated container would otherwise hide it.
              Material(
                color: Colors.transparent,
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    Icons.visibility_outlined,
                    color: context.colors.brandPrimary,
                  ),
                  title: Text(l10n.trustWhatWeKnowAction),
                  subtitle: Text(l10n.trustWhatWeKnowSubtitle),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/settings/trust/knows'),
                ),
              ),
            ],
          ),

          const SizedBox(height: AppSpacing.lg),
          _Section(
            title: l10n.trustSectionEnding,
            children: [
              Text(l10n.trustRevokeTitle, style: context.text.cardTitle),
              const SizedBox(height: AppSpacing.xs),
              Text(
                l10n.trustRevokeDescription,
                style: context.text.supporting,
              ),
              const SizedBox(height: AppSpacing.smd),
              SecondaryButton(
                label: l10n.trustRevokeTitle,
                icon: Icons.power_settings_new_rounded,
                onPressed: busy || deleted || trust.isRevoked
                    ? null
                    : () => _confirmRevoke(context),
              ),
              const SizedBox(height: AppSpacing.xl),
              Text(l10n.trustDeleteTitle, style: context.text.cardTitle),
              const SizedBox(height: AppSpacing.xs),
              Text(
                l10n.trustDeleteDescription,
                style: context.text.supporting,
              ),
              const SizedBox(height: AppSpacing.smd),
              DestructiveButton(
                label: l10n.trustDeleteTitle,
                icon: Icons.delete_forever_rounded,
                onPressed: busy || deleted
                    ? null
                    : () => _confirmDelete(context),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _confirmRevoke(BuildContext context) async {
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(l10n.trustRevokeConfirmTitle),
        content: Text(l10n.trustRevokeConfirmMessage),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.cancelAction),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(l10n.trustRevokeTitle),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await onApply(const RevokeTrust(), successMessage: l10n.trustRevokedMessage);
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final l10n = context.l10n;
    final confirmed = await DeletePilotDataDialog.show(context);
    if (confirmed != true) return;
    await onApply(
      const DeletePilotData(),
      successMessage: l10n.trustDeletedMessage,
    );
  }
}

class _Section extends StatelessWidget {
  final String? title;
  final List<Widget> children;

  const _Section({this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null) ...[
          Semantics(
            header: true,
            child: Text(
              title!,
              style: context.text.caption.copyWith(
                color: colors.textMuted,
                letterSpacing: 0.6,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
        Container(
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
        ),
      ],
    );
  }
}
