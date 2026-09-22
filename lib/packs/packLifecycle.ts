/**
 * Pack rollout: enabling and disabling a pack for one account (#528, slice 2).
 *
 * Slice 1 left this sentence in `packEntitlement.ts`: "enabling and disabling
 * packs against this decision (stopping watchers, removing UI, preserving
 * data) is the follow-up slice." This is that slice's non-UI half.
 *
 * ── Disabling is a pause, never a purge ────────────────────────────
 *
 * Every stop in here is `enabled: false` on the watcher the pack installed.
 * Nothing is deleted: not the watcher, not its runtime baseline, not its
 * firing history, and certainly not the provider connection it reads through
 * or any commitment the user made. That is not a stylistic preference — it is
 * the RevenueCat contract restated ("entitlement loss preserves data and
 * disables premium behaviour") and the issue's rollout rule restated
 * ("disabling does not corrupt the shared provider connection, does not
 * delete unrelated user data"). A lapsed subscription that deleted watchers
 * would be indistinguishable, a month later, from a user who never had the
 * pack; a disabled one resumes exactly where it stopped.
 *
 * The engine does the stopping, not this module: `watcherStatusOf` reads
 * `enabled: false` as `paused`, and `runWatcherSweep` re-checks it inside the
 * firing transaction. So a disabled pack is silent for the same reason a
 * paused watcher is, through the same code path, with no pack-aware branch
 * anywhere in the engine. There is no per-pack worker here and no per-pack
 * scheduler — a pack's watchers ride the one sweep or they do not run.
 *
 * ── Resuming never replays ─────────────────────────────────────────
 *
 * Re-enabling restores the *same* watcher documents rather than creating new
 * ones, which is what makes "preserve data" mean something: the ids, the
 * history and the subject the user pointed at all survive a lapse. Entering
 * `active` primes the baseline from the current signal without firing (the
 * engine's own rule), so a month of missed fixtures is absorbed, not
 * delivered in a burst the moment a card is charged.
 *
 * ── A pack only ever stops its own watchers ────────────────────────
 *
 * The pack→watcher link is `PackInstallationRecord.watcherIds`; see that
 * contract's header for why it lives there and not as a field on the watcher.
 * Every mutation below additionally refuses to touch a watcher whose
 * `createdBy` is not `pack_template`, so even a corrupted record cannot let a
 * pack switch off something the user built by hand.
 *
 * That guard is narrower than it may read, and the limit is worth stating: it
 * separates *pack* watchers from *user* watchers, and nothing more. It cannot
 * tell one pack's watcher from another's — the record is the only thing that
 * can — so a record naming a watcher another pack installed would still stop
 * it. `tests/packs/packWatcherIntegrity.test.ts` is what keeps that from being
 * reachable: every `pack_template` watcher in a tree must appear on exactly
 * one installation record.
 *
 * ── A disabled pack stays disabled against the API ─────────────────
 *
 * `enabled` is a field a client can write (PATCH, and the pause route). So
 * "the pack is off" is enforced in two places rather than one:
 * `assertPackWatcherMayBeEnabled` (`packWatcherGuard.ts`) refuses the write at
 * the boundary, and `applyPackEntitlement`'s deny direction re-asserts
 * `enabled: false` on every run regardless of what the record already said.
 * One of those alone is a race; both together are the property.
 */

import { getStorage, type StorageAdapter } from '../storage';
import { PACK_INSTALLATIONS, userCol, userSubDoc } from '../storage/paths';
import type { ContextProviderKind } from '../../src/contracts/v1/integrationConnectionContracts';
import {
  PACK_INSTALLATION_SCHEMA_VERSION,
  VERTICAL_PACK_CONTRACT_VERSION,
  type PackInstallationReason,
  type PackInstallationRecord,
  type VerticalPackDefinition,
} from '../../src/contracts/v1/verticalPackContracts';
import { createWatcherStore, type StoredWatcher } from '../watchers/watcherStore';
import type { EntitlementDecision, EntitlementProjection } from '../integrations/revenuecat/entitlements';
import { decidePackEntitlement } from './packEntitlement';
import { instantiateWatcherTemplate } from './instantiate';

export class PackLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackLifecycleError';
  }
}

export interface PackLifecycleDeps {
  readonly storage?: StorageAdapter;
}

/** What a lifecycle call did, in the terms the caller can assert on. */
export interface PackLifecycleOutcome {
  readonly packId: string;
  readonly state: 'enabled' | 'disabled';
  readonly reason: PackInstallationReason | 'entitlement_denied' | 'not_installed' | 'unchanged';
  /** Every watcher the pack owns for this account. */
  readonly watcherIds: readonly string[];
  /** The watchers this call actually flipped. */
  readonly changedWatcherIds: readonly string[];
  /** The entitlement judgement this call made, when it made one. */
  readonly decision: EntitlementDecision | null;
  readonly record: PackInstallationRecord | null;
}

function installationPath(scopeId: string, packId: string): string {
  return userSubDoc(scopeId, PACK_INSTALLATIONS, packId);
}

export async function readPackInstallation(
  scopeId: string,
  packId: string,
  deps: PackLifecycleDeps = {},
): Promise<PackInstallationRecord | null> {
  const storage = deps.storage ?? getStorage();
  return (await storage.get<PackInstallationRecord>(installationPath(scopeId, packId))) ?? null;
}

export async function listPackInstallations(
  scopeId: string,
  deps: PackLifecycleDeps = {},
): Promise<readonly PackInstallationRecord[]> {
  const storage = deps.storage ?? getStorage();
  const rows = await storage.list<PackInstallationRecord>(userCol(scopeId, PACK_INSTALLATIONS));
  return rows.map((row) => row.data).sort((left, right) => left.packId.localeCompare(right.packId));
}

export interface EnablePackArgs extends PackLifecycleDeps {
  readonly pack: VerticalPackDefinition;
  readonly scopeId: string;
  /** The provider the pack's watchers read through. */
  readonly provider: ContextProviderKind;
  /** The user's grant, for the templates that require one. */
  readonly connectionId: string | null;
  /** What the user pointed each template at, by template id. */
  readonly subjects: Readonly<Record<string, string>>;
  /** The account's entitlement projection, or null when none has been fetched. */
  readonly entitlement: EntitlementProjection | null;
  readonly now: string;
}

/**
 * Turn a pack on for one account, through the entitlement gate.
 *
 * A first enable instantiates one watcher per template; a re-enable resumes
 * the watchers already on the record. Either way the gate runs first: a pack
 * whose entitlement the projection denies installs nothing at all, so a
 * refusal cannot leave half a pack behind.
 */
export async function enablePack(args: EnablePackArgs): Promise<PackLifecycleOutcome> {
  const storage = args.storage ?? getStorage();
  const { pack, scopeId } = args;

  const decision = decidePackEntitlement(pack, args.entitlement, args.now);
  if (!decision.allowed) {
    const existing = await readPackInstallation(scopeId, pack.packId, { storage });
    return {
      packId: pack.packId,
      state: existing?.state ?? 'disabled',
      reason: 'entitlement_denied',
      watcherIds: existing?.watcherIds ?? [],
      changedWatcherIds: [],
      decision,
      record: existing,
    };
  }

  const existing = await readPackInstallation(scopeId, pack.packId, { storage });
  const store = createWatcherStore(scopeId, storage);

  if (existing) {
    // A manifest can gain a template between one enable and the next. Without
    // this, the new template would be silently absent for every account that
    // ever enabled the pack — forever, because a re-enable only ever touched
    // the ids already on the record.
    const covered = new Set(existing.templateIds);
    const pending = pack.watcherTemplates.filter((template) => !covered.has(template.templateId));
    requireSubjects(pack.packId, pending, args.subjects);

    const added = await createTemplateWatchers(args, pending, store);
    const resumed = await setPackWatchersEnabled(existing, true, args.now, storage);
    const record: PackInstallationRecord = {
      ...existing,
      state: 'enabled',
      reason: existing.reason === 'entitlement_lost' ? 'entitlement_restored' : 'user_enabled',
      watcherIds: Object.freeze([...existing.watcherIds, ...added.watcherIds]),
      templateIds: Object.freeze([...existing.templateIds, ...added.templateIds]),
      updatedAt: args.now,
    };
    try {
      await storage.set(installationPath(scopeId, pack.packId), record);
    } catch (error) {
      await rollback(added.watcherIds, store);
      throw error;
    }
    return {
      packId: pack.packId,
      state: 'enabled',
      reason: record.reason,
      watcherIds: record.watcherIds,
      changedWatcherIds: Object.freeze([...resumed, ...added.watcherIds]),
      decision,
      record,
    };
  }

  // Every blank the templates need is checked before anything at all is
  // written. The failure this prevents is the one a half-finished install
  // leaves behind: a live watcher, `createdBy: 'pack_template'`, named by no
  // installation record — which means no `disablePack` call in the product can
  // ever reach it, and it fires on every sweep for the life of the account.
  requireSubjects(pack.packId, pack.watcherTemplates, args.subjects);

  const created = await createTemplateWatchers(args, pack.watcherTemplates, store);
  const record: PackInstallationRecord = {
    version: VERTICAL_PACK_CONTRACT_VERSION,
    schemaVersion: PACK_INSTALLATION_SCHEMA_VERSION,
    packId: pack.packId,
    scopeId,
    state: 'enabled',
    reason: 'user_enabled',
    watcherIds: created.watcherIds,
    templateIds: created.templateIds,
    enabledAt: args.now,
    updatedAt: args.now,
  };
  try {
    await storage.set(installationPath(scopeId, pack.packId), record);
  } catch (error) {
    // The record is what makes a pack watcher stoppable, so an install that
    // could not write one undoes itself rather than leaving orphans.
    await rollback(created.watcherIds, store);
    throw error;
  }
  return {
    packId: pack.packId,
    state: 'enabled',
    reason: 'user_enabled',
    watcherIds: record.watcherIds,
    changedWatcherIds: record.watcherIds,
    decision,
    record,
  };
}

/** Every named template has a subject, or nothing is created at all. */
function requireSubjects(
  packId: string,
  templates: readonly { readonly templateId: string }[],
  subjects: Readonly<Record<string, string>>,
): void {
  const missing = templates
    .filter((template) => subjects[template.templateId] === undefined)
    .map((template) => template.templateId);
  if (missing.length > 0) {
    throw new PackLifecycleError(
      `pack '${packId}' was enabled without a subject for: ${missing.join(', ')}`,
    );
  }
}

/**
 * Instantiate one watcher per template, undoing them all if any one fails.
 *
 * `instantiateWatcherTemplate` validates the manifest and can throw on the
 * second template after the first is already stored, so the compensating
 * delete is not theoretical.
 */
async function createTemplateWatchers(
  args: EnablePackArgs,
  templates: readonly VerticalPackDefinition['watcherTemplates'][number][],
  store: ReturnType<typeof createWatcherStore>,
): Promise<{ watcherIds: readonly string[]; templateIds: readonly string[] }> {
  const watcherIds: string[] = [];
  const templateIds: string[] = [];
  try {
    for (const template of templates) {
      const input = instantiateWatcherTemplate({
        pack: args.pack,
        templateId: template.templateId,
        provider: args.provider,
        connectionId: template.requiresConnection ? args.connectionId : null,
        subjectRef: args.subjects[template.templateId]!,
      });
      watcherIds.push((await store.create(input, args.now)).definition.watcherId);
      templateIds.push(template.templateId);
    }
  } catch (error) {
    await rollback(watcherIds, store);
    throw error;
  }
  return { watcherIds: Object.freeze(watcherIds), templateIds: Object.freeze(templateIds) };
}

async function rollback(watcherIds: readonly string[], store: ReturnType<typeof createWatcherStore>): Promise<void> {
  for (const watcherId of watcherIds) await store.remove(watcherId);
}

export interface DisablePackArgs extends PackLifecycleDeps {
  readonly scopeId: string;
  readonly packId: string;
  readonly now: string;
  /** `user_disabled` by default; the entitlement sweep passes `entitlement_lost`. */
  readonly reason?: Extract<PackInstallationReason, 'user_disabled' | 'entitlement_lost'>;
}

/**
 * Turn a pack off for one account.
 *
 * Stops the pack's watchers and records why. Deletes nothing — see this
 * file's header. A pack that was never enabled is a no-op, not an error: the
 * caller asked for a state, and that state already holds.
 */
export async function disablePack(args: DisablePackArgs): Promise<PackLifecycleOutcome> {
  const storage = args.storage ?? getStorage();
  const existing = await readPackInstallation(args.scopeId, args.packId, { storage });
  if (!existing) {
    return {
      packId: args.packId,
      state: 'disabled',
      reason: 'not_installed',
      watcherIds: [],
      changedWatcherIds: [],
      decision: null,
      record: null,
    };
  }

  const stopped = await setPackWatchersEnabled(existing, false, args.now, storage);
  const record: PackInstallationRecord = {
    ...existing,
    state: 'disabled',
    reason: args.reason ?? 'user_disabled',
    updatedAt: args.now,
  };
  await storage.set(installationPath(args.scopeId, args.packId), record);
  return {
    packId: args.packId,
    state: 'disabled',
    reason: record.reason,
    watcherIds: record.watcherIds,
    changedWatcherIds: stopped,
    decision: null,
    record,
  };
}

export interface ApplyPackEntitlementArgs extends PackLifecycleDeps {
  readonly pack: VerticalPackDefinition;
  readonly scopeId: string;
  readonly entitlement: EntitlementProjection | null;
  readonly now: string;
}

/**
 * Reconcile one installed pack against the current entitlement projection.
 *
 * Losing the entitlement disables the pack and preserves everything it owns;
 * regaining it resumes a pack that was disabled *by this function* and leaves
 * alone one the user switched off themselves. That asymmetry is the whole
 * reason `PackInstallationReason` distinguishes the two.
 */
export async function applyPackEntitlement(args: ApplyPackEntitlementArgs): Promise<PackLifecycleOutcome> {
  const storage = args.storage ?? getStorage();
  const { pack, scopeId } = args;
  const decision = decidePackEntitlement(pack, args.entitlement, args.now);
  const existing = await readPackInstallation(scopeId, pack.packId, { storage });

  if (!existing) {
    return {
      packId: pack.packId,
      state: 'disabled',
      reason: 'not_installed',
      watcherIds: [],
      changedWatcherIds: [],
      decision,
      record: null,
    };
  }

  if (!decision.allowed) {
    // Unconditional, and deliberately not gated on `existing.state`. The
    // record saying `disabled` is not evidence that the watchers are: the
    // `enabled` flag is writable over the API (PATCH, and the pause route's
    // `{"paused": false}`), so a lapsed subscriber who resumes their watchers
    // by hand would otherwise keep premium behaviour for ever while every
    // later run of this function reported "disabled / unchanged". The deny
    // direction re-asserts itself on every run instead.
    //
    // Entitlement loss DISABLES. It must never delete: the watchers, their
    // baselines and their history are the user's, and the RevenueCat contract
    // is "preserve data, disable premium behaviour".
    const stopped = await setPackWatchersEnabled(existing, false, args.now, storage);
    const recordMoves = existing.state === 'enabled';
    const record: PackInstallationRecord = recordMoves
      ? { ...existing, state: 'disabled', reason: 'entitlement_lost', updatedAt: args.now }
      : existing;
    if (recordMoves) await storage.set(installationPath(scopeId, pack.packId), record);
    return {
      packId: pack.packId,
      state: 'disabled',
      // A run that re-stopped a watcher somebody had switched back on did
      // something, and must not report `unchanged`.
      reason: recordMoves || stopped.length > 0 ? 'entitlement_lost' : 'unchanged',
      watcherIds: record.watcherIds,
      changedWatcherIds: stopped,
      decision,
      record,
    };
  }

  if (decision.allowed && existing.state === 'disabled' && existing.reason === 'entitlement_lost') {
    const resumed = await setPackWatchersEnabled(existing, true, args.now, storage);
    const record: PackInstallationRecord = {
      ...existing,
      state: 'enabled',
      reason: 'entitlement_restored',
      updatedAt: args.now,
    };
    await storage.set(installationPath(scopeId, pack.packId), record);
    return {
      packId: pack.packId,
      state: 'enabled',
      reason: 'entitlement_restored',
      watcherIds: record.watcherIds,
      changedWatcherIds: resumed,
      decision,
      record,
    };
  }

  return {
    packId: pack.packId,
    state: existing.state,
    reason: 'unchanged',
    watcherIds: existing.watcherIds,
    changedWatcherIds: [],
    decision,
    record: existing,
  };
}

/**
 * Flip every watcher the record claims, and only those the pack really owns.
 *
 * Returns the ids it actually changed, so a caller can tell "stopped three"
 * from "stopped none because they were already stopped".
 */
async function setPackWatchersEnabled(
  record: PackInstallationRecord,
  enabled: boolean,
  now: string,
  storage: StorageAdapter,
): Promise<readonly string[]> {
  const store = createWatcherStore(record.scopeId, storage);
  const changed: string[] = [];
  for (const watcherId of record.watcherIds) {
    const next = await store.update(watcherId, (current: StoredWatcher) => {
      // A record can drift; a pack still may not reach past its own watchers.
      if (current.definition.createdBy !== 'pack_template') return null;
      if (current.definition.enabled === enabled) return null;
      return {
        ...current,
        definition: { ...current.definition, enabled, updatedAt: now },
      };
    });
    if (next && next.definition.enabled === enabled && next.definition.updatedAt === now) {
      changed.push(watcherId);
    }
  }
  return Object.freeze(changed);
}
