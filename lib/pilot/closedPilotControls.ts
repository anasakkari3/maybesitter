export const CLOSED_PILOT_MINIMUM = 25;
export const CLOSED_PILOT_MAXIMUM = 40;

export type PilotStopReason =
  | 'not_allowlisted'
  | 'consent_required'
  | 'quiet_mode'
  | 'revoked'
  | 'deleted'
  | 'feature_disabled'
  | 'kill_switch_active';

export interface PilotTrustState {
  version: 'v1';
  participantId: string;
  recommendationConsent: boolean;
  analyticsConsent: boolean;
  calendarConsent: boolean;
  firstValueAt: string | null;
  quietMode: boolean;
  revokedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
}

export type PilotTrustAction =
  | { type: 'grant_recommendation_consent'; at: string }
  | { type: 'set_analytics_consent'; granted: boolean; at: string }
  | { type: 'record_first_value'; at: string }
  | { type: 'set_calendar_consent'; granted: boolean; at: string }
  | { type: 'set_quiet_mode'; enabled: boolean; at: string }
  | { type: 'revoke'; at: string }
  | { type: 'delete'; at: string };

export interface PilotExposureDecision {
  allowed: boolean;
  reason: 'authorized' | PilotStopReason;
}

export interface WhatMaybeSitterKnows {
  version: 'v1';
  participantId: string;
  confirmedCommitmentCount: number;
  recommendationConsent: boolean;
  analyticsConsent: boolean;
  calendarConnected: boolean;
  privateMessageIngestion: false;
  sensitiveInference: false;
  medicalProfile: false;
}

export interface PilotAuditEvent {
  version: 'v1';
  eventType: 'exposure_checked' | 'consent_changed' | 'quiet_mode_changed' | 'revoked' | 'data_deleted';
  participantId: string;
  occurredAt: string;
  outcome: 'allowed' | 'blocked' | 'recorded';
  reasonCode: string;
}

const PARTICIPANT_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;

function requireIsoTime(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error('timestamp must be UTC ISO time');
  }
}

export function parseClosedPilotAllowlist(raw: string | undefined): ReadonlySet<string> {
  const values = (raw || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length < CLOSED_PILOT_MINIMUM || values.length > CLOSED_PILOT_MAXIMUM) {
    throw new Error(`closed pilot allowlist must contain ${CLOSED_PILOT_MINIMUM}–${CLOSED_PILOT_MAXIMUM} participants`);
  }
  if (new Set(values).size !== values.length) throw new Error('closed pilot allowlist contains duplicates');
  if (values.some((value) => !PARTICIPANT_ID.test(value))) throw new Error('closed pilot participant IDs must be pseudonymous');
  return new Set(values);
}

export function createPilotTrustState(participantId: string, at: string): PilotTrustState {
  if (!PARTICIPANT_ID.test(participantId)) throw new Error('participantId must be pseudonymous');
  requireIsoTime(at);
  return {
    version: 'v1', participantId, recommendationConsent: false, analyticsConsent: false,
    calendarConsent: false, firstValueAt: null, quietMode: false, revokedAt: null,
    deletedAt: null, updatedAt: at,
  };
}

export function applyPilotTrustAction(state: PilotTrustState, action: PilotTrustAction): PilotTrustState {
  requireIsoTime(action.at);
  if (state.deletedAt) throw new Error('deleted pilot state cannot be changed');
  if (state.revokedAt && action.type !== 'delete') throw new Error('revoked pilot state can only be deleted');

  switch (action.type) {
    case 'grant_recommendation_consent':
      return { ...state, recommendationConsent: true, updatedAt: action.at };
    case 'set_analytics_consent':
      return { ...state, analyticsConsent: action.granted, updatedAt: action.at };
    case 'record_first_value':
      return { ...state, firstValueAt: state.firstValueAt || action.at, updatedAt: action.at };
    case 'set_calendar_consent':
      if (action.granted && !state.firstValueAt) throw new Error('calendar consent is available only after first value');
      return { ...state, calendarConsent: action.granted, updatedAt: action.at };
    case 'set_quiet_mode':
      return { ...state, quietMode: action.enabled, updatedAt: action.at };
    case 'revoke':
      return {
        ...state, recommendationConsent: false, analyticsConsent: false, calendarConsent: false,
        quietMode: true, revokedAt: action.at, updatedAt: action.at,
      };
    case 'delete':
      return {
        ...state, recommendationConsent: false, analyticsConsent: false, calendarConsent: false,
        quietMode: true, deletedAt: action.at, updatedAt: action.at,
      };
  }
}

export function decidePilotExposure(input: {
  participantId: string;
  allowlist: ReadonlySet<string>;
  trust: PilotTrustState;
  featureEnabled: boolean;
  killSwitchActive: boolean;
}): PilotExposureDecision {
  if (!input.allowlist.has(input.participantId)) return { allowed: false, reason: 'not_allowlisted' };
  if (input.trust.deletedAt) return { allowed: false, reason: 'deleted' };
  if (input.trust.revokedAt) return { allowed: false, reason: 'revoked' };
  if (input.killSwitchActive) return { allowed: false, reason: 'kill_switch_active' };
  if (!input.featureEnabled) return { allowed: false, reason: 'feature_disabled' };
  if (input.trust.quietMode) return { allowed: false, reason: 'quiet_mode' };
  if (!input.trust.recommendationConsent) return { allowed: false, reason: 'consent_required' };
  return { allowed: true, reason: 'authorized' };
}

export function buildWhatMaybeSitterKnows(input: {
  trust: PilotTrustState;
  confirmedCommitmentCount: number;
}): WhatMaybeSitterKnows {
  if (!Number.isInteger(input.confirmedCommitmentCount) || input.confirmedCommitmentCount < 0) {
    throw new Error('confirmedCommitmentCount must be a non-negative integer');
  }
  return {
    version: 'v1', participantId: input.trust.participantId,
    confirmedCommitmentCount: input.confirmedCommitmentCount,
    recommendationConsent: input.trust.recommendationConsent,
    analyticsConsent: input.trust.analyticsConsent,
    calendarConnected: input.trust.calendarConsent,
    privateMessageIngestion: false, sensitiveInference: false, medicalProfile: false,
  };
}

export function createPilotAuditEvent(input: PilotAuditEvent): PilotAuditEvent {
  requireIsoTime(input.occurredAt);
  if (!PARTICIPANT_ID.test(input.participantId)) throw new Error('participantId must be pseudonymous');
  if (!/^[a-z0-9_]{2,64}$/.test(input.reasonCode)) throw new Error('reasonCode must be a safe code');
  return { ...input };
}
