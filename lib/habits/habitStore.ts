/**
 * ⚠️ PLACEHOLDER — habit persistence, stood up by the adapter lane (#520).
 *
 * **Process memory. Nothing here survives a restart, and nothing here is
 * deleted with an account.** Both of those are why `MAYBESITTER_FEATURE_HABITS`
 * exists and defaults to off: the routes this store backs are real, guarded and
 * tested, and they must not be reachable by a real user until the domain lane's
 * store replaces this one.
 *
 * The brief for this lane was explicit that it should not invent the real
 * store, so this is the smallest thing the routes can be written and proved
 * against. What is *not* a placeholder is the shape: `HabitStore` is the port
 * the routes are written to, and the reconciliation is `setHabitStoreFactory`
 * pointing at the domain lane's implementation. The routes below never
 * construct a store directly for that reason.
 *
 * ── What this deliberately does not do ───────────────────────────
 *
 * It does not touch `lib/storage`. A user-scoped Firestore collection is not
 * two lines of paths: it has to be added to `USER_SCOPED_COLLECTIONS`, covered
 * by `deleteTree(users/{uid})`, and proved by `tests/storage/deletionCoverage.
 * test.ts` — and a habit is a statement about somebody's life, so a collection
 * that account deletion does not know about is the wrong kind of mistake to
 * leave for a later lane to notice. The domain lane owns that registration
 * along with the store.
 *
 * ── Scope is the account, here as everywhere ─────────────────────
 *
 * Every method takes the uid and every record is filed under it, so one
 * account's habits are unreadable from another's and a habit id belonging to
 * somebody else is a 404 — the same answer as an id that never existed,
 * because this store cannot tell the two apart and must not be able to.
 */
import { randomUUID } from 'node:crypto';
import type {
  HabitDefinition,
  HabitOccurrence,
  HabitOccurrenceOutcome,
} from './habitTypes';

/** The fields a client may state when creating a habit. Never `habitId`, never `scopeId`. */
export interface NewHabitInput {
  readonly title: string;
  readonly cadence: HabitDefinition['cadence'];
  readonly durationMinutes: number;
  readonly preferredWindows: HabitDefinition['preferredWindows'];
  readonly minimumOccurrences: number;
  readonly maximumOccurrences: number;
  readonly flexibility: HabitDefinition['flexibility'];
  readonly recoveryPolicy: HabitDefinition['recoveryPolicy'];
  readonly status: HabitDefinition['status'];
  readonly source: HabitDefinition['source'];
}

export type HabitPatch = Partial<Omit<NewHabitInput, 'source'>>;

/**
 * Why an occurrence transition was refused.
 *
 * `conflict` is the one that matters: an occurrence that is already in a
 * *different* terminal state is not re-decided by a second tap. Re-applying the
 * *same* outcome is not a conflict and not an error — the phone that retried a
 * request it never saw the answer to must get the answer, not a 409.
 */
export type OccurrenceTransition =
  | { readonly kind: 'applied'; readonly occurrence: HabitOccurrence }
  | { readonly kind: 'unchanged'; readonly occurrence: HabitOccurrence }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly occurrence: HabitOccurrence };

/**
 * The port the routes are written to.
 *
 * The domain lane's store implements this, or this interface moves to sit on
 * top of it. Either way the routes do not change.
 */
export interface HabitStore {
  list(uid: string): Promise<readonly HabitDefinition[]>;
  create(uid: string, input: NewHabitInput, now: string): Promise<HabitDefinition>;
  update(uid: string, habitId: string, patch: HabitPatch, now: string): Promise<HabitDefinition | null>;
  remove(uid: string, habitId: string): Promise<boolean>;
  listOccurrences(uid: string, habitId: string): Promise<readonly HabitOccurrence[]>;
  /** Only the domain lane's materializer writes occurrences; this is the dev seam. */
  putOccurrence(uid: string, occurrence: HabitOccurrence): Promise<void>;
  transitionOccurrence(
    uid: string,
    habitId: string,
    occurrenceId: string,
    outcome: HabitOccurrenceOutcome,
  ): Promise<OccurrenceTransition>;
}

interface AccountHabits {
  readonly definitions: Map<string, HabitDefinition>;
  readonly occurrences: Map<string, HabitOccurrence>;
}

/** ⚠️ PLACEHOLDER. Process memory, keyed by uid. */
export class InMemoryHabitStore implements HabitStore {
  private readonly accounts = new Map<string, AccountHabits>();

  private account(uid: string): AccountHabits {
    const existing = this.accounts.get(uid);
    if (existing) return existing;
    const created: AccountHabits = { definitions: new Map(), occurrences: new Map() };
    this.accounts.set(uid, created);
    return created;
  }

  async list(uid: string): Promise<readonly HabitDefinition[]> {
    // Sorted by id, so two reads of an unchanged account answer identically —
    // the rule `retrievalOrdering` had to be taught the hard way elsewhere in
    // this repo, where a random uuid reordered a list on every read.
    return Array.from(this.account(uid).definitions.values()).sort((left, right) =>
      left.habitId < right.habitId ? -1 : left.habitId > right.habitId ? 1 : 0);
  }

  async create(uid: string, input: NewHabitInput, now: string): Promise<HabitDefinition> {
    const habitId = `hbt_${randomUUID()}`;
    const definition: HabitDefinition = {
      habitId,
      // From the verified uid, never from the body. See the header.
      scopeId: uid,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.account(uid).definitions.set(habitId, definition);
    return definition;
  }

  async update(uid: string, habitId: string, patch: HabitPatch, now: string): Promise<HabitDefinition | null> {
    const account = this.account(uid);
    const current = account.definitions.get(habitId);
    if (current === undefined) return null;
    const updated: HabitDefinition = { ...current, ...patch, updatedAt: now };
    account.definitions.set(habitId, updated);
    return updated;
  }

  async remove(uid: string, habitId: string): Promise<boolean> {
    const account = this.account(uid);
    if (!account.definitions.delete(habitId)) return false;
    // A habit's occurrences go with it. An orphaned occurrence has no title,
    // no flexibility and no window, and the adapter would drop it every day
    // for ever without anybody being told why.
    for (const [occurrenceId, occurrence] of Array.from(account.occurrences.entries())) {
      if (occurrence.habitId === habitId) account.occurrences.delete(occurrenceId);
    }
    return true;
  }

  async listOccurrences(uid: string, habitId: string): Promise<readonly HabitOccurrence[]> {
    return Array.from(this.account(uid).occurrences.values())
      .filter((occurrence) => occurrence.habitId === habitId)
      .sort((left, right) => (left.occurrenceId < right.occurrenceId ? -1 : 1));
  }

  async putOccurrence(uid: string, occurrence: HabitOccurrence): Promise<void> {
    this.account(uid).occurrences.set(occurrence.occurrenceId, occurrence);
  }

  async transitionOccurrence(
    uid: string,
    habitId: string,
    occurrenceId: string,
    outcome: HabitOccurrenceOutcome,
  ): Promise<OccurrenceTransition> {
    const account = this.account(uid);
    const current = account.occurrences.get(occurrenceId);
    // The habit id in the path has to be the occurrence's own. Without this an
    // occurrence could be completed through *any* habit the caller owns, and
    // the two ids in the URL would stop meaning what they say.
    if (current === undefined || current.habitId !== habitId) return { kind: 'not_found' };
    if (current.state === outcome) return { kind: 'unchanged', occurrence: current };
    // `recovered` is the domain lane's, and a decision already taken is not
    // re-taken by a later tap: skipping something you already finished is a
    // conflict, not an edit.
    if (!['pending', 'scheduled'].includes(current.state)) return { kind: 'conflict', occurrence: current };
    const updated: HabitOccurrence = { ...current, state: outcome };
    account.occurrences.set(occurrenceId, updated);
    return { kind: 'applied', occurrence: updated };
  }
}

let store: HabitStore | null = null;

/** The one place a route gets a store. Replaced wholesale by the domain lane. */
export function getHabitStore(): HabitStore {
  if (store === null) store = new InMemoryHabitStore();
  return store;
}

/** Installs the real store. Also how a test gets a clean one. */
export function setHabitStoreForTests(replacement: HabitStore | null): void {
  store = replacement;
}

/**
 * Whether the habits API is on in this build.
 *
 * Off by default, and read at call time rather than at import time so a test
 * can set it. This is a local gate and deliberately *not* an
 * `IntelligenceModuleName` flag: habits are not an intelligence module, and
 * widening that frozen union to get a boolean would change a contract two other
 * tracks pin.
 *
 * The gate exists because of what backs these routes today — see the header of
 * this file. It comes out when the durable store lands.
 */
export function habitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAYBESITTER_FEATURE_HABITS === 'true';
}
