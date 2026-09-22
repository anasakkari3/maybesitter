/**
 * The watcher evaluation engine (#525).
 *
 * One engine for every provider: a sweep reads watchers across all accounts
 * (bounded), resolves each one's status, observes its normalized signal
 * through the registered observer, evaluates the condition against the stored
 * baseline, dedupes, and routes the configured effect through the Action
 * Policy. It is deliberately the *only* place a firing happens, so the rules
 * the issue states hold in one place rather than per provider:
 *
 * ── Duplicate source signals fire once ─────────────────────────────
 * The fire event's document id is `docIdForKey(watcherId, signalId)` and it is
 * `create`d inside the same transaction that writes the effect artifact, so
 * the second delivery of one signal — overlapping ticks, a retried sweep —
 * is a recorded duplicate, not a second effect.
 *
 * ── Disabled and disconnected watchers do nothing ──────────────────
 * `enabled: false` and a non-connected source connection are re-checked inside
 * the firing transaction, not only at sweep-read time, so a pause or a
 * disconnect that lands mid-sweep still costs zero effects.
 *
 * ── Resume never replays ───────────────────────────────────────────
 * Conditions are transition-triggered against a baseline
 * (`evaluateWatchCondition`), and entering `active` — creation, resume from
 * pause, reconnect from blocked — primes the baseline from the current signal
 * without firing. History that accumulated while the watcher was off is
 * absorbed, never fired.
 *
 * ── Effects stay in their lane ─────────────────────────────────────
 * `propose_commitment` records a proposal and nothing canonical;
 * `replan_if_impacted` appends a `PlanningStateChange` — the entry of the
 * common state-change pipeline — and no watcher calls the planner; `notify`
 * queues a content-free notification intent; `update_context` absorbs the new
 * state into the watcher's baseline. Every firing first passes
 * `evaluateActionPolicy` with the effect's fixed local capability
 * (`WATCHER_EFFECT_CAPABILITIES`); a refusal is recorded as `policy_blocked`
 * and nothing runs. There is no path from a watcher definition to a provider
 * write capability.
 */
import {
  evaluateWatchCondition,
  WATCHER_CONTRACT_VERSION,
  WATCHER_EFFECT_CAPABILITIES,
  WATCHER_EVENT_SCHEMA_VERSION,
  watchConditionReason,
  type PlanningStateChange,
  PLANNING_STATE_CHANGE_SCHEMA_VERSION,
  type WatcherFireEvent,
  type WatcherNotification,
  type WatcherProposal,
  type WatcherSignal,
} from '../../src/contracts/v1/watcherContracts';
import { evaluateActionPolicy, type CapabilityId } from '../../src/contracts/v1/actionPolicyContracts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import { getStorage, type StorageAdapter } from '../storage';
import {
  docIdForKey,
  PLANNING_STATE_CHANGES,
  PROVIDER_CONNECTIONS,
  userSubDoc,
  WATCHER_EVENTS,
  WATCHER_NOTIFICATIONS,
  WATCHER_PROPOSALS,
  WATCHERS,
} from '../storage/paths';
import { listWatchersAcrossUsers, watcherStatusOf, type StoredWatcher } from './watcherStore';
import { defaultWatcherSignalRegistry, type WatcherSignalRegistry } from './signals';
import { isMonitoringPaused } from './monitoringSettings';

/** The most watchers one sweep touches; the rest wait for the next tick. */
export const WATCHER_SWEEP_BATCH = 200;

export interface WatcherSweepTotals {
  scanned: number;
  /** An observer answered and the condition ran. */
  evaluated: number;
  fired: number;
  /** Blocked by the Action Policy; recorded, not executed. */
  policyBlocked: number;
  /** Entered `active` and absorbed the current state without firing. */
  primed: number;
  paused: number;
  blocked: number;
  /** The signal was already fired on — a redelivery. */
  duplicates: number;
  /** The observer has no current reading (e.g. no readiness data yet). */
  noSignal: number;
  /** More watchers exist than the batch bound; the next tick takes them. */
  remaining: boolean;
  failures: Array<{ watcherId: string; reason: string }>;
}

export interface WatcherSweepOptions {
  storage?: StorageAdapter;
  now?: Date;
  limit?: number;
  registry?: WatcherSignalRegistry;
}

function emptyTotals(): WatcherSweepTotals {
  return {
    scanned: 0,
    evaluated: 0,
    fired: 0,
    policyBlocked: 0,
    primed: 0,
    paused: 0,
    blocked: 0,
    duplicates: 0,
    noSignal: 0,
    remaining: false,
    failures: [],
  };
}

/**
 * The connection a watcher reads through, as stored.
 *
 * Deliberately *not* injectable. The firing transaction re-reads the same
 * record through `tx.get` — it has to, or a disconnect landing mid-sweep would
 * not be seen — and a seam that only replaced this one would let a test prove
 * a disconnect stops a firing while the transactional check it actually
 * depends on was never exercised. A test that wants a revoked connection
 * writes a revoked connection.
 */
async function readConnection(
  scopeId: string,
  connectionId: string,
  storage: StorageAdapter,
): Promise<IntegrationConnectionRecord | null> {
  return (await storage.get<IntegrationConnectionRecord>(userSubDoc(scopeId, PROVIDER_CONNECTIONS, connectionId))) ?? null;
}

export function watcherEventIdFor(watcherId: string, signalId: string): string {
  return docIdForKey(`watcher-fire:${watcherId}:${signalId}`);
}

function fireEvent(
  stored: StoredWatcher,
  signal: WatcherSignal,
  now: string,
  outcome: WatcherFireEvent['outcome'],
  reason: string,
  policyDecision: WatcherFireEvent['policyDecision'],
  effectRef: string | null,
): WatcherFireEvent {
  const { definition } = stored;
  return {
    version: WATCHER_CONTRACT_VERSION,
    schemaVersion: WATCHER_EVENT_SCHEMA_VERSION,
    eventId: watcherEventIdFor(definition.watcherId, signal.signalId),
    watcherId: definition.watcherId,
    scopeId: definition.scopeId,
    signalId: signal.signalId,
    provider: signal.provider,
    signalKind: signal.signalKind,
    subjectRef: signal.subjectRef,
    observedAt: signal.observedAt,
    firedAt: now,
    effect: definition.effect,
    outcome,
    reason,
    policyDecision,
    provenanceRef: signal.provenanceRef,
    effectRef,
  };
}

function effectArtifact(
  stored: StoredWatcher,
  signal: WatcherSignal,
  now: string,
  eventId: string,
): { path: string; value: PlanningStateChange | WatcherProposal | WatcherNotification; ref: string } | null {
  const { definition } = stored;
  const reason = watchConditionReason(definition.condition);
  if (definition.effect === 'replan_if_impacted') {
    const changeId = `watcher:${eventId}`;
    return {
      path: userSubDoc(definition.scopeId, PLANNING_STATE_CHANGES, docIdForKey(changeId)),
      ref: changeId,
      value: {
        schemaVersion: PLANNING_STATE_CHANGE_SCHEMA_VERSION,
        changeId,
        scopeId: definition.scopeId,
        source: 'watcher',
        entityId: definition.watcherId,
        occurredAt: now,
        changedFields: definition.condition.kind === 'threshold' ? [definition.condition.metric] : ['digest'],
        beforeDigest: stored.runtime.lastDigest,
        afterDigest: signal.stateDigest,
        provenanceRef: signal.provenanceRef,
      },
    };
  }
  if (definition.effect === 'propose_commitment') {
    const proposalId = `wpr_${eventId}`;
    return {
      path: userSubDoc(definition.scopeId, WATCHER_PROPOSALS, proposalId),
      ref: proposalId,
      value: {
        schemaVersion: 'watcher-proposal-v1',
        proposalId,
        watcherId: definition.watcherId,
        scopeId: definition.scopeId,
        state: 'proposed',
        signalKind: signal.signalKind,
        subjectRef: signal.subjectRef,
        reason,
        proposedAt: now,
        provenanceRef: signal.provenanceRef,
      },
    };
  }
  if (definition.effect === 'notify') {
    const notificationId = `wtn_${eventId}`;
    return {
      path: userSubDoc(definition.scopeId, WATCHER_NOTIFICATIONS, notificationId),
      ref: notificationId,
      value: {
        schemaVersion: 'watcher-notification-v1',
        notificationId,
        watcherId: definition.watcherId,
        scopeId: definition.scopeId,
        state: 'queued',
        signalKind: signal.signalKind,
        subjectRef: signal.subjectRef,
        reason,
        queuedAt: now,
        provenanceRef: signal.provenanceRef,
      },
    };
  }
  // update_context: the absorbed baseline *is* the effect; no artifact.
  return null;
}

function absorbedRuntime(stored: StoredWatcher, signal: WatcherSignal, now: string, fired: boolean): StoredWatcher {
  return {
    ...stored,
    runtime: {
      ...stored.runtime,
      lastSignalId: signal.signalId,
      lastDigest: signal.stateDigest,
      lastMeasures: signal.measures,
      lastObservedAt: signal.observedAt,
      lastFiredAt: fired ? now : stored.runtime.lastFiredAt,
      fireCount: fired ? stored.runtime.fireCount + 1 : stored.runtime.fireCount,
      updatedAt: now,
    },
  };
}

type FireResult = 'fired' | 'policy_blocked' | 'duplicate' | 'gone' | 'paused' | 'blocked';

/**
 * Records one firing and its effect artifact atomically.
 *
 * The policy runs first and outside the transaction; the event, the new
 * baseline and the artifact commit together or not at all. The definition is
 * re-read inside the transaction and the two "do nothing" states — paused,
 * disconnected — are re-checked there, so a change that landed between the
 * sweep's read and this commit cannot slip an effect past it.
 */
async function commitFiring(
  stored: StoredWatcher,
  signal: WatcherSignal,
  now: string,
  storage: StorageAdapter,
): Promise<FireResult> {
  const { definition } = stored;
  const eventId = watcherEventIdFor(definition.watcherId, signal.signalId);
  const eventPath = userSubDoc(definition.scopeId, WATCHER_EVENTS, eventId);
  const watcherPath = userSubDoc(definition.scopeId, WATCHERS, definition.watcherId);
  const connectionPath = definition.source.connectionId === null
    ? null
    : userSubDoc(definition.scopeId, PROVIDER_CONNECTIONS, definition.source.connectionId);

  // The capability comes from the effect table and from nowhere else. A stored
  // effect the table does not name — a corrupted document, a downgrade, an
  // effect added to the contract without a policy row — is denied here rather
  // than handed to the policy, because `evaluateActionPolicy` reads the
  // capability as a string and an absent one must not be allowed to become a
  // thrown sweep failure that looks like bad luck. This is the only lookup: a
  // watcher has no field that could name a capability of its own, which is why
  // no watcher can reach a provider write.
  const capability: CapabilityId | undefined = WATCHER_EFFECT_CAPABILITIES[definition.effect];
  const decision = capability === undefined
    ? { decision: 'denied' as const, reason: 'unknown_watcher_effect' }
    : evaluateActionPolicy({
      capability,
      // The effect is a local write; no provider executes anything here. The
      // three confirmation flags are hard-coded false: a watcher fires without
      // anybody present, so it can only ever run what an unconfirmed,
      // non-interactive system actor is allowed to run.
      provider: null,
      actor: 'system',
      userConfirmed: false,
      strongConfirmation: false,
      settingsAllowAutomaticExternalWrites: false,
    });

  if (decision.decision !== 'allowed') {
    const blocked = fireEvent(stored, signal, now, 'policy_blocked', decision.reason, decision.decision, null);
    return storage.runTransaction(async (tx) => {
      if (await tx.get<WatcherFireEvent>(eventPath)) return 'duplicate';
      const current = await tx.get<StoredWatcher>(watcherPath);
      if (!current) return 'gone';
      if (!current.definition.enabled) return 'paused';
      if (await isMonitoringPaused(definition.scopeId, storage, tx)) {
        tx.set(watcherPath, absorbedRuntime(current, signal, now, false));
        return 'paused';
      }
      tx.create(eventPath, blocked);
      // Absorbed, not fired: a refusal must not advance `fireCount` or
      // `lastFiredAt`, or the history would claim an effect that never ran.
      // The baseline still moves, so the same refused state is not re-evaluated
      // every minute forever.
      tx.set(watcherPath, absorbedRuntime(current, signal, now, false));
      return 'policy_blocked';
    });
  }

  return storage.runTransaction(async (tx) => {
    if (await tx.get<WatcherFireEvent>(eventPath)) return 'duplicate';
    const current = await tx.get<StoredWatcher>(watcherPath);
    if (!current) return 'gone';
    if (!current.definition.enabled) return 'paused';
    if (await isMonitoringPaused(definition.scopeId, storage, tx)) {
      tx.set(watcherPath, absorbedRuntime(current, signal, now, false));
      return 'paused';
    }
    if (connectionPath) {
      const connection = await tx.get<IntegrationConnectionRecord>(connectionPath);
      if (!connection || connection.state !== 'connected') return 'blocked';
    }
    const artifact = effectArtifact(current, signal, now, eventId);
    const event = fireEvent(
      current, signal, now, 'effected', watchConditionReason(current.definition.condition), decision.decision,
      artifact?.ref ?? null,
    );
    tx.create(eventPath, event);
    tx.set(watcherPath, absorbedRuntime(current, signal, now, true));
    if (artifact) tx.create(artifact.path, artifact.value);
    return 'fired';
  });
}

/** The counters one watcher's turn may increment. `remaining` and `failures` are the sweep's own. */
type WatcherSweepCounter = keyof Omit<WatcherSweepTotals, 'scanned' | 'remaining' | 'failures'>;

/**
 * One watcher, one observation. Returns every counter this turn increments —
 * `evaluated` (an observer answered and the condition ran) is orthogonal to
 * the outcome, so a firing returns both, and the two are reported rather than
 * one overwriting the other. Never throws: one bad watcher must not stop the
 * rest of the run (the same isolation the football projection gives one
 * user's fixtures).
 */
async function evaluateOne(
  row: StoredWatcher,
  now: string,
  storage: StorageAdapter,
  registry: WatcherSignalRegistry,
): Promise<readonly WatcherSweepCounter[]> {
  const { definition, runtime } = row;
  const connection = definition.source.connectionId === null
    ? { required: false, state: null }
    : { required: true, state: (await readConnection(definition.scopeId, definition.source.connectionId, storage))?.state ?? null };
  const observer = registry.observerFor(definition.source);
  const computed = watcherStatusOf(definition, connection, observer !== null);

  if (computed.status === 'paused') {
    if (runtime.status !== 'paused') {
      await new StatusWriter(storage, definition.scopeId, definition.watcherId).write({ status: 'paused', blockedReason: null }, now);
    }
    return ['paused'];
  }
  if (computed.status === 'blocked') {
    if (runtime.status !== 'blocked' || runtime.blockedReason !== computed.blockedReason) {
      await new StatusWriter(storage, definition.scopeId, definition.watcherId).write(computed, now);
    }
    return ['blocked'];
  }

  // Computed active. Entering active from anywhere else primes rather than
  // fires: the current state becomes the baseline and history is not replayed.
  if (runtime.status !== 'active') {
    const signal = await observer!.observe(definition.source, { scopeId: definition.scopeId, now }, { storage });
    await new StatusWriter(storage, definition.scopeId, definition.watcherId).write(
      { status: 'active', blockedReason: null }, now, signal,
    );
    return ['primed'];
  }

  const signal = await observer!.observe(definition.source, { scopeId: definition.scopeId, now }, { storage });
  if (!signal) return ['noSignal'];

  if (!evaluateWatchCondition(definition.condition, signal, runtime)) {
    if (runtime.lastDigest !== signal.stateDigest || runtime.lastSignalId !== signal.signalId) {
      await new StatusWriter(storage, definition.scopeId, definition.watcherId).absorb(signal, now);
    }
    return ['evaluated'];
  }

  const result = await commitFiring(row, signal, now, storage);
  if (result === 'fired') return ['evaluated', 'fired'];
  if (result === 'policy_blocked') return ['evaluated', 'policyBlocked'];
  if (result === 'duplicate') return ['evaluated', 'duplicates'];
  if (result === 'paused') return ['evaluated', 'paused'];
  if (result === 'blocked') return ['evaluated', 'blocked'];
  // `gone`: the watcher was deleted between the sweep's read and the commit.
  return ['evaluated'];
}

/** Small writer so the three runtime-write call sites stay readable. */
class StatusWriter {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly scopeId: string,
    private readonly watcherId: string,
  ) {}

  private path(): string {
    return userSubDoc(this.scopeId, WATCHERS, this.watcherId);
  }

  async write(
    status: { status: StoredWatcher['runtime']['status']; blockedReason: StoredWatcher['runtime']['blockedReason'] },
    now: string,
    primeWith?: WatcherSignal | null,
  ): Promise<void> {
    await this.storage.runTransaction(async (tx) => {
      const current = await tx.get<StoredWatcher>(this.path());
      if (!current) return;
      tx.set(this.path(), {
        ...current,
        runtime: {
          ...current.runtime,
          status: status.status,
          blockedReason: status.blockedReason,
          ...(primeWith ? {
            lastSignalId: primeWith.signalId,
            lastDigest: primeWith.stateDigest,
            lastMeasures: primeWith.measures,
            lastObservedAt: primeWith.observedAt,
          } : {}),
          updatedAt: now,
        },
      });
    });
  }

  async absorb(signal: WatcherSignal, now: string): Promise<void> {
    await this.storage.runTransaction(async (tx) => {
      const current = await tx.get<StoredWatcher>(this.path());
      if (!current) return;
      tx.set(this.path(), absorbedRuntime(current, signal, now, false));
    });
  }
}

/**
 * The per-minute sweep. Bounded by `limit`; anything beyond it is reported in
 * `remaining` and taken by the next tick, the same answer the jobs tick gives
 * to a reminder backlog.
 */
export async function runWatcherSweep(options: WatcherSweepOptions = {}): Promise<WatcherSweepTotals> {
  const storage = options.storage ?? getStorage();
  const registry = options.registry ?? defaultWatcherSignalRegistry();
  const now = (options.now ?? new Date()).toISOString();
  const limit = options.limit ?? WATCHER_SWEEP_BATCH;

  const totals = emptyTotals();
  const { rows, remaining } = await listWatchersAcrossUsers(storage, limit);
  totals.remaining = remaining;
  totals.scanned = rows.length;

  for (const row of rows) {
    try {
      for (const counter of await evaluateOne(row.stored, now, storage, registry)) {
        totals[counter] += 1;
      }
    } catch (error) {
      totals.failures.push({
        watcherId: row.watcherId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return totals;
}
