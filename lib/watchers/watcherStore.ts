/**
 * Watcher persistence (#525).
 *
 * One document per watcher at `users/{uid}/watchers/{watcherId}`, holding the
 * user-configured `WatcherDefinition` and the engine's `WatcherRuntime`
 * together, because the two are always read and written in the same breath —
 * the API joins them for the client, and the engine updates the runtime
 * baselines in the same transaction that records a firing.
 *
 * ── Scope is the account ───────────────────────────────────────────
 *
 * Every method takes the uid and builds paths from it, so one account's
 * watchers are unreadable from another's — a GET for somebody else's watcher
 * id is a 404, the same answer as a watcher that never existed. The sweep is
 * the one cross-account reader (`listWatchersAcrossUsers`), and it is
 * collection-group based for the reason `listFollowedUserIds` is: the
 * per-minute job must not need the list of uids up front.
 */
import { randomUUID } from 'node:crypto';
import {
  type WatcherFireEvent,
  WATCHER_CONTRACT_VERSION,
  WATCHER_SCHEMA_VERSION,
  type WatcherDefinition,
  type WatcherEffect,
  type WatchCondition,
  type WatcherRuntime,
  type WatcherSourceRef,
  type WatcherStatus,
  type WatcherBlockedReason,
} from '../../src/contracts/v1/watcherContracts';
import { getStorage, type StorageAdapter } from '../storage';
import { userCol, userSubDoc, WATCHER_EVENTS, WATCHERS } from '../storage/paths';

export interface StoredWatcher {
  readonly definition: WatcherDefinition;
  readonly runtime: WatcherRuntime;
}

export interface NewWatcherInput {
  readonly enabled: boolean;
  readonly label?: string;
  readonly source: WatcherSourceRef;
  readonly condition: WatchCondition;
  readonly effect: WatcherEffect;
  readonly createdBy: 'user' | 'pack_template';
}

export function initialWatcherRuntime(watcherId: string, scopeId: string, now: string): WatcherRuntime {
  return {
    watcherId,
    scopeId,
    // Every watcher is born active-but-unprimed: with no baseline the first
    // observation primes rather than fires, so nothing that happened before
    // the watcher existed is ever replayed as a trigger.
    status: 'active',
    blockedReason: null,
    lastSignalId: null,
    lastDigest: null,
    lastMeasures: [],
    lastObservedAt: null,
    lastFiredAt: null,
    fireCount: 0,
    updatedAt: now,
  };
}

export class WatcherStore {
  constructor(
    private readonly uid: string,
    private readonly storage: StorageAdapter,
  ) {}

  private path(watcherId: string): string {
    return userSubDoc(this.uid, WATCHERS, watcherId);
  }

  async create(input: NewWatcherInput, now: string): Promise<StoredWatcher> {
    const watcherId = `wtc_${randomUUID()}`;
    const stored: StoredWatcher = {
      definition: {
        version: WATCHER_CONTRACT_VERSION,
        schemaVersion: WATCHER_SCHEMA_VERSION,
        watcherId,
        scopeId: this.uid,
        enabled: input.enabled,
        ...(input.label ? { label: input.label } : {}),
        source: input.source,
        condition: input.condition,
        effect: input.effect,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      },
      runtime: initialWatcherRuntime(watcherId, this.uid, now),
    };
    await this.storage.set(this.path(watcherId), stored);
    return stored;
  }

  async get(watcherId: string): Promise<StoredWatcher | null> {
    return (await this.storage.get<StoredWatcher>(this.path(watcherId))) ?? null;
  }

  async list(): Promise<readonly StoredWatcher[]> {
    const rows = await this.storage.list<StoredWatcher>(userCol(this.uid, WATCHERS));
    return rows
      .map((row) => row.data)
      .sort((left, right) => left.definition.createdAt.localeCompare(right.definition.createdAt));
  }

  /**
   * Transactional read-modify-write of the one document. `mutate` returns the
   * next stored watcher, or null to leave it untouched.
   */
  async update(
    watcherId: string,
    mutate: (current: StoredWatcher) => StoredWatcher | null,
  ): Promise<StoredWatcher | null> {
    const path = this.path(watcherId);
    return this.storage.runTransaction(async (tx) => {
      const current = await tx.get<StoredWatcher>(path);
      if (!current) return null;
      const next = mutate(current);
      if (!next) return current;
      tx.set(path, next);
      return next;
    });
  }

  /**
   * This watcher's firings, newest first, bounded.
   *
   * Read out of *this account's* `watcherEvents` collection and filtered by
   * watcher id, so a history request naming another account's watcher id
   * returns nothing — there is no path from a uid to another uid's events,
   * because the collection the query runs against is built from the caller's
   * own uid before the filter is applied.
   */
  async listEvents(watcherId: string, limit: number): Promise<readonly WatcherFireEvent[]> {
    const rows = await this.storage.list<WatcherFireEvent>(userCol(this.uid, WATCHER_EVENTS), {
      where: [['watcherId', '==', watcherId]],
      orderBy: { field: 'firedAt', direction: 'desc' },
      limit,
    });
    return rows.map((row) => row.data);
  }

  async remove(watcherId: string): Promise<boolean> {
    const path = this.path(watcherId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredWatcher>(path);
      if (!existing) return false;
      tx.delete(path);
      return true;
    });
  }
}

export function createWatcherStore(uid: string, storage?: StorageAdapter): WatcherStore {
  return new WatcherStore(uid, storage ?? getStorage());
}

export interface SweepWatcherRow {
  readonly watcherId: string;
  readonly stored: StoredWatcher;
}

/**
 * Every watcher anybody has, oldest first, capped — the sweep's read.
 *
 * Bounded so a run's cost is known before it starts; whatever exceeds the cap
 * is picked up by the next tick a minute later. The cap counts documents, so
 * paused watchers are not free — they are filtered after the read, which the
 * sweep report's `paused` count reflects.
 */
export async function listWatchersAcrossUsers(
  storage: StorageAdapter,
  limit: number,
): Promise<{ rows: SweepWatcherRow[]; remaining: boolean }> {
  const rows = await storage.listGroup<StoredWatcher>(WATCHERS, { limit: limit + 1 });
  const page = rows.slice(0, limit).map((row) => ({
    watcherId: row.data.definition.watcherId,
    stored: row.data,
  }));
  return { rows: page, remaining: rows.length > limit };
}

export function watcherStatusOf(
  definition: Pick<WatcherDefinition, 'enabled'>,
  connection: { required: boolean; state: string | null },
  observerAvailable: boolean,
): { status: WatcherStatus; blockedReason: WatcherBlockedReason | null } {
  if (!definition.enabled) return { status: 'paused', blockedReason: null };
  // A watcher that names a connection can only run while that connection is
  // connected; one that was revoked, expired or never existed blocks. A watcher
  // naming none (readiness on the account, shared fixtures) never does.
  if (connection.required && connection.state !== 'connected') {
    return {
      status: 'blocked',
      blockedReason: connection.state === 'needs_reauth' || connection.state === 'permission_limited'
        ? 'provider_needs_reauth'
        : 'provider_disconnected',
    };
  }
  if (!observerAvailable) return { status: 'blocked', blockedReason: 'signal_unavailable' };
  return { status: 'active', blockedReason: null };
}
