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
  eventType: 'exposure_checked' | 'consent_changed' | 'quiet_mode_changed' | 'revoked' | 'data_deleted' | 'support_reported';
  participantId: string;
  occurredAt: string;
  outcome: 'allowed' | 'blocked' | 'recorded';
  reasonCode: string;
}

export interface PilotTrustIncident {
  version: 'v1';
  incidentId: string;
  participantId: string;
  occurredAt: string;
  surface: 'capture' | 'recommendation' | 'calendar' | 'analytics' | 'account';
  category: 'reliability' | 'privacy' | 'safety' | 'consent' | 'other';
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'contained' | 'resolved';
  ownerId: string;
  containmentCode: string;
  resolutionCode: string | null;
}

const PARTICIPANT_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function requireIsoTime(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error('timestamp must be UTC ISO time');
  }
}

export function requirePilotParticipantId(value: string): string {
  if (!PARTICIPANT_ID.test(value)) throw new Error('participantId must be pseudonymous');
  return value;
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
  requirePilotParticipantId(participantId);
  requireIsoTime(at);
  return {
    version: 'v1', participantId, recommendationConsent: false, analyticsConsent: false,
    calendarConsent: false, firstValueAt: null, quietMode: false, revokedAt: null,
    deletedAt: null, updatedAt: at,
  };
}

export function requirePilotTrustState(value: unknown): PilotTrustState {
  if (!value || typeof value !== 'object') throw new Error('pilot trust state must be an object');
  const state = value as PilotTrustState;
  if (state.version !== 'v1') throw new Error('unsupported pilot trust state version');
  requirePilotParticipantId(state.participantId);
  for (const field of ['recommendationConsent', 'analyticsConsent', 'calendarConsent', 'quietMode'] as const) {
    if (typeof state[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  for (const field of ['firstValueAt', 'revokedAt', 'deletedAt'] as const) {
    if (state[field] !== null) requireIsoTime(state[field]);
  }
  requireIsoTime(state.updatedAt);
  return {
    version: 'v1', participantId: state.participantId,
    recommendationConsent: state.recommendationConsent, analyticsConsent: state.analyticsConsent,
    calendarConsent: state.calendarConsent, firstValueAt: state.firstValueAt,
    quietMode: state.quietMode, revokedAt: state.revokedAt, deletedAt: state.deletedAt,
    updatedAt: state.updatedAt,
  };
}

export function applyPilotTrustAction(state: PilotTrustState, action: PilotTrustAction): PilotTrustState {
  requireIsoTime(action.at);
  if (Date.parse(action.at) < Date.parse(state.updatedAt)) throw new Error('pilot trust actions cannot be backdated');
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
  requirePilotParticipantId(input.participantId);
  if (!SAFE_CODE.test(input.reasonCode)) throw new Error('reasonCode must be a safe code');
  if (!['exposure_checked', 'consent_changed', 'quiet_mode_changed', 'revoked', 'data_deleted', 'support_reported'].includes(input.eventType)) {
    throw new Error('unsupported pilot audit event type');
  }
  if (!['allowed', 'blocked', 'recorded'].includes(input.outcome)) throw new Error('unsupported pilot audit outcome');
  return {
    version: 'v1', eventType: input.eventType, participantId: input.participantId,
    occurredAt: input.occurredAt, outcome: input.outcome, reasonCode: input.reasonCode,
  };
}

export function createPilotTrustIncident(input: PilotTrustIncident): PilotTrustIncident {
  requireIsoTime(input.occurredAt);
  requirePilotParticipantId(input.participantId);
  for (const [name, value] of [
    ['incidentId', input.incidentId],
    ['ownerId', input.ownerId],
    ['containmentCode', input.containmentCode],
  ] as const) {
    if (!SAFE_CODE.test(value)) throw new Error(`${name} must be a safe code`);
  }
  if (input.resolutionCode !== null && !SAFE_CODE.test(input.resolutionCode)) {
    throw new Error('resolutionCode must be a safe code');
  }
  if (input.status === 'resolved' && input.resolutionCode === null) {
    throw new Error('resolved incidents require a resolutionCode');
  }
  if (!['capture', 'recommendation', 'calendar', 'analytics', 'account'].includes(input.surface)) {
    throw new Error('unsupported incident surface');
  }
  if (!['reliability', 'privacy', 'safety', 'consent', 'other'].includes(input.category)) {
    throw new Error('unsupported incident category');
  }
  if (!['low', 'medium', 'high', 'critical'].includes(input.severity)) throw new Error('unsupported incident severity');
  if (!['open', 'contained', 'resolved'].includes(input.status)) throw new Error('unsupported incident status');
  return {
    version: 'v1', incidentId: input.incidentId, participantId: input.participantId,
    occurredAt: input.occurredAt, surface: input.surface, category: input.category,
    severity: input.severity, status: input.status, ownerId: input.ownerId,
    containmentCode: input.containmentCode, resolutionCode: input.resolutionCode,
  };
}
