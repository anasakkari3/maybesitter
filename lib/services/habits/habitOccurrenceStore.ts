/**
 * Where a habit's materialized dates live (#520, adapter lane).
 *
 * `lib/habits/habitStore.ts` stores the *rule* and deliberately stores nothing
 * else — its header says occurrences "belong wherever the lane that schedules
 * them puts them". This is that place, and the reason it exists at all is that
 * an occurrence carries something the rule cannot regenerate: what the person
 * did. A `completed` Wednesday is not derivable from "gym three times a week",
 * so it has to be written down somewhere that survives an edit to the cadence.
 *
 * ── The document id is the occurrence id, unchanged ─────────────
 *
 * `materialize.ts` mints `{habitId}.{localDate}.{ordinal}` precisely so that
 * re-running materialization addresses the rows it already wrote. That
 * property is only worth anything if persistence preserves it, so the id goes
 * in as the document id rather than into a field beside a minted one — which
 * is what `requireDocId` already permits (dots and hyphens are legal, and the
 * id starts with a hex character from the habit's uuid).
 *
 * The consequence is that `putMany` is idempotent by construction: writing the
 * same materialization twice is the same two writes, not four rows. There is
 * no upsert flag and no "have I run today" marker, because there is nothing a
 * second run could do differently.
 *
 * ── Scope is the account, and the habit is checked too ──────────
 *
 * Every method takes the uid and builds its paths from it, so one account's
 * occurrences are unreadable from another's. `transition` additionally checks
 * that the occurrence belongs to the habit named in the path: without it an
 * occurrence could be completed through *any* habit the caller owns and the two
 * ids in the URL would stop meaning what they say.
 *
 * ── Why the transition is a transaction ─────────────────────────
 *
 * Two phones pressing "done" and "not today" on the same occurrence in the same
 * second must not both win. The read and the write are one transaction, so the
 * second one sees the first's state and answers `conflict` rather than
 * overwriting a decision the person already made.
 */
import {
  HABIT_LOCAL_DATE_PATTERN,
  type HabitOccurrence,
  type HabitOccurrenceState,
} from '../../../src/contracts/v1/habitContracts';
import { byDateThenOrdinal } from '../../habits/materialize';
import {
  HABIT_OCCURRENCES,
  getStorage,
  requireUserId,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../../storage';

/** The two states these routes can put an occurrence into. Never `recovered`. */
export type HabitOccurrenceOutcome = 'completed' | 'skipped';

/**
 * Why a transition did or did not happen.
 *
 * `unchanged` is not `conflict`, and the difference is the whole of this
 * type's usefulness: a phone that retried a request whose answer it never saw
 * must get the answer, while a phone that is a decision behind must be told so
 * rather than allowed to overwrite it.
 */
export type OccurrenceTransition =
  | { readonly kind: 'applied'; readonly occurrence: HabitOccurrence }
  | { readonly kind: 'unchanged'; readonly occurrence: HabitOccurrence }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly occurrence: HabitOccurrence };

/** The states a person's answer may still be given about. */
const OPEN_STATES: readonly HabitOccurrenceState[] = Object.freeze(['pending', 'scheduled']);

export function isOpenOccurrence(occurrence: HabitOccurrence): boolean {
  return OPEN_STATES.includes(occurrence.state);
}

/**
 * Shape guard for a document read back.
 *
 * The same ruling `isHabitDefinition` takes one file over: a hand-edited or
 * half-migrated row reads as absent rather than as an occurrence with a state
 * nothing validated — which would otherwise be handed to the planner, or
 * counted against a week's `maximumOccurrences`.
 */
export function isHabitOccurrence(value: unknown): value is HabitOccurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.occurrenceId === 'string' && raw.occurrenceId !== ''
    && typeof raw.habitId === 'string' && raw.habitId !== ''
    && typeof raw.localDate === 'string' && HABIT_LOCAL_DATE_PATTERN.test(raw.localDate)
    && Number.isInteger(raw.ordinal) && (raw.ordinal as number) >= 0
    && typeof raw.state === 'string'
    && ['pending', 'scheduled', 'completed', 'skipped', 'recovered'].includes(raw.state)
    && typeof raw.durationMinutes === 'number'
    && (raw.recoveredFromOccurrenceId === null || typeof raw.recoveredFromOccurrenceId === 'string');
}

export interface HabitOccurrenceStore {
  /** Every occurrence of one habit, ascending by date then ordinal. */
  listForHabit(scopeId: string, habitId: string): Promise<readonly HabitOccurrence[]>;
  /** Every occurrence in the scope whose `localDate` falls in `[from, to]`. */
  listInRange(scopeId: string, fromLocalDate: string, toLocalDate: string): Promise<readonly HabitOccurrence[]>;
  get(scopeId: string, occurrenceId: string): Promise<HabitOccurrence | null>;
  /** Idempotent: the id is the document id. */
  putMany(scopeId: string, occurrences: readonly HabitOccurrence[]): Promise<void>;
  removeMany(scopeId: string, occurrenceIds: readonly string[]): Promise<number>;
  transition(
    scopeId: string,
    habitId: string,
    occurrenceId: string,
    outcome: HabitOccurrenceOutcome,
  ): Promise<OccurrenceTransition>;
  /** Everything belonging to one habit. Used when the habit itself is removed. */
  deleteForHabit(scopeId: string, habitId: string): Promise<number>;
}

export class StorageHabitOccurrenceStore implements HabitOccurrenceStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  private collection(scopeId: string): string {
    return userCol(requireUserId(scopeId), HABIT_OCCURRENCES);
  }

  private path(scopeId: string, occurrenceId: string): string {
    return userSubDoc(requireUserId(scopeId), HABIT_OCCURRENCES, occurrenceId);
  }

  private async all(scopeId: string): Promise<HabitOccurrence[]> {
    const rows = await this.storage.list<HabitOccurrence>(this.collection(scopeId));
    return rows.map((row) => row.data).filter(isHabitOccurrence).sort(byDateThenOrdinal);
  }

  async listForHabit(scopeId: string, habitId: string): Promise<readonly HabitOccurrence[]> {
    return (await this.all(scopeId)).filter((occurrence) => occurrence.habitId === habitId);
  }

  async listInRange(
    scopeId: string,
    fromLocalDate: string,
    toLocalDate: string,
  ): Promise<readonly HabitOccurrence[]> {
    // Compared as strings, which is exact for `YYYY-MM-DD` and needs no civil
    // arithmetic: the format is fixed-width and zero-padded, so lexical order
    // *is* chronological order. Filtered here rather than with a `where`
    // clause because the memory adapter and Firestore would need an index to
    // agree, and this range is a page of rows by construction.
    return (await this.all(scopeId))
      .filter((occurrence) => occurrence.localDate >= fromLocalDate && occurrence.localDate <= toLocalDate);
  }

  async get(scopeId: string, occurrenceId: string): Promise<HabitOccurrence | null> {
    const stored = await this.storage.get<HabitOccurrence>(this.path(scopeId, occurrenceId));
    return stored && isHabitOccurrence(stored) ? stored : null;
  }

  async putMany(scopeId: string, occurrences: readonly HabitOccurrence[]): Promise<void> {
    for (const occurrence of occurrences) {
      await this.storage.set<HabitOccurrence>(this.path(scopeId, occurrence.occurrenceId), occurrence);
    }
  }

  async removeMany(scopeId: string, occurrenceIds: readonly string[]): Promise<number> {
    let removed = 0;
    for (const occurrenceId of occurrenceIds) {
      await this.storage.delete(this.path(scopeId, occurrenceId));
      removed += 1;
    }
    return removed;
  }

  async transition(
    scopeId: string,
    habitId: string,
    occurrenceId: string,
    outcome: HabitOccurrenceOutcome,
  ): Promise<OccurrenceTransition> {
    const path = this.path(scopeId, occurrenceId);
    return this.storage.runTransaction<OccurrenceTransition>(async (tx) => {
      const existing = await tx.get<HabitOccurrence>(path);
      // The habit in the path must be the occurrence's own. See the header.
      if (!existing || !isHabitOccurrence(existing) || existing.habitId !== habitId) {
        return { kind: 'not_found' };
      }
      if (existing.state === outcome) return { kind: 'unchanged', occurrence: existing };
      // A skip that has already been made up for is still that same skip.
      //
      // `recovered` is what a `skipped` row becomes once the domain minted a
      // replacement for it, so it is downstream of the outcome being asked
      // for rather than a different answer to the question. Treating it as a
      // conflict — which this did — breaks retry idempotency in exactly the
      // case where recovery fires: the phone presses "not today", the domain
      // records the skip *and* a make-up date, the phone never sees the
      // response and retries, and gets a 409 about a decision it made itself.
      // Completing a recovered date is still a conflict, because that is a
      // different answer.
      if (outcome === 'skipped' && existing.state === 'recovered') {
        return { kind: 'unchanged', occurrence: existing };
      }
      // Any other decision already taken is not re-taken by a later tap, and
      // `recovered` is the domain's to set, never a route's.
      if (!isOpenOccurrence(existing)) return { kind: 'conflict', occurrence: existing };
      const updated: HabitOccurrence = { ...existing, state: outcome };
      tx.set<HabitOccurrence>(path, updated);
      return { kind: 'applied', occurrence: updated };
    });
  }

  async deleteForHabit(scopeId: string, habitId: string): Promise<number> {
    const mine = await this.listForHabit(scopeId, habitId);
    return this.removeMany(scopeId, mine.map((occurrence) => occurrence.occurrenceId));
  }
}

export function createStorageHabitOccurrenceStore(adapter?: StorageAdapter): HabitOccurrenceStore {
  return new StorageHabitOccurrenceStore(adapter);
}
