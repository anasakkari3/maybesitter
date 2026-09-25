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
import { replanExplanation } from './replanMetadata';
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
import { applyEditsToBlocks, protectionAfterMove, protectionOf, schedulePlan } from '../../planning/scheduler';
import { planIncrementalPatch } from '../../planning/incremental/freezeResolve';
import { randomUUID } from 'node:crypto';
import {
  MAX_REJECTED_PROPOSALS,
  appendPlanEvent,
  mutateStoredPlan,
  pendingProposalOf,
  preparePlanEvent,
  proposalFingerprint,
  proposalHasExpired,
  readStoredPlan,
  type StoredPlanProposal,
  replaceStoredPlan,
  type DailyPlanStatus,
  type PlanEdits,
  type PlanEvent,
  type PlanMove,
  type StoredDailyPlan,
} from './planStore';
import { MAX_PLAN_GENERATIONS_PER_DAY } from './planSettings';
import { readBusyBlocksForPlanning } from '../../calendar/busyBlocks';
import { buildDailyPlanInput, dayHorizon } from './buildDailyPlan';
import { loadDomainState } from '../mobile/participantState';
import type { Commitment } from '../../../src/domain/stateMachine';
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
      return [{
        ...block,
        currentInterval: interval,
        lastPlacedBy: 'planner' as const,
        lastPlanGeneration: generation,
        // Explicitly re-anchored, not carried through. #522's rule is that a
        // successful user move becomes the new preferred placement
        // (`applyEditsToBlocks` calls this for a drag), and accepting a patch
        // is a deliberate user act with the same standing — the person was
        // shown the move and said yes. Carrying the old preference through
        // would leave the block asserting it prefers an hour it no longer
        // occupies, a state `withinMaxShift` rejects, and
        // `projectBlockProtectionIntoPlanningConstraints` would then pull the
        // item back on the next regeneration and silently undo the approval.
        protection: protectionAfterMove(block.protection, interval),
      }];
    }
    if (unplaced.has(block.source.id)) return [{ ...block, currentInterval: null }];
    return [];
  });
}

/**
 * What a person's edits and status become when a new placement is installed
 * under them (#523, #610).
 *
 * One rule, for both writers that do it: accepting a proposed patch
 * (`acceptPlanProposal`) and continuous replanning's auto-apply. The reasons
 * are in `acceptPlanProposal`'s header. In short, a move is an interval checked
 * against the placement it was made on, so it is dropped rather than laid over
 * one nothing has checked it against. A removal is a bare item id and is kept.
 * The status is carried over, except that a plan whose only edits were moves
 * falls back to what it was before the edit.
 */
export function editsSurvivingReschedule(current: StoredDailyPlan): { edits: PlanEdits; status: DailyPlanStatus } {
  const edits: PlanEdits = { moves: [], removals: current.edits.removals };
  const status: DailyPlanStatus = current.status === 'edited' && edits.removals.length === 0
    ? (current.acceptedAt === null ? 'proposed' : 'accepted')
    : current.status;
  return { edits, status };
}

/**
 * A plan as it will read once installed under a person's kept removals: the
 * visible day a patch or a replan produces (#610).
 *
 * The companion of `editsSurvivingReschedule`. The planner is never told about
 * removals, so it may place a removed item again. The removal is kept, so
 * the item stays off the day, and every reader of the new placement has to
 * agree on that: the replan's diff, the proposal the client is shown, and
 * the blocks the install writes. Moves need no counterpart here, because
 * they are dropped and the planner's placement stands.
 */
export function planUnderKeptRemovals(plan: Plan, removals: readonly string[]): Plan {
  if (removals.length === 0) return plan;
  const removed = new Set(removals);
  return {
    ...plan,
    scheduled: plan.scheduled.filter((item) => !removed.has(item.itemId)),
    unscheduled: plan.unscheduled.filter((item) => !removed.has(item.itemId)),
  };
}

/**
 * Installs the proposed patch as the plan (#523's user-control layer).
 *
 * Returns null when there is no plan for the date — 404, the same as every
 * other action here. Throws `PlanProposalRejected` when there is a plan but no
 * patch to act on (`no_proposal`), and when the state the patch was solved
 * against is no longer the stored one (`stale_proposal`).
 *
 * Since the #611 guards `stale_proposal` also covers three more cases, each
 * refused without writing anything and without recording a rejection: the
 * offer's day is over (`proposalHasExpired`); a meeting or a pinned
 * commitment now sits on one of its placements (`offerCollidesWithFixedTime`,
 * the council's compare-and-set against the calendar); and the caller named an
 * offer that a newer one has replaced (`proposalId`).
 *
 * ── The guard is the stronger one, and it is the write's own ─────
 *
 * The whole acceptance happens inside `mutateStoredPlan`'s transaction: the
 * proposal is re-checked there, and **the replacement document is built from
 * the transaction's own `current`**, never from a read taken before it.
 *
 * A compare-and-set over a document assembled outside the transaction is not
 * enough here, and the reason is the premise this file's header states: none
 * of `acceptPlan`, `dismissPlan`, `editPlan` or `setBlockProtection` moves
 * `generation` or `inputDigest`. So an edit landing between an outside read
 * and the write passes *any* `(generation, inputDigest)` guard untouched and
 * is then overwritten with pre-read values — the user's removal destroyed,
 * their `status` reverted, and the patch installed on a plan that had just
 * been edited under it, which is precisely the orphan this slice exists to
 * make impossible. A guard that only sees the two numbers nothing moves is a
 * guard that cannot see the dangerous case.
 *
 * Re-running `pendingProposalOf` inside the transaction subsumes that CAS
 * rather than weakening it: it compares the patch's base against the document
 * the transaction actually read — generation *and* `inputDigest`, the
 * stronger pair — and it additionally catches the mutators, because every one
 * of them clears `proposal` and a cleared field is `no_proposal`. A refusal
 * writes nothing at all: `mutateStoredPlan`'s mutator returns null.
 *
 * ── What the accepted document says ──────────────────────────────
 *
 * The auto-apply branch of `continuousReplanService` is the precedent and this
 * matches it: the generation advances, `replaces` records the one it
 * supersedes, the exact solve inputs and digest replace the old metadata,
 * a deterministic explanation describes the new day, `causeChangeIds`
 * becomes the patch's own, and `proposal`
 * goes back to null.
 *
 * Two further rules, which the auto-apply branch now follows too (#610) via
 * `editsSurvivingReschedule`. The first is that **moves are dropped and
 * removals are kept**. The two halves of `PlanEdits` are not the same kind of
 * statement: a move is an interval, validated against the placement it was
 * made on, and layering it over a plan that has just been rescheduled would
 * apply an interval nothing has checked — `effectiveSchedule` would happily
 * overlap it with something. A removal is a bare item id. It needs no
 * placement to be valid and nothing about a reschedule makes it stale, and
 * discarding it would put work back on the user's day that they took off it —
 * silently, because the patch they approved never named it. (Since #610 the
 * diff is computed on the visible day with the removals applied on both
 * sides, so a removed item is absent from it altogether.)
 *
 * The second is that `acceptedAt` is carried over untouched rather than
 * stamped: accepting a *patch* says something about the schedule, not about
 * whether the person has accepted their day, and inventing an `acceptedAt`
 * would invent a fact the activity ledger reads. `status` is carried over for
 * the same reason, with one tidy: a plan whose only edits were moves is no
 * longer edited once they are dropped, so `'edited'` would disagree with the
 * DTO's own `edited: false`. It falls back to what it must have been before
 * the edit — `'accepted'` if there is an `acceptedAt`, `'proposed'` if not.
 *
 * ── What the ledger says (#587) ──────────────────────────────────
 *
 * Two entries, committed in the same transaction as the document:
 *
 *  - `plan_regenerated` for the generation the patch installs, exactly as
 *    before. It is the system-level fact that the plan in force changed, and
 *    every reader of the generation chain reads it: #527's history turns its
 *    `causeChangeIds` into the "replan applied" row, and it is the one entry
 *    per generation that `applyIncrementalPlanPatch`, auto-apply and a
 *    rebuild all write. Dropping it here would leave a gap in that chain
 *    for exactly the generations a person approved.
 *  - `plan_proposal_accepted`, the person's decision: the proposal's id, its
 *    base, and its causes, so the Trust surface can say "you accepted a
 *    change caused by X". It is the one of the two the activity feed shows
 *    (`planActivity.ts`), and #527's history does not read it, so neither
 *    surface counts the acceptance twice.
 */
export interface ProposalAnswerOptions extends PlanActionOptions {
  /**
   * The offer the person was shown, when the client names it (#611 guards).
   *
   * A newer proposal replaces an unanswered one (supersede, don't stack), so
   * the offer in the document when the tap arrives may not be the offer that
   * was on screen. Named, a different one is refused as `stale_proposal`:
   * never installed unseen, and never remembered as declined when the person
   * never saw it. Optional: a client that does not send it answers whatever is
   * pending, as before.
   */
  readonly proposalId?: string;
}

/** One blocking interval of the day as the planner would read it now. */
export interface FixedTimeInForce {
  readonly interval: TimeInterval;
  /** The pinned commitment it comes from; null for calendar busy time. */
  readonly sourceCommitmentId: string | null;
}

/**
 * The time the planner would treat as taken on this plan's day, now (#611
 * guards, the council's "compare-and-set on accept").
 *
 * Through the planner's own fixed-time projection, `buildDailyPlanInput`'s
 * `fixedEvents`: calendar busy blocks (`readBusyBlocksForPlanning`, with the
 * all-day rule) and pinned commitments (`scheduled_event`, `postponedUntil`,
 * anything else `fixedStartOf` pins, with `fixedEndFor`'s length). Only that
 * projection is run, not the whole request builder: the routine, the focus
 * hint and the plan-layer projection shape where floating work may go, and
 * none of them adds taken time.
 *
 * `commitments` may be passed by a caller that has already loaded them.
 */
export async function fixedTimeInForce(
  uid: string,
  stored: Pick<StoredDailyPlan, 'date' | 'timezone'>,
  now: string,
  deps: { readonly storage?: StorageAdapter; readonly commitments?: readonly Commitment[] } = {},
): Promise<FixedTimeInForce[]> {
  const storage = deps.storage ?? getStorage();
  const commitments = deps.commitments ?? Object.values((await loadDomainState(storage, uid)).commitments);
  const busyBlocks = await readBusyBlocksForPlanning(uid, dayHorizon(stored.date, stored.timezone), { storage });
  const { constraints } = buildDailyPlanInput({
    uid,
    date: stored.date,
    timezone: stored.timezone,
    commitments,
    busyBlocks,
    profile: null,
    focusHint: null,
    builtAt: now,
  });
  return constraints.fixedEvents
    .filter((event) => event.blocking)
    .map((event) => ({ interval: event.interval, sourceCommitmentId: event.sourceCommitmentId }));
}

/**
 * The same, for a reader that only needs it when there is a live offer to
 * check: nothing is read otherwise.
 */
export async function fixedTimeForOffer(
  uid: string,
  stored: StoredDailyPlan,
  now: Date,
  deps: { readonly storage?: StorageAdapter; readonly commitments?: readonly Commitment[] } = {},
): Promise<FixedTimeInForce[]> {
  const proposal = pendingProposalOf(stored, now);
  if (proposal === null) return [];
  return fixedTimeInForce(uid, {
    ...stored,
    timezone: proposal.solveInputs?.constraints.timezone ?? stored.timezone,
  }, now.toISOString(), deps);
}

/**
 * Whether any placement of the offer sits on time taken now (#611 guards).
 *
 * The offer was solved against the day as it stood then; a meeting or a pinned
 * commitment that has landed on one of its placements since would put two
 * things in one slot if it were accepted. So the offer's day, as accepting it
 * installs it (the person's removals kept off it), is checked against
 * `fixedTimeInForce`. Reserved intervals, as the impact evaluator compares
 * them. An item never collides with its own pin.
 *
 * A collision, not a fingerprint: a meeting added elsewhere in the day moves
 * nothing the offer does, and refusing it over that would leave the person a
 * button that cannot be pressed until the next tick.
 *
 * `acceptPlanProposal` refuses on it, and `pendingProposalToDto` withholds the
 * offer on it: one answer to "can this still be accepted", in both places.
 */
export function offerCollidesWithFixedTime(
  stored: Pick<StoredDailyPlan, 'edits'>,
  proposal: StoredPlanProposal,
  fixed: readonly FixedTimeInForce[],
): boolean {
  return scheduleCollidesWithFixedTime(planUnderKeptRemovals(proposal.plan, stored.edits.removals).scheduled, fixed);
}

/**
 * Whether any of these placements sits on time taken now: the one collision
 * rule behind accepting an offer, showing it, and (#611 guards, round 3)
 * withdrawing it, which asks it of the visible day. Reserved intervals, as the
 * impact evaluator compares them; an item never collides with its own pin.
 */
export function scheduleCollidesWithFixedTime(
  items: readonly PlannedItem[],
  fixed: readonly FixedTimeInForce[],
): boolean {
  if (fixed.length === 0) return false;
  return items.some((item) => fixed.some((taken) =>
    taken.sourceCommitmentId !== item.itemId && intervalsOverlap(item.reservedInterval, taken.interval)));
}

export async function acceptPlanProposal(
  uid: string,
  date: string,
  options: ProposalAnswerOptions = {},
): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  let rejection: PlanProposalRejected | null = null;
  // Minted outside the transaction, so a retried body writes the same rows.
  const regeneratedId = randomUUID();
  const decisionId = randomUUID();

  /**
   * The time taken now, read before the transaction because the mutator
   * is synchronous. Both orderings are then safe. A meeting written before
   * this read is seen and refuses the patch. One written after it is ordered
   * after the acceptance: its change row is judged by the next tick against
   * the generation this installs, where it overlaps a scheduled task and earns
   * a proposal of its own. The drain cannot skip it, because the acceptance
   * moves the generation and `acknowledgeIfPlanUnchanged` holds any change
   * judged against the plan it replaced.
   */
  const before = await readStoredPlan(uid, date, options.storage);
  const offeredTimezone = before ? pendingProposalOf(before, at)?.solveInputs?.constraints.timezone : undefined;
  const checkedTimezone = offeredTimezone ?? before?.timezone;
  const taken = before ? await fixedTimeInForce(uid, { ...before, timezone: checkedTimezone! }, at, { storage: options.storage }) : [];

  const outcome = await mutateStoredPlan<null>(uid, date, (current) => {
    // Re-read inside the transaction, and everything below is derived from
    // *this* `current`. See the header: a document assembled from an earlier
    // read clobbers whatever landed in between.
    const proposal = pendingProposalOf(current, at);
    if (!proposal) {
      // Recorded rather than thrown, for the reason `editPlan` records its
      // refusal: throwing out of a transaction body is retried by the adapter,
      // and a deterministic refusal does not become true on the second go.
      rejection = new PlanProposalRejected(
        current.proposal ? 'stale_proposal' : 'no_proposal',
        current.proposal
          ? 'the proposed change describes a plan that has since moved on'
          : 'there is no proposed change to accept for this plan',
      );
      return null;
    }
    if (options.proposalId !== undefined && options.proposalId !== proposal.proposalId) {
      rejection = new PlanProposalRejected('stale_proposal', 'a newer proposed change has replaced the one being accepted');
      return null;
    }
    /**
     * Refused and left in place, not dropped. The meeting that caused this
     * has a change row the next tick judges against the patch and re-solves
     * (`overlaps_proposed_block`), so the offer is replaced by one that
     * accounts for it. Clearing it here would lose the conflicts the patch was
     * solving too: their change rows were drained when it was stored.
     */
    // A same-ID offer can refresh its solve snapshot while the busy-time
    // read runs. Never install a different zone using the old zone's horizon.
    if (proposal.solveInputs && proposal.solveInputs.constraints.timezone !== checkedTimezone) {
      rejection = new PlanProposalRejected('stale_proposal', 'the proposed solve zone changed during acceptance');
      return null;
    }
    if (offerCollidesWithFixedTime(current, proposal, taken)) {
      rejection = new PlanProposalRejected('stale_proposal', 'the day has changed under the proposed times');
      return null;
    }
    if (!proposal.solveInputs) {
      // An old offer cannot prove which inputs produced its reviewed times.
      // Leave it intact: declining it or manually regenerating the day remains
      // available. A later solve may refresh it, but no new tick is promised
      // when its original change rows have already been drained.
      rejection = new PlanProposalRejected('stale_proposal', 'the proposed change needs a new solve snapshot');
      return null;
    }
    rejection = null;

    const generation = current.generation + 1;
    // The moves go, the removals stay. See the header above.
    const { edits, status } = editsSurvivingReschedule(current);
    const causeChangeIds = proposal.causeChangeIds;
    const causes = causeChangeIds.length > 0 ? { causeChangeIds: [...causeChangeIds] } : {};
    return {
      next: {
        ...current,
        generation,
        replaces: { generation: current.generation, inputDigest: current.inputDigest },
        plan: proposal.plan,
        constraints: proposal.solveInputs.constraints,
        config: proposal.solveInputs.config,
        incrementalSolve: proposal.solveInputs.incrementalSolve ?? null,
        timezone: proposal.solveInputs.constraints.timezone,
        inputDigest: proposal.plan.inputDigest,
        explanation: replanExplanation(planUnderKeptRemovals(proposal.plan, edits.removals), { ...current, timezone: proposal.solveInputs.constraints.timezone }),
        // The kept removals are mirrored onto the blocks the way the edit
        // path and auto-apply mirror them (#610). Without that, a removed item
        // the patch placed again would carry that placement on its block,
        // and a protected one would be anchored by the next solve.
        blocks: applyEditsToBlocks(
          blocksForAcceptedProposal(current.blocks ?? [], proposal.plan, generation),
          proposal.plan.scheduled,
          edits,
          generation,
        ),
        edits,
        status,
        updatedAt: at,
        causeChangeIds: proposal.causeChangeIds,
        proposal: null,
      },
      result: null,
      // Both in this commit. See "What the ledger says" above.
      ledger: [
        preparePlanEvent(uid, {
          type: 'plan_regenerated',
          date,
          at,
          generation,
          inputDigest: proposal.plan.inputDigest,
          ...causes,
        }, regeneratedId),
        preparePlanEvent(uid, {
          type: 'plan_proposal_accepted',
          date,
          at,
          generation: proposal.baseGeneration,
          inputDigest: proposal.baseInputDigest,
          proposalId: proposal.proposalId,
          ...causes,
        }, decisionId),
      ],
    };
  }, options.storage);

  if (rejection) throw rejection;
  // Not a refusal — the mutator only returns null with `rejection` set — so
  // this is the date having no plan at all, which is the 404 every other
  // action here answers.
  if (!outcome) return null;
  return outcome.stored;
}

/**
 * Declines the proposed patch: the offer goes, the plan stays.
 *
 * Nothing about the plan in force changes — not the generation, not the
 * digest, not the placement, not the status. "No thanks" is not a decision
 * about the day; it is a decision about the offer. What does change is
 * `proposal`, `updatedAt`, and the memory of the answer (#587).
 *
 * A stale proposal is cleared too rather than refused. It is already withheld
 * from every reader, so the only thing left to do with it is stop storing it,
 * and a rejection that failed because the orphan was *too* dead would be a
 * dead end for a client with nothing else to press.
 *
 * ── The answer is remembered (#587) ──────────────────────────────
 *
 * Two things commit with the cleared offer. A `plan_proposal_rejected` ledger
 * entry records the decision as the person's, with the proposal's id, base,
 * causes and placement fingerprint. And the plan document remembers the
 * declined placement in `rejectedProposals`, which the replan tick reads before
 * it stores a patch (`proposalWasRejected`). Before this, a rejection left no
 * trace at all, and the next change row about the same meeting solved to the
 * same placement and offered it again.
 *
 * Only a live proposal is remembered. A stale one describes a state that is no
 * longer in force, so no future patch can have its base, and remembering it
 * would only take a slot. Its rejection is still recorded in the ledger: the
 * person did press the button.
 */
export async function rejectPlanProposal(
  uid: string,
  date: string,
  options: ProposalAnswerOptions = {},
): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  let rejection: PlanProposalRejected | null = null;
  // Minted outside the transaction, so a retried body writes the same row.
  const decisionId = randomUUID();

  const outcome = await mutateStoredPlan<null>(uid, date, (current) => {
    const proposal = current.proposal ?? null;
    // An offer whose day is over is not an offer (#611 guards): no reader
    // shows it, so there is nothing for the person to be declining. It is
    // refused like an absent one and nothing is written, least of all a
    // rejection, because expiry is not an answer.
    if (proposal === null || proposalHasExpired(current, at)) {
      rejection = new PlanProposalRejected('no_proposal', 'there is no proposed change to reject for this plan');
      return null;
    }
    // The person declined the offer they were shown (#611 guards). If a newer
    // one has replaced it, nothing is written: the newer one was never seen,
    // so it must not be remembered as declined, and the one that was seen is
    // already gone.
    if (options.proposalId !== undefined && options.proposalId !== proposal.proposalId) {
      rejection = new PlanProposalRejected('stale_proposal', 'a newer proposed change has replaced the one being declined');
      return null;
    }
    rejection = null;
    const fingerprint = proposalFingerprint(proposal.plan);
    const live = pendingProposalOf(current, at) !== null;
    // Entries for an older generation can never match again, so they are
    // dropped here rather than carried forever.
    const remembered = (current.rejectedProposals ?? []).filter((mark) => mark.baseGeneration === current.generation);
    const rejectedProposals = live
      ? [...remembered, {
        baseGeneration: proposal.baseGeneration,
        baseInputDigest: proposal.baseInputDigest,
        fingerprint,
      }].slice(-MAX_REJECTED_PROPOSALS)
      : remembered;
    return {
      next: { ...current, proposal: null, updatedAt: at, rejectedProposals },
      result: null,
      ledger: [preparePlanEvent(uid, {
        type: 'plan_proposal_rejected',
        date,
        at,
        generation: proposal.baseGeneration,
        inputDigest: proposal.baseInputDigest,
        proposalId: proposal.proposalId,
        proposalFingerprint: fingerprint,
        ...(proposal.causeChangeIds.length > 0 ? { causeChangeIds: [...proposal.causeChangeIds] } : {}),
      }, decisionId)],
    };
  }, options.storage);

  if (rejection) throw rejection;
  return outcome?.stored ?? null;
}

/**
 * The generations of this day the person (or a replan they could answer)
 * produced: every generation except the ones the automatic refresh of a
 * stale, untouched plan wrote (`planRefresh.ts`). The rebuild cap counts
 * these, so a refresh nobody asked for never costs a rebuild.
 */
export function userGenerationsOf(stored: Pick<StoredDailyPlan, 'generation' | 'automaticGenerations'>): number {
  return stored.generation - (stored.automaticGenerations ?? 0);
}

/** Rebuilds still available today, as the cap in `regeneratePlan` counts them. */
export function rebuildsLeftOf(stored: Pick<StoredDailyPlan, 'generation' | 'automaticGenerations'>): number {
  return Math.max(0, MAX_PLAN_GENERATIONS_PER_DAY - userGenerationsOf(stored));
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
 * drift away from the number of plans that were actually built — less the
 * generations the automatic refresh wrote (`userGenerationsOf`), which the
 * person never asked for.
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
  if (rebuildsLeftOf(current) === 0) return { ok: false, reason: 'limit_reached' };

  const composed = await composeDailyPlan(uid, date, { timezone: current.timezone }, current.generation + 1, deps, {
    previousGeneration: current.generation,
    previousInputDigest: current.inputDigest,
    // `?? []` for documents written before blocks existed (#521): the new
    // generation's blocks are derived from the new plan either way, and only
    // the provenance carry-forward has nothing to read.
    previousBlocks: current.blocks ?? [],
  });
  // The refreshes already written today stay uncounted after a rebuild, or
  // the rebuild would charge the person for them retroactively.
  const rebuilt: StoredDailyPlan = current.automaticGenerations
    ? { ...composed, automaticGenerations: current.automaticGenerations }
    : composed;
  const stored = await replaceStoredPlan(uid, rebuilt, current.generation, deps.storage);
  if (!stored) return { ok: false, reason: 'raced' };

  await appendPlanEvent(uid, {
    type: 'plan_regenerated', date, at: stored.generatedAt, generation: stored.generation, inputDigest: stored.inputDigest,
  }, deps.storage);
  return { ok: true, stored };
}

/** Re-runs the exact solver path recorded with a proposal. */
export function replayPlanSolveInputs(inputs: NonNullable<StoredPlanProposal['solveInputs']>): Plan {
  const incremental = inputs.incrementalSolve ?? null;
  if (incremental === null) return schedulePlan(inputs.constraints, inputs.config);
  return planIncrementalPatch({
    basePlan: incremental.basePlan,
    baseBlocks: incremental.baseBlocks,
    closure: incremental.closure,
    nextConstraints: inputs.constraints,
    config: inputs.config,
    baseGeneration: incremental.baseGeneration,
    resultGeneration: incremental.resultGeneration,
    causeChangeIds: incremental.causeChangeIds,
  }).plan;
}

/** Re-runs the solver path that produced a stored generation. */
export function replayStoredPlan(stored: StoredDailyPlan): Plan {
  return replayPlanSolveInputs({
    constraints: stored.constraints,
    config: stored.config,
    incrementalSolve: stored.incrementalSolve ?? null,
  });
}
