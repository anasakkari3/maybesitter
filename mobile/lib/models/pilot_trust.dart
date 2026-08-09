import 'package:flutter/foundation.dart';

/// Why the pilot is not showing a recommendation right now.
///
/// Mirrors `PilotStopReason` in `lib/pilot/closedPilotControls.ts`, with two
/// additions the Flutter surface needs:
///
///  * [suspended] — operator-initiated removal of an authorised participant.
///    **This value does not exist in the backend contract yet** (see
///    `docs/architecture/V03_FLUTTER_PILOT_CONTRACT.md`). It is distinct from
///    [revoked], which the participant chose.
///  * [unknown] — any reason string this build does not recognise. Treated as
///    blocked, never as authorised: an unparseable reason must fail closed.
enum PilotStopReason {
  authorized,
  notAllowlisted,
  wrongInstance,
  consentRequired,
  quietMode,
  revoked,
  suspended,
  deleted,
  featureDisabled,
  killSwitchActive,
  unknown;

  static PilotStopReason fromJsonString(String? value) {
    switch (value) {
      case 'authorized':
        return PilotStopReason.authorized;
      case 'not_allowlisted':
        return PilotStopReason.notAllowlisted;
      case 'wrong_instance':
        return PilotStopReason.wrongInstance;
      case 'consent_required':
        return PilotStopReason.consentRequired;
      case 'quiet_mode':
        return PilotStopReason.quietMode;
      case 'revoked':
        return PilotStopReason.revoked;
      case 'suspended':
        return PilotStopReason.suspended;
      case 'deleted':
        return PilotStopReason.deleted;
      case 'feature_disabled':
        return PilotStopReason.featureDisabled;
      case 'kill_switch_active':
        return PilotStopReason.killSwitchActive;
      default:
        return PilotStopReason.unknown;
    }
  }

  /// True when the participant can reverse this themselves from the trust
  /// centre. Operator-side stops are not the participant's to undo, and the UI
  /// must not offer a control that cannot work.
  bool get isParticipantReversible =>
      this == PilotStopReason.quietMode ||
      this == PilotStopReason.consentRequired;
}

@immutable
class PilotExposureDecision {
  final bool allowed;
  final PilotStopReason reason;

  const PilotExposureDecision({required this.allowed, required this.reason});

  static const blockedUnknown = PilotExposureDecision(
    allowed: false,
    reason: PilotStopReason.unknown,
  );
}

@immutable
class PilotTrustState {
  final String participantId;
  final bool recommendationConsent;
  final bool analyticsConsent;
  final bool calendarConsent;

  /// Set by the backend the first time a recommendation was actually served.
  /// Calendar consent is not offered before this exists — see the progressive
  /// data-sharing ladder in the V03 runbook.
  final DateTime? firstValueAt;
  final bool quietMode;
  final DateTime? revokedAt;
  final DateTime? deletedAt;
  final DateTime updatedAt;

  const PilotTrustState({
    required this.participantId,
    required this.recommendationConsent,
    required this.analyticsConsent,
    required this.calendarConsent,
    required this.quietMode,
    required this.updatedAt,
    this.firstValueAt,
    this.revokedAt,
    this.deletedAt,
  });

  bool get hasReachedFirstValue => firstValueAt != null;
  bool get isRevoked => revokedAt != null;
  bool get isDeleted => deletedAt != null;

  /// The calendar step of the data-sharing ladder only becomes visible after
  /// the product has been useful once. Asking on first launch — merely because
  /// the feature exists — is exactly what V03 forbids.
  bool get mayOfferCalendarConsent =>
      hasReachedFirstValue && !isRevoked && !isDeleted;
}

/// The participant-inspectable "What MaybeSitter knows" view.
///
/// The three `false` fields are not padding: they are the explicit, visible
/// promise that these capabilities are off, and the screen states them even
/// though they never vary in V03.
@immutable
class WhatMaybeSitterKnows {
  final String participantId;
  final int confirmedCommitmentCount;
  final bool recommendationConsent;
  final bool analyticsConsent;
  final bool calendarConnected;
  final bool privateMessageIngestion;
  final bool sensitiveInference;
  final bool medicalProfile;

  const WhatMaybeSitterKnows({
    required this.participantId,
    required this.confirmedCommitmentCount,
    required this.recommendationConsent,
    required this.analyticsConsent,
    required this.calendarConnected,
    this.privateMessageIngestion = false,
    this.sensitiveInference = false,
    this.medicalProfile = false,
  });
}

@immutable
class PilotTrustSnapshot {
  final PilotTrustState trust;
  final PilotExposureDecision exposure;
  final WhatMaybeSitterKnows whatKnows;

  const PilotTrustSnapshot({
    required this.trust,
    required this.exposure,
    required this.whatKnows,
  });
}
