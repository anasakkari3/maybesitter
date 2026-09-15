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
 */
import {
  mergeIntervals,
  normalizeWorkingWindows,
} from '../../planning/constraints';
import { intervalsOverlap, toEpochMs } from '../../planning/shared/time';
import type { Plan, PlannedItem, TimeInterval } from '../../../src/contracts/v1/planningContracts';
import type { StorageAdapter } from '../../storage';
import { schedulePlan } from '../../planning/scheduler';
import {
  appendPlanEvent,
  mutateStoredPlan,
  readStoredPlan,
  replaceStoredPlan,
  type PlanEdits,
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
    next: { ...current, status: 'accepted', acceptedAt: at, updatedAt: at },
    result: null,
  }), options.storage);
  if (!outcome) return null;
  await appendPlanEvent(uid, {
    type: 'plan_accepted', date, at, generation: outcome.stored.generation, inputDigest: outcome.stored.inputDigest,
  }, options.storage);
  return outcome.stored;
}

export async function dismissPlan(uid: string, date: string, options: PlanActionOptions = {}): Promise<StoredDailyPlan | null> {
  const at = clockOf(options).toISOString();
  const outcome = await mutateStoredPlan<null>(uid, date, (current) => ({
    next: { ...current, status: 'dismissed', updatedAt: at },
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
      return { next: { ...current, status: 'edited', edits, updatedAt: at }, result: null };
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

  const rebuilt = await composeDailyPlan(uid, date, { timezone: current.timezone }, current.generation + 1, deps);
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
