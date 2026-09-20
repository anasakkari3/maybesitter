/**
 * Where a Seed lives (#519).
 *
 * `users/{uid}/intentSeeds/{seedId}`, one document per seed, in the owner's
 * own tree — so account deletion takes it with `deleteTree`, and no reader of
 * the commitment tree can trip over it.
 *
 * ── The id is derived, which is what makes "Keep" safe to press twice ──
 *
 * A confirm arrives with an idempotency key, and the document id is
 * `docIdForKey` of it. Two taps therefore address the *same* document, and the
 * create is a transaction that reads before it writes: the second one finds
 * the first seed and hands it back with `replayed: true`. There is no window
 * in which two seeds exist, because there was never a second path to write to.
 *
 * This matters more here than it looks. A seed is a sentence somebody wrote
 * once; a duplicate is not a wasted row, it is the product showing them the
 * same thought twice and asking them to dismiss it twice.
 *
 * ── `promoted` is written by one method and no other ─────────────
 *
 * `patch` refuses the status outright and never touches `promotedTo`;
 * `claimPromotion` is the only writer of either, and it claims inside a
 * transaction. That is the mechanism behind the issue's "no Seed can silently
 * promote itself": there is no code path from a status change to a Goal or a
 * Commitment, and the one path that exists is a route the user pressed.
 *
 * A promotion that has already been claimed returns null rather than claiming
 * again, so a racing second tap cannot create a second commitment for one
 * seed. The service turns that into the first promotion's answer.
 */
import {
  INTENT_SEED_SCHEMA_VERSION,
  SEED_USER_STATUSES,
  type CreateSeedInput,
  type IntentSeed,
  type IntentSeedStore,
  type PatchSeedInput,
  type SeedExport,
} from '../../src/contracts/v1/intentContracts';
import {
  INTENT_SEEDS,
  docIdForKey,
  getStorage,
  requireUserId,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../storage';

/** The document, which is the seed exactly. Nothing is stored beside it. */
type StoredSeed = IntentSeed;

function seedPath(scopeId: string, seedId: string): string {
  return userSubDoc(requireUserId(scopeId), INTENT_SEEDS, seedId);
}

/**
 * Newest first, decided here rather than left to the adapter.
 *
 * The two adapters disagree about the natural order of a collection read, so
 * sorting explicitly is what makes the list the same from either — the same
 * reasoning `lib/analytics/eventStore.ts` gives. The tie-break is the seed id
 * rather than anything random: two seeds created in the same millisecond must
 * come back in the same order on every read, or one save's rows reorder under
 * the user's finger.
 */
function byNewest(a: IntentSeed, b: IntentSeed): number {
  const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (created !== 0 && !Number.isNaN(created)) return created;
  return a.seedId < b.seedId ? -1 : a.seedId > b.seedId ? 1 : 0;
}

export class StorageIntentSeedStore implements IntentSeedStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async create(input: CreateSeedInput, now: string): Promise<{ seed: IntentSeed; replayed: boolean }> {
    const seedId = docIdForKey(input.idempotencyKey);
    const path = seedPath(input.scopeId, seedId);
    const seed: IntentSeed = {
      version: INTENT_SEED_SCHEMA_VERSION,
      seedId,
      scopeId: input.scopeId,
      kind: input.kind,
      summary: input.summary,
      // Always `open`. A seed does not arrive snoozed, promoted or dismissed:
      // those are things the user does to it afterwards, and accepting one of
      // them here would be a client choosing a state the person never chose.
      status: 'open',
      // Null, always. The issue's "no invented date" is this line: a seed
      // created from a capture carries no time at all, and `revisitAt` can
      // only be set later by the user through the patch route.
      revisitAt: null,
      source: input.source,
      sourceRef: input.sourceRef,
      provenance: input.provenance,
      promotedTo: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredSeed>(path);
      // The replay. Not an error and not a second row: the first seed, with
      // the flag that lets the route answer 200 rather than 201.
      if (existing) return { seed: existing, replayed: true };
      tx.create<StoredSeed>(path, seed);
      return { seed, replayed: false };
    });
  }

  async get(scopeId: string, seedId: string): Promise<IntentSeed | null> {
    // Addressed inside the scope's own collection, so an id from another
    // account cannot resolve at all — there is no collection-group read here
    // for a check to have to undo.
    return (await this.storage.get<StoredSeed>(seedPath(scopeId, seedId))) ?? null;
  }

  async list(scopeId: string): Promise<readonly IntentSeed[]> {
    const rows = await this.storage.list<StoredSeed>(userCol(requireUserId(scopeId), INTENT_SEEDS));
    return rows.map((row) => row.data).sort(byNewest);
  }

  async patch(
    scopeId: string,
    seedId: string,
    input: PatchSeedInput,
    now: string,
  ): Promise<IntentSeed | null> {
    const path = seedPath(scopeId, seedId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredSeed>(path);
      if (!existing) return null;
      // A promoted seed is finished. Editing the summary of something that is
      // now a commitment would leave the two disagreeing, with the commitment
      // being the one that actually rings.
      if (existing.status === 'promoted') return null;
      // The status boundary, restated where the write happens rather than only
      // at the route: `promoted` is the promote path's to write, and nothing
      // reaching a patch may set it. Checked only when the patch actually
      // names a status — a patch that only edits the summary is not asking to
      // move the seed anywhere, and validating a field nobody sent would make
      // this branch and the `promoted` guard above the same check twice, so
      // that neither could be shown to be doing anything.
      if (input.status !== undefined && !SEED_USER_STATUSES.includes(input.status)) return null;
      const status = input.status ?? existing.status;
      const updated: IntentSeed = {
        ...existing,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        status,
        ...(input.revisitAt === undefined ? {} : { revisitAt: input.revisitAt }),
        updatedAt: now,
      };
      tx.set<StoredSeed>(path, updated);
      return updated;
    });
  }

  async claimPromotion(
    scopeId: string,
    seedId: string,
    promotedTo: { kind: 'commitment' | 'goal'; id: string },
    now: string,
  ): Promise<IntentSeed | null> {
    const path = seedPath(scopeId, seedId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredSeed>(path);
      if (!existing) return null;
      // Already promoted, or deliberately dropped. Either way this claim is
      // not the one that gets to create something.
      if (existing.status === 'promoted' || existing.status === 'dismissed') return null;
      const updated: IntentSeed = {
        ...existing,
        status: 'promoted',
        promotedTo,
        updatedAt: now,
      };
      tx.set<StoredSeed>(path, updated);
      return updated;
    });
  }

  async remove(scopeId: string, seedId: string): Promise<boolean> {
    const path = seedPath(scopeId, seedId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredSeed>(path);
      if (!existing) return false;
      tx.delete(path);
      return true;
    });
  }

  async deleteScope(scopeId: string): Promise<number> {
    const rows = await this.storage.list<StoredSeed>(userCol(requireUserId(scopeId), INTENT_SEEDS));
    for (const row of rows) await this.storage.delete(seedPath(scopeId, row.id));
    return rows.length;
  }

  /**
   * Everything in the scope, whatever its status (#519's "export includes
   * Seeds").
   *
   * Terminal rows included on purpose: a promoted seed and a dismissed one are
   * both part of what the product holds about somebody, and an export that
   * quietly showed only the live ones would be an export that is wrong in
   * exactly the direction that flatters us.
   */
  async export(scopeId: string, now: string): Promise<SeedExport> {
    return {
      version: INTENT_SEED_SCHEMA_VERSION,
      scopeId,
      exportedAt: now,
      seeds: await this.list(scopeId),
    };
  }
}

export function createStorageIntentSeedStore(storage?: StorageAdapter): IntentSeedStore {
  return new StorageIntentSeedStore(storage);
}
