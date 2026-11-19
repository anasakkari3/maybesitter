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
 *
 * ── The account deletion fence (#772) ──────────────────────────────
 *
 * `create` and `update` read `users/{uid}` in the transaction that writes the
 * watcher and refuse (`AccountUnavailableError`) unless the account is live:
 * a follow, a pack install or a pause in flight when the account is deleted
 * must not re-create a watcher the per-minute sweep would then keep finding.
 * `remove` is left plain: a delete re-creates nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { requireLiveAccount } from '../account/accountLiveness';
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

  private build(input: NewWatcherInput, now: string, watcherId: string): StoredWatcher {
    const runtime = initialWatcherRuntime(watcherId, this.uid, now);
    return {
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
      // A watcher created off is paused from its first read, not `active`
      // until a sweep notices (QA CXA6.7).
      runtime: input.enabled ? runtime : { ...runtime, status: 'paused' },
    };
  }

  async create(input: NewWatcherInput, now: string): Promise<StoredWatcher> {
    const stored = this.build(input, now, `wtc_${randomUUID()}`);
    await this.storage.runTransaction(async (tx) => {
      await requireLiveAccount(tx, this.uid);
      tx.set(this.path(stored.definition.watcherId), stored);
    });
    return stored;
  }

  /**
   * Creates the watcher under a fixed id unless that document already exists,
   * in one transaction: two requests racing to create "the same" watcher end
   * with one document (QA CXA6.4, CA6.7). Answers the stored one either way.
   */
  async createOnce(
    input: NewWatcherInput,
    now: string,
    watcherId: string,
  ): Promise<{ watcher: StoredWatcher; created: boolean }> {
    const path = this.path(watcherId);
    return this.storage.runTransaction(async (tx) => {
      await requireLiveAccount(tx, this.uid);
      const existing = await tx.get<StoredWatcher>(path);
      if (existing) return { watcher: existing, created: false };
      const stored = this.build(input, now, watcherId);
      tx.set(path, stored);
      return { watcher: stored, created: true };
    });
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
      await requireLiveAccount(tx, this.uid);
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
    // Only this generation's: a watcher made again under its stable id does
    // not inherit the firings of the one deleted before it (E3 review). Old
    // firings are older, so they sit at the tail the limit cuts first.
    const current = await this.get(watcherId);
    return rows.map((row) => row.data).filter((event) => isCurrentGeneration(event, current));
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

/**
 * A `wtc_<uuid>`-shaped id derived from what makes two watchers "the same"
 * (QA CXA6.4, CA6.7), within one account. The uid is part of the hash so two
 * accounts never share an id: a request naming another account's watcher id
 * must keep finding nothing. A watcher deleted and made again gets its id back.
 */
export function stableWatcherId(uid: string, key: string): string {
  const hex = createHash('sha256').update(`${uid}\u0000${key}`).digest('hex');
  return `wtc_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Whether a firing belongs to the watcher now under its id. An event without
 * `watcherCreatedAt` predates stable ids and so cannot belong to an earlier
 * generation; one with it must match (E3 review).
 */
export function isCurrentGeneration(event: WatcherFireEvent, watcher: StoredWatcher | null | undefined): boolean {
  if (!watcher || event.watcherCreatedAt === undefined) return true;
  return event.watcherCreatedAt === watcher.definition.createdAt;
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
