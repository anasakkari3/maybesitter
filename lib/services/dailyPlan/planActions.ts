/**
 * What a person may do to the plan they were given (UC-3.10a, #194).
 *
 * Accept it, dismiss it, move a couple of things, or ask for a new one. All
 * four change the *proposal* and none of them touches a commitment: no path in
 * this file reaches `commandService`, `applyParticipantCommand`, the
 * `commitments` collection or any writer of it, and
 * `tests/dailyPlan/dailyPlanBoundaries.test.ts` proves that by reading the
 * source rather than by trusting this paragraph. That is
 * `PLANNING_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical` in force:
 * moving a task in today's plan says something about today, not about the
 * commitment, and a plan that quietly rewrote due dates would be editing the
 * user's obligations on their behalf.
 *
 * ── An edit is checked against the constraints the plan was built from ──
 *
 * Not against whatever the commitments say now. The stored document carries its
 * own `constraints`, so a move is judged against the same working windows, the
 * same busy time and the same horizon that produced the placement being moved.
 * Re-deriving them would mean a user's edit could be refused — or accepted —
 * because something unrelated changed between the morning and the afternoon,
 * and the reason code shown would then describe a plan that no longer exists.
 *
 * A refused edit writes nothing at all. `mutateStoredPlan` is given a mutator
 * that returns null, so the document is not rewritten with identical values and
 * a new `updatedAt` — "the stored plan is unchanged" means unchanged.
 *
 * ── Every mutator here clears the proposal (#523) ────────────────
 *
 * `acceptPlan`, `dismissPlan`, `editPlan` and the changing branch of
 * `setBlockProtection` each write `proposal: null` alongside what they came to
 * write. A `StoredPlanProposal` is a patch of one *state* of the plan, and
 * these four change that state without moving either number the patch is
 * pinned to (`generation` stays, `inputDigest` stays) — so nothing downstream
 * could tell the patch had been orphaned. The clearing is assigned rather than
 * left to the `{ ...current }` spread for the reason `causeChangeIds` is
 * assigned unconditionally on the write side: an omitted key inherits.
 */
import {
  mergeIntervals,
  normalizeWorkingWindows,
} from '../../planning/constraints';
import { intervalsOverlap, toEpochMs } from '../../planning/shared/time';
import type {
  PlacementProtection,
  Plan,
  PlannedItem,
  ProtectionOrigin,
  TimeInterval,
} from '../../../src/contracts/v1/planningContracts';
import { ownershipOf, type ScheduleBlock } from '../../../src/contracts/v1/scheduleBlockContracts';
import { getStorage, type StorageAdapter } from '../../storage';
import { readActivityStats, recordActivityEvents } from '../activity/activityStats';
import { earliestLedgerAcceptance, planEventAsRecord } from '../activity/planActivity';
import { applyEditsToBlocks, protectionOf, schedulePlan } from '../../planning/scheduler';
import {
  appendPlanEvent,
  mutateStoredPlan,
  pendingProposalOf,
  preparePlanEvent,
  readStoredPlan,
  replaceStoredPlan,
  replaceStoredPlanIfBaseMatches,
  type DailyPlanStatus,
  type PlanEdits,
  type PlanEvent,
  type PlanMove,
  type StoredDailyPlan,
} from './planStore';
import { MAX_PLAN_GENERATIONS_PER_DAY } from './planSettings';
import { composeDailyPlan, type DailyPlanDeps } from './dailyPlanService';

export type PlanEditReason =
  | 'unknown_item'
  | 'invalid_instant'
  | 'invalid_interval'
  | 'outside_horizon'
  | 'outside_working_window'
  | 'overlaps_fixed_event'
  | 'overlaps_scheduled_item'
  | 'empty_edit';

export class PlanEditRejected extends Error {
  constructor(readonly reason: PlanEditReason, readonly itemId: string | null, message: string) {
    super(message);
    this.name = 'PlanEditRejected';
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function requireInstant(value: unknown, itemId: string): string {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new PlanEditRejected('invalid_instant', itemId, `${JSON.stringify(value)} is not an ISO instant`);
  }
  return new Date(value).toISOString();
}

/** The placement the user sees: the plan, with their moves and removals applied. */
export function effectiveSchedule(stored: StoredDailyPlan): PlannedItem[] {
  const removed = new Set(stored.edits.removals);
  const moved = new Map(stored.edits.moves.map((move) => [move.itemId, move]));
  return stored.plan.scheduled
    .filter((item) => !removed.has(item.itemId))
    .map((item) => {
      const move = moved.get(item.itemId);
      if (!move) return item;
      const interval: TimeInterval = { startsAt: move.startsAt, endsAt: move.endsAt };
      // The reserved interval moves with the effort. Buffers are zero for every
      // item this adapter builds, so the two coincide; keeping them separate
      // here means a future non-zero buffer does not silently vanish on an edit.
      return { itemId: item.itemId, interval, reservedInterval: interval };
    })
    .sort((left, right) => toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt));
}

/** Parses the client's edit payload. Throws `PlanEditRejected` on anything else. */
export function parseEdit(body: unknown): { moves: PlanMove[]; removals: string[] } {
  const payload = (body ?? {}) as { moves?: unknown; removals?: unknown };
  const rawMoves = Array.isArray(payload.moves) ? payload.moves : [];
  const rawRemovals = Array.isArray(payload.removals) ? payload.removals : [];

  const moves: PlanMove[] = rawMoves.map((entry) => {
    const move = (entry ?? {}) as { itemId?: unknown; startsAt?: unknown; endsAt?: unknown };
    if (typeof move.itemId !== 'string' || move.itemId === '') {
      throw new PlanEditRejected('unknown_item', null, 'a move must name an itemId');
    }
    const startsAt = requireInstant(move.startsAt, move.itemId);
    // `endsAt` is optional: a client that drags a block sends where it landed,
    // and the block keeps the length the planner gave it. Its absence is not an
    // invitation to invent a duration — the original interval supplies it.
    const endsAt = move.endsAt === undefined ? null : requireInstant(move.endsAt, move.itemId);
    return { itemId: move.itemId, startsAt, endsAt: endsAt ?? startsAt };
  });

  const removals = rawRemovals.map((value) => {
    if (typeof value !== 'string' || value === '') {
      throw new PlanEditRejected('unknown_item', null, 'a removal must be an item id');
    }
    return value;
  });

  if (moves.length === 0 && removals.length === 0) {
    throw new PlanEditRejected('empty_edit', null, 'an edit must move or remove at least one item');
  }
  return { moves, removals };
}

/**
 * Re-validates an edit against the plan's own constraints.
 *
 * Throws the first reason, with the item it is about: a 422 that says
 * `overlaps_fixed_event` without saying which item is a message the client
 * cannot render next to anything.
 */
export function validateEdit(stored: StoredDailyPlan, edit: { moves: readonly PlanMove[]; removals: readonly string[] }): PlanEdits {
  const placed = new Map(stored.plan.scheduled.map((item) => [item.itemId, item]));
  for (const itemId of [...edit.moves.map((move) => move.itemId), ...edit.removals]) {
    if (!placed.has(itemId)) {
      throw new PlanEditRejected('unknown_item', itemId, `${itemId} is not placed in this plan`);
    }
  }

  // A move with no explicit end keeps the length the planner gave it.
  const moves: PlanMove[] = edit.moves.map((move) => {
    const original = placed.get(move.itemId)!;
    const lengthMs = toEpochMs(original.interval.endsAt) - toEpochMs(original.interval.startsAt);
    const endsAt = move.endsAt === move.startsAt
      ? new Date(toEpochMs(move.startsAt) + lengthMs).toISOString()
      : move.endsAt;
    if (toEpochMs(endsAt) <= toEpochMs(move.startsAt)) {
      throw new PlanEditRejected('invalid_interval', move.itemId, 'a move must end after it starts');
    }
    return { itemId: move.itemId, startsAt: move.startsAt, endsAt };
  });

  const next: PlanEdits = { moves, removals: [...edit.removals] };
  const schedule = effectiveSchedule({ ...stored, edits: next });

  const horizon: TimeInterval = { startsAt: stored.constraints.horizon.startsAt, endsAt: stored.constraints.horizon.endsAt };
  const windows = mergeIntervals(
    normalizeWorkingWindows(stored.constraints.workingWindows, stored.constraints.horizon, stored.config)
      .windows.map((occurrence) => occurrence.interval),
  );
  const blocking = stored.constraints.fixedEvents.filter((event) => event.blocking);

  for (const move of moves) {
    const item = schedule.find((entry) => entry.itemId === move.itemId)!;
    if (toEpochMs(item.interval.startsAt) < toEpochMs(horizon.startsAt)
      || toEpochMs(item.interval.endsAt) > toEpochMs(horizon.endsAt)) {
      throw new PlanEditRejected('outside_horizon', move.itemId, 'the move falls outside the day being planned');
    }
    if (!windows.some((window) =>
      toEpochMs(item.interval.startsAt) >= toEpochMs(window.startsAt)
      && toEpochMs(item.interval.endsAt) <= toEpochMs(window.endsAt))) {
      throw new PlanEditRejected('outside_working_window', move.itemId, 'the move falls outside the hours this plan may use');
    }
    // Acceptance criterion 1 again, on the edit path: a user may not drag work
    // into time the calendar says is already spoken for.
    if (blocking.some((event) => intervalsOverlap(item.reservedInterval, event.interval))) {
      throw new PlanEditRejected('overlaps_fixed_event', move.itemId, 'the move lands on time that is already taken');
    }
    if (schedule.some((other) => other.itemId !== item.itemId && intervalsOverlap(item.reservedInterval, other.reservedInterval))) {
      throw new PlanEditRejected('overlaps_scheduled_item', move.itemId, 'the move lands on another item in this plan');
    }
  }

  return next;
}

export interface PlanActionOptions {
  storage?: StorageAdapter;
  now?: () => Date;
}

function clockOf(options: PlanActionOptions): Date {
  return (options.now ?? (() => new Date()))();
}

export async function acceptPlan(uid: string, date: string, options: PlanActionOptions = {}): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  const outcome = await mutateStoredPlan<null>(uid, date, (current) => ({
    // `proposal: null` in the same transaction, assigned and not omitted —
    // see `clearsProposal` above. Accepting *the plan* is a statement about
    // the plan the user is looking at; a patch of it that was solved before
    // they pressed the button is not part of what they accepted.
    next: { ...current, status: 'accepted', acceptedAt: at, updatedAt: at, proposal: null },
    result: null,
  }), options.storage);
  if (!outcome) return null;
  const { path, record } = preparePlanEvent(uid, {
    type: 'plan_accepted', date, at, generation: outcome.stored.generation, inputDigest: outcome.stored.inputDigest,
  });
  // The ledger entry and the activity counter commit together (#201): a
  // counter bumped in a second write drifts on every crash between the two,
  // and the first-plan Moment would then disagree with the history.
  await (options.storage ?? getStorage()).runTransaction(async (tx) => {
    const stats = await readActivityStats(tx, uid);
    // A legacy acceptance (ledger entry, no counter) keeps its own, earlier
    // date: once this sets the counter, the summary stops scanning for one.
    const legacy = stats.firstPlanAcceptedAt === null ? await earliestLedgerAcceptance(tx, uid) : null;
    tx.set<PlanEvent>(path, record);
    recordActivityEvents(tx, uid, stats, [
      planEventAsRecord(record),
      ...(legacy ? [{ id: 'legacy', type: 'plan_accepted', at: legacy, aggregateId: '', payload: {} }] : []),
    ]);
  });
  return outcome.stored;
}

export async function dismissPlan(uid: string, date: string, options: PlanActionOptions = {}): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  const outcome = await mutateStoredPlan<null>(uid, date, (current) => ({
    // Cleared with the dismissal: offering a patch of a day the person has
    // just set aside is the orphan in its plainest form.
    next: { ...current, status: 'dismissed', updatedAt: at, proposal: null },
    result: null,
  }), options.storage);
  if (!outcome) return null;
  await appendPlanEvent(uid, {
    type: 'plan_dismissed', date, at, generation: outcome.stored.generation, inputDigest: outcome.stored.inputDigest,
  }, options.storage);
  return outcome.stored;
}

/**
 * Applies a validated edit.
 *
 * The validation runs *inside* the transaction's mutator, against the document
 * as it is at that moment, so an edit built against a plan another device has
 * since regenerated is refused rather than applied to the new one.
 */
export async function editPlan(
  uid: string,
  date: string,
  edit: { moves: readonly PlanMove[]; removals: readonly string[] },
  options: PlanActionOptions = {},
): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  let rejection: PlanEditRejected | null = null;

  const outcome = await mutateStoredPlan<null>(uid, date, (current) => {
    try {
      const edits = validateEdit(current, edit);
      // The blocks move in the same commit as the edit record (#521): a move
      // writes the new interval onto the block — the plan layer's own state —
      // and never onto the commitment, which is the issue's "a manual move
      // never writes a time onto the source" criterion. A document from before
      // blocks existed has none to update; the next regeneration rebuilds them.
      const blocks = applyEditsToBlocks(current.blocks ?? [], current.plan.scheduled, edits, current.generation);
      // The edit is the case a read-time digest comparison cannot see: it
      // changes `edits` and `blocks` and leaves `generation` and
      // `inputDigest` exactly as they were, so the patch would go on
      // satisfying every guard while describing placements the user has just
      // overruled. Cleared here, in the edit's own transaction.
      return { next: { ...current, status: 'edited', edits, blocks, updatedAt: at, proposal: null }, result: null };
    } catch (error) {
      // Recorded rather than thrown: throwing out of a transaction body would
      // be retried by the adapter, and a deterministic refusal does not become
      // true on the second attempt.
      rejection = error instanceof PlanEditRejected ? error : null;
      if (!rejection) throw error;
      return null;
    }
  }, options.storage);

  if (rejection) throw rejection;
  if (!outcome) return null;
  await appendPlanEvent(uid, {
    type: 'plan_edited', date, at, generation: outcome.stored.generation, inputDigest: outcome.stored.inputDigest,
  }, options.storage);
  return outcome.stored;
}

/* ── Block protection (#522) ─────────────────────────────── */

export type PlanProtectionReason =
  | 'unknown_block'
  | 'invalid_ownership'
  | 'invalid_origin'
  | 'invalid_max_shift'
  | 'invalid_interval'
  | 'fixed_block';

export class PlanProtectionRejected extends Error {
  constructor(readonly reason: PlanProtectionReason, readonly blockId: string | null, message: string) {
    super(message);
    this.name = 'PlanProtectionRejected';
  }
}

/**
 * What a client may say about a block's protection.
 *
 * `ownership` is deliberately only the two values a *person* may choose.
 * `fixed` is not among them: a fixed block's position belongs to the
 * commitment that pinned it, and letting this mutation declare one would be
 * the plan layer editing an obligation on the user's behalf — the thing
 * `PLANNING_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical` forbids.
 * Sending `flexible` releases a protection, which is the only way back.
 */
export interface BlockProtectionRequest {
  readonly blockId: string;
  readonly ownership: 'flexible' | 'protected_flexible';
  readonly origin: ProtectionOrigin;
  readonly maxShiftMinutes: number | null;
  /** Defaults to where the block sits now — "keep it here" is the usual ask. */
  readonly preferredInterval: TimeInterval | null;
}

const PROTECTION_ORIGINS: readonly ProtectionOrigin[] = ['user', 'habit_policy', 'goal_policy'];

/** Parses the client's protection payload. Throws on anything else. */
export function parseProtection(body: unknown): BlockProtectionRequest {
  const payload = (body ?? {}) as Record<string, unknown>;
  const blockId = payload.blockId;
  if (typeof blockId !== 'string' || blockId === '') {
    throw new PlanProtectionRejected('unknown_block', null, 'a protection must name a blockId');
  }
  const ownership = payload.ownership;
  if (ownership !== 'flexible' && ownership !== 'protected_flexible') {
    throw new PlanProtectionRejected(
      'invalid_ownership',
      blockId,
      'ownership must be "protected_flexible" or "flexible"',
    );
  }
  // Defaulted rather than required: a person protecting their own gym block is
  // the overwhelmingly common case, and a client that had to name the origin
  // would eventually name the wrong one.
  const origin = payload.origin === undefined ? 'user' : payload.origin;
  if (typeof origin !== 'string' || !(PROTECTION_ORIGINS as readonly string[]).includes(origin)) {
    throw new PlanProtectionRejected('invalid_origin', blockId, `unknown protection origin: ${String(origin)}`);
  }

  const raw = payload.maxShiftMinutes;
  if (raw !== undefined && raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) {
    // Refused at the boundary rather than carried inward. The solver treats an
    // unusable bound as a window admitting nothing (`PROTECTED_SHIFT_EXCEEDED`),
    // which is the right answer for a bound that reached it — but a client
    // sending `-30` has made a mistake, and answering it with an unschedulable
    // item tomorrow morning is not telling them.
    throw new PlanProtectionRejected(
      'invalid_max_shift',
      blockId,
      'maxShiftMinutes must be a non-negative number of minutes, or null',
    );
  }
  const maxShiftMinutes = raw === undefined || raw === null ? null : raw;

  let preferredInterval: TimeInterval | null = null;
  const interval = payload.preferredInterval;
  if (interval !== undefined && interval !== null) {
    const candidate = interval as { startsAt?: unknown; endsAt?: unknown };
    const startsAt = requireProtectionInstant(candidate.startsAt, blockId);
    const endsAt = requireProtectionInstant(candidate.endsAt, blockId);
    if (toEpochMs(endsAt) <= toEpochMs(startsAt)) {
      throw new PlanProtectionRejected('invalid_interval', blockId, 'a preferred interval must end after it starts');
    }
    preferredInterval = { startsAt, endsAt };
  }

  return { blockId, ownership, origin: origin as ProtectionOrigin, maxShiftMinutes, preferredInterval };
}

function requireProtectionInstant(value: unknown, blockId: string): string {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new PlanProtectionRejected('invalid_interval', blockId, `${JSON.stringify(value)} is not an ISO instant`);
  }
  return new Date(value).toISOString();
}

/** Two protections that say the same thing. Used to keep the write idempotent. */
export function sameProtection(
  left: PlacementProtection | null | undefined,
  right: PlacementProtection | null | undefined,
): boolean {
  const a = left ?? null;
  const b = right ?? null;
  if (a === null || b === null) return a === b;
  const sameInterval = a.preferredInterval === null || b.preferredInterval === null
    ? a.preferredInterval === b.preferredInterval
    : toEpochMs(a.preferredInterval.startsAt) === toEpochMs(b.preferredInterval.startsAt)
      && toEpochMs(a.preferredInterval.endsAt) === toEpochMs(b.preferredInterval.endsAt);
  return a.ownership === b.ownership
    && a.origin === b.origin
    && a.maxShiftMinutes === b.maxShiftMinutes
    && sameInterval;
}

/**
 * The protection a request produces for one block.
 *
 * `flexible` erases the protection rather than storing one that says "not
 * protected": absence is how every block that was never protected reads, and a
 * second spelling of the same state is a second thing every reader has to know
 * about.
 */
function protectionFor(block: ScheduleBlock, request: BlockProtectionRequest): PlacementProtection | null {
  if (request.ownership === 'flexible') return null;
  return {
    ownership: 'protected_flexible',
    origin: request.origin,
    // Where it sits now, unless the caller named an interval. An unplaced block
    // yields null, which the contract allows: it is protected in principle and
    // has nothing to retain until the planner gives it a first placement.
    preferredInterval: request.preferredInterval ?? block.currentInterval,
    maxShiftMinutes: request.maxShiftMinutes,
  };
}

export interface BlockProtectionOutcome {
  readonly stored: StoredDailyPlan;
  /** False when the block already said exactly this. See `setBlockProtection`. */
  readonly changed: boolean;
}

/**
 * Declares (or releases) the protection on one schedule block.
 *
 * This is #522's mutation, and it lives on the **existing** Plan boundary on
 * purpose: a protection is a fact about a block, a block is part of the stored
 * plan document, and a standalone planner service would be a second owner of
 * one document with no transaction between them. `mutateStoredPlan` gives it
 * the same read-modify-write the edit path uses, so a protection and a
 * concurrent move cannot interleave into a document that shows one and not the
 * other.
 *
 * It changes **no placement**. The plan the user is looking at stays exactly
 * where it is; what changes is how the next regeneration treats that hour
 * (`projectBlockProtectionIntoPlanningConstraints`). Moving something is
 * `editPlan`'s job, and a mutation that did both would make "protect this"
 * silently reschedule the day.
 *
 * **Idempotent by content.** A repeated request that asks for the protection
 * the block already carries rewrites the document with identical bytes — same
 * `updatedAt`, same everything — and appends no second ledger entry. Two
 * phones tapping "keep this here" produce one record, not two.
 */
export async function setBlockProtection(
  uid: string,
  date: string,
  request: BlockProtectionRequest,
  options: PlanActionOptions = {},
): Promise<BlockProtectionOutcome | null> {
  const at = clockOf(options).toISOString();
  let rejection: PlanProtectionRejected | null = null;

  const outcome = await mutateStoredPlan<boolean>(uid, date, (current) => {
    // `?? []` for a document written before blocks existed (#521): it has no
    // block to name, which is `unknown_block` and not a crash.
    const blocks = current.blocks ?? [];
    const block = blocks.find((candidate) => candidate.blockId === request.blockId);
    if (block === undefined) {
      rejection = new PlanProtectionRejected(
        'unknown_block',
        request.blockId,
        `${request.blockId} is not a block of this plan`,
      );
      return null;
    }
    if (ownershipOf(block) === 'fixed') {
      rejection = new PlanProtectionRejected(
        'fixed_block',
        request.blockId,
        'a pinned event already owns its time; protection describes a placement the planner makes',
      );
      return null;
    }

    const next = protectionFor(block, request);
    if (sameProtection(protectionOf(block), next)) {
      // Unchanged, and reported as such. Returning the document as it stands
      // keeps the transaction a read-modify-write while writing nothing new,
      // and the caller skips the ledger entry.
      return { next: current, result: false };
    }
    return {
      next: {
        ...current,
        blocks: blocks.map((candidate) => (candidate.blockId === request.blockId
          ? { ...candidate, protection: next }
          : candidate)),
        updatedAt: at,
        // Only on the branch that actually changes something. The idempotent
        // branch above returns `current` untouched, and a repeated "keep this
        // here" that changed nothing must not throw away a live offer.
        proposal: null,
      },
      result: true,
    };
  }, options.storage);

  if (rejection) throw rejection;
  if (!outcome) return null;
  if (!outcome.result) return { stored: outcome.stored, changed: false };

  await appendPlanEvent(uid, {
    type: 'plan_protected', date, at, generation: outcome.stored.generation, inputDigest: outcome.stored.inputDigest,
  }, options.storage);
  return { stored: outcome.stored, changed: true };
}

/* ── The proposed patch: accept it or reject it (#523) ───────────── */

export type PlanProposalReason = 'no_proposal' | 'stale_proposal';

export class PlanProposalRejected extends Error {
  constructor(readonly reason: PlanProposalReason, message: string) {
    super(message);
    this.name = 'PlanProposalRejected';
  }
}

/**
 * The blocks of a plan, re-pointed at the placements a patch would install.
 *
 * Not `reconcileScheduleBlocks`: that needs the `ScheduleBlockSources` map,
 * which is built on the write side from the adapters and is not on the
 * document. What this can do without it is the three cases a patch can put a
 * flexible block in, and it must do all three — `reconcileScheduleBlocks` can
 * never emit a block the plan does not account for, so neither may this.
 *
 *  - **the patch places it** → the new interval, and the provenance of that
 *    placement: `lastPlacedBy: 'planner'`, `lastPlanGeneration` the new one.
 *    Identity and `protection` are carried through untouched — #522's
 *    declaration is about the block, and a reschedule is not a release.
 *  - **the patch leaves it unscheduled** → `currentInterval: null` and
 *    *nothing else*. `lastPlacedBy` and `lastPlanGeneration` describe the last
 *    real placement (`blocks.ts`, property 4), so stamping the new generation
 *    on an unplaced block would have it claim that generation placed it while
 *    asserting it is unplaced — and would erase a `'user'` placement the person
 *    made.
 *  - **the patch accounts for it in neither list** → dropped. Keeping it would
 *    leave a block with a stale `currentInterval` for work the plan no longer
 *    contains, which is exactly #521's no-orphan-blocks invariant broken —
 *    and `planToDto.protections` walks `stored.blocks` unconditionally, so an
 *    orphan that was protected would surface a protection row for an item in
 *    neither `scheduled` nor `unscheduled`.
 *
 * Fixed blocks are excepted from all three: a pinned event's interval belongs
 * to the commitment that pinned it, not to a patch, and it is sourced from the
 * constraints rather than from the plan's item lists — so "in neither list" is
 * its normal state and not an orphan.
 *
 * An item the patch places that has no block yet simply has none until the
 * next regeneration builds one — a missing block disables `protect` for that
 * row and misstates nothing, which is the same honest gap a pre-#521 document
 * has.
 */
function blocksForAcceptedProposal(
  blocks: readonly ScheduleBlock[],
  plan: Plan,
  generation: number,
): ScheduleBlock[] {
  const placed = new Map(plan.scheduled.map((item) => [item.itemId, item.interval] as const));
  const unplaced = new Set(plan.unscheduled.map((item) => item.itemId));
  return blocks.flatMap((block) => {
    if (block.mobility !== 'flexible') return [block];
    const interval = placed.get(block.source.id) ?? null;
    if (interval !== null) {
      return [{ ...block, currentInterval: interval, lastPlacedBy: 'planner' as const, lastPlanGeneration: generation }];
    }
    if (unplaced.has(block.source.id)) return [{ ...block, currentInterval: null }];
    return [];
  });
}

/**
 * Installs the proposed patch as the plan (#523's user-control layer).
 *
 * Returns null when there is no plan for the date — 404, the same as every
 * other action here. Throws `PlanProposalRejected` when there is a plan but no
 * patch to act on (`no_proposal`), and when the state the patch was solved
 * against is no longer the stored one (`stale_proposal`).
 *
 * ── The guard is the stronger one, and it is the write's own ─────
 *
 * `replaceStoredPlanIfBaseMatches`, not `replaceStoredPlan`: a patch is a
 * claim about a particular plan state, and a document carrying the expected
 * generation with a different `inputDigest` is not that state. The
 * `pendingProposalOf` check below decides whether to *offer* the accept; it
 * decides nothing about whether the write may land, because between that read
 * and the write a concurrent regeneration can move the document. Both numbers
 * are therefore re-compared inside the transaction, and a refusal writes
 * nothing at all.
 *
 * ── What the accepted document says ──────────────────────────────
 *
 * The auto-apply branch of `continuousReplanService` is the precedent and this
 * matches it: the generation advances, `replaces` records the one it
 * supersedes, `inputDigest` carries over (the inputs did not change — the
 * placement did), `causeChangeIds` becomes the patch's own, and `proposal`
 * goes back to null.
 *
 * Two deliberate departures. The first is that **moves are dropped and
 * removals are kept**. The two halves of `PlanEdits` are not the same kind of
 * statement: a move is an interval, validated against the placement it was
 * made on, and layering it over a plan that has just been rescheduled would
 * apply an interval nothing has checked — `effectiveSchedule` would happily
 * overlap it with something. A removal is a bare item id. It needs no
 * placement to be valid and nothing about a reschedule makes it stale, and
 * discarding it would put work back on the user's day that they took off it —
 * silently, because the diff is computed against the *un-edited* stored plan,
 * so a removed item shows as `unchanged` and the patch they approved never
 * named it.
 *
 * The second is that `acceptedAt` is carried over untouched rather than
 * stamped: accepting a *patch* says something about the schedule, not about
 * whether the person has accepted their day, and inventing an `acceptedAt`
 * would invent a fact the activity ledger reads. `status` is carried over for
 * the same reason, with one tidy: a plan whose only edits were moves is no
 * longer edited once they are dropped, so `'edited'` would disagree with the
 * DTO's own `edited: false`. It falls back to what it must have been before
 * the edit — `'accepted'` if there is an `acceptedAt`, `'proposed'` if not.
 */
export async function acceptPlanProposal(
  uid: string,
  date: string,
  options: PlanActionOptions = {},
): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  const current = await readStoredPlan(uid, date, options.storage);
  if (!current) return null;

  const proposal = pendingProposalOf(current);
  if (!proposal) {
    throw new PlanProposalRejected(
      current.proposal ? 'stale_proposal' : 'no_proposal',
      current.proposal
        ? 'the proposed change describes a plan that has since moved on'
        : 'there is no proposed change to accept for this plan',
    );
  }

  const generation = current.generation + 1;
  // The moves go, the removals stay. See the header above.
  const edits: PlanEdits = { moves: [], removals: current.edits.removals };
  const status: DailyPlanStatus = current.status === 'edited' && edits.removals.length === 0
    ? (current.acceptedAt === null ? 'proposed' : 'accepted')
    : current.status;
  const document: StoredDailyPlan = {
    ...current,
    generation,
    replaces: { generation: current.generation, inputDigest: current.inputDigest },
    plan: proposal.plan,
    blocks: blocksForAcceptedProposal(current.blocks ?? [], proposal.plan, generation),
    edits,
    status,
    updatedAt: at,
    causeChangeIds: proposal.causeChangeIds,
    proposal: null,
  };

  const stored = await replaceStoredPlanIfBaseMatches(
    uid,
    document,
    { generation: proposal.baseGeneration, inputDigest: proposal.baseInputDigest },
    options.storage,
  );
  if (!stored) {
    throw new PlanProposalRejected(
      'stale_proposal',
      'the plan changed while the proposed change was being accepted',
    );
  }

  // `plan_regenerated` and not a sixth ledger type: the fact recorded is that
  // the plan in force was replaced by a new generation, which is what
  // `applyIncrementalPlanPatch` records for the same kind of write. A new
  // member of `PlanEventType` would also need a decision in
  // `lib/services/activity/planActivity.ts`, which is not this slice's to make.
  await appendPlanEvent(uid, {
    type: 'plan_regenerated',
    date,
    at,
    generation: stored.generation,
    inputDigest: stored.inputDigest,
    ...(proposal.causeChangeIds.length > 0 ? { causeChangeIds: proposal.causeChangeIds } : {}),
  }, options.storage);
  return stored;
}

/**
 * Declines the proposed patch: the offer goes, the plan stays.
 *
 * Nothing but `proposal` and `updatedAt` changes — not the generation, not the
 * digest, not the placement, not the status. "No thanks" is not a decision
 * about the day; it is a decision about the offer.
 *
 * A stale proposal is cleared too rather than refused. It is already withheld
 * from every reader, so the only thing left to do with it is stop storing it,
 * and a rejection that failed because the orphan was *too* dead would be a
 * dead end for a client with nothing else to press.
 */
export async function rejectPlanProposal(
  uid: string,
  date: string,
  options: PlanActionOptions = {},
): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  let rejection: PlanProposalRejected | null = null;

  const outcome = await mutateStoredPlan<null>(uid, date, (current) => {
    if ((current.proposal ?? null) === null) {
      rejection = new PlanProposalRejected('no_proposal', 'there is no proposed change to reject for this plan');
      return null;
    }
    return { next: { ...current, proposal: null, updatedAt: at }, result: null };
  }, options.storage);

  if (rejection) throw rejection;
  return outcome?.stored ?? null;
}

export type RegenerateOutcome =
  | { readonly ok: true; readonly stored: StoredDailyPlan }
  | { readonly ok: false; readonly reason: 'not_found' | 'limit_reached' | 'raced' };

/**
 * Rebuilds today's plan from what the commitments say now.
 *
 * Capped at `MAX_PLAN_GENERATIONS_PER_DAY` documents for the day — the morning
 * build plus `MAX_PLAN_REBUILDS_PER_DAY` rebuilds. The cap is read from the
 * stored `generation` rather than from a counter of its own, so it cannot
 * drift away from the number of plans that were actually built.
 *
 * **Known cost, not fixed here:** the model is called by `composeDailyPlan`
 * before the compare-and-set below, so two devices asking at once spend two
 * Gemini calls and one of them is thrown away with a 409. Making that impossible
 * means claiming the generation before composing, which leaves a burnt
 * generation behind every failed compose — a worse trade for a race between two
 * of one person's own devices. Recorded on #194 rather than silently accepted.
 */
export async function regeneratePlan(
  uid: string,
  date: string,
  deps: DailyPlanDeps & PlanActionOptions = {},
): Promise<RegenerateOutcome> {
  const current = await readStoredPlan(uid, date, deps.storage);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.generation >= MAX_PLAN_GENERATIONS_PER_DAY) return { ok: false, reason: 'limit_reached' };

  const rebuilt = await composeDailyPlan(uid, date, { timezone: current.timezone }, current.generation + 1, deps, {
    previousGeneration: current.generation,
    previousInputDigest: current.inputDigest,
    // `?? []` for documents written before blocks existed (#521): the new
    // generation's blocks are derived from the new plan either way, and only
    // the provenance carry-forward has nothing to read.
    previousBlocks: current.blocks ?? [],
  });
  const stored = await replaceStoredPlan(uid, rebuilt, current.generation, deps.storage);
  if (!stored) return { ok: false, reason: 'raced' };

  await appendPlanEvent(uid, {
    type: 'plan_regenerated', date, at: stored.generatedAt, generation: stored.generation, inputDigest: stored.inputDigest,
  }, deps.storage);
  return { ok: true, stored };
}

/** Re-runs the scheduler on a stored request. Used by tests to prove replay. */
export function replayStoredPlan(stored: StoredDailyPlan): Plan {
  return schedulePlan(stored.constraints, stored.config);
}
