import { randomUUID } from 'node:crypto';
import { analyticsContextFrom } from '../../analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../analytics/eventStore';
import { isClientReportableEvent, recordClientEvent, recordFirstValueReached } from '../../analytics/loopAnalytics';
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
import { resolveUserAccess } from '../../pilot/pilotAccess';
import {
  isSilentRefusal,
  resolveNextStepAccess,
  type NextStepAccess,
} from './nextStepAccess';
import {
  appendNextStepDecision,
  hiddenCommitmentIds,
  listRecentNextStepDecisions,
  resolveDeferUntil,
} from './nextStepDecisionLog';
import { completeCommitment, patchCommitment } from './commitmentService';
import { appendAudit, appendIncident, applyTrustAction } from '../../pilot/pilotTrustStore';
import { getLiveNextStep, prepareLiveNextStepDecision } from '../nextStepLiveService';
import {
  findParticipantDecision,
  getParticipantStateSnapshot,
  readParticipantState,
  replayOrRecordParticipantDecision,
} from './participantState';
import {
  NEXT_STEP_CONTRACT_VERSION,
  type NextStepDecision,
  type NextStepLocale,
  type NextStepRecommendationContract,
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
  // `not allowlisted` and the allowlist-configuration 503 are gone with the
  // roster (UC-1.0e, #144). What is left are refusals about this user's own
  // trust record and the operator's runtime controls.
  const status = /not admitted|wrong_instance|consent_required|quiet_mode|revoked|deleted|feature_disabled|kill_switch_active/.test(message)
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

async function confirmedCommitmentCount(participantId: string): Promise<number> {
  return Object.values((await readParticipantState(participantId)).commitments)
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
      // Retired by UC-1.5 (#149). This used to delete the participant's domain
      // state and nothing else — not the Firebase user, not the top-level
      // records, no receipt — while a client calling it could reasonably
      // believe the account was gone. Two meanings of "delete my data" is one
      // too many, and the dangerous one is the half that leaves the account
      // signed in.
      throw new MobilePilotError('use account deletion', 400, 'use_account_deletion');
    default:
      throw new Error('unsupported pilot trust action');
  }
}

type AllowedAccess = Awaited<ReturnType<typeof resolveUserAccess>> & { trust: PilotTrustState };

async function assertAccess(participantId: string, at: string): Promise<AllowedAccess> {
  const access = await resolveUserAccess(participantId, at);
  if (!access.decision.allowed || !access.trust) {
    throw new MobilePilotError(
      'closed pilot recommendation unavailable',
      403,
      access.decision.reason,
    );
  }
  return access as AllowedAccess;
}

/**
 * The next step's own gate (UC-2.9, #170).
 *
 * ── The consent it reads was the whole bug ───────────────────────
 *
 * `decidePilotExposure` refuses unless `trust.recommendationConsent` is true.
 * That is the *closed pilot's* admission flag: it is created `false`, and the
 * only thing that ever sets it is the Trust centre's
 * `grant_recommendation_consent` action.
 *
 * Onboarding (#171) does not call that. It records the launch consent, in
 * `users/{uid}.consents.recommendations`, versioned against the words the user
 * was actually shown. So every user who agreed to next steps during onboarding
 * was refused with 403 `consent_required` for as long as they never went and
 * found the Trust switch — which is to say, the feature was off for everyone
 * who used the product as designed.
 *
 * `resolveNextStepAccess` reads the launch consent. Nothing else about the
 * order changed: deleted and revoked still come before any flag.
 *
 * The audit event stays, because `resolveUserAccess` used to write one and an
 * exposure decision that leaves no record is not an improvement.
 */
async function nextStepAccessFor(participantId: string, at: string): Promise<NextStepAccess> {
  const access = await resolveNextStepAccess(participantId, new Date(at));
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'exposure_checked',
    participantId,
    occurredAt: at,
    outcome: access.allowed ? 'allowed' : 'blocked',
    reasonCode: access.reason,
  }));
  return access;
}

/**
 * The commitments the next step is currently not offering (UC-2.9, #170).
 *
 * Deferred, or dismissed within the last day. They are excluded as
 * *candidates* and changed in no other way: a deferred commitment keeps its
 * due time and its place on Today, Upcoming and Details, because "not this
 * one" is an answer about the suggestion and not an edit to the thing.
 */
async function hiddenFor(participantId: string, now: Date): Promise<Set<string>> {
  return hiddenCommitmentIds(await listRecentNextStepDecisions(participantId, now), now);
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

export async function getMobileNextStep(participantId: string, input: MobilePilotSource) {
  const now = new Date();
  const at = now.toISOString();
  const access = await nextStepAccessFor(participantId, at);

  // Quiet hours and quiet mode are not refusals: the user asked not to be
  // spoken to right now, and nothing is wrong. A 403 there would make the
  // client draw an error on a screen where the correct rendering is silence,
  // so the answer is 200 with no card and an `exposure` that says why. The
  // state is `empty` and not something warmer on purpose — claiming the day is
  // empty would be a second lie, so the client reads `exposure`, not `state`.
  if (!access.allowed) {
    if (!isSilentRefusal(access.reason)) {
      throw new MobilePilotError('next step unavailable', 403, access.reason);
    }
    return {
      success: true,
      participantId,
      recommendation: silentRecommendation(localeFrom(input.locale)),
      assignment: resolveNextStepArm(participantId),
      exposure: { allowed: false, reason: access.reason },
    };
  }

  const context = {
    ...recommendationContext(input, participantId, access.trust.analyticsConsent, now),
    excludeCommitmentIds: await hiddenFor(participantId, now),
  };
  const recommendation = await getLiveNextStep(await readParticipantState(participantId), context);
  if (recommendation.state === 'ready' && !access.trust.firstValueAt) {
    await applyTrustAction(participantId, { type: 'record_first_value', at });
    await recordFirstValueReached(context, { surface: 'recommendation', reason: 'next_step_ready' });
  }
  const assignment = resolveNextStepArm(participantId);
  return {
    success: true,
    participantId,
    recommendation,
    assignment,
    exposure: { allowed: true, reason: access.reason },
  };
}

/**
 * The shape returned when the user asked for quiet.
 *
 * No proposal is computed at all — not computed and withheld. During quiet
 * hours the selector should not be reading the person's commitments to decide
 * something nobody will be shown.
 */
function silentRecommendation(locale: NextStepLocale): NextStepRecommendationContract {
  return {
    version: NEXT_STEP_CONTRACT_VERSION,
    proposalId: '',
    state: 'empty',
    locale,
    primaryStep: null,
    explanation: null,
    availableActions: [],
    persistence: { occurred: false, confirmationRequired: true },
  };
}

export async function recordMobilePilotLoopEvent(participantId: string, input: MobilePilotSource) {
  const now = new Date();
  const at = now.toISOString();
  const access = await resolveUserAccess(participantId, at, false);
  if (!access.trust) {
    throw new MobilePilotError(
      'participant is not admitted to this pilot instance',
      403,
      access.decision.reason,
    );
  }
  const eventName = input.eventName;
  if (!isClientReportableEvent(eventName)) {
    throw new MobilePilotError('eventName is not client reportable', 400);
  }
  const context = {
    anonymousUserId: participantId,
    consent: access.trust.analyticsConsent ? 'granted' as const : 'essential' as const,
    now,
    emit: appendAnalyticsEvent,
  };
  const properties = input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)
    ? input.properties as Record<string, string | number | boolean | null>
    : {};
  const event = await recordClientEvent(context, eventName, properties);
  return {
    success: true,
    participantId,
    recorded: event !== null,
    eventId: event?.eventId ?? null,
  };
}

function nextStepDecision(value: unknown): NextStepDecision {
  if (value === 'accept' || value === 'edit' || value === 'defer' || value === 'dismiss' || value === 'done') {
    return value;
  }
  throw new Error('decision must be accept, edit, defer, dismiss, or done');
}

/** The bounds an edited next-step title must satisfy (UC-2.9, #170). */
export const NEXT_STEP_EDIT_TITLE_MAX = 120;

/**
 * The title an `edit` carries.
 *
 * Refused rather than trimmed to fit. `patchCommitment` takes any string, and
 * `cleanText(_, 120)` in the selector silently truncates — so an over-long
 * title would be accepted here and come back shortened, which reads to the
 * user as the product having quietly rewritten what they typed. A 400 says
 * what happened.
 *
 * An `editedTitle` sent with any other decision is ignored, not an error: it
 * is a client sending a field that does not apply, and refusing the whole
 * decision over it would lose an answer the user did give.
 */
function editedTitleFrom(value: unknown, decision: NextStepDecision): string | undefined {
  if (decision !== 'edit') return undefined;
  if (typeof value !== 'string') throw new MobilePilotError('editedTitle is required for an edit', 400);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > NEXT_STEP_EDIT_TITLE_MAX) {
    throw new MobilePilotError(`editedTitle must be 1-${NEXT_STEP_EDIT_TITLE_MAX} characters`, 400);
  }
  return trimmed;
}

function proposalFrom(value: unknown): Pick<NextStepRecommendationContract, 'proposalId'> {
  if (!value || typeof value !== 'object') throw new Error('proposal is required');
  const proposal = value as Partial<NextStepRecommendationContract>;
  if (typeof proposal.proposalId !== 'string' || !proposal.proposalId) throw new Error('proposal.proposalId is required');
  return { proposalId: proposal.proposalId };
}

export function resetMobilePilotDecisionReplaysForTests(): void {
  // Replay records live under the participant's tree in durable storage. A
  // test gets a clean slate from `setStorageForTests(createMemoryStorage())`,
  // so there is no process-global state to reset here.
}

/**
 * ── Why the recorded decision is built in two halves ─────────────
 *
 * `replayOrRecordParticipantDecision` runs its callback inside a storage
 * transaction, and a transaction retries on contention. The callback therefore
 * has to be pure: the staleness read happens before it, and the analytics
 * event it implies is emitted after the transaction committed, once, and only
 * when this call is the one that recorded the decision. Emitting from inside
 * the callback would post one `recommendation_accepted` per attempt for a
 * single tap.
 */
export async function recordMobileNextStepDecision(participantId: string, input: MobilePilotSource) {
  const now = new Date();
  const at = now.toISOString();
  // The same gate as the read, with one difference: a silent refusal does not
  // block a decision. Quiet hours can begin while a card is on screen, and
  // refusing the tap that follows would throw away a decision the user has
  // already made about a suggestion they were legitimately shown. It records
  // what they chose; it does not speak to them.
  const access = await nextStepAccessFor(participantId, at);
  if (!access.allowed && !isSilentRefusal(access.reason)) {
    throw new MobilePilotError('next step unavailable', 403, access.reason);
  }
  const proposal = proposalFrom(input.proposal);
  const decision = nextStepDecision(input.decision ?? input.action);
  const editedTitle = editedTitleFrom(input.editedTitle, decision);
  const assignment = resolveNextStepArm(participantId);
  const fingerprint = JSON.stringify({
    participantId,
    proposalId: proposal.proposalId,
    decision,
    editedTitle: editedTitle ?? null,
  });
  const explicitKey = stringValue(input, 'idempotencyKey');

  // Before the staleness check, deliberately. A decision with effects changes
  // the world — `done` completes the commitment — so the proposal it was made
  // against is stale the instant it succeeds. Validating first would answer a
  // network retry with 409 and leave the client unable to tell whether its
  // decision landed, which is the one thing an idempotency key exists to
  // prevent.
  if (explicitKey) {
    const replayed = await findParticipantDecision<{ success: true }>(participantId, explicitKey, fingerprint)
      .catch((error: unknown) => {
        if (error instanceof Error && /idempotencyKey body mismatch/.test(error.message)) {
          throw new MobilePilotError(error.message, 409);
        }
        throw error;
      });
    if (replayed) return { ...replayed, replayed: true };
  }

  const context = {
    ...recommendationContext(input, participantId, access.trust.analyticsConsent, now),
    emitShown: false,
    // The same exclusions the read applied, so the proposal this validates
    // against is the one the user was actually shown.
    excludeCommitmentIds: await hiddenFor(participantId, now),
  };

  // A read, so it belongs outside the transaction that records the decision.
  const canonicalProposal = await getLiveNextStep(await getParticipantStateSnapshot(participantId), context);
  if (canonicalProposal.state !== 'ready' || canonicalProposal.proposalId !== proposal.proposalId) {
    throw new MobilePilotError('proposal is stale or invalid', 409);
  }

  const commitmentId = canonicalProposal.primaryStep?.commitmentId ?? null;
  const deferUntil = decision === 'defer' ? resolveDeferUntil(input.deferUntil, now) : null;

  /**
   * What the decision actually does (UC-2.9, #170).
   *
   * Until now a decision emitted an analytics event and changed nothing:
   * "Already done" left the commitment active, "Change it" discarded the new
   * title, and "Later" brought the same item straight back on the next fetch.
   * The card asked five questions and acted on none of the answers.
   *
   * Ordering: the ledger entry is written first. It is the record that the
   * user decided, and it must survive a failing effect — a `done` whose
   * `Complete` is refused by the state machine still happened, and the history
   * has to say so. The effect follows, and its failure is not swallowed: the
   * caller gets a 500 and the client refetches, rather than a cheerful 200
   * over a commitment that never completed.
   */
  const applyDecision = async (): Promise<void> => {
    await appendNextStepDecision(participantId, {
      proposalId: canonicalProposal.proposalId,
      commitmentId,
      decision,
      arm: assignment.arm,
      evidenceCodes: (canonicalProposal.explanation?.evidenceCodes ?? []).map((item) => item.code),
      deferUntil,
      at,
    });
    if (!commitmentId) return;
    if (decision === 'done') {
      await completeCommitment(commitmentId, now, { participantId });
    }
    if (decision === 'edit' && editedTitle) {
      await patchCommitment(commitmentId, { title: editedTitle }, now, { participantId });
    }
    // `defer` and `dismiss` need no write beyond the ledger: the ledger *is*
    // the exclusion, and the commitment itself is deliberately untouched.
  };

  // Collected rather than assigned to a nullable, so a retry that re-runs the
  // callback cannot leave a half-applied effect behind.
  const pendingEmits: Array<() => Promise<void>> = [];
  const create = () => {
    const prepared = prepareLiveNextStepDecision(canonicalProposal, decision, context, editedTitle);
    pendingEmits.push(async () => {
      await applyDecision();
      await prepared.emit();
    });
    return {
      success: true as const,
      replayed: false,
      participantId,
      assignment,
      outcome: prepared.outcome,
    };
  };

  if (!explicitKey) {
    const response = create();
    await pendingEmits[pendingEmits.length - 1]?.();
    return response;
  }
  try {
    const result = await replayOrRecordParticipantDecision(participantId, explicitKey, fingerprint, create);
    // Exactly one emit, and only for the call that actually recorded it.
    if (!result.replayed) await pendingEmits[pendingEmits.length - 1]?.();
    return { ...result.response, replayed: result.replayed };
  } catch (error) {
    if (error instanceof Error && /idempotencyKey body mismatch/.test(error.message)) {
      throw new MobilePilotError(error.message, 409);
    }
    throw error;
  }
}

export async function getMobilePilotTrust(participantId: string) {
  const at = new Date().toISOString();
  const access = await resolveUserAccess(participantId, at, false);
  if (!access.trust) throw new MobilePilotError('participant is not admitted to this pilot instance', 403, access.decision.reason);
  return {
    success: true,
    participantId,
    trust: access.trust,
    exposure: access.decision,
    whatKnows: buildWhatMaybeSitterKnows({
      trust: access.trust,
      confirmedCommitmentCount: await confirmedCommitmentCount(participantId),
    }),
  };
}

export async function updateMobilePilotTrust(participantId: string, input: MobilePilotSource) {
  const at = new Date().toISOString();
  const access = await resolveUserAccess(participantId, at, false);
  if (!access.trust) throw new MobilePilotError('participant is not admitted to this pilot instance', 403, access.decision.reason);
  const action = trustAction(input.action, at);
  const trust = await applyTrustAction(participantId, action);
  // No `data_deleted` branch: `delete` is refused when the action is parsed
  // (#149), so it cannot reach here. Account deletion writes its own audit.
  const eventType = action.type === 'set_quiet_mode'
    ? 'quiet_mode_changed'
    : action.type === 'revoke'
      ? 'revoked'
      : 'consent_changed';
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType,
    participantId,
    occurredAt: at,
    outcome: 'recorded',
    reasonCode: action.type,
  }));
  const exposure = (await resolveUserAccess(participantId, at, false)).decision;
  return {
    success: true,
    participantId,
    trust,
    exposure,
    whatKnows: buildWhatMaybeSitterKnows({
      trust,
      confirmedCommitmentCount: await confirmedCommitmentCount(participantId),
    }),
  };
}

export async function reportMobilePilotIncident(participantId: string, input: MobilePilotSource) {
  requirePilotParticipantId(participantId);
  const access = await resolveUserAccess(participantId, new Date().toISOString(), false);
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
  await appendIncident(incident);
  await appendAudit(createPilotAuditEvent({
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
