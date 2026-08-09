import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utilities/l10n_extensions.dart';
import '../../design_system/components/maybesitter_buttons.dart';
import '../../design_system/theme/app_theme.dart';
import '../../design_system/tokens/elevation.dart';
import '../../design_system/tokens/radius.dart';
import '../../design_system/tokens/spacing.dart';
import '../../l10n/generated/app_localizations.dart';
import '../../models/pilot_trust.dart';
import '../../services/contracts/pilot_trust_service.dart';
import '../trust/pilot_trust_controller.dart';

/// Every reason the recommendation surface can be absent, rendered as an
/// explanation rather than an empty space.
///
/// Design rules encoded here:
///
///  * Each state says what still works ("capture still works", "nothing was
///    deleted"), because a blocked recommendation is not a broken app.
///  * A recovery action appears **only** when the participant can actually
///    perform it. Operator-side stops — suspension, kill switch, feature flag,
///    allowlist — offer no button, because offering one that cannot work is
///    worse than offering none.
///  * No wording references a browser, a web page, or a URL. The participant's
///    surface is this app.
class PilotStateNotice extends ConsumerWidget {
  final PilotStopReason reason;
  final VoidCallback? onRetry;

  /// Transport failure rather than a pilot decision.
  final bool isTransportFailure;

  const PilotStateNotice({super.key, required this.reason, this.onRetry})
    : isTransportFailure = false;

  const PilotStateNotice.transportFailure({super.key, this.onRetry})
    : reason = PilotStopReason.unknown,
      isTransportFailure = true;

  _NoticeCopy _copy(AppLocalizations l10n) {
    if (isTransportFailure) {
      return _NoticeCopy(
        title: l10n.pilotStateOfflineTitle,
        message: l10n.pilotStateOfflineMessage,
        icon: Icons.cloud_off_rounded,
        tone: _NoticeTone.neutral,
      );
    }
    return switch (reason) {
      PilotStopReason.notAllowlisted => _NoticeCopy(
        title: l10n.pilotStateUnauthorizedTitle,
        message: l10n.pilotStateUnauthorizedMessage,
        icon: Icons.person_off_outlined,
        tone: _NoticeTone.warning,
      ),
      PilotStopReason.wrongInstance => _NoticeCopy(
        title: l10n.pilotStateWrongInstanceTitle,
        message: l10n.pilotStateWrongInstanceMessage,
        icon: Icons.devices_other_outlined,
        tone: _NoticeTone.warning,
      ),
      PilotStopReason.suspended => _NoticeCopy(
        title: l10n.pilotStateSuspendedTitle,
        message: l10n.pilotStateSuspendedMessage,
        icon: Icons.pause_circle_outline_rounded,
        tone: _NoticeTone.warning,
      ),
      PilotStopReason.killSwitchActive => _NoticeCopy(
        title: l10n.pilotStatePausedTitle,
        message: l10n.pilotStatePausedMessage,
        icon: Icons.pause_circle_outline_rounded,
        tone: _NoticeTone.neutral,
      ),
      PilotStopReason.featureDisabled => _NoticeCopy(
        title: l10n.pilotStateDisabledTitle,
        message: l10n.pilotStateDisabledMessage,
        icon: Icons.toggle_off_outlined,
        tone: _NoticeTone.neutral,
      ),
      PilotStopReason.consentRequired => _NoticeCopy(
        title: l10n.pilotStateConsentRequiredTitle,
        message: l10n.pilotStateConsentRequiredMessage,
        icon: Icons.lightbulb_outline_rounded,
        tone: _NoticeTone.brand,
        actionLabel: l10n.pilotStateConsentRequiredAction,
        action: const GrantRecommendationConsent(),
      ),
      PilotStopReason.quietMode => _NoticeCopy(
        title: l10n.pilotStateQuietTitle,
        message: l10n.pilotStateQuietMessage,
        icon: Icons.notifications_off_outlined,
        tone: _NoticeTone.neutral,
        actionLabel: l10n.pilotStateQuietAction,
        action: const SetQuietMode(false),
      ),
      PilotStopReason.revoked => _NoticeCopy(
        title: l10n.pilotStateRevokedTitle,
        message: l10n.pilotStateRevokedMessage,
        icon: Icons.block_outlined,
        tone: _NoticeTone.neutral,
        actionLabel: l10n.pilotStateRevokedAction,
        action: const GrantRecommendationConsent(),
      ),
      PilotStopReason.deleted => _NoticeCopy(
        title: l10n.pilotStateDeletedTitle,
        message: l10n.pilotStateDeletedMessage,
        icon: Icons.delete_outline_rounded,
        tone: _NoticeTone.neutral,
      ),
      // `authorized` should never reach this widget, and an `unknown` reason
      // must fail closed rather than guess. Both land on the same neutral
      // "unavailable" copy.
      PilotStopReason.authorized ||
      PilotStopReason.unknown => _NoticeCopy(
        title: l10n.pilotStateUnknownTitle,
        message: l10n.pilotStateUnknownMessage,
        icon: Icons.help_outline_rounded,
        tone: _NoticeTone.neutral,
      ),
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final copy = _copy(context.l10n);
    final accent = switch (copy.tone) {
      _NoticeTone.brand => colors.brandStrong,
      _NoticeTone.warning => colors.warning,
      _NoticeTone.neutral => colors.textMuted,
    };

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.smd,
        AppSpacing.gutter,
        AppSpacing.sm,
      ),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpacing.lg),
        decoration: BoxDecoration(
          color: colors.surface,
          borderRadius: AppRadius.card,
          border: Border.all(color: accent.withValues(alpha: 0.28)),
          boxShadow: AppElevation.card(colors),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(copy.icon, size: 20, color: accent),
                const SizedBox(width: AppSpacing.smd),
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(copy.title, style: context.text.cardTitle),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(copy.message, style: context.text.supporting),
            if (copy.action != null) ...[
              const SizedBox(height: AppSpacing.lg),
              PrimaryButton(
                label: copy.actionLabel!,
                onPressed: () async {
                  await ref
                      .read(pilotTrustControllerProvider.notifier)
                      .apply(copy.action!);
                  onRetry?.call();
                },
              ),
            ] else if (isTransportFailure && onRetry != null) ...[
              const SizedBox(height: AppSpacing.lg),
              SecondaryButton(
                label: context.l10n.retryAction,
                icon: Icons.refresh_rounded,
                onPressed: onRetry,
                isFullWidth: false,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

enum _NoticeTone { brand, warning, neutral }

class _NoticeCopy {
  final String title;
  final String message;
  final IconData icon;
  final _NoticeTone tone;
  final String? actionLabel;
  final PilotTrustAction? action;

  const _NoticeCopy({
    required this.title,
    required this.message,
    required this.icon,
    required this.tone,
    this.actionLabel,
    this.action,
  });
}
