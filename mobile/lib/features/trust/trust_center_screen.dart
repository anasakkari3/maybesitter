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
import '../../models/calendar_import.dart';
import '../../models/commitment.dart';
import '../../models/pilot_trust.dart';
import '../../services/calendar_conflict_detector.dart';
import '../../services/apple_calendar_import_service.dart';
import '../../services/providers.dart';
import '../../services/contracts/pilot_trust_service.dart';
import '../pilot/pilot_state_notice.dart';
import 'delete_pilot_data_dialog.dart';
import 'calendar_import_controller.dart';
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

  Future<bool> _applyTrustAction(
    BuildContext context,
    WidgetRef ref,
    PilotTrustAction action, {
    String? successMessage,
  }) async {
    await _apply(context, ref, action, successMessage: successMessage);
    if (!context.mounted) return false;
    final state = ref.read(pilotTrustControllerProvider);
    return state.status != PilotTrustStatus.failed;
  }

  Future<void> _showCalendarMessage(
    BuildContext context,
    String message,
  ) async {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _enableCalendarImport(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final l10n = context.l10n;
    final calendarController = ref.read(
      calendarImportControllerProvider.notifier,
    );
    final calendarSnapshot = await calendarController.connect();
    if (!context.mounted || calendarSnapshot == null) return;
    if (!calendarSnapshot.isConnected) {
      final message = calendarSnapshot.isPermissionDenied
          ? l10n.trustCalendarPermissionDeniedMessage
          : l10n.trustCalendarUnsupportedMessage;
      await _showCalendarMessage(context, message);
      return;
    }

    final applied = await _applyTrustAction(
      context,
      ref,
      const SetCalendarConsent(true),
      successMessage: l10n.trustCalendarConnectedMessage,
    );
    if (!applied) {
      await calendarController.disconnect();
    }
  }

  Future<void> _disableCalendarConsent(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final applied = await _applyTrustAction(
      context,
      ref,
      const SetCalendarConsent(false),
    );
    if (!applied) return;
    await ref.read(calendarImportControllerProvider.notifier).disconnect();
  }

  Future<void> _refreshCalendarImport(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final l10n = context.l10n;
    final snapshot = await ref
        .read(calendarImportControllerProvider.notifier)
        .refresh();
    if (!context.mounted || snapshot == null) return;
    final message = snapshot.isConnected
        ? l10n.trustCalendarRefreshedMessage
        : l10n.trustCalendarPermissionDeniedMessage;
    await _showCalendarMessage(context, message);
  }

  Future<void> _disconnectCalendarImport(
    BuildContext context,
    WidgetRef ref,
  ) async {
    await ref.read(calendarImportControllerProvider.notifier).disconnect();
    if (!context.mounted) return;
    await _showCalendarMessage(
      context,
      context.l10n.trustCalendarDisconnectedMessage,
    );
  }

  Future<void> _deleteCalendarImportData(
    BuildContext context,
    WidgetRef ref,
  ) async {
    await ref
        .read(calendarImportControllerProvider.notifier)
        .deleteImportedData();
    if (!context.mounted) return;
    await _showCalendarMessage(
      context,
      context.l10n.trustCalendarDeletedMessage,
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final state = ref.watch(pilotTrustControllerProvider);
    final calendarImport = ref.watch(calendarImportControllerProvider);
    final commitments =
        ref.watch(commitmentsStreamProvider).value ?? const <Commitment>[];
    final conflictSummary = summarizeCalendarConflicts(
      commitments: commitments,
      calendar: calendarImport.snapshot,
    );

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
          calendarImport: calendarImport,
          conflictSummary: conflictSummary,
          busy: state.applying || calendarImport.applying,
          showActionFailure: state.status == PilotTrustStatus.failed,
          onApply: (action, {String? successMessage}) => _applyTrustAction(
            context,
            ref,
            action,
            successMessage: successMessage,
          ),
          onEnableCalendarImport: () => _enableCalendarImport(context, ref),
          onDisableCalendarConsent: () => _disableCalendarConsent(context, ref),
          onRefreshCalendarImport: () => _refreshCalendarImport(context, ref),
          onDisconnectCalendarImport: () =>
              _disconnectCalendarImport(context, ref),
          onDeleteCalendarImportData: () =>
              _deleteCalendarImportData(context, ref),
        ),
      },
    );
  }
}

typedef _ApplyAction =
    Future<bool> Function(PilotTrustAction action, {String? successMessage});

class _TrustControls extends StatelessWidget {
  final PilotTrustSnapshot snapshot;
  final CalendarImportUiState calendarImport;
  final CalendarConflictSummary conflictSummary;
  final bool busy;
  final bool showActionFailure;
  final _ApplyAction onApply;
  final Future<void> Function() onEnableCalendarImport;
  final Future<void> Function() onDisableCalendarConsent;
  final Future<void> Function() onRefreshCalendarImport;
  final Future<void> Function() onDisconnectCalendarImport;
  final Future<void> Function() onDeleteCalendarImportData;

  const _TrustControls({
    required this.snapshot,
    required this.calendarImport,
    required this.conflictSummary,
    required this.busy,
    required this.showActionFailure,
    required this.onApply,
    required this.onEnableCalendarImport,
    required this.onDisableCalendarConsent,
    required this.onRefreshCalendarImport,
    required this.onDisconnectCalendarImport,
    required this.onDeleteCalendarImportData,
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
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    MaybesitterSwitch(
                      label: l10n.trustCalendarConsentLabel,
                      description: l10n.trustCalendarConsentDescription,
                      value: trust.calendarConsent,
                      onChanged: busy
                          ? (_) {}
                          : (granted) => granted
                                ? onEnableCalendarImport()
                                : onDisableCalendarConsent(),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    _CalendarImportCard(
                      trust: trust,
                      calendarImport: calendarImport,
                      conflictSummary: conflictSummary,
                      busy: busy,
                      onRefresh: onRefreshCalendarImport,
                      onDisconnect: onDisconnectCalendarImport,
                      onDeleteData: onDeleteCalendarImportData,
                      onReconnect: onEnableCalendarImport,
                    ),
                  ],
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
              Text(l10n.trustRevokeDescription, style: context.text.supporting),
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
              Text(l10n.trustDeleteDescription, style: context.text.supporting),
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
    final applied = await onApply(
      const RevokeTrust(),
      successMessage: l10n.trustRevokedMessage,
    );
    if (!applied) return;
    await onDisconnectCalendarImport();
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final l10n = context.l10n;
    final confirmed = await DeletePilotDataDialog.show(context);
    if (confirmed != true) return;
    final applied = await onApply(
      const DeletePilotData(),
      successMessage: l10n.trustDeletedMessage,
    );
    if (!applied) return;
    await onDeleteCalendarImportData();
  }
}

class _CalendarImportCard extends StatelessWidget {
  final PilotTrustState trust;
  final CalendarImportUiState calendarImport;
  final CalendarConflictSummary conflictSummary;
  final bool busy;
  final Future<void> Function() onReconnect;
  final Future<void> Function() onRefresh;
  final Future<void> Function() onDisconnect;
  final Future<void> Function() onDeleteData;

  const _CalendarImportCard({
    required this.trust,
    required this.calendarImport,
    required this.conflictSummary,
    required this.busy,
    required this.onReconnect,
    required this.onRefresh,
    required this.onDisconnect,
    required this.onDeleteData,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final snapshot = calendarImport.snapshot;
    if (calendarImport.status == CalendarImportStatus.loading &&
        snapshot == null) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }

    final effective = snapshot ?? CalendarImportSnapshot.unsupported;
    String summary;
    if (!trust.calendarConsent) {
      summary = l10n.trustCalendarConsentOffMessage;
    } else if (!effective.isSupported) {
      summary = l10n.trustCalendarUnsupportedMessage;
    } else if (effective.isPermissionDenied) {
      summary = l10n.trustCalendarPermissionDeniedMessage;
    } else if (effective.isConnected) {
      summary = l10n.trustCalendarImportedSummary(
        effective.importedEventCount,
        AppleCalendarImportService.lookAheadDays,
      );
    } else if (effective.hasRetainedData) {
      summary = l10n.trustCalendarDisconnectedRetainedMessage(
        effective.importedEventCount,
      );
    } else {
      summary = l10n.trustCalendarNotConnectedMessage;
    }

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: context.colors.surface,
        borderRadius: AppRadius.card,
        border: Border.all(color: context.colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.trustCalendarProviderApple, style: context.text.cardTitle),
          const SizedBox(height: AppSpacing.xs),
          Text(summary, style: context.text.supporting),
          if (effective.lastSyncedAt != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              l10n.trustCalendarLastSynced(
                MaterialLocalizations.of(
                  context,
                ).formatShortDate(effective.lastSyncedAt!),
              ),
              style: context.text.caption.copyWith(
                color: context.colors.textMuted,
              ),
            ),
          ],
          if (conflictSummary.hasConflicts) ...[
            const SizedBox(height: AppSpacing.sm),
            StatusBanner(
              title: l10n.trustCalendarConflictTitle,
              message: l10n.trustCalendarConflictMessage(
                conflictSummary.commitmentCount,
                conflictSummary.busyBlockCount,
              ),
              tone: StatusBannerTone.warning,
              icon: Icons.event_busy_outlined,
            ),
          ],
          const SizedBox(height: AppSpacing.sm),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.xs,
            children: [
              if (trust.calendarConsent &&
                  !effective.isConnected &&
                  effective.isSupported)
                TertiaryButton(
                  label: l10n.trustCalendarConnectAction,
                  icon: Icons.link_rounded,
                  onPressed: busy ? null : onReconnect,
                ),
              if (effective.isConnected)
                TertiaryButton(
                  label: l10n.trustCalendarRefreshAction,
                  icon: Icons.refresh_rounded,
                  onPressed: busy ? null : onRefresh,
                ),
              if (effective.isConnected)
                TertiaryButton(
                  label: l10n.trustCalendarDisconnectAction,
                  icon: Icons.link_off_rounded,
                  onPressed: busy ? null : onDisconnect,
                ),
              if (effective.hasRetainedData)
                TertiaryButton(
                  label: l10n.trustCalendarDeleteDataAction,
                  icon: Icons.delete_outline_rounded,
                  isDestructive: true,
                  onPressed: busy ? null : onDeleteData,
                ),
            ],
          ),
        ],
      ),
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
