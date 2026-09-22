/**
 * The API-boundary half of "a disabled pack is off" (#528, slice 2).
 *
 * `enabled` is a field a client can write: `PATCH /api/mobile/watchers/{id}`
 * and `POST /api/mobile/watchers/{id}/pause` with `{"paused": false}` both set
 * it. Without this guard, a subscriber whose entitlement lapsed could resume
 * their pack's watchers by hand — the record would still say `disabled`, the
 * reconciler would still report "unchanged", and the premium behaviour would
 * run on every sweep for ever.
 *
 * So enabling a watcher that a pack installed is refused while that pack's
 * installation is disabled. The complementary half is in
 * `applyPackEntitlement`, whose deny direction re-asserts `enabled: false`
 * unconditionally; a guard that can be raced needs a reconciler behind it.
 *
 * ── Fail closed on an unattributable pack watcher ──────────────────
 *
 * A `pack_template` watcher that appears on no installation record cannot be
 * reached by `disablePack` — nothing in the product can turn it off. Enabling
 * one is therefore refused too, rather than being treated as "no pack said
 * no". The three ways one could exist are all closed now (the API rejects a
 * client-supplied `createdBy: 'pack_template'`, `enablePack` validates every
 * subject before it writes anything, and a failed install rolls back), and
 * `tests/packs/packWatcherIntegrity.test.ts` asserts the invariant directly.
 */

import { getStorage, type StorageAdapter } from '../storage';
import { PACK_INSTALLATIONS, userCol, userSubDoc } from '../storage/paths';
import type { PackInstallationRecord } from '../../src/contracts/v1/verticalPackContracts';
import type { StoredWatcher } from '../watchers/watcherStore';

/** Why a watcher may not be enabled. Carries a reason code for the route. */
export class PackWatcherLockedError extends Error {
  constructor(message: string, readonly reason: 'pack_disabled' | 'pack_watcher_unattributable') {
    super(message);
    this.name = 'PackWatcherLockedError';
  }
}

export interface PackWatcherGuardDeps {
  readonly storage?: StorageAdapter;
}

/**
 * Which installation records claim this watcher.
 *
 * Returns every match rather than the first, so a caller can tell "one pack
 * owns it" from the corrupt state where two do.
 */
export async function packsClaiming(
  scopeId: string,
  watcherId: string,
  deps: PackWatcherGuardDeps = {},
): Promise<readonly PackInstallationRecord[]> {
  const storage = deps.storage ?? getStorage();
  const rows = await storage.list<PackInstallationRecord>(userCol(scopeId, PACK_INSTALLATIONS));
  return rows
    .map((row) => row.data)
    .filter((record) => record.watcherIds.includes(watcherId))
    .sort((left, right) => left.packId.localeCompare(right.packId));
}

/**
 * Throws unless this watcher may be switched on right now.
 *
 * A watcher the user built by hand is never this function's business: only
 * `createdBy: 'pack_template'` is gated, because only a pack has an
 * entitlement behind it.
 */
export async function assertPackWatcherMayBeEnabled(
  scopeId: string,
  stored: StoredWatcher,
  deps: PackWatcherGuardDeps = {},
): Promise<void> {
  if (stored.definition.createdBy !== 'pack_template') return;

  const claims = await packsClaiming(scopeId, stored.definition.watcherId, deps);
  if (claims.length === 0) {
    throw new PackWatcherLockedError(
      'this watcher was installed by a pack that no longer claims it, so it cannot be switched on',
      'pack_watcher_unattributable',
    );
  }
  const disabled = claims.filter((record) => record.state === 'disabled');
  if (disabled.length > 0) {
    throw new PackWatcherLockedError(
      `the ${disabled.map((record) => record.packId).join(', ')} pack is disabled; enable the pack to resume its watchers`,
      'pack_disabled',
    );
  }
}

/**
 * Drop a deleted watcher from whatever installation record claimed it.
 *
 * Without this, deleting a pack watcher leaves a dangling id on the record:
 * `setPackWatchersEnabled` silently swallows it (the store's `update` returns
 * null for a document that is gone) while `enablePack` keeps reporting the
 * full `watcherIds` as though the pack were intact. The record would claim
 * more than it owns, and the "exactly one record" invariant would be true of
 * watchers but not of ids.
 *
 * `templateIds` is pruned index-for-index with `watcherIds`, so a later
 * re-enable sees the template as uninstalled and reinstalls it — which is the
 * behaviour a user deleting one of a pack's watchers and then toggling the
 * pack would expect.
 */
export async function forgetPackWatcher(
  scopeId: string,
  watcherId: string,
  now: string,
  deps: PackWatcherGuardDeps = {},
): Promise<readonly string[]> {
  const storage = deps.storage ?? getStorage();
  const touched: string[] = [];
  for (const record of await packsClaiming(scopeId, watcherId, { storage })) {
    const keep = record.watcherIds
      .map((id, index) => ({ id, templateId: record.templateIds[index] }))
      .filter((entry) => entry.id !== watcherId);
    await storage.set(userSubDoc(scopeId, PACK_INSTALLATIONS, record.packId), {
      ...record,
      watcherIds: Object.freeze(keep.map((entry) => entry.id)),
      templateIds: Object.freeze(keep.map((entry) => entry.templateId).filter((id): id is string => id !== undefined)),
      updatedAt: now,
    });
    touched.push(record.packId);
  }
  return Object.freeze(touched);
}
