/**
 * Watchers and their connections, projected into what a Trust screen shows
 * (#527, slice 1).
 *
 * Read-only. It reads two things the system already stores — the account's
 * watchers and the connection records they name — and returns a list. It
 * writes nothing, schedules nothing and decides nothing about whether a
 * watcher may run; `watcherStatusOf` and the engine keep that job.
 *
 * ── Why the status is recomputed rather than read ─────────────────
 *
 * `WatcherRuntime.status` is what the **last sweep** concluded. For a user
 * looking at a Trust screen that is the wrong tense: revoking a connection
 * updates the connection record immediately, and the watcher's stored status
 * still says `active` until the next sweep writes over it. Showing "active"
 * next to a provider the user disconnected thirty seconds ago is precisely
 * the kind of thing this issue exists to stop.
 *
 * So connection-derived status is computed here from the live record, in the
 * same order `watcherStatusOf` uses, and only `signal_unavailable` — which
 * depends on the engine's observer registry and is not readable from storage —
 * is taken from the stored runtime. Those two are kept in the same order as
 * the engine's so the projection cannot disagree with it about precedence:
 * disabled first, then the connection, then the observer.
 *
 * ── Nothing from the provider crosses this boundary ───────────────
 *
 * Every string this module emits is an identifier the system minted, an
 * instant, or a member of a closed vocabulary. It never reads
 * `credentialRef`, `grantedScopes`, `identity.displayName`, `errorCode`, a
 * sync cursor, or any watcher measure. `tests/watchers/backgroundMonitors.test.ts`
 * asserts that over the serialized output as a whole.
 */
import {
  BACKGROUND_MONITOR_SCHEMA_VERSION,
  type BackgroundActivityView,
  type BackgroundMonitorPurpose,
  type BackgroundMonitorStatus,
  type BackgroundMonitorView,
} from '../../src/contracts/v1/backgroundMonitorContracts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import type { WatchCondition } from '../../src/contracts/v1/watcherContracts';
import { getStorage, type StorageAdapter } from '../storage';
import { userSubDoc, PROVIDER_CONNECTIONS } from '../storage/paths';
import { createWatcherStore, type StoredWatcher } from './watcherStore';
import { readMonitoringSettings } from './monitoringSettings';

/**
 * How often the sweep runs, in minutes.
 *
 * `infra/scheduler.sh` upserts `watcher-sweep-*` with the crontab `* * * * *`,
 * so this is one. It is stated here because `nextCheckAt` is otherwise a
 * number this module would be inventing, and
 * `tests/watchers/backgroundMonitors.test.ts` reads that shell line and fails
 * if the two ever disagree — a cadence changed in infra and not here would
 * make the app quietly promise the wrong thing.
 */
export const WATCHER_SWEEP_INTERVAL_MINUTES = 1;

const PURPOSE_BY_CONDITION: Readonly<Record<WatchCondition['kind'], BackgroundMonitorPurpose>> = Object.freeze({
  digest_changed: 'notice_any_change',
  threshold: 'notice_threshold_crossed',
});

/** `mon_` + the watcher id. See `BackgroundMonitorView.monitorId`. */
export function monitorIdForWatcher(watcherId: string): string {
  return `mon_${watcherId}`;
}

/**
 * The status of one watcher, given the connection record it names.
 *
 * `connection` is the record as stored, or null for "this watcher names a
 * connection and there is no such record" — which is treated exactly like a
 * disconnected one, because from the user's side it is: there is nothing
 * there to read through.
 */
export function backgroundMonitorStatusOf(
  stored: StoredWatcher,
  connection: IntegrationConnectionRecord | null,
): BackgroundMonitorStatus {
  const { definition, runtime } = stored;
  if (!definition.enabled) return 'paused';

  if (definition.source.connectionId !== null) {
    const state = connection?.state ?? null;
    if (state !== 'connected') {
      // `permission_limited` is a grant that exists and is too narrow, which
      // the user fixes the same way an expired one is fixed — by
      // re-authorizing — so the engine groups the two and so does this.
      if (state === 'needs_reauth' || state === 'permission_limited') return 'needs_reauth';
      if (state === 'error') return 'error';
      return 'blocked_permission';
    }
    // A connected record that still asks for re-auth. The engine does not read
    // this flag, because by the time it matters the state has moved; a screen
    // that told the user everything was fine while the record says otherwise
    // would be wrong in the direction this issue cares about.
    if (connection?.reauthRequired === true) return 'needs_reauth';
  }

  // The only input that is not readable from storage: whether an observer is
  // registered for this (provider, signalKind). The last sweep is the only
  // thing that knows, so it is the one status taken from the runtime.
  if (runtime.status === 'blocked' && runtime.blockedReason === 'signal_unavailable') return 'error';

  return 'active';
}

function nextCheckAt(status: BackgroundMonitorStatus, now: string): string | null {
  // Only an active monitor has a next check. The sweep does visit a paused or
  // blocked watcher, but it returns before observing anything, so saying it
  // is "about to check" would be false.
  if (status !== 'active') return null;
  return new Date(Date.parse(now) + WATCHER_SWEEP_INTERVAL_MINUTES * 60_000).toISOString();
}

export function projectBackgroundMonitor(
  stored: StoredWatcher,
  connection: IntegrationConnectionRecord | null,
  now: string,
): BackgroundMonitorView {
  const { definition, runtime } = stored;
  const status = backgroundMonitorStatusOf(stored, connection);
  return {
    monitorId: monitorIdForWatcher(definition.watcherId),
    watcherId: definition.watcherId,
    connectionId: definition.source.connectionId,
    // User-authored label or closed vocabulary fallback, never a provider-authored string.
    label: definition.label ?? `${definition.source.provider}:${definition.source.signalKind}`,
    status,
    purpose: PURPOSE_BY_CONDITION[definition.condition.kind],
    effects: [definition.effect],
    lastCheckedAt: runtime.lastObservedAt,
    lastChangedAt: runtime.lastFiredAt,
    nextCheckAt: nextCheckAt(status, now),
    // A paused monitor's row offers Resume, which is the same endpoint with
    // `paused: false`; it is not a second thing this flag has to describe.
    canPause: definition.enabled,
    // `DELETE /api/mobile/watchers/{id}` refuses nothing an account owns,
    // including one a pack template created. If that ever gains a rule, it
    // belongs in one place and this reads it.
    canDelete: true,
  };
}

export interface BackgroundActivityDeps {
  readonly storage?: StorageAdapter;
}

/**
 * Every watcher this account has, as monitors.
 *
 * Ordered by `monitorId` so two reads of an unchanged account are byte
 * identical: the store's own order is the collection's, and a list whose rows
 * move between reads makes a client's diffing and a fixture's stability both
 * unreliable.
 *
 * Connections are read once per distinct `connectionId`, not once per watcher:
 * several watchers over one calendar are the ordinary case and would otherwise
 * be several reads of the same document.
 */
export async function listBackgroundActivity(
  uid: string,
  now: string,
  deps: BackgroundActivityDeps = {},
): Promise<BackgroundActivityView> {
  const storage = deps.storage ?? getStorage();
  const settings = await readMonitoringSettings(uid, { storage });
  const watchers = await createWatcherStore(uid, storage).list();

  const connectionIds = Array.from(new Set(
    watchers
      .map((watcher) => watcher.definition.source.connectionId)
      .filter((id): id is string => id !== null),
  ));
  const connections = new Map<string, IntegrationConnectionRecord | null>();
  for (const connectionId of connectionIds) {
    connections.set(
      connectionId,
      (await storage.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionId))) ?? null,
    );
  }

  const monitors = watchers
    .map((watcher) => projectBackgroundMonitor(
      watcher,
      watcher.definition.source.connectionId === null
        ? null
        : connections.get(watcher.definition.source.connectionId) ?? null,
      now,
    ))
    .sort((left, right) => left.monitorId.localeCompare(right.monitorId));

  return { schemaVersion: BACKGROUND_MONITOR_SCHEMA_VERSION, paused: settings.paused, monitors };
}
