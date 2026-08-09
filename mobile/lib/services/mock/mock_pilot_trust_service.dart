import '../../models/pilot_trust.dart';
import '../contracts/pilot_trust_service.dart';

/// In-memory trust store used in mock mode and in widget tests.
///
/// It reproduces the backend's *decision* rules — the precedence order in
/// which exposure is refused — so the Flutter pilot-state surfaces can be
/// exercised without a server. It deliberately does not reproduce anything
/// else: allowlisting, kill switches and instance binding stay server-side.
class MockPilotTrustService implements PilotTrustService {
  PilotTrustState _trust;

  /// Operator-side conditions the participant cannot change from the app.
  final bool featureEnabled;
  final bool killSwitchActive;
  final bool allowlisted;
  final bool suspended;

  MockPilotTrustService({
    String participantId = 'pilot-participant',
    bool recommendationConsent = true,
    bool analyticsConsent = false,
    bool calendarConsent = false,
    bool quietMode = false,
    DateTime? firstValueAt,
    DateTime? revokedAt,
    DateTime? deletedAt,
    this.confirmedCommitmentCount = 3,
    this.featureEnabled = true,
    this.killSwitchActive = false,
    this.allowlisted = true,
    this.suspended = false,
  }) : _trust = PilotTrustState(
         participantId: participantId,
         recommendationConsent: recommendationConsent,
         analyticsConsent: analyticsConsent,
         calendarConsent: calendarConsent,
         quietMode: quietMode,
         firstValueAt: firstValueAt,
         revokedAt: revokedAt,
         deletedAt: deletedAt,
         updatedAt: DateTime.utc(2026, 8, 9),
       );

  int confirmedCommitmentCount;

  /// Same precedence as `resolvePilotAccess` server-side: identity, then
  /// operator stops, then participant stops, then consent.
  PilotExposureDecision get _exposure {
    if (!allowlisted) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.notAllowlisted,
      );
    }
    if (suspended) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.suspended,
      );
    }
    if (!featureEnabled) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.featureDisabled,
      );
    }
    if (killSwitchActive) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.killSwitchActive,
      );
    }
    if (_trust.isDeleted) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.deleted,
      );
    }
    if (_trust.isRevoked) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.revoked,
      );
    }
    if (!_trust.recommendationConsent) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.consentRequired,
      );
    }
    if (_trust.quietMode) {
      return const PilotExposureDecision(
        allowed: false,
        reason: PilotStopReason.quietMode,
      );
    }
    return const PilotExposureDecision(
      allowed: true,
      reason: PilotStopReason.authorized,
    );
  }

  PilotTrustSnapshot get _snapshot => PilotTrustSnapshot(
    trust: _trust,
    exposure: _exposure,
    whatKnows: WhatMaybeSitterKnows(
      participantId: _trust.participantId,
      confirmedCommitmentCount: confirmedCommitmentCount,
      recommendationConsent: _trust.recommendationConsent,
      analyticsConsent: _trust.analyticsConsent,
      calendarConnected: _trust.calendarConsent,
    ),
  );

  /// Test/mock hook mirroring the server recording first value when a
  /// recommendation is actually served.
  void recordFirstValue(DateTime at) {
    if (_trust.firstValueAt == null) {
      _trust = _copy(firstValueAt: at);
    }
  }

  @override
  Future<PilotTrustSnapshot> getSnapshot({required String participantId}) async {
    if (!allowlisted) {
      throw const PilotNotAdmittedException(PilotStopReason.notAllowlisted);
    }
    return _snapshot;
  }

  @override
  Future<PilotTrustSnapshot> apply({
    required String participantId,
    required PilotTrustAction action,
  }) async {
    if (!allowlisted) {
      throw const PilotNotAdmittedException(PilotStopReason.notAllowlisted);
    }
    final now = DateTime.now().toUtc();
    switch (action) {
      case GrantRecommendationConsent():
        // Granting consent again is the documented way back from a revoke.
        _trust = _copy(
          recommendationConsent: true,
          updatedAt: now,
          clearRevokedAt: true,
        );
      case SetRecommendationConsent(:final granted):
        // Touches recommendation consent only. Analytics consent, calendar
        // consent and the revoked marker are all left exactly as they were —
        // that separation is the whole point of this action existing.
        _trust = _copy(
          recommendationConsent: granted,
          updatedAt: now,
          // Turning suggestions back on clears a prior revoke, so the switch
          // is not a dead control after a full revoke.
          clearRevokedAt: granted,
        );
      case SetAnalyticsConsent(:final granted):
        _trust = _copy(analyticsConsent: granted, updatedAt: now);
      case SetCalendarConsent(:final granted):
        // Guards the ladder: calendar cannot be switched on before the product
        // has produced value once, even if a client asks.
        if (granted && !_trust.mayOfferCalendarConsent) return _snapshot;
        _trust = _copy(calendarConsent: granted, updatedAt: now);
      case SetQuietMode(:final enabled):
        _trust = _copy(quietMode: enabled, updatedAt: now);
      case RevokeTrust():
        // Revoke turns consent off and preserves commitments.
        _trust = _copy(
          recommendationConsent: false,
          analyticsConsent: false,
          calendarConsent: false,
          revokedAt: now,
          updatedAt: now,
        );
      case DeletePilotData():
        _trust = _copy(
          recommendationConsent: false,
          analyticsConsent: false,
          calendarConsent: false,
          deletedAt: now,
          updatedAt: now,
        );
        confirmedCommitmentCount = 0;
    }
    return _snapshot;
  }

  PilotTrustState _copy({
    bool? recommendationConsent,
    bool? analyticsConsent,
    bool? calendarConsent,
    bool? quietMode,
    DateTime? firstValueAt,
    DateTime? revokedAt,
    DateTime? deletedAt,
    DateTime? updatedAt,
    bool clearRevokedAt = false,
  }) => PilotTrustState(
    participantId: _trust.participantId,
    recommendationConsent:
        recommendationConsent ?? _trust.recommendationConsent,
    analyticsConsent: analyticsConsent ?? _trust.analyticsConsent,
    calendarConsent: calendarConsent ?? _trust.calendarConsent,
    quietMode: quietMode ?? _trust.quietMode,
    firstValueAt: firstValueAt ?? _trust.firstValueAt,
    revokedAt: clearRevokedAt ? null : (revokedAt ?? _trust.revokedAt),
    deletedAt: deletedAt ?? _trust.deletedAt,
    updatedAt: updatedAt ?? _trust.updatedAt,
  );
}
