import { randomUUID } from 'node:crypto';
import { analyticsContextFrom } from '../../analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../analytics/eventStore';
import { recordDataDeleted } from '../../analytics/loopAnalytics';
import { resolveNextStepArm } from '../../experiments/experimentControls';
import {
  buildWhatMaybeSitterKnows,
  createPilotAuditEvent,
  createPilotTrustIncident,
  requirePilotParticipantId,
  type PilotTrustAction,
  type PilotTrustIncident,
  type PilotTrustState,
} from '../../pilot/closedPilotControls';
import { resolvePilotAccess } from '../../pilot/pilotAccess';
import { getPilotTrustStore } from '../../pilot/pilotTrustStore';
import { resetSingleUserAccount } from '../appMetadataService';
import { getCommandServiceState } from '../commandService';
import { getLiveNextStep, recordLiveNextStepDecision } from '../nextStepLiveService';
import type {
  NextStepDecision,
  NextStepLocale,
  NextStepRecommendationContract,
} from '../../../src/contracts/v1/nextStepContracts';

type MobilePilotSource = Record<string, unknown>;

type MobileTrustAction =
  | { type: 'grant_recommendation_consent' }
  | { type: 'set_recommendation_consent'; granted?: unknown }
  | { type: 'set_analytics_consent'; granted?: unknown }
  | { type: 'set_calendar_consent'; granted?: unknown }
  | { type: 'set_quiet_mode'; enabled?: unknown }
  | { type: 'revoke' }
  | { type: 'delete' };

export class MobilePilotError extends Error {
  constructor(message: string, readonly status = 400, readonly reason?: string) {
    super(message);
  }
}

export function mobilePilotErrorResponse(error: unknown): Response {
  if (error instanceof MobilePilotError) {
    return Response.json(
      { success: false, error: error.message, ...(error.reason ? { reason: error.reason } : {}) },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : 'mobile pilot request failed';
  const status = /allowlist must contain|instance participant binding is required/.test(message)
    ? 503
    : /not admitted|not allowlisted|wrong_instance|consent_required|quiet_mode|revoked|deleted|feature_disabled|kill_switch_active/.test(message)
      ? 403
      : 400;
  return Response.json({ success: false, error: message }, { status });
}

function stringValue(source: MobilePilotSource, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

function localeFrom(value: unknown): NextStepLocale {
  return value === 'ar' || value === 'he' ? value : 'en';
}

function participantIdentity(source: MobilePilotSource): string {
  const participantId = stringValue(source, 'participantId') || stringValue(source, 'anonymousUserId');
  if (!participantId) throw new MobilePilotError('participantId is required', 400);
  requirePilotParticipantId(participantId);
  const scopeId = stringValue(source, 'scopeId');
  if (scopeId && scopeId !== participantId) {
    throw new MobilePilotError('scopeId must match participantId', 403, 'wrong_scope');
  }
  return participantId;
}

function confirmedCommitmentCount(): number {
  return Object.values(getCommandServiceState().commitments)
    .filter((commitment) => Boolean(commitment.confirmedAt)).length;
}

function trustAction(value: unknown, at: string): PilotTrustAction {
  if (!value || typeof value !== 'object') throw new Error('action is required');
  const action = value as MobileTrustAction;
  switch (action.type) {
    case 'grant_recommendation_consent':
      return { type: action.type, at };
    case 'set_recommendation_consent':
      if (typeof action.granted !== 'boolean') throw new Error('granted must be boolean');
      return { type: action.type, granted: action.granted, at };
    case 'set_analytics_consent':
      if (typeof action.granted !== 'boolean') throw new Error('granted must be boolean');
      return { type: action.type, granted: action.granted, at };
    case 'set_calendar_consent':
      if (typeof action.granted !== 'boolean') throw new Error('granted must be boolean');
      return { type: action.type, granted: action.granted, at };
    case 'set_quiet_mode':
      if (typeof action.enabled !== 'boolean') throw new Error('enabled must be boolean');
      return { type: action.type, enabled: action.enabled, at };
    case 'revoke':
      return { type: action.type, at };
    case 'delete':
      return { type: action.type, at };
    default:
      throw new Error('unsupported pilot trust action');
  }
}

function assertAccess(participantId: string, at: string): ReturnType<typeof resolvePilotAccess> & { trust: PilotTrustState } {
  const access = resolvePilotAccess(participantId, at);
  if (!access.decision.allowed || !access.trust) {
    throw new MobilePilotError(
      'closed pilot recommendation unavailable',
      403,
      access.decision.reason,
    );
  }
  return access as ReturnType<typeof resolvePilotAccess> & { trust: PilotTrustState };
}

function recommendationContext(input: MobilePilotSource, participantId: string, analyticsConsent: boolean, now: Date) {
  return {
    anonymousUserId: participantId,
    locale: localeFrom(input.locale),
    consent: analyticsConsent ? 'granted' as const : 'essential' as const,
    now,
    emit: appendAnalyticsEvent,
    timezone: stringValue(input, 'timezone') || 'UTC',
  };
}

export function getMobileNextStep(input: MobilePilotSource) {
  const participantId = participantIdentity(input);
  const now = new Date();
  const at = now.toISOString();
  const access = assertAccess(participantId, at);
  const context = recommendationContext(input, participantId, access.trust.analyticsConsent, now);
  const recommendation = getLiveNextStep(getCommandServiceState(), context);
  if (recommendation.state === 'ready' && !access.trust.firstValueAt) {
    getPilotTrustStore().apply(participantId, { type: 'record_first_value', at });
  }
  const assignment = resolveNextStepArm(participantId);
  return {
    success: true,
    participantId,
    recommendation,
    assignment,
    exposure: access.decision,
  };
}

function nextStepDecision(value: unknown): NextStepDecision {
  if (value === 'accept' || value === 'edit' || value === 'defer' || value === 'dismiss' || value === 'done') {
    return value;
  }
  throw new Error('decision must be accept, edit, defer, dismiss, or done');
}

function proposalFrom(value: unknown): Pick<NextStepRecommendationContract, 'proposalId'> {
  if (!value || typeof value !== 'object') throw new Error('proposal is required');
  const proposal = value as Partial<NextStepRecommendationContract>;
  if (typeof proposal.proposalId !== 'string' || !proposal.proposalId) throw new Error('proposal.proposalId is required');
  return { proposalId: proposal.proposalId };
}

type DecisionReplay = {
  fingerprint: string;
  response: {
    success: true;
    replayed: boolean;
    participantId: string;
    assignment: ReturnType<typeof resolveNextStepArm>;
    outcome: ReturnType<typeof recordLiveNextStepDecision>;
  };
};

type MobilePilotGlobals = typeof globalThis & {
  __maybesitterMobileDecisionReplays?: Map<string, DecisionReplay>;
};

const mobilePilotGlobals = globalThis as MobilePilotGlobals;
const decisionReplays = mobilePilotGlobals.__maybesitterMobileDecisionReplays ?? new Map<string, DecisionReplay>();
mobilePilotGlobals.__maybesitterMobileDecisionReplays = decisionReplays;

export function resetMobilePilotDecisionReplaysForTests(): void {
  decisionReplays.clear();
}

export function recordMobileNextStepDecision(input: MobilePilotSource) {
  const participantId = participantIdentity(input);
  const now = new Date();
  const at = now.toISOString();
  const access = assertAccess(participantId, at);
  const proposal = proposalFrom(input.proposal);
  const decision = nextStepDecision(input.decision ?? input.action);
  const editedTitle = typeof input.editedTitle === 'string' ? input.editedTitle : undefined;
  const assignment = resolveNextStepArm(participantId);
  const fingerprint = JSON.stringify({
    participantId,
    proposalId: proposal.proposalId,
    decision,
    editedTitle: editedTitle ?? null,
  });
  const explicitKey = stringValue(input, 'idempotencyKey');
  const replayKey = explicitKey ? `${participantId}:${explicitKey}` : '';
  if (replayKey) {
    const replay = decisionReplays.get(replayKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new MobilePilotError('idempotencyKey body mismatch', 409);
      }
      return { ...replay.response, replayed: true };
    }
  }

  const context = {
    ...recommendationContext(input, participantId, access.trust.analyticsConsent, now),
    emitShown: false,
  };
  const canonicalProposal = getLiveNextStep(getCommandServiceState(), context);
  if (canonicalProposal.state !== 'ready' || canonicalProposal.proposalId !== proposal.proposalId) {
    throw new MobilePilotError('proposal is stale or invalid', 409);
  }
  const outcome = recordLiveNextStepDecision(canonicalProposal, decision, context, editedTitle);
  const response = {
    success: true as const,
    replayed: false,
    participantId,
    assignment,
    outcome,
  };
  if (replayKey) decisionReplays.set(replayKey, { fingerprint, response });
  return response;
}

export function getMobilePilotTrust(input: MobilePilotSource) {
  const participantId = participantIdentity(input);
  const at = new Date().toISOString();
  const access = resolvePilotAccess(participantId, at, false);
  if (!access.trust) throw new MobilePilotError('participant is not admitted to this pilot instance', 403, access.decision.reason);
  return {
    success: true,
    participantId,
    trust: access.trust,
    exposure: access.decision,
    whatKnows: buildWhatMaybeSitterKnows({
      trust: access.trust,
      confirmedCommitmentCount: confirmedCommitmentCount(),
    }),
  };
}

export async function updateMobilePilotTrust(input: MobilePilotSource) {
  const participantId = participantIdentity(input);
  const at = new Date().toISOString();
  const access = resolvePilotAccess(participantId, at, false);
  if (!access.trust) throw new MobilePilotError('participant is not admitted to this pilot instance', 403, access.decision.reason);
  const action = trustAction(input.action, at);
  const store = getPilotTrustStore();
  const trust = store.apply(participantId, action);
  const eventType = action.type === 'set_quiet_mode'
    ? 'quiet_mode_changed'
    : action.type === 'revoke'
      ? 'revoked'
      : action.type === 'delete'
        ? 'data_deleted'
        : 'consent_changed';
  store.appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType,
    participantId,
    occurredAt: at,
    outcome: 'recorded',
    reasonCode: action.type,
  }));
  if (action.type === 'delete') {
    await resetSingleUserAccount();
    const analytics = analyticsContextFrom({ anonymousUserId: participantId, consent: 'essential' }, appendAnalyticsEvent);
    if (analytics) recordDataDeleted(analytics, 'all_commitments');
  }
  const exposure = resolvePilotAccess(participantId, at, false).decision;
  return {
    success: true,
    participantId,
    trust,
    exposure,
    whatKnows: buildWhatMaybeSitterKnows({
      trust,
      confirmedCommitmentCount: confirmedCommitmentCount(),
    }),
  };
}

export function reportMobilePilotIncident(input: MobilePilotSource) {
  const participantId = participantIdentity(input);
  const access = resolvePilotAccess(participantId, new Date().toISOString(), false);
  if (!access.trust) throw new MobilePilotError('participant is not admitted to this pilot instance', 403, access.decision.reason);
  const at = new Date().toISOString();
  const incident = createPilotTrustIncident({
    version: 'v1',
    incidentId: `incident-${randomUUID()}`,
    participantId,
    occurredAt: at,
    surface: input.surface as PilotTrustIncident['surface'],
    category: input.category as PilotTrustIncident['category'],
    severity: 'medium',
    status: 'open',
    ownerId: process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID || 'pilot_owner',
    containmentCode: 'reported_for_review',
    resolutionCode: null,
  });
  const store = getPilotTrustStore();
  store.appendIncident(incident);
  store.appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'support_reported',
    participantId,
    occurredAt: at,
    outcome: 'recorded',
    reasonCode: incident.category,
  }));
  return {
    success: true,
    incidentId: incident.incidentId,
    status: incident.status,
  };
}
