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
import type { Plan, PlanDiff, PlanningConfig, PlanningConstraints } from '../../../src/contracts/v1/planningContracts';
import type { ReplanPolicyReason, UserControlMode } from '../../../src/contracts/v1/replanContracts';
import type { ScheduleBlock } from '../../../src/contracts/v1/scheduleBlockContracts';
import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';
import type { UserLocale } from '../../storage/userDocument';
import type { PlanPushPending } from './planPushRetry';
import { createHash, randomUUID } from 'node:crypto';
import { dayHorizon } from './buildDailyPlan';

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
  /**
   * The patch continuous replanning proposed against *this* generation (#523).
   *
   * `null` rather than absent once anything has written it, and written
   * explicitly by every path that replaces the document: an omitted key on a
   * `{ ...storedPlan }` rebuild would let generation N+1 inherit a patch of
   * generation N, which is the same inheritance bug `causeChangeIds` is
   * assigned unconditionally to avoid.
   */
  readonly proposal?: StoredPlanProposal | null;
  /**
   * The patches the person declined against this generation (#587).
   *
   * The memory the tick consults before storing a patch
   * (`proposalWasRejected`): without it a rejection clears the offer and
   * nothing else, and the very next change row about the same meeting — a
   * provider re-sync, a producer retry — solves to the same placement and
   * offers it again. Kept on the plan document rather than read from the
   * ledger so that the check runs inside the same transaction that would store
   * the patch: a rejection that lands while the tick is solving is seen, not
   * raced.
   *
   * Numbers and hashes only. Scoped to the day by living on the day's
   * document, and to the generation by `baseGeneration`: a rebuilt plan is a
   * different question, so an entry for an older generation matches nothing
   * and is dropped the next time a rejection is written.
   */
  readonly rejectedProposals?: readonly RejectedProposalMark[];
  /**
   * The morning push this plan still owes (#431). Server-only bookkeeping,
   * never in the DTO; see `planPushRetry.ts`.
   *
   * Written in the same write that creates the plan, removed — absent, never
   * null — by a confirmed send or a deliberate drop. Carried by every
   * `{ ...current }` rewrite, so an edit or an automatic replan keeps it; a
   * user's own rebuild drops it, and so should: they are looking at the plan.
   */
  readonly pushPending?: PlanPushPending;
}

/**
 * One declined patch, as the re-raise guard needs to recognise it (#587).
 *
 * `(baseGeneration, baseInputDigest)` is the state the patch was solved
 * against, and `fingerprint` is `proposalFingerprint` of the placement it
 * would have installed. No titles, no intervals, no text.
 */
export interface RejectedProposalMark {
  readonly baseGeneration: number;
  readonly baseInputDigest: string;
  readonly fingerprint: string;
}

/**
 * The most declined patches one generation remembers.
 *
 * A bound on the document, not a product rule: every entry is a person pressing
 * "no" on one day's plan, so a real day never comes near it, and the oldest
 * entry is the one dropped if one ever does.
 */
export const MAX_REJECTED_PROPOSALS = 20;

/**
 * A schedule patch continuous replanning proposed but did not apply (#523).
 *
 * ── Why this is a field on the plan and not its own collection ────
 *
 * A proposal is not an independent record; it is a *patch of one generation*.
 * `diff` and `plan` only mean anything relative to the exact `(generation,
 * inputDigest)` pair they were solved against, and the failure mode of storing
 * them apart is a proposal that outlives the plan it patches — a user shown
 * "move this to 14:00" for a day that was already rebuilt twice since.
 *
 * Keeping it in `users/{uid}/plans/{date}` makes that impossible rather than
 * merely unlikely: the proposal is written in the same transaction that reads
 * the generation (`storePlanProposal` refuses a stale base), it is replaced or
 * cleared by whatever rewrites the plan next, and it is deleted when the plan
 * is. A sibling collection would have needed all three re-established by hand,
 * plus an entry in `USER_SCOPED_COLLECTIONS` and one in the deletion coverage
 * list — three new ways for a proposal to be orphaned, to survive account
 * deletion, or to be checked by nothing.
 *
 * It does not change `status`. The plan in force is still the accepted plan:
 * the patch is an offer beside it, not a state it has entered.
 *
 * ── The orphaning hazard, and how it is closed (#523's reader) ───
 *
 * `storePlanProposal` pins a patch to `generation` alone, and `generation` is
 * not the only thing that moves a plan: `acceptPlan`, `dismissPlan`,
 * `editPlan` and `setBlockProtection` all rewrite the document with
 * `{ ...current, … }` without incrementing it. A patch solved against
 * generation 3 would therefore survive an edit or a dismissal and still
 * satisfy the compare-and-set.
 *
 * Of the three closures this comment once offered, only one actually works.
 * **None of those four mutators touches `inputDigest`** — an edit changes
 * `edits`, `blocks` and `status`, and the digest still describes the same
 * planner inputs — so comparing `baseInputDigest` at read time compares equal
 * and presents the orphan as actionable. Bumping the generation on an edit
 * would make a user's drag look like a regeneration and would burn a slot of
 * `MAX_PLAN_GENERATIONS_PER_DAY`. So the fix is the second one: those four
 * mutators now write `proposal: null` in the same transaction that changes
 * the plan under it, and a patch cannot outlive the state it patches.
 *
 * `pendingProposalOf` keeps the read-time `(generation, inputDigest)`
 * comparison as well, because the two catch different things: the clearing
 * catches a mutator that changes the plan without moving either number, and
 * the comparison catches a writer that moves a number without clearing the
 * field. Neither subsumes the other, and both are cheap.
 */
export interface StoredPlanProposal {
  readonly proposalId: string;
  readonly proposedAt: string;
  /** The generation this is a patch *of*; a stale base is refused, not merged. */
  readonly baseGeneration: number;
  readonly baseInputDigest: string;
  /** The solved plan this patch would install, verbatim from the planner. */
  readonly plan: Plan;
  /** Exact inputs of `plan`; absent only on offers stored before #586.
   * Legacy offers can be declined or regenerated, but cannot be installed
   * without this snapshot. No current-time solve may replace reviewed times.
   */
  readonly solveInputs?: {
    readonly constraints: PlanningConstraints;
    readonly config: PlanningConfig;
  };
  /** The existing diff contract, not a second one (#523's `PlanDiff` step). */
  readonly diff: PlanDiff;
  readonly reason: ReplanPolicyReason;
  readonly userControlMode: UserControlMode;
  /**
   * The changes whose own impact produced this patch (#527, AC 2).
   *
   * A proposal carries its causes for the reason a generation does: the user
   * is being asked to accept a change to their day, and "because your calendar
   * moved" is the difference between an offer and an unexplained one. Narrowed
   * exactly as `StoredDailyPlan.causeChangeIds` is — the impacting ids, never
   * the whole batch the replan request subsumed.
   */
  readonly causeChangeIds: readonly string[];
  /**
   * What each cause was about, so it can be re-read after its change row is
   * drained (#611 guards): the replan tick re-resolves these to decide whether
   * an old cause still blocks something a superseding offer moves (else it is
   * not carried over), and whether any cause still collides with the visible
   * day (else the offer is withdrawn).
   *
   * Ids only, as `PlanningStateChange` carries them: a change id, a source
   * kind and an entity id. Absent on offers stored before this field existed,
   * which the tick then treats the way it did before.
   */
  readonly causeRefs?: readonly ProposalCauseRef[];
}

/** One cause of an offer, as the tick needs to re-read it. Ids only. */
export interface ProposalCauseRef {
  readonly changeId: string;
  readonly source: PlanningStateChange['source'];
  readonly entityId: string;
}

/**
 * How many causes one offer names (#611 guards). The cap is by entity, not by
 * change id, so one meeting's burst of rows cannot crowd out another meeting:
 *
 *  - at most `MAX_CAUSE_ENTITIES` entities (meetings, blocks) are named, this
 *    run's own before the ones carried from the offer it replaces;
 *  - of one entity's rows in one run, at most `MAX_CHANGE_IDS_PER_CAUSE`: the
 *    first and the latest by `occurredAt`, which is enough to join the offer
 *    to the event that started the burst and to the one that settled it.
 *
 * `MAX_PROPOSAL_CAUSES` is their product, the most change ids an offer holds.
 * These bound the document; the rules that decide what is a cause at all are
 * in the replan service (`causesOf`).
 */
export const MAX_CAUSE_ENTITIES = 25;
export const MAX_CHANGE_IDS_PER_CAUSE = 2;
export const MAX_PROPOSAL_CAUSES = MAX_CAUSE_ENTITIES * MAX_CHANGE_IDS_PER_CAUSE;

/**
 * The instant an unanswered proposal on this plan stops being an offer: the
 * end of the plan's own local day (#611 guards, the council's "expiry").
 *
 * Local midnight after `date`, in the zone the plan was built in, by the same
 * function that gives the plan its horizon (`dayHorizon`), so a DST day is
 * 23 or 25 hours long here exactly as it is to the planner. A patch of
 * Tuesday's plan is a question about Tuesday, and once Tuesday is over there
 * is nothing left for a "yes" to change.
 */
export function proposalExpiresAt(stored: Pick<StoredDailyPlan, 'date' | 'timezone'>): string {
  return dayHorizon(stored.date, stored.timezone).endsAt;
}

/**
 * Whether the proposal stored on this plan has outlived its day.
 *
 * Checked at read time, by every reader through `pendingProposalOf`, rather
 * than cleared by a job: no sweep visits every plan at midnight (the replan
 * tick visits only accounts with pending changes, and only today's plan), and
 * a check that costs one comparison needs none. The expired field stays on a
 * document for a day that is over until something rewrites it. Nothing
 * records it as declined: expiry is not the person's answer, so
 * `rejectedProposals` and the ledger are untouched.
 */
export function proposalHasExpired(stored: Pick<StoredDailyPlan, 'date' | 'timezone'>, now: Date | string): boolean {
  const at = typeof now === 'string' ? Date.parse(now) : now.getTime();
  return at >= Date.parse(proposalExpiresAt(stored));
}

/**
 * The proposal a reader may act on, or null (#523).
 *
 * The one place "is this patch still about this plan" is answered, so the read
 * surface and the accept action cannot drift into two different answers. A
 * patch whose base is not exactly the document's own `(generation,
 * inputDigest)` is not a weaker offer — it describes a plan the user is no
 * longer looking at — so it is withheld rather than shown with a caveat.
 *
 * Nor is one whose day is over (#611 guards): `now` is required, so no caller
 * can ask the question without saying when it is asking.
 *
 * Pure and synchronous: it is a predicate over the document and an instant,
 * and every caller already has both.
 */
export function pendingProposalOf(stored: StoredDailyPlan, now: Date | string): StoredPlanProposal | null {
  const proposal = stored.proposal ?? null;
  if (proposal === null) return null;
  if (proposal.baseGeneration !== stored.generation) return null;
  if (proposal.baseInputDigest !== stored.inputDigest) return null;
  if (proposalHasExpired(stored, now)) return null;
  return proposal;
}

export type PlanEventType =
  | 'plan_proposed'
  | 'plan_accepted'
  | 'plan_edited'
  | 'plan_dismissed'
  | 'plan_regenerated'
  | 'plan_protected'
  /**
   * The plan was put on screen (#533). A view, not a decision: it exists so
   * R3 (`lib/memoryGrowth/rules.ts`) can name the time a person usually looks
   * at their plan, and it is deliberately not activity (`planActivity.ts`).
   */
  | 'plan_opened'
  /**
   * The person accepted a patch continuous replanning proposed (#587).
   * Written only by `acceptPlanProposal`, which only the authenticated
   * actions route reaches, so the type itself names the actor: the ledger has
   * never carried an actor field, and `plan_accepted`, `plan_edited` and
   * `plan_dismissed` are acts of the person by their type alone. It is written
   * in the same commit as the `plan_regenerated` entry for the generation it
   * installs, which stays the system fact that the plan in force changed.
   */
  | 'plan_proposal_accepted'
  /**
   * The person declined such a patch (#587). Also the audit record of the
   * re-raise guard, see `StoredDailyPlan.rejectedProposals`.
   */
  | 'plan_proposal_rejected';

export interface PlanEvent {
  readonly id: string;
  readonly type: PlanEventType;
  readonly date: string;
  readonly at: string;
  readonly generation: number;
  /** The plan's digest, which is a hash and carries no user text. */
  readonly inputDigest: string;
  /**
   * On a `plan_regenerated` or a `plan_proposed` written by an automatic
   * replan: the change ids that caused it (#527, AC 2; #523). Absent
   * everywhere else — a manual rebuild, an acceptance, an edit — for the
   * reason `StoredDailyPlan.causeChangeIds` is absent there. A proposal
   * records them for the same reason a generation does: it is an offer to
   * change the user's day, and the ledger should say what prompted it.
   * Opaque ids, like the digest beside them.
   */
  readonly causeChangeIds?: readonly string[];
  /**
   * On `plan_proposed` written by an automatic replan, and on both answers to
   * it (#587): the proposal the entry is about, so an answer joins to the
   * offer it answers. On those three entries `generation` and `inputDigest`
   * are the proposal's base, the state it was solved against, and not the
   * generation an acceptance goes on to install (that one is on the
   * `plan_regenerated` entry written beside it). An opaque id.
   */
  readonly proposalId?: string;
  /**
   * On `plan_proposal_rejected` only: `proposalFingerprint` of the declined
   * placement, the key the re-raise guard remembers. A hash.
   */
  readonly proposalFingerprint?: string;
}

/**
 * A hash of the placement a patch would install (#587).
 *
 * The re-raise guard compares patches by this. Not by `plan.inputDigest`,
 * which hashes the whole planning request and so moves with anything the
 * request carries that the person never sees, and not by `proposalId`, which
 * is minted fresh on every solve. Two patches with the same fingerprint put
 * every item in the same place and leave the same items unplaced, which is
 * what a person saw and said no to.
 *
 * Instants are compared as epoch milliseconds, so two spellings of one instant
 * are one placement. The inputs are item ids and numbers, and the output is a
 * hash, so nothing a person wrote reaches it.
 */
export function proposalFingerprint(plan: Plan): string {
  const placed = plan.scheduled
    .map((item) => [item.itemId, Date.parse(item.interval.startsAt), Date.parse(item.interval.endsAt)] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const unplaced = plan.unscheduled.map((item) => item.itemId).sort();
  return createHash('sha256').update(JSON.stringify({ placed, unplaced })).digest('hex');
}

/**
 * Whether the person already declined this exact patch of this exact state
 * (#587, the council's "the same change does not re-raise it").
 *
 * Read by the replan tick inside the transaction that would store the patch.
 * A match needs all three: the same base generation, the same base digest and
 * the same placement. A patch that moves anything differently is a different
 * offer and is still made, and so is any patch of a rebuilt plan.
 */
export function proposalWasRejected(stored: StoredDailyPlan, proposal: StoredPlanProposal): boolean {
  const marks = stored.rejectedProposals ?? [];
  if (marks.length === 0) return false;
  const fingerprint = proposalFingerprint(proposal.plan);
  return marks.some((mark) => mark.baseGeneration === proposal.baseGeneration
    && mark.baseInputDigest === proposal.baseInputDigest
    && mark.fingerprint === fingerprint);
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
  mutate: (current: StoredDailyPlan) => PlanMutation<T> | null,
  storage?: StorageAdapter,
): Promise<{ stored: StoredDailyPlan; result: T } | null> {
  const path = planPath(uid, date);
  return storageOf(storage).runTransaction(async (tx) => {
    const current = await tx.get<StoredDailyPlan>(path);
    if (!current) return null;
    const outcome = mutate(current);
    if (!outcome) return null;
    tx.set<StoredDailyPlan>(path, outcome.next);
    for (const entry of outcome.ledger ?? []) tx.set<PlanEvent>(entry.path, entry.record);
    return { stored: outcome.next, result: outcome.result };
  });
}

/**
 * What a `mutateStoredPlan` mutator returns.
 *
 * `ledger` is the plan ledger entries that commit with the document (#587):
 * a person's answer to a proposal and the state change it makes are one fact,
 * and an entry appended in a second write would be lost on every crash
 * between the two. Built with `preparePlanEvent`.
 */
export interface PlanMutation<T> {
  readonly next: StoredDailyPlan;
  readonly result: T;
  readonly ledger?: readonly { readonly path: string; readonly record: PlanEvent }[];
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
 * Records a proposed patch against the generation it was solved for.
 *
 * Returns null when that generation is no longer current — the plan was
 * rebuilt, edited or replaced while the planner was running — because a patch
 * of a plan that no longer exists is not a weaker proposal, it is a wrong one.
 * That is the compare-and-set `replaceStoredPlan` uses, applied to a write
 * that does not replace the plan itself.
 */
export async function storePlanProposal(
  uid: string,
  date: string,
  proposal: StoredPlanProposal,
  storage?: StorageAdapter,
): Promise<StoredDailyPlan | null> {
  const outcome = await mutateStoredPlan<null>(
    uid,
    date,
    (current) => {
      if (current.generation !== proposal.baseGeneration) return null;
      // `status` is deliberately untouched: the accepted plan is still the
      // plan in force, and a proposal beside it has not been accepted.
      return { next: { ...current, proposal, updatedAt: proposal.proposedAt }, result: null };
    },
    storage,
  );
  return outcome?.stored ?? null;
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
 * A caller that can only build the entry inside the transaction body (#587:
 * the answer to a proposal needs the proposal the body read) mints the id
 * outside and passes it in, for the same reason.
 */
export function preparePlanEvent(
  uid: string,
  event: Omit<PlanEvent, 'id'>,
  id: string = randomUUID(),
): { path: string; record: PlanEvent } {
  const record: PlanEvent = { id, ...event };
  return { path: `${userCol(uid, PLAN_EVENTS)}/${sortableDocId(record.at, record.id)}`, record };
}

export async function listPlanEvents(uid: string, storage?: StorageAdapter): Promise<PlanEvent[]> {
  const rows = await storageOf(storage).list<PlanEvent>(userCol(uid, PLAN_EVENTS));
  return rows.map((row) => row.data).sort((left, right) => left.at.localeCompare(right.at));
}
