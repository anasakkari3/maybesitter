/**
 * Watcher / trigger contracts (#525).
 *
 * A Watcher is not an Integration. An integration is *access* to a source (an
 * OAuth grant, a capability list); a Watcher is the condition a user wants
 * monitored over a normalized signal. Providers and native adapters produce
 * `WatcherSignal`s; the engine matches them against `WatcherDefinition`s,
 * evaluates the condition, dedupes, and routes the configured effect through
 * the Action Policy. No watcher calls the planner, and no provider payload
 * shape crosses this boundary — only the normalized fields below.
 *
 * ── What never appears here ────────────────────────────────────────
 *
 * No provider response bodies, no titles, no free text. `subjectRef` is an
 * opaque subject reference minted by the user or a pack template; `stateDigest`
 * is a hash; `provenanceRef` is an internal pointer. A contract with no field
 * for provider content cannot leak one into a notification, a proposal or the
 * history.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { ContextProviderKind } from './integrationConnectionContracts';
import type { CapabilityId } from './actionPolicyContracts';

export const WATCHER_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const WATCHER_SCHEMA_VERSION = 'watcher-v1' as const;
export const WATCHER_SIGNAL_SCHEMA_VERSION = 'watcher-signal-v1' as const;
export const WATCHER_EVENT_SCHEMA_VERSION = 'watcher-event-v1' as const;
export const PLANNING_STATE_CHANGE_SCHEMA_VERSION = 'planning-state-change-v1' as const;

/* ── The definition ──────────────────────────────────────────────── */

export const WATCHER_EFFECTS = Object.freeze([
  'notify',
  'replan_if_impacted',
  'propose_commitment',
  'update_context',
] as const);

export type WatcherEffect = (typeof WATCHER_EFFECTS)[number];

export const WATCHER_CONDITION_KINDS = Object.freeze(['digest_changed', 'threshold'] as const);

export type WatchCondition =
  /** The observed state digest differs from the last baseline. */
  | { readonly kind: 'digest_changed' }
  /**
   * A normalized measure crosses a threshold. Edge-triggered: it fires on the
   * crossing, not on every observation that satisfies it, and the first
   * observation after activation only primes the baseline (see the engine).
   */
  | {
    readonly kind: 'threshold';
    readonly metric: string;
    readonly operator: 'lt' | 'lte' | 'gt' | 'gte';
    readonly value: number;
  };

export interface WatcherSourceRef {
  readonly provider: ContextProviderKind;
  /**
   * The connection the signal is read through, or null when the signal needs
   * no user grant (readiness stored on the account, shared fixture data). A
   * watcher naming a connection blocks when that connection leaves
   * `connected`; one naming none never does.
   */
  readonly connectionId: string | null;
  /** Normalized signal vocabulary, e.g. `readiness`, `fixture`. Never a provider API name. */
  readonly signalKind: string;
  /** Opaque subject the user pointed at, e.g. a provider match id. Content-free. */
  readonly subjectRef: string;
}

export interface WatcherDefinition {
  readonly version: typeof WATCHER_CONTRACT_VERSION;
  readonly schemaVersion: typeof WATCHER_SCHEMA_VERSION;
  readonly watcherId: string;
  readonly scopeId: string;
  readonly enabled: boolean;
  /** Human-readable title or label for the watcher (e.g. 'Watching: BA flight 162') (#527). */
  readonly label?: string;
  readonly source: WatcherSourceRef;
  readonly condition: WatchCondition;
  readonly effect: WatcherEffect;
  readonly createdBy: 'user' | 'pack_template';
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* ── Runtime state, kept beside the definition ───────────────────── */

export type WatcherStatus = 'active' | 'paused' | 'blocked';

export type WatcherBlockedReason =
  /** The connection the watcher reads through is not `connected`. */
  | 'provider_disconnected'
  /** The connection needs the user to re-authorize it. */
  | 'provider_needs_reauth'
  /** No registered observer answers this (provider, signalKind) pair. */
  | 'signal_unavailable';

/**
 * What the engine remembers between runs. The baselines are the dedupe and
 * no-replay machinery: a watcher fires on transitions *from* its baseline,
 * never on the first observation after (re)activation.
 */
export interface WatcherRuntime {
  readonly watcherId: string;
  readonly scopeId: string;
  readonly status: WatcherStatus;
  readonly blockedReason: WatcherBlockedReason | null;
  /** The last signal that was absorbed (fired or merely observed). */
  readonly lastSignalId: string | null;
  readonly lastDigest: string | null;
  readonly lastMeasures: readonly WatcherMeasure[];
  readonly lastObservedAt: string | null;
  readonly lastFiredAt: string | null;
  readonly fireCount: number;
  readonly updatedAt: string;
}

/* ── The signal ──────────────────────────────────────────────────── */

/**
 * A normalized, unit-less measure an adapter computed from provider state
 * (e.g. a 0..1 recovery score). Numbers only: the unit and the provider's
 * field name stay behind the adapter.
 */
export interface WatcherMeasure {
  readonly metric: string;
  readonly value: number;
}

export interface WatcherSignal {
  readonly schemaVersion: typeof WATCHER_SIGNAL_SCHEMA_VERSION;
  /** Stable identity of this observation; duplicate deliveries carry the same one. */
  readonly signalId: string;
  readonly provider: ContextProviderKind;
  readonly signalKind: string;
  readonly subjectRef: string;
  readonly observedAt: string;
  /** Hash of the normalized observed state. The adapter computes it; the engine compares it. */
  readonly stateDigest: string;
  /** Internal pointer to where the observation came from. Never a payload. */
  readonly provenanceRef: string;
  readonly measures: readonly WatcherMeasure[];
}

/* ── What a firing leaves behind ─────────────────────────────────── */

export type WatcherEventOutcome =
  /** The effect ran (its artifact was recorded). */
  | 'effected'
  /** The Action Policy refused the effect; nothing ran. */
  | 'policy_blocked';

/**
 * One firing, append-only. This is both the history `GET
 * /api/mobile/watchers/{id}/history` serves and the idempotency lock: the
 * event id is derived from `(watcherId, signalId)`, so the same signal
 * delivered twice can only be recorded — and therefore fired — once.
 */
export interface WatcherFireEvent {
  readonly version: typeof WATCHER_CONTRACT_VERSION;
  readonly schemaVersion: typeof WATCHER_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly watcherId: string;
  readonly scopeId: string;
  readonly signalId: string;
  readonly provider: ContextProviderKind;
  readonly signalKind: string;
  readonly subjectRef: string;
  readonly observedAt: string;
  readonly firedAt: string;
  readonly effect: WatcherEffect;
  readonly outcome: WatcherEventOutcome;
  /** Why it fired (`digest_changed`, `threshold_crossed`) or, when blocked, the policy reason. */
  readonly reason: string;
  readonly policyDecision: 'allowed' | 'requires_confirmation' | 'requires_strong_confirmation' | 'denied';
  readonly provenanceRef: string;
  /** The artifact the effect produced (state-change, proposal or notification id), if any. */
  readonly effectRef: string | null;
}

/* ── Effect artifacts ────────────────────────────────────────────── */

export const PLANNING_STATE_CHANGE_SOURCES = Object.freeze([
  'commitment',
  'calendar',
  'external_task',
  'habit',
  'watcher',
  'readiness',
  'manual',
] as const);

export type PlanningStateChangeSource = (typeof PLANNING_STATE_CHANGE_SOURCES)[number];

/**
 * The normalized change a `replan_if_impacted` watcher emits into the common
 * state-change pipeline. This is the *entry* of the pipeline only: consuming
 * it (impact evaluation, replan) belongs to the replanning lane (#523), which
 * no watcher calls directly.
 */
export interface PlanningStateChange {
  readonly schemaVersion: typeof PLANNING_STATE_CHANGE_SCHEMA_VERSION;
  readonly changeId: string;
  readonly scopeId: string;
  readonly source: PlanningStateChangeSource;
  /** The watcher id when `source` is `watcher`. */
  readonly entityId: string;
  readonly occurredAt: string;
  readonly changedFields: readonly string[];
  readonly beforeDigest: string | null;
  readonly afterDigest: string;
  readonly provenanceRef: string;
}

/**
 * What `propose_commitment` produces: a proposal, and only ever a proposal.
 * It has no path into canonical work — confirming it into a commitment is a
 * separate, user-driven surface (#527's UX), exactly like a capture proposal.
 */
export interface WatcherProposal {
  readonly schemaVersion: 'watcher-proposal-v1';
  readonly proposalId: string;
  readonly watcherId: string;
  readonly scopeId: string;
  readonly state: 'proposed';
  readonly signalKind: string;
  readonly subjectRef: string;
  readonly reason: string;
  readonly proposedAt: string;
  readonly provenanceRef: string;
}

/**
 * What `notify` produces: a queued, content-free notification intent. The
 * monitoring surface (#527) renders and delivers it; the engine does not
 * invent per-provider notification copy.
 */
export interface WatcherNotification {
  readonly schemaVersion: 'watcher-notification-v1';
  readonly notificationId: string;
  readonly watcherId: string;
  readonly scopeId: string;
  readonly state: 'queued';
  readonly signalKind: string;
  readonly subjectRef: string;
  readonly reason: string;
  readonly queuedAt: string;
  readonly provenanceRef: string;
}

/* ── The policy binding ──────────────────────────────────────────── */

/**
 * Each effect's Action Policy capability, as data. Every effect maps to a
 * *local, low-risk* capability: the engine evaluates this map on every firing
 * and refuses to run anything the policy does not allow. There is no entry —
 * and no watcher-controlled field — that maps to a provider write; a watcher
 * cannot send provider actions because this table cannot name one, and a
 * separately authorized Action Gateway flow is the only path that ever could
 * (#525 Safety).
 */
export const WATCHER_EFFECT_CAPABILITIES: Readonly<Record<WatcherEffect, CapabilityId>> = Object.freeze({
  notify: 'create_local_reminder',
  replan_if_impacted: 'update_local_plan',
  propose_commitment: 'create_local_proposal',
  update_context: 'update_local_context',
});

export const WATCHER_POLICY = Object.freeze({
  effectsRouteThroughActionPolicy: true,
  providerWriteCapabilitiesAllowed: false,
  directPlannerCallsAllowed: false,
  proposalsCreateCanonicalWork: false,
  telemetryCarriesContent: false,
  providerPayloadInContracts: false,
} as const);

/* ── Validation ──────────────────────────────────────────────────── */

const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;

/** `signalKind` and threshold `metric` are normalized vocabulary, not free text. */
export function isWatcherIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

/**
 * `subjectRef` is opaque to the engine but user- or pack-minted, so it is
 * bounded printable text with no whitespace — never a payload.
 */
export function isWatcherSubjectRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && /^[^\s]+$/.test(value);
}

export function isWatcherEffect(value: unknown): value is WatcherEffect {
  return typeof value === 'string' && (WATCHER_EFFECTS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWatchCondition(value: unknown): value is WatchCondition {
  if (!isRecord(value)) return false;
  if (value.kind === 'digest_changed') return Object.keys(value).length === 1;
  if (value.kind !== 'threshold') return false;
  return isWatcherIdentifier(value.metric)
    && (value.operator === 'lt' || value.operator === 'lte' || value.operator === 'gt' || value.operator === 'gte')
    && typeof value.value === 'number'
    && Number.isFinite(value.value);
}

/** The condition's own reason code, recorded on the event when it fires. */
export function watchConditionReason(condition: WatchCondition): 'digest_changed' | 'threshold_crossed' {
  return condition.kind === 'digest_changed' ? 'digest_changed' : 'threshold_crossed';
}

function satisfiedBy(operator: 'lt' | 'lte' | 'gt' | 'gte', value: number, threshold: number): boolean {
  if (operator === 'lt') return value < threshold;
  if (operator === 'lte') return value <= threshold;
  if (operator === 'gt') return value > threshold;
  return value >= threshold;
}

/**
 * Pure condition evaluation against the stored baseline.
 *
 * Both conditions are transition-triggered: with no baseline (first
 * observation after activation or resume) nothing fires and the caller primes
 * instead — which is what makes reconnect resume without replaying history.
 * `threshold` fires on the crossing edge: the measure satisfies the operator
 * now and did not at the baseline.
 */
export function evaluateWatchCondition(
  condition: WatchCondition,
  signal: Pick<WatcherSignal, 'stateDigest' | 'measures'>,
  baseline: Pick<WatcherRuntime, 'lastDigest' | 'lastMeasures'>,
): boolean {
  if (condition.kind === 'digest_changed') {
    return baseline.lastDigest !== null && signal.stateDigest !== baseline.lastDigest;
  }
  const current = signal.measures.find((measure) => measure.metric === condition.metric);
  if (!current) return false;
  if (!satisfiedBy(condition.operator, current.value, condition.value)) return false;
  const prior = baseline.lastMeasures.find((measure) => measure.metric === condition.metric);
  if (!prior) return false;
  return !satisfiedBy(condition.operator, prior.value, condition.value);
}
