import '../../models/pilot_trust.dart';

/// The participant-facing trust actions available in V03.
///
/// Mirrors the `ClientAction` union accepted by `/api/pilot/trust`. Note that
/// `record_first_value` is deliberately absent: first value is observed by the
/// backend when a recommendation is actually served, never asserted by the
/// client.
sealed class PilotTrustAction {
  const PilotTrustAction();

  Map<String, dynamic> toJson();
}

class GrantRecommendationConsent extends PilotTrustAction {
  const GrantRecommendationConsent();

  @override
  Map<String, dynamic> toJson() => {'type': 'grant_recommendation_consent'};
}

/// Turns the recommendation surface on or off, and nothing else.
///
/// This is what the "Suggestions" switch in the trust centre sends. It is
/// deliberately narrower than [RevokeTrust]: a participant who silences
/// suggestions has not asked to withdraw analytics consent or disconnect their
/// calendar, and mapping a single switch onto a full revoke would take those
/// away without being asked.
///
/// **Pending backend support.** The current `/api/mobile/pilot/trust` action
/// union has `grant_recommendation_consent` (grant-only) and `revoke`
/// (everything). See `docs/architecture/V03_FLUTTER_PILOT_CONTRACT.md`.
class SetRecommendationConsent extends PilotTrustAction {
  final bool granted;
  const SetRecommendationConsent(this.granted);

  @override
  Map<String, dynamic> toJson() => {
    'type': 'set_recommendation_consent',
    'granted': granted,
  };
}

class SetAnalyticsConsent extends PilotTrustAction {
  final bool granted;
  const SetAnalyticsConsent(this.granted);

  @override
  Map<String, dynamic> toJson() => {
    'type': 'set_analytics_consent',
    'granted': granted,
  };
}

class SetCalendarConsent extends PilotTrustAction {
  final bool granted;
  const SetCalendarConsent(this.granted);

  @override
  Map<String, dynamic> toJson() => {
    'type': 'set_calendar_consent',
    'granted': granted,
  };
}

class SetQuietMode extends PilotTrustAction {
  final bool enabled;
  const SetQuietMode(this.enabled);

  @override
  Map<String, dynamic> toJson() => {
    'type': 'set_quiet_mode',
    'enabled': enabled,
  };
}

/// Turns off recommendation, analytics and calendar consent while preserving
/// canonical commitments. Reversible by granting consent again.
class RevokeTrust extends PilotTrustAction {
  const RevokeTrust();

  @override
  Map<String, dynamic> toJson() => {'type': 'revoke'};
}

/// Final. Deletes canonical state and analytics. Always double-confirmed.
class DeletePilotData extends PilotTrustAction {
  const DeletePilotData();

  @override
  Map<String, dynamic> toJson() => {'type': 'delete'};
}

abstract class PilotTrustService {
  Future<PilotTrustSnapshot> getSnapshot({required String participantId});

  Future<PilotTrustSnapshot> apply({
    required String participantId,
    required PilotTrustAction action,
  });
}

/// Thrown when the participant is not admitted to this pilot instance — a 403
/// from the trust endpoint. Distinct from a transport failure, because the
/// participant must be told they are not authorised rather than told to retry.
class PilotNotAdmittedException implements Exception {
  final PilotStopReason reason;
  const PilotNotAdmittedException(this.reason);

  @override
  String toString() => 'PilotNotAdmittedException: ${reason.name}';
}
