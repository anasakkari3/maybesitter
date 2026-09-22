/**
 * Burst coalescing for planning state changes (#523, slice 1).
 *
 * One provider refresh fans out into several notifications that all describe
 * the same resulting state; the issue's requirement is that five such
 * notifications produce one replan decision, not five. This module is the
 * whole mechanism, and it is logic only: it returns groups, and the pipeline
 * follow-up decides what a group enqueues. Nothing here stores, schedules or
 * calls anything.
 *
 * ── Two distinct rules, because they dedupe different things ───────
 *
 *  1. **Same `changeId` → same delivery.** A redelivered change is the same
 *     change, whenever it arrives — the issue's "duplicate events are
 *     idempotent" criterion. No window applies; an id is an identity.
 *  2. **Same `(scopeId, entityId, afterDigest)` within the window → one
 *     burst.** Distinct notifications describing one entity reaching one
 *     state are one underlying event — the five calendar sync notifications
 *     of one provider refresh. The digest is what makes "one underlying
 *     event" checkable: two notifications with different `afterDigest`s
 *     observed different resulting states, and coalescing them would discard
 *     a real transition.
 *
 * The window is anchored at each group's **first** change. Anchoring at the
 * latest would let a steady drip of notifications chain-coalesce forever,
 * and the issue says "bounded".
 *
 * ── Determinism ────────────────────────────────────────────────────
 *
 * Input order cannot affect the output: changes are sorted by
 * `(occurredAt, changeId)` before grouping, and groups are emitted in the
 * order of their first change. The representative is the group's latest
 * change — the one carrying the newest declared state — chosen by the same
 * sort, never by arrival order. No clock is read; `occurredAt` values are
 * compared against each other.
 */

import {
  REPLAN_BURST_WINDOW_MS,
  type CoalescedStateChange,
} from '../../../src/contracts/v1/replanContracts';
import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';
import { toEpochMs, toInstant } from '../shared/time';

export interface CoalesceOptions {
  /** The bounded window a burst coalesces within. Defaults to `REPLAN_BURST_WINDOW_MS`. */
  readonly windowMs?: number;
}

function burstKey(change: PlanningStateChange): string {
  return `${change.scopeId}${change.entityId}${change.afterDigest}`;
}

function byOccurrence(left: PlanningStateChange, right: PlanningStateChange): number {
  const delta = toEpochMs(left.occurredAt) - toEpochMs(right.occurredAt);
  return delta !== 0 ? delta : left.changeId.localeCompare(right.changeId);
}

interface OpenGroup {
  representative: PlanningStateChange;
  changeIds: string[];
  firstEpochMs: number;
  lastEpochMs: number;
}

function closeGroup(group: OpenGroup): CoalescedStateChange {
  return Object.freeze({
    representative: group.representative,
    coalescedCount: group.changeIds.length,
    changeIds: Object.freeze(group.changeIds.slice()),
    firstOccurredAt: toInstant(group.firstEpochMs),
    lastOccurredAt: toInstant(group.lastEpochMs),
  });
}

/**
 * Deduplicate and coalesce a batch of changes into the groups a pipeline
 * evaluates once each.
 *
 * Throws on a malformed `windowMs` rather than coalescing with a NaN — a NaN
 * comparison is `false` in both directions, which would silently coalesce
 * nothing or everything depending on where it landed, and both failures look
 * like data.
 */
export function coalescePlanningStateChanges(
  changes: readonly PlanningStateChange[],
  options: CoalesceOptions = {},
): readonly CoalescedStateChange[] {
  const windowMs = options.windowMs ?? REPLAN_BURST_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new TypeError(`windowMs must be a non-negative finite number, received ${JSON.stringify(windowMs)}`);
  }

  // Rule 1: same changeId is the same delivery, whenever it arrives.
  const seen = new Set<string>();
  const distinct: PlanningStateChange[] = [];
  for (const change of changes) {
    if (seen.has(change.changeId)) continue;
    seen.add(change.changeId);
    distinct.push(change);
  }

  const ordered = distinct.slice().sort(byOccurrence);

  // Rule 2: one open group per burst key; a change joins the open group only
  // inside the window anchored at the group's first change.
  const open = new Map<string, OpenGroup>();
  const closed: OpenGroup[] = [];
  for (const change of ordered) {
    const key = burstKey(change);
    const occurredMs = toEpochMs(change.occurredAt);
    const group = open.get(key);
    if (group !== undefined && occurredMs - group.firstEpochMs <= windowMs) {
      group.representative = change;
      group.changeIds.push(change.changeId);
      group.lastEpochMs = occurredMs;
      continue;
    }
    if (group !== undefined) closed.push(group);
    open.set(key, {
      representative: change,
      changeIds: [change.changeId],
      firstEpochMs: occurredMs,
      lastEpochMs: occurredMs,
    });
  }

  const groups = closed.concat(Array.from(open.values()));
  // Deterministic emission order: by first change, then representative id.
  groups.sort((left, right) => {
    const delta = left.firstEpochMs - right.firstEpochMs;
    return delta !== 0 ? delta : left.representative.changeId.localeCompare(right.representative.changeId);
  });
  return Object.freeze(groups.map(closeGroup));
}
