/**
 * Where a day's plan is kept, and the one rule about writing it (UC-3.10a, #194).
 *
 * ── A plan is a proposal, and the commitments stay canonical ─────
 *
 * `PLANNING_PERSISTENCE_POLICY` says `planCanPersist: false`,
 * `adapterOwnsCanonicalWrites: true` and `originalCommitmentRemainsCanonical:
 * true`. This module is that adapter, and what it persists is a *proposal about
 * time* under `users/{uid}/plans/{date}` — never a commitment, never a
 * commitment's time, never anything the domain reducer reads. The scheduler
 * itself still persists nothing.
 *
 * The `plan` field is the scheduler's output verbatim and is never rewritten.
 * A user who moves something gets an `edits` record layered on top, so the
 * document always says both what the planner proposed and what the person
 * decided — and `inputDigest` keeps meaning "this is the plan those inputs
 * produce", which it would stop meaning the moment an edit was written back
 * into `plan.scheduled`.
 *
 * ── Creating is a transaction, and that is the whole idempotency ─
 *
 * `createIfAbsent` reads the document and writes it in one transaction, so the
 * read is part of what the transaction read: a second tick that gets there
 * first invalidates this one, which retries, sees the plan already there, and
 * reports `created: false`. The caller pushes only when `created` is true, so
 * "one plan document and one push" survives two concurrent ticks, a Cloud
 * Scheduler retry, and a recovered claim. This is `StorageSchedulerStore`'s
 * dedupe, applied to a different document.
 */
import { getStorage, type StorageAdapter } from '../../storage';
import { sortableDocId, userCol, userSubDoc } from '../../storage/paths';
import { PLANS, PLAN_EVENTS } from '../../storage/paths';
import type { Plan, PlanningConfig, PlanningConstraints } from '../../../src/contracts/v1/planningContracts';
import type { ScheduleBlock } from '../../../src/contracts/v1/scheduleBlockContracts';
import type { UserLocale } from '../../storage/userDocument';
import { randomUUID } from 'node:crypto';

export type DailyPlanStatus = 'proposed' | 'accepted' | 'edited' | 'dismissed';
export type ExplanationSource = 'model' | 'template';

export interface StoredExplanation {
  readonly text: string;
  readonly locale: UserLocale;
  readonly source: ExplanationSource;
  /** Always true: an explanation that did not pass the validator is not stored. */
  readonly validated: true;
}

/** One item the user moved, on top of the plan the scheduler produced. */
export interface PlanMove {
  readonly itemId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface PlanEdits {
  readonly moves: readonly PlanMove[];
  readonly removals: readonly string[];
}

export const NO_EDITS: PlanEdits = Object.freeze({ moves: [], removals: [] });

/**
 * The document one plan generation replaced (#521).
 *
 * The ledger already records each generation's digest as it happens; this is
 * the link that lets a reader walk the chain *backwards* from the document
 * itself — "which plan is this one a regeneration of" — without scanning
 * events. Both fields are a number and a hash: no user text.
 */
export interface PlanGenerationAncestry {
  readonly generation: number;
  readonly inputDigest: string;
}

export interface StoredDailyPlan {
  readonly date: string;
  readonly timezone: string;
  readonly locale: UserLocale;
  readonly status: DailyPlanStatus;
  /** The scheduler's output, verbatim. Never rewritten — see the header. */
  readonly plan: Plan;
  /**
   * The schedule blocks of this generation (#521): one per occurrence the
   * planner was asked about, each carrying the stable identity the issue's
   * contract defines. Rebuilt on regeneration, updated in place on an edit —
   * in the same transaction as the `edits` record it mirrors, so the document
   * never shows a move in one and not the other. Carries no titles; the
   * commitment owns its words (`planDto` joins them at read time).
   */
  readonly blocks: readonly ScheduleBlock[];
  /** Null on the first build of the day; the replaced generation otherwise. */
  readonly replaces: PlanGenerationAncestry | null;
  /**
   * The request that produced it, kept so that an edit can be re-validated
   * against *the same* constraints rather than against whatever the
   * commitments happen to say later.
   */
  readonly constraints: PlanningConstraints;
  readonly config: PlanningConfig;
  readonly explanation: StoredExplanation;
  readonly edits: PlanEdits;
  readonly generatedAt: string;
  /** 1 on first build; `regenerate` increments it. */
  readonly generation: number;
  readonly inputDigest: string;
  readonly acceptedAt: string | null;
  readonly updatedAt: string;
  /**
   * The state changes this generation was built from (#527, AC 2).
   *
   * Optional, and absent on every plan written before this field existed and
   * on every plan a person asked for: a morning build and a manual rebuild
   * have no monitor behind them, and an empty list would be a claim rather
   * than a silence. Present only when an automatic replan wrote the
   * generation, where it carries the pipeline result's `impactingChangeIds` —
   * the changes whose *own* impact required the replan, which is narrower than
   * the batch the replan request subsumes. A change that arrived in the same
   * sweep and was evaluated `NO_EFFECT` is not a cause of this plan and is
   * deliberately not recorded as one. Those are the ids
   * `attributionsForArtifacts` joins to the firings, which is how a plan read
   * back from storage can name the monitor that caused it. Ids and
   * nothing else: no monitor label, no provider text, and no second copy of
   * the chain that could drift from the firings it describes.
   */
  readonly causeChangeIds?: readonly string[];
}

export type PlanEventType =
  | 'plan_proposed'
  | 'plan_accepted'
  | 'plan_edited'
  | 'plan_dismissed'
  | 'plan_regenerated'
  | 'plan_protected';

export interface PlanEvent {
  readonly id: string;
  readonly type: PlanEventType;
  readonly date: string;
  readonly at: string;
  readonly generation: number;
  /** The plan's digest, which is a hash and carries no user text. */
  readonly inputDigest: string;
  /**
   * On a `plan_regenerated` written by an automatic replan: the change ids
   * that caused it (#527, AC 2). Absent everywhere else — a manual rebuild,
   * an acceptance, an edit — for the reason `StoredDailyPlan.causeChangeIds`
   * is absent there. Opaque ids, like the digest beside them.
   */
  readonly causeChangeIds?: readonly string[];
}

function storageOf(storage?: StorageAdapter): StorageAdapter {
  return storage ?? getStorage();
}

export function planPath(uid: string, date: string): string {
  return userSubDoc(uid, PLANS, date);
}

export async function readStoredPlan(
  uid: string,
  date: string,
  storage?: StorageAdapter,
): Promise<StoredDailyPlan | null> {
  return storageOf(storage).get<StoredDailyPlan>(planPath(uid, date));
}

/**
 * Writes the plan unless one is already there. Reports which happened.
 *
 * The boolean is the load-bearing part: it is what the caller pushes on.
 */
export async function createIfAbsent(
  uid: string,
  document: StoredDailyPlan,
  storage?: StorageAdapter,
): Promise<{ created: boolean; stored: StoredDailyPlan }> {
  const path = planPath(uid, document.date);
  return storageOf(storage).runTransaction(async (tx) => {
    const existing = await tx.get<StoredDailyPlan>(path);
    if (existing) return { created: false, stored: existing };
    tx.set<StoredDailyPlan>(path, document);
    return { created: true, stored: document };
  });
}

/**
 * Read-modify-write in one transaction.
 *
 * The mutator returns null to leave the document alone, which is how an action
 * that turns out not to apply — an edit the validator refuses — leaves the
 * stored plan byte-for-byte unchanged rather than rewriting it with the same
 * values and a new `updatedAt`.
 */
export async function mutateStoredPlan<T>(
  uid: string,
  date: string,
  mutate: (current: StoredDailyPlan) => { next: StoredDailyPlan; result: T } | null,
  storage?: StorageAdapter,
): Promise<{ stored: StoredDailyPlan; result: T } | null> {
  const path = planPath(uid, date);
  return storageOf(storage).runTransaction(async (tx) => {
    const current = await tx.get<StoredDailyPlan>(path);
    if (!current) return null;
    const outcome = mutate(current);
    if (!outcome) return null;
    tx.set<StoredDailyPlan>(path, outcome.next);
    return { stored: outcome.next, result: outcome.result };
  });
}

/**
 * Replaces a plan with a newly built one, if the generation it was built from
 * is still the current one.
 *
 * Returns null when it is not: two phones asking to regenerate at once must
 * produce one new plan, not two builds racing to be last.
 */
export async function replaceStoredPlan(
  uid: string,
  document: StoredDailyPlan,
  expectedGeneration: number,
  storage?: StorageAdapter,
): Promise<StoredDailyPlan | null> {
  const path = planPath(uid, document.date);
  return storageOf(storage).runTransaction(async (tx) => {
    const current = await tx.get<StoredDailyPlan>(path);
    if (!current || current.generation !== expectedGeneration) return null;
    tx.set<StoredDailyPlan>(path, document);
    return document;
  });
}

/**
 * Replaces a plan with one built from a specific base, if that base is still
 * the stored plan — generation *and* input digest (#524's stale-patch guard).
 *
 * `replaceStoredPlan` checks the generation alone, which is the right guard
 * for a full regeneration: its inputs were re-read after the generation was
 * observed. An incremental patch is a stronger claim — it was computed
 * against a particular plan state, and a document that carries the expected
 * generation but a different digest is not that state (an edit layered new
 * constraints under the same number, or a writer rewrote the document
 * without bumping). Applying there would overwrite a plan the patch never
 * saw, so the digest is checked inside the same transaction as the
 * generation, at the persistence boundary and not before it.
 *
 * Returns null on any mismatch; the caller recomputes from the newest state
 * rather than retrying the same patch.
 */
export async function replaceStoredPlanIfBaseMatches(
  uid: string,
  document: StoredDailyPlan,
  expectedBase: PlanGenerationAncestry,
  storage?: StorageAdapter,
): Promise<StoredDailyPlan | null> {
  const path = planPath(uid, document.date);
  return storageOf(storage).runTransaction(async (tx) => {
    const current = await tx.get<StoredDailyPlan>(path);
    if (!current
      || current.generation !== expectedBase.generation
      || current.inputDigest !== expectedBase.inputDigest) return null;
    tx.set<StoredDailyPlan>(path, document);
    return document;
  });
}

/**
 * Appends to the plan ledger.
 *
 * Its own collection, and deliberately not `events`. `events` is the domain
 * log: every row in it is a `DomainEvent` the reducer produced and replays into
 * `DomainState`, so a record the reducer does not know is a record it has to
 * skip — the same reasoning `nextStepDecisions` and `clarificationEvents` were
 * given their own collections for. A plan is not an aggregate the reducer owns.
 *
 * No titles and no explanation text: the digest is a hash, and the type and the
 * date are all a reader needs.
 */
export async function appendPlanEvent(
  uid: string,
  event: Omit<PlanEvent, 'id'>,
  storage?: StorageAdapter,
): Promise<PlanEvent> {
  const { path, record } = preparePlanEvent(uid, event);
  await storageOf(storage).set<PlanEvent>(path, record);
  return record;
}

/**
 * A ledger entry and where it goes, without writing it.
 *
 * For a caller that must write the entry inside a transaction alongside
 * something else — `acceptPlan` advances the activity counter (#201) in the
 * same commit. The id is minted here, outside that transaction, so a retried
 * transaction body writes the same record rather than a new one per attempt.
 */
export function preparePlanEvent(uid: string, event: Omit<PlanEvent, 'id'>): { path: string; record: PlanEvent } {
  const record: PlanEvent = { id: randomUUID(), ...event };
  return { path: `${userCol(uid, PLAN_EVENTS)}/${sortableDocId(record.at, record.id)}`, record };
}

export async function listPlanEvents(uid: string, storage?: StorageAdapter): Promise<PlanEvent[]> {
  const rows = await storageOf(storage).list<PlanEvent>(userCol(uid, PLAN_EVENTS));
  return rows.map((row) => row.data).sort((left, right) => left.at.localeCompare(right.at));
}
