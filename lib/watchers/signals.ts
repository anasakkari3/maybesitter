/**
 * Where watcher signals come from (#525).
 *
 * An observer is the normalized boundary the issue's engine diagram draws:
 *
 *   provider / native adapter → normalized WatcherSignal → matching watchers
 *
 * It knows one kind of source (stored readiness, the shared fixture store, …)
 * and answers "what is the state of this subject right now" as a
 * `WatcherSignal` — a digest, normalized measures and a provenance pointer.
 * Provider response shapes never leave the observer: there is no field on
 * `WatcherSignal` that could carry one.
 *
 * Signal ids are content-addressed (`kind:subject:digest`), so the same state
 * observed twice — a retried sweep, overlapping ticks — is the same signal,
 * which is what makes the firing dedupe below hold across instances rather
 * than only within one process.
 */
import { createHash } from 'node:crypto';
import {
  WATCHER_SIGNAL_SCHEMA_VERSION,
  type WatcherSignal,
  type WatcherSourceRef,
} from '../../src/contracts/v1/watcherContracts';
import type { Fixture } from '../../src/contracts/v1/fixtureContracts';
import type { StorageAdapter } from '../storage';
import { fixtureDoc } from '../storage/paths';
import { composeCurrentUserState } from '../userState/userStateService';

export interface WatcherSignalObserver {
  /** Which sources this observer can answer for. */
  supports(source: WatcherSourceRef): boolean;
  observe(
    source: WatcherSourceRef,
    context: { scopeId: string; now: string },
    deps: { storage: StorageAdapter },
  ): Promise<WatcherSignal | null>;
}

export interface WatcherSignalRegistry {
  observerFor(source: WatcherSourceRef): WatcherSignalObserver | null;
}

export function createWatcherSignalRegistry(
  observers: readonly WatcherSignalObserver[],
): WatcherSignalRegistry {
  return {
    observerFor(source) {
      return observers.find((observer) => observer.supports(source)) ?? null;
    },
  };
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/* ── Readiness ───────────────────────────────────────────────────── */

export const READINESS_SIGNAL_KIND = 'readiness';
/** The normalized measure a readiness threshold condition names. */
export const READINESS_SCORE_METRIC = 'readiness_score';

/**
 * Readiness as a watcher signal, composed from the same UserState projection
 * the product already reads (`composeCurrentUserState`). The digest covers the
 * band and the score — the two normalized facts a condition can be about — so
 * a provider payload that moved without moving either one is NO_EFFECT, not a
 * firing.
 */
export const readinessObserver: WatcherSignalObserver = {
  supports: (source) => source.signalKind === READINESS_SIGNAL_KIND,
  async observe(source, context, deps) {
    const current = await composeCurrentUserState(
      { uid: context.scopeId, now: context.now },
      { storage: deps.storage },
    );
    const snapshot = current.projection.readiness;
    if (!snapshot) return null;
    const stateDigest = digestOf({ band: snapshot.band, score: snapshot.score });
    return {
      schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
      signalId: `${READINESS_SIGNAL_KIND}:${context.scopeId}:${stateDigest}`,
      provider: source.provider,
      signalKind: READINESS_SIGNAL_KIND,
      subjectRef: source.subjectRef,
      observedAt: snapshot.computedAt,
      stateDigest,
      provenanceRef: 'userState/readiness',
      measures: snapshot.score === null ? [] : [{ metric: READINESS_SCORE_METRIC, value: snapshot.score }],
    };
  },
};

/* ── Football fixtures ───────────────────────────────────────────── */

export const FIXTURE_SIGNAL_KIND = 'fixture';

/**
 * A stored fixture as a watcher signal. The fixture store already keeps one
 * normalized, content-hashed row per match (`lib/football/fixtureStore.ts`);
 * the signal's digest *is* that content hash, so "the fixture changed" and
 * "the digest changed" are the same statement by construction.
 */
export const fixtureObserver: WatcherSignalObserver = {
  supports: (source) => source.signalKind === FIXTURE_SIGNAL_KIND,
  async observe(source, context, deps) {
    const fixture = await deps.storage.get<Fixture>(fixtureDoc(source.provider, source.subjectRef));
    if (!fixture) return null;
    return {
      schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
      signalId: `${FIXTURE_SIGNAL_KIND}:${fixture.provider}:${fixture.providerMatchId}:${fixture.contentHash}`,
      provider: fixture.provider,
      signalKind: FIXTURE_SIGNAL_KIND,
      subjectRef: fixture.providerMatchId,
      observedAt: context.now,
      stateDigest: fixture.contentHash,
      provenanceRef: `fixtures/${fixture.provider}/${fixture.providerMatchId}`,
      measures: [],
    };
  },
};

/** The observers a deployed sweep runs with. Tests build their own registry. */
export function defaultWatcherSignalRegistry(): WatcherSignalRegistry {
  return createWatcherSignalRegistry([readinessObserver, fixtureObserver]);
}
