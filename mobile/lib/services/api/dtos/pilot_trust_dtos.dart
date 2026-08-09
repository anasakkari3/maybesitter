import 'package:flutter/foundation.dart';

import '../../../models/pilot_trust.dart';

/// Wire shapes for pilot trust state, field-for-field with
/// `PilotTrustState`, `PilotExposureDecision` and `WhatMaybeSitterKnows` in
/// `lib/pilot/closedPilotControls.ts`.
@immutable
class PilotTrustStateDto {
  final String participantId;
  final bool recommendationConsent;
  final bool analyticsConsent;
  final bool calendarConsent;
  final String? firstValueAt;
  final bool quietMode;
  final String? revokedAt;
  final String? deletedAt;
  final String updatedAt;

  const PilotTrustStateDto({
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

  factory PilotTrustStateDto.fromJson(Map<String, dynamic> json) =>
      PilotTrustStateDto(
        participantId: json['participantId'] as String? ?? '',
        // Every consent defaults to false. A missing field must never read as
        // consent granted.
        recommendationConsent: json['recommendationConsent'] as bool? ?? false,
        analyticsConsent: json['analyticsConsent'] as bool? ?? false,
        calendarConsent: json['calendarConsent'] as bool? ?? false,
        firstValueAt: json['firstValueAt'] as String?,
        quietMode: json['quietMode'] as bool? ?? false,
        revokedAt: json['revokedAt'] as String?,
        deletedAt: json['deletedAt'] as String?,
        updatedAt: json['updatedAt'] as String? ?? '',
      );

  PilotTrustState toDomain() => PilotTrustState(
    participantId: participantId,
    recommendationConsent: recommendationConsent,
    analyticsConsent: analyticsConsent,
    calendarConsent: calendarConsent,
    firstValueAt: _parse(firstValueAt),
    quietMode: quietMode,
    revokedAt: _parse(revokedAt),
    deletedAt: _parse(deletedAt),
    updatedAt: _parse(updatedAt) ?? DateTime.now().toUtc(),
  );

  static DateTime? _parse(String? value) =>
      value == null ? null : DateTime.tryParse(value)?.toUtc();
}

@immutable
class PilotExposureDecisionDto {
  final bool allowed;
  final String reason;

  const PilotExposureDecisionDto({required this.allowed, required this.reason});

  factory PilotExposureDecisionDto.fromJson(Map<String, dynamic> json) =>
      PilotExposureDecisionDto(
        // Absent means blocked. Exposure fails closed at every layer.
        allowed: json['allowed'] as bool? ?? false,
        reason: json['reason'] as String? ?? 'unknown',
      );

  PilotExposureDecision toDomain() {
    final parsed = PilotStopReason.fromJsonString(reason);
    // An unrecognised reason is never treated as authorised, even if the
    // server said `allowed: true` — a build that cannot name the state cannot
    // explain it to the participant either.
    if (parsed == PilotStopReason.unknown) {
      return PilotExposureDecision.blockedUnknown;
    }
    return PilotExposureDecision(allowed: allowed, reason: parsed);
  }
}

@immutable
class WhatMaybeSitterKnowsDto {
  final String participantId;
  final int confirmedCommitmentCount;
  final bool recommendationConsent;
  final bool analyticsConsent;
  final bool calendarConnected;
  final bool privateMessageIngestion;
  final bool sensitiveInference;
  final bool medicalProfile;

  const WhatMaybeSitterKnowsDto({
    required this.participantId,
    required this.confirmedCommitmentCount,
    required this.recommendationConsent,
    required this.analyticsConsent,
    required this.calendarConnected,
    required this.privateMessageIngestion,
    required this.sensitiveInference,
    required this.medicalProfile,
  });

  factory WhatMaybeSitterKnowsDto.fromJson(Map<String, dynamic> json) =>
      WhatMaybeSitterKnowsDto(
        participantId: json['participantId'] as String? ?? '',
        confirmedCommitmentCount:
            (json['confirmedCommitmentCount'] as num?)?.toInt() ?? 0,
        recommendationConsent: json['recommendationConsent'] as bool? ?? false,
        analyticsConsent: json['analyticsConsent'] as bool? ?? false,
        calendarConnected: json['calendarConnected'] as bool? ?? false,
        // These three default to `true` on a malformed payload so the screen
        // can never accidentally promise a capability is off when the server
        // did not actually say so.
        privateMessageIngestion:
            json['privateMessageIngestion'] as bool? ?? true,
        sensitiveInference: json['sensitiveInference'] as bool? ?? true,
        medicalProfile: json['medicalProfile'] as bool? ?? true,
      );

  WhatMaybeSitterKnows toDomain() => WhatMaybeSitterKnows(
    participantId: participantId,
    confirmedCommitmentCount: confirmedCommitmentCount,
    recommendationConsent: recommendationConsent,
    analyticsConsent: analyticsConsent,
    calendarConnected: calendarConnected,
    privateMessageIngestion: privateMessageIngestion,
    sensitiveInference: sensitiveInference,
    medicalProfile: medicalProfile,
  );
}

@immutable
class PilotTrustSnapshotDto {
  final PilotTrustStateDto trust;
  final PilotExposureDecisionDto exposure;
  final WhatMaybeSitterKnowsDto whatKnows;

  const PilotTrustSnapshotDto({
    required this.trust,
    required this.exposure,
    required this.whatKnows,
  });

  factory PilotTrustSnapshotDto.fromJson(Map<String, dynamic> json) =>
      PilotTrustSnapshotDto(
        trust: PilotTrustStateDto.fromJson(
          json['trust'] as Map<String, dynamic>? ?? const {},
        ),
        exposure: PilotExposureDecisionDto.fromJson(
          json['exposure'] as Map<String, dynamic>? ?? const {},
        ),
        whatKnows: WhatMaybeSitterKnowsDto.fromJson(
          json['whatKnows'] as Map<String, dynamic>? ?? const {},
        ),
      );

  PilotTrustSnapshot toDomain() => PilotTrustSnapshot(
    trust: trust.toDomain(),
    exposure: exposure.toDomain(),
    whatKnows: whatKnows.toDomain(),
  );
}
