/**
 * Where a Habit lives (#520).
 *
 * `users/{uid}/habits/{habitId}`, one document per habit, in the owner's own
 * tree — so account deletion takes it with `deleteTree` and an id from another
 * account cannot resolve at all.
 *
 * ── The rule is stored; the occurrences are not ─────────────────
 *
 * This store holds `HabitDefinition` and nothing else. Occurrences are
 * materialized from the definition over a bounded horizon (`materialize.ts`)
 * and belong wherever the lane that schedules them puts them; keeping them out
 * of here is what makes "a Habit never becomes an infinite set of Commitments"
 * true of the storage layer as well as of the domain — there is no collection
 * that could grow without a horizon, because there is no collection.
 *
 * ── Create cannot bypass the confirmation ───────────────────────
 *
 * `create` takes a `HabitDefinitionInput`, whose `confirmation` is not
 * optional, and re-validates it here rather than trusting the route. That is
 * deliberate duplication: a service check and a store check are not the same
 * check, and the one that has to hold when a second route is added next sprint
 * is this one.
 */
import { randomUUID } from 'node:crypto';
import {
  HabitValidationError,
  applyHabitPatch,
  buildHabitDefinition,
  isHabitDefinition,
  parseHabitDefinitionInput,
  type HabitDefinition,
  type HabitDefinitionInput,
  type HabitPatchInput,
  type HabitStore,
} from '../../src/contracts/v1/habitContracts';
import {
  HABITS,
  getStorage,
  requireUserId,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../storage';

/** The document, which is the habit exactly. Nothing is stored beside it. */
type StoredHabit = HabitDefinition;

function habitPath(scopeId: string, habitId: string): string {
  return userSubDoc(requireUserId(scopeId), HABITS, habitId);
}

/**
 * Newest first, decided here rather than left to the adapter — the two
 * adapters disagree about the natural order of a collection read. The
 * tie-break is the habit id rather than anything random, so two habits created
 * in the same millisecond come back in the same order on every read instead of
 * reordering under the user's finger.
 */
function byNewest(a: HabitDefinition, b: HabitDefinition): number {
  const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (created !== 0 && !Number.isNaN(created)) return created;
  return a.habitId < b.habitId ? -1 : a.habitId > b.habitId ? 1 : 0;
}

export class StorageHabitStore implements HabitStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async create(input: HabitDefinitionInput, now: string): Promise<HabitDefinition> {
    // Re-validated, not trusted. See the header.
    const validated = parseHabitDefinitionInput(input);
    const habit = buildHabitDefinition(randomUUID(), validated, now);
    await this.storage.set<StoredHabit>(habitPath(habit.scopeId, habit.habitId), habit);
    return habit;
  }

  async get(scopeId: string, habitId: string): Promise<HabitDefinition | null> {
    const stored = await this.storage.get<StoredHabit>(habitPath(scopeId, habitId));
    // A hand-edited or half-migrated document reads as absent rather than as a
    // habit with a cadence nothing validated — which would go on to materialize
    // occurrences from whatever is in the field.
    return stored && isHabitDefinition(stored) ? stored : null;
  }

  async list(scopeId: string): Promise<readonly HabitDefinition[]> {
    const rows = await this.storage.list<StoredHabit>(userCol(requireUserId(scopeId), HABITS));
    return rows.map((row) => row.data).filter(isHabitDefinition).sort(byNewest);
  }

  async patch(
    scopeId: string,
    habitId: string,
    patch: HabitPatchInput,
    now: string,
  ): Promise<HabitDefinition | null> {
    const path = habitPath(scopeId, habitId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredHabit>(path);
      if (!existing || !isHabitDefinition(existing)) return null;
      // Throws rather than returning null when the patch is incoherent — "not
      // found" and "minimumOccurrences above the ceiling" are different answers
      // and a route that conflated them would return 404 for a typo.
      const updated = applyHabitPatch(existing, patch, now);
      tx.set<StoredHabit>(path, updated);
      return updated;
    });
  }

  async remove(scopeId: string, habitId: string): Promise<boolean> {
    const path = habitPath(scopeId, habitId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<StoredHabit>(path);
      if (!existing) return false;
      tx.delete(path);
      return true;
    });
  }

  async deleteScope(scopeId: string): Promise<number> {
    const rows = await this.storage.list<StoredHabit>(userCol(requireUserId(scopeId), HABITS));
    for (const row of rows) {
      await this.storage.delete(`${userCol(requireUserId(scopeId), HABITS)}/${row.id}`);
    }
    return rows.length;
  }
}

export function createStorageHabitStore(adapter?: StorageAdapter): HabitStore {
  return new StorageHabitStore(adapter);
}

export { HabitValidationError };
