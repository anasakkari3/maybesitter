/**
 * Trust, consent and exposure for one user.
 *
 * ── The allowlist is gone (UC-1.0e, #144) ────────────────────────
 *
 * This module used to own the closed-pilot size bounds and the parser for
 * them: a 25–40 entry roster of hand-minted ids that
 * decided who was admitted at all. Identity is a Firebase account now and
 * anyone who signs in is a user, so membership is not a question this file
 * answers any more. What survives is everything that was always about the
 * person rather than the roster: their trust record, their consents, and the
 * exposure decision those imply.
 */
import { requireUserId } from '../storage/paths';

export type PilotStopReason =
  // No exposure decision produces `not_allowlisted` any more — the membership
  // branch that did is gone. The member survives because the staged-exposure
  // layer (`lib/release/exposure`) still refuses a participant outside the
  // *stage cohort* with that word, and both sides of that seam are pinned
  // against this union at compile time.
  | 'not_allowlisted'
  | 'wrong_instance'
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
  | { type: 'set_recommendation_consent'; granted: boolean; at: string }
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

const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function requireIsoTime(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error('timestamp must be UTC ISO time');
  }
}

/**
 * A participant id, which since UC-1.0e (#144) is a Firebase uid.
 *
 * This used to be `/^[a-z0-9][a-z0-9_-]{2,63}$/` — lowercase only, because the
 * ids were ours and we minted them in that shape. A Firebase uid is 28 mixed-
 * case characters, so that pattern rejected every real account. It delegates
 * to `requireUserId` (UC-1.0b, #141) instead, which is the same check the
 * storage layer applies to the path the record is written at: one definition
 * of "a usable id", not two that can disagree.
 *
 * It is a shape check, never an authorisation check. Admission is
 * `requireMobileUser`'s, and it is a signature.
 */
export function requirePilotParticipantId(value: string): string {
  return requireUserId(value);
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
  if (state.deletedAt) throw new Error('deleted pilot state cannot be changed');
  if (state.revokedAt && action.type !== 'delete') throw new Error('revoked pilot state can only be deleted');
  // Recording a first value that is already recorded changes nothing, so it is
  // not a backdated write — it is a no-op, and the caller asked for a state
  // that already holds.
  //
  // Two confirms racing on separate instances both read `firstValueAt: null`
  // and both send this action. One commits; the other arrives with the earlier
  // timestamp and used to be rejected as backdated, which threw out of a
  // confirm whose commitment was already persisted and returned HTTP 400 for a
  // capture that had in fact been saved. #153's staging run caught it: eight
  // captures accepted, seven commitments reported.
  //
  // The rule itself stays. It is what stops a delayed `grant` from undoing a
  // later `revoke`, and that ordering still matters for every action that
  // actually changes something.
  if (action.type === 'record_first_value' && state.firstValueAt) return state;
  if (Date.parse(action.at) < Date.parse(state.updatedAt)) throw new Error('pilot trust actions cannot be backdated');

  switch (action.type) {
    case 'grant_recommendation_consent':
      return { ...state, recommendationConsent: true, updatedAt: action.at };
    case 'set_recommendation_consent':
      return { ...state, recommendationConsent: action.granted, updatedAt: action.at };
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

/**
 * What this user may currently see.
 *
 * The `allowlist` parameter and its `not_allowlisted` branch are gone
 * (UC-1.0e, #144): every caller is an authenticated account, so there is no
 * roster left to be outside of. Order is unchanged, and it is deliberate —
 * `deleted` outranks `revoked`, an operator stop outranks a consent question,
 * and `consent_required` is last so that a user who simply has not been asked
 * yet is told that rather than something more alarming.
 */
export function decidePilotExposure(input: {
  trust: PilotTrustState;
  featureEnabled: boolean;
  killSwitchActive: boolean;
}): PilotExposureDecision {
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
