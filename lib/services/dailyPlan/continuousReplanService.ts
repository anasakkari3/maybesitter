/**
 * Continuous replanning service (#523, slice 2).
 *
 * Consumes normalized `PlanningStateChange` records (written by watchers, and
 * by every busy-block write of a calendar sync since #611) and executes
 * continuous replanning against the user's active daily plan using the
 * continuous replanning pipeline:
 *
 * normalized state change → ImpactEvaluator → {NO_EFFECT | PLAN_STALE | REPLAN_REQUIRED}
 *   → deduped enqueue → canonical planner → PlanDiff → policy/user-control layer.
 *
 * ── Invariants ─────────────────────────────────────────────────────
 *
 *  - Idempotency & Concurrency (#610): both writes — the auto-applied
 *    generation and the proposed patch — are built inside one transaction from
 *    the document it reads, and are refused unless that document is still the
 *    state the run judged and solved against (`stillTheStateSolvedAgainst`).
 *    A generation-only compare-and-set is not enough: `editPlan`,
 *    `dismissPlan` and `setBlockProtection` never move the generation.
 *  - The person's day, not the planner's (#610): the impact view and the diff
 *    read the *visible* day, with the person's edits applied. A dismissed day
 *    is never replanned or patched, and a background run never changes a
 *    plan's status on the person's behalf.
 *  - A change is drained only when its outcome was decided and stored. A
 *    write refused because the plan moved underneath it leaves the change for
 *    the next tick, which judges it against whatever is in force by then.
 *  - User State: Reuses `UserStateProjection` from `userStateProjectionContracts.ts`
 *    and `composeCurrentUserState`. Does not create a second user state model.
 *  - Canonical writes: Proposes time changes or updates plan proposals; never
 *    mutates canonical `Commitment` records directly.
 */

import { replanExplanation } from './replanMetadata';
import { isDeepStrictEqual } from 'node:util';
import { getStorage, type StorageAdapter } from '../../storage';
import {
  PLANNING_STATE_CHANGES,
  docIdForKey,
  userCol,
  userDoc,
  userSubDoc,
} from '../../storage/paths';
import {
  appendPlanEvent,
  mutateStoredPlan,
  MAX_CAUSE_ENTITIES,
  MAX_CHANGE_IDS_PER_CAUSE,
  pendingProposalOf,
  planPath,
  proposalFingerprint,
  proposalWasRejected,
  readStoredPlan,
  type IncrementalSolveSnapshot,
  type ProposalCauseRef,
  type StoredDailyPlan,
  type StoredPlanProposal,
} from './planStore';
import {
  editsSurvivingReschedule,
  effectiveSchedule,
  fixedTimeInForce,
  planUnderKeptRemovals,
  scheduleCollidesWithFixedTime,
} from './planActions';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DELIVERY_LOCAL_TIME, DEFAULT_PLAN_ENABLED, localDateOf, planSettingsOf } from './planSettings';
import { DEFAULT_MOBILE_TIMEZONE } from '../mobile/time';
import { dailyPlanScheduleSources } from './buildDailyPlan';
import { composeDailyPlanRequest } from './dailyPlanService';
import {
  PROTECTED_OWNERSHIP,
  applyEditsToBlocks,
  diffPlans,
  reconcileScheduleBlocks,
  schedulePlan,
} from '../../planning/scheduler';
import { computeImpactClosure } from '../../planning/incremental/impactClosure';
import { planIncrementalPatch } from '../../planning/incremental/freezeResolve';
import { composeCurrentUserState, type CurrentUserState } from '../../userState/userStateService';
import { executeContinuousReplanPipeline } from '../../planning/replan';
import { resolveChangedEntityFacts, type EntityFactsByChangeId } from './changedEntityFacts';
import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';
import type {
  FixedEvent,
  Plan,
  PlannedItem,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  TimeInterval,
} from '../../../src/contracts/v1/planningContracts';
import type { IncrementalPatchMode } from '../../../src/contracts/v1/incrementalReplanContracts';
import { ownershipOf } from '../../../src/contracts/v1/scheduleBlockContracts';
import { intervalsOverlap, toEpochMs } from '../../planning/shared/time';
import { compareByCodePoint } from '../../planning/shared/compare';
import type {
  ChangedEntityFacts,
  ContinuousReplanPipelineResult,
  PlanImpactView,
  ReplanPolicyConfig,
} from '../../../src/contracts/v1/replanContracts';

export interface ContinuousReplanServiceOptions {
  readonly storage?: StorageAdapter;
  readonly now?: Date;
  readonly changes?: readonly PlanningStateChange[];
  /**
   * Post-change facts supplied by the caller, keyed by `changeId`, used instead
   * of resolving them from storage (#605). Without it, each change's facts are
   * read from the entity as stored now (`resolveChangedEntityFacts`), which is
   * what the scheduled tick relies on.
   */
  readonly entityFactsByChangeId?: EntityFactsByChangeId;
  readonly policyConfig?: Partial<ReplanPolicyConfig>;
  readonly date?: string;
}

export interface ContinuousReplanUserReport {
  readonly uid: string;
  readonly date: string;
  readonly changesProcessed: number;
  readonly pipelineResult: ContinuousReplanPipelineResult;
  readonly planStored: boolean;
  readonly userState: CurrentUserState | null;
  /**
   * Why nothing was planned, when nothing was (#523, AC 9).
   *
   * `null` on every run that reached the pipeline. The sweep counts this
   * rather than reading the setting a second time of its own: one decision,
   * made in one place, reported outward — a second read in
   * `runContinuousReplanTick` would be a copy of the gate that a mutation
   * could leave disagreeing with the original.
   */
  readonly skipped: 'continuous_replan_disabled' | 'plan_dismissed' | null;
  /**
   * What became of the offer (#611 guards): a new one stored (`offered`), the
   * one on the table kept because the re-solve landed on its placement
   * (`kept`), or the one on the table withdrawn (`withdrawn`). Null when the
   * run stored no offer and touched none.
   */
  readonly offerOutcome: 'offered' | 'kept' | 'withdrawn' | null;
  /** How the planner produced the candidate, or null when no solve ran. */
  readonly replanMode: IncrementalPatchMode | null;
}

interface IncrementalImpactInputs {
  readonly changedBlockIds: readonly string[];
  readonly changedFixedEvents: readonly FixedEvent[];
}

function itemWithoutPlanLayerAndClockFloor(
  item: PlanningItem,
): Omit<PlanningItem, 'protection' | 'earliestStartAt'> {
  const { protection: _protection, earliestStartAt: _clockFloor, ...rest } = item;
  return rest;
}

/** The fresh request differs only where the declared local causes allow it. */
function requestDeltaIsLocal(
  changes: readonly PlanningStateChange[],
  stored: StoredDailyPlan,
  next: PlanningConstraints,
  config: PlanningConfig,
): boolean {
  if (!isDeepStrictEqual(stored.config, config)) return false;
  const { items: oldItems, fixedEvents: oldEvents, ...oldFrame } = stored.constraints;
  const { items: nextItems, fixedEvents: nextEvents, ...nextFrame } = next;
  if (!isDeepStrictEqual(oldFrame, nextFrame)) return false;

  const commitmentIds = new Set(
    changes.filter((change) => change.source === 'commitment').map((change) => change.entityId),
  );
  const oldById = new Map(oldItems.map((item) => [item.itemId, item] as const));
  const nextById = new Map(nextItems.map((item) => [item.itemId, item] as const));
  const itemIds = new Set([...Array.from(oldById.keys()), ...Array.from(nextById.keys())]);
  for (const itemId of Array.from(itemIds)) {
    const before = oldById.get(itemId);
    const after = nextById.get(itemId);
    if (commitmentIds.has(itemId)) continue;
    if (!before || !after) return false;
    // Protection is plan-layer state projected at solve time. It is safe here:
    // an unaffected protected/user-owned block remains frozen, while an
    // impacted one is solved under the fresh protection constraint.
    // The clock floor is also safe to ignore for unaffected existing blocks:
    // they may have started already, while only the impacted set is being
    // placed again. Readiness buffers and every other item constraint remain
    // part of the comparison and force a full solve when they move globally.
    if (!isDeepStrictEqual(itemWithoutPlanLayerAndClockFloor(before), itemWithoutPlanLayerAndClockFloor(after))) return false;
  }

  const hasCalendarCause = changes.some((change) => change.source === 'calendar');
  return hasCalendarCause || isDeepStrictEqual(oldEvents, nextEvents);
}

/**
 * Translate the normalized causes into the incremental engine's deliberately
 * smaller vocabulary. Returning null is the safe, explicit full-replan path:
 * an unknown or broad source must never be mistaken for a local edit and then
 * frozen out of the solve.
 */
function incrementalImpactInputs(
  changes: readonly PlanningStateChange[],
  factsByChangeId: EntityFactsByChangeId,
  stored: StoredDailyPlan,
): IncrementalImpactInputs | null {
  const blocksBySource = new Map(stored.blocks.map((block) => [block.source.id, block] as const));
  const changedBlockIds = new Set<string>();
  const changedFixedEvents: FixedEvent[] = [];

  for (const change of changes) {
    if (change.source === 'commitment') {
      const block = blocksBySource.get(change.entityId);
      if (!block) return null;
      changedBlockIds.add(block.blockId);
      continue;
    }
    if (change.source === 'calendar') {
      const facts = factsByChangeId.get(change.changeId) ?? null;
      if (!facts?.blocking || facts.interval === null) return null;
      changedFixedEvents.push({
        eventId: `replan-change:${change.changeId}`,
        interval: facts.interval,
        sourceCommitmentId: null,
        blocking: true,
      });
      continue;
    }
    return null;
  }

  if (changedBlockIds.size === 0 && changedFixedEvents.length === 0) return null;
  return {
    changedBlockIds: Array.from(changedBlockIds).sort(compareByCodePoint),
    changedFixedEvents,
  };
}

/**
 * How often `runContinuousReplanTick` is scheduled to run, in minutes.
 *
 * Declared beside the sweep it describes and asserted against the crontab in
 * `infra/scheduler.sh`, the way `WATCHER_SWEEP_INTERVAL_MINUTES` is: the
 * cadence is a fact about production that otherwise lives only in a shell
 * script nobody edits together with this file.
 *
 * Five minutes, not one. Two reasons, and the second is the load-bearing one:
 *
 *  - `REPLAN_BURST_WINDOW_MS` is 60 seconds. A sweep that fires every minute
 *    would keep meeting bursts whose window has not closed yet and replan on
 *    the first notification of a provider refresh, then again on the rest —
 *    which is the coalescing the pipeline exists to do, undone by its own
 *    cadence.
 *  - A run is a full scan of `users` followed by a per-account read of
 *    `planningStateChanges`, so its cost is the size of the user base, not the
 *    size of the work. Unlike `daily-plan-tick`, it has no indexed "who is
 *    due" query to make the empty minute free.
 *
 * Nothing here is time-critical in the way a reminder is: the output is a
 * patch offered for review, or a shift of minutes inside a churn budget.
 */
export const CONTINUOUS_REPLAN_SWEEP_INTERVAL_MINUTES = 5;

function storageOf(storage?: StorageAdapter): StorageAdapter {
  return storage ?? getStorage();
}

/**
 * Drops the change rows this run consumed.
 *
 * Called on the disabled path too, and that is deliberate.
 * `planningStateChanges` is a work queue, not a ledger. Leaving rows behind
 * for an account that has switched replanning off does two things, and each
 * would be reason enough on its own: the collection grows for as long as the
 * switch stays off, and the moment the user switches back on becomes a replan
 * over every stale change accumulated since. Reading a change and deciding
 * not to act on it is still having read it.
 *
 * Draining costs the Trust surface nothing. `attributionsForArtifacts`
 * resolves a plan's `causeChangeIds` against `watcherEvents.effectRef`, not
 * against these rows, so a change id stored on a plan still names its monitor
 * after the row is gone — and the orphan count is unaffected in the other
 * direction too, since `watcherEngine` writes a firing and its change in one
 * transaction with `ref: changeId`, which means a watcher-sourced change row
 * is claimed the instant it exists and could never have been counted as an
 * orphan whether it is kept or dropped.
 */
async function acknowledgeChanges(
  uid: string,
  storage: StorageAdapter,
  changeDocPaths: readonly string[],
  supplied: readonly PlanningStateChange[] | undefined,
): Promise<void> {
  for (const docPath of changeRowPaths(uid, changeDocPaths, supplied)) {
    await storage.delete(docPath);
  }
}

/** The rows this run consumed: listed here, or named by the caller's changes. */
function changeRowPaths(
  uid: string,
  changeDocPaths: readonly string[],
  supplied: readonly PlanningStateChange[] | undefined,
): string[] {
  if (changeDocPaths.length > 0) return [...changeDocPaths];
  return (supplied ?? []).map((change) => userSubDoc(uid, PLANNING_STATE_CHANGES, docIdForKey(change.changeId)));
}

/**
 * Transactional writes are capped per commit (Firestore allows 500). The
 * re-check below needs only one read and one delete in the same commit to be
 * atomic, so the rows are drained in chunks under this size.
 */
const DRAIN_CHUNK = 400;

/**
 * Drains a verdict that stored nothing, but only if the plan it was judged
 * against is still the plan in force (#610, AC 5).
 *
 * `NO_EFFECT`, `PLAN_STALE` and a discarded replan write nothing, so no
 * compare-and-set ever tells them that the plan moved while they were
 * judging. Suppose a person accepts an older patch mid-run, and the patch puts
 * a task where the change's meeting now is. The change was judged `PLAN_STALE`
 * against the generation that was replaced, and draining it would leave the
 * conflict in the new generation with nothing left to fix it.
 *
 * So the plan is re-read, and the first chunk of rows is deleted, in one
 * transaction. If the plan is not the state the verdict read, nothing is
 * drained and the next tick re-judges the rows against whatever is in force.
 * Rows after the first chunk are deleted once that commit has shown the
 * verdict held. A plan that changes after that commit changes after the
 * judgement, which is the same case as a change arriving after the drain.
 *
 * Returns whether the rows were drained.
 */
async function acknowledgeIfPlanUnchanged(
  uid: string,
  date: string,
  storage: StorageAdapter,
  judgedAgainst: StoredDailyPlan | null,
  rows: readonly string[],
): Promise<boolean> {
  const [first, rest] = [rows.slice(0, DRAIN_CHUNK), rows.slice(DRAIN_CHUNK)];
  const drained = await storage.runTransaction(async (tx) => {
    const current = await tx.get<StoredDailyPlan>(planPath(uid, date));
    const unchanged = current === null || judgedAgainst === null
      ? current === judgedAgainst
      : stillTheStateSolvedAgainst(current, judgedAgainst);
    if (!unchanged) return false;
    for (const row of first) tx.delete(row);
    return true;
  });
  if (!drained) return false;
  for (const row of rest) await storage.delete(row);
  return true;
}

/**
 * The stored plan as the replan must read it: protected blocks where they sit
 * (#585).
 *
 * The solve reads a protection's anchor off the blocks, and a drag re-anchors
 * it there (`protectionAfterMove`) while `plan.scheduled` keeps the planner's
 * placement — the move itself lives in `edits`. Measured against
 * `plan.scheduled`, a replan that keeps a dragged protected block where the
 * person put it reports moving it there: the user's own drag is charged to the
 * churn budget, flips the policy to review, and is offered back to them as the
 * system's proposal. The impact evaluator has the mirror-image blind spot — a
 * meeting landing on the dragged hour would not overlap anything it can see.
 *
 * Protected blocks only. For them the anchor the solver honours, the block's
 * `currentInterval` and what the person sees are one placement by
 * construction. An unprotected drag is not an anchor — the solver is free to
 * place the item elsewhere, and whether a replan should respect such a drag at
 * all is a separate question this does not answer by the back door.
 *
 * The reserved interval travels with the effort, buffers intact.
 */
function planAsProtectionsHoldIt(stored: StoredDailyPlan): Plan {
  const held = new Map<string, { startsAt: string; endsAt: string }>();
  for (const block of stored.blocks ?? []) {
    if (ownershipOf(block) !== PROTECTED_OWNERSHIP || block.currentInterval === null) continue;
    held.set(block.source.id, block.currentInterval);
  }
  if (held.size === 0) return stored.plan;
  const at = (ms: number) => new Date(ms).toISOString();
  return {
    ...stored.plan,
    scheduled: stored.plan.scheduled.map((entry): PlannedItem => {
      const interval = held.get(entry.itemId);
      if (interval === undefined) return entry;
      const startMs = toEpochMs(interval.startsAt);
      const endMs = toEpochMs(interval.endsAt);
      if (startMs === toEpochMs(entry.interval.startsAt) && endMs === toEpochMs(entry.interval.endsAt)) return entry;
      const before = toEpochMs(entry.interval.startsAt) - toEpochMs(entry.reservedInterval.startsAt);
      const after = toEpochMs(entry.reservedInterval.endsAt) - toEpochMs(entry.interval.endsAt);
      return {
        itemId: entry.itemId,
        interval: { startsAt: at(startMs), endsAt: at(endMs) },
        reservedInterval: { startsAt: at(startMs - before), endsAt: at(endMs + after) },
      };
    }),
  };
}

/**
 * The day as the person sees it (#610): protected blocks where they sit, and
 * then the person's own edits, with removed items gone and moved items at the
 * slots they were moved to.
 *
 * Both the impact view and the diff base read this. Measured against
 * `plan.scheduled`, a meeting on the slot of a task the person removed
 * "overlaps" it and earns a replan whose `causeChangeIds` names the meeting
 * for a conflict nobody can see, while a meeting on a task they moved overlaps
 * nothing the evaluator can see and the task sits under it. The diff has the
 * same blind spot: replanning a moved task back off a meeting reads as
 * "unchanged" against the planner's placement, so the policy would discard
 * the very replan the impact view asked for, and a move dropped on install
 * (`editsSurvivingReschedule`) would be charged nothing against the churn
 * budget.
 */
function visiblePlanOf(stored: StoredDailyPlan): Plan {
  const held = planAsProtectionsHoldIt(stored);
  return { ...held, scheduled: effectiveSchedule({ ...stored, plan: held }) };
}

/**
 * The complete day the incremental engine freezes. User moves are positions
 * and must be retained; removals remain solver inputs and are filtered only
 * from the visible diff/install view, just as on the full-planner path.
 */
function incrementalBasePlanOf(stored: StoredDailyPlan): Plan {
  const held = planAsProtectionsHoldIt(stored);
  return {
    ...held,
    scheduled: effectiveSchedule({
      ...stored,
      plan: held,
      edits: { ...stored.edits, removals: [] },
    }),
  };
}

/**
 * Whether the stored document is still the state this run judged and solved
 * against (#610). Read inside the write's own transaction.
 *
 * Generation and digest alone cannot tell. `editPlan`, `dismissPlan`,
 * `acceptPlan` and `setBlockProtection` rewrite the document without moving
 * either, so a write guarded by them alone installs a solve over an edit it
 * never saw. A removal comes back onto the day, a dismissed plan is revived,
 * and a protection is dropped from blocks rebuilt from the old ones. So the
 * status, the edits and the blocks are compared too, since those are what the
 * impact view, the solve and the policy read. Anything else on the document is
 * carried from the transaction's own read, never from the snapshot.
 *
 * A refusal is not retried here. The change is left in place and the next
 * tick judges it against whatever is in force by then.
 */
function stillTheStateSolvedAgainst(current: StoredDailyPlan, solved: StoredDailyPlan): boolean {
  return current.generation === solved.generation
    && current.inputDigest === solved.inputDigest
    && current.status === solved.status
    && isDeepStrictEqual(current.edits, solved.edits)
    && isDeepStrictEqual(current.blocks ?? [], solved.blocks ?? [])
    && offerIdOf(current) === offerIdOf(solved);
}

/**
 * Which offer the document carries, by id (#611 guards).
 *
 * Part of the state a run judged against since the tick began judging each
 * change against the pending offer as well as the day: an offer accepted,
 * declined or replaced while the run was solving changes what the run's
 * verdict and its merged causes are about. The raw field, not
 * `pendingProposalOf`, because the question is whether the document moved,
 * not whether the offer is still live.
 */
function offerIdOf(stored: StoredDailyPlan): string | null {
  return stored.proposal?.proposalId ?? null;
}

/**
 * The causes a write names, and what each is about (#611 guards, #527).
 *
 *  1. **A run's own changes are causes only if they contradicted a
 *     placement.** With an offer pending, a stale verdict re-solves (see the
 *     pipeline's `pendingView`), and the rows behind it moved an input but
 *     overlapped nothing: an unrelated meeting at 16:00 did not cause the
 *     offer to move a task off 06:00. So `own` is the `REPLAN_REQUIRED` ids
 *     when an offer is pending, and the impacting ids as before otherwise.
 *  2. **A replaced offer's cause is carried only while it still blocks what
 *     the new placement moves** (`filterCarried`). Its entity is re-read now
 *     (`causeRefs`), and it survives if its blocking interval overlaps the
 *     path of an item that moves relative to the visible day: the item's
 *     visible placement, its new one, or the time between (an item left
 *     unplaced counts with its visible placement). A cancelled meeting, or
 *     one nothing moves across, is dropped. A kept offer, whose placement is
 *     unchanged, carries all of its causes (`filterCarried: false`).
 *  3. **An entity is named once across runs.** A later row about an entity a
 *     carried cause already names (a re-sync, a retry) adds nothing, so a
 *     meeting announced on every tick does not accumulate ids.
 *  4. **The cap is by entity** (`MAX_CAUSE_ENTITIES`, this run's new entities
 *     before carried ones), and of one entity's rows in one run only the
 *     first and the latest by `occurredAt` are named
 *     (`MAX_CHANGE_IDS_PER_CAUSE`). One meeting's burst cannot crowd another
 *     meeting out.
 *
 * A carried id with no ref (an offer stored before `causeRefs` existed)
 * cannot be re-read, so it is carried as it is, as its own entity.
 *
 * Attribution only. Whether an offer is withdrawn is decided on the facts of
 * the day, not on these (`dayCollidesNow` in `processStateChangesForUser`).
 */
function causesOf(args: {
  readonly pending: StoredPlanProposal | null;
  readonly own: readonly string[];
  readonly changesById: ReadonlyMap<string, PlanningStateChange>;
  readonly carriedFacts: EntityFactsByChangeId;
  readonly visible: Plan | null;
  readonly placed: Plan | null;
  readonly filterCarried: boolean;
}): { readonly changeIds: readonly string[]; readonly refs: readonly ProposalCauseRef[] } {
  const { pending, own, changesById, carriedFacts, visible, placed, filterCarried } = args;
  interface Entity { readonly key: string; ids: string[]; readonly refs: Map<string, ProposalCauseRef> }
  const entityOf = (list: Entity[], index: Map<string, Entity>, key: string): Entity => {
    let entity = index.get(key);
    if (entity === undefined) {
      entity = { key, ids: [], refs: new Map() };
      index.set(key, entity);
      list.push(entity);
    }
    return entity;
  };

  const carried: Entity[] = [];
  const carriedIndex = new Map<string, Entity>();
  if (pending !== null) {
    const refById = new Map((pending.causeRefs ?? []).map((ref) => [ref.changeId, ref] as const));
    const spans = visible && placed ? movedSpans(visible, placed) : [];
    for (const id of pending.causeChangeIds) {
      const ref = refById.get(id);
      if (ref === undefined) {
        entityOf(carried, carriedIndex, JSON.stringify(['id', id])).ids.push(id);
        continue;
      }
      if (filterCarried && !blocksAny(carriedFacts.get(id) ?? null, spans)) continue;
      const entity = entityOf(carried, carriedIndex, entityKey(ref));
      entity.ids.push(id);
      entity.refs.set(id, ref);
    }
  }

  const fresh: Entity[] = [];
  const freshIndex = new Map<string, Entity>();
  const byOccurrence = (left: string, right: string): number => {
    const delta = toEpochMs(changesById.get(left)!.occurredAt) - toEpochMs(changesById.get(right)!.occurredAt);
    return delta !== 0 ? delta : compareByCodePoint(left, right);
  };
  for (const id of own.filter((candidate) => changesById.has(candidate)).sort(byOccurrence)) {
    const change = changesById.get(id)!;
    const ref: ProposalCauseRef = { changeId: id, source: change.source, entityId: change.entityId };
    const key = entityKey(ref);
    if (carriedIndex.has(key)) continue;
    const entity = entityOf(fresh, freshIndex, key);
    entity.ids.push(id);
    entity.refs.set(id, ref);
  }
  for (const entity of fresh) {
    if (entity.ids.length > MAX_CHANGE_IDS_PER_CAUSE) entity.ids = [entity.ids[0]!, entity.ids[entity.ids.length - 1]!];
  }

  const named = [...fresh, ...carried].slice(0, MAX_CAUSE_ENTITIES);
  const changeIds = named.flatMap((entity) => entity.ids).sort(compareByCodePoint);
  const refs = new Map<string, ProposalCauseRef>();
  for (const entity of named) entity.refs.forEach((ref, id) => refs.set(id, ref));
  return { changeIds, refs: changeIds.flatMap((id) => (refs.has(id) ? [refs.get(id)!] : [])) };
}

function entityKey(ref: ProposalCauseRef): string {
  return JSON.stringify([ref.source, ref.entityId]);
}

/** Whether a cause's facts are blocking time that overlaps any of `spans`. */
function blocksAny(facts: ChangedEntityFacts | null, spans: readonly TimeInterval[]): boolean {
  const interval = facts?.blocking ? facts.interval : null;
  return interval !== null && spans.some((span) => intervalsOverlap(interval, span));
}

/**
 * The path each item travels between the visible day and a new placement: from
 * the earlier of its two reserved intervals' starts to the later end. An item
 * the new placement leaves unplaced counts with its visible placement. An item
 * that does not move has no path.
 */
function movedSpans(visible: Plan, placed: Plan): TimeInterval[] {
  const next = new Map(placed.scheduled.map((item) => [item.itemId, item.reservedInterval] as const));
  const at = (ms: number) => new Date(ms).toISOString();
  return visible.scheduled.flatMap((item) => {
    const from = item.reservedInterval;
    const to = next.get(item.itemId);
    if (to === undefined) return [from];
    const [fromStart, fromEnd, toStart, toEnd] = [from.startsAt, from.endsAt, to.startsAt, to.endsAt].map(toEpochMs);
    if (fromStart === toStart && fromEnd === toEnd) return [];
    return [{ startsAt: at(Math.min(fromStart!, toStart!)), endsAt: at(Math.max(fromEnd!, toEnd!)) }];
  });
}

/**
 * Process pending state changes for a user and apply continuous replanning.
 */
export async function processStateChangesForUser(
  uid: string,
  options: ContinuousReplanServiceOptions = {},
): Promise<ContinuousReplanUserReport> {
  const storage = storageOf(options.storage);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  // 1. Fetch pending changes if not supplied directly
  let rawChanges: PlanningStateChange[];
  let changeDocPaths: string[] = [];
  if (options.changes !== undefined) {
    rawChanges = options.changes.slice();
  } else {
    const listResult = await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES));
    rawChanges = listResult.map((row) => row.data);
    changeDocPaths = listResult.map((row) => `${userCol(uid, PLANNING_STATE_CHANGES)}/${row.id}`);
  }

  // 2. Read user settings and active plan
  const user = await storage.get<{ timezone?: string | null; locale?: string | null; planSettings?: any }>(userDoc(uid));
  const accountTimezone = user?.timezone ?? DEFAULT_MOBILE_TIMEZONE;
  const settings = planSettingsOf(user ?? null, accountTimezone);
  const date = options.date ?? localDateOf(nowIso, settings.timezone);

  const storedPlan = await readStoredPlan(uid, date, storage);

  // If no changes exist, return early with no effect
  if (rawChanges.length === 0) {
    const emptyResult: ContinuousReplanPipelineResult = {
      scopeId: uid,
      date,
      impact: {
        changeId: 'none',
        scopeId: uid,
        decision: 'NO_EFFECT',
        reason: 'digests_unchanged',
      },
      enqueued: false,
      queueEntry: null,
      impactingChangeIds: [],
      basePlan: storedPlan?.plan ?? null,
      newPlan: null,
      diff: null,
      policyDecision: null,
      planStatus: storedPlan ? 'accepted' : 'none',
    };

    return {
      uid,
      date,
      changesProcessed: 0,
      pipelineResult: emptyResult,
      planStored: false,
      userState: null,
      skipped: null,
      offerOutcome: null,
      replanMode: null,
    };
  }

  /**
   * The gate (#523, AC 9), and the only place it is read.
   *
   * Placed after the changes and the plan are known and before anything
   * expensive: no domain load, no busy-block read, no planner call, no policy
   * decision. `=== false` rather than `!settings.continuousReplanEnabled`
   * because `planSettingsOf` has already turned every absent, malformed or
   * legacy value into a boolean — so an `undefined` arriving here would mean
   * someone bypassed that function, and failing *open* is the safe direction
   * for a switch whose off position silences a shipped feature.
   *
   * Independence from provider sync is by construction: nothing below reads a
   * connection record, and nothing above writes one. A connected calendar
   * still syncs and still writes the `PlanningStateChange` rows this function
   * is looking at — which is exactly why they are drained anyway.
   */
  if (settings.continuousReplanEnabled === false) {
    await acknowledgeChanges(uid, storage, changeDocPaths, options.changes);
    return {
      uid,
      date,
      changesProcessed: rawChanges.length,
      pipelineResult: {
        scopeId: uid,
        date,
        impact: {
          /**
           * `'none'`, always — never `rawChanges[0]`.
           *
           * The pair `(changeId, reason)` is an audit record, and naming
           * whichever change the store happened to list first would assert
           * that *that* change was the one judged. Nothing here judged any of
           * them; the sentinel the empty-batch path already uses is the
           * honest answer, and it does not move when the list order does.
           */
          changeId: 'none',
          scopeId: uid,
          decision: 'NO_EFFECT',
          reason: 'continuous_replan_disabled',
        },
        enqueued: false,
        queueEntry: null,
        impactingChangeIds: [],
        basePlan: storedPlan?.plan ?? null,
        newPlan: null,
        diff: null,
        policyDecision: null,
        planStatus: storedPlan ? 'accepted' : 'none',
      },
      planStored: false,
      userState: null,
      skipped: 'continuous_replan_disabled',
      offerOutcome: null,
      replanMode: null,
    };
  }

  /**
   * A dismissed day is never replanned or patched (#610, AC 3).
   *
   * `dismissPlan` clears any pending patch on purpose, and a background run
   * that went on to solve would either revive the plan as a new generation or
   * store a fresh patch on a day the person has set aside. Checked here,
   * before anything expensive, and again inside each write's transaction for
   * a dismissal that lands while the run is solving.
   *
   * Unlike the switch above, the changes are **not** drained. Nothing was
   * decided about them. A dismissal can be taken back (`acceptPlan` accepts a
   * dismissed plan), and the change should then be replanned like any other.
   * Rows held past the day are harmless: tomorrow's tick judges them against
   * tomorrow's plan, where an interval from today is outside the horizon and
   * is drained as `NO_EFFECT`.
   */
  if (storedPlan?.status === 'dismissed') {
    return {
      uid,
      date,
      changesProcessed: rawChanges.length,
      pipelineResult: {
        scopeId: uid,
        date,
        // `'none'`, for the reason the switch's path gives: nothing was judged.
        impact: { changeId: 'none', scopeId: uid, decision: 'NO_EFFECT', reason: 'plan_dismissed' },
        enqueued: false,
        queueEntry: null,
        impactingChangeIds: [],
        basePlan: storedPlan.plan,
        newPlan: null,
        diff: null,
        policyDecision: null,
        // No plan is in force for a dismissed day.
        planStatus: 'none',
      },
      planStored: false,
      userState: null,
      skipped: 'plan_dismissed',
      offerOutcome: null,
      replanMode: null,
    };
  }

  /** The user-state projection a run reports, after its verdict. */
  const userStateAfter = (result: ContinuousReplanPipelineResult) => composeCurrentUserState(
    {
      uid,
      now: nowIso,
      plan: {
        meta: {
          source: 'plan',
          freshness: 'fresh',
          updatedAt: nowIso,
          inputDigest: storedPlan?.inputDigest ?? null,
        },
        status: result.planStatus,
        planId: storedPlan ? date : null,
        updatedAt: nowIso,
      },
    },
    { storage, userDocument: user },
  );

  /**
   * No plan for the day: nothing to replan, and nothing to read for it (#645
   * review). The evaluator answers `no_current_plan` for every change before
   * it looks at a fact (rule 3), so resolving each change's entity and
   * composing the day's planning request — the domain load, the busy-block
   * read, the plan-layer projection — bought nothing. Since #611 every
   * calendar-connected account has rows on most ticks, and most accounts on
   * most ticks have no plan for the day.
   *
   * The verdict is still the pipeline's own, with no facts and a planner that
   * must never run, so the report is the one the full path produced. The rows
   * drain exactly as a verdict that stored nothing drains: only if the day
   * still has no plan when the drain commits (`acknowledgeIfPlanUnchanged`).
   */
  if (storedPlan === null) {
    const pipelineResult = executeContinuousReplanPipeline({
      changes: rawChanges,
      planView: null,
      pendingView: null,
      entityFactsByChangeId: new Map(),
      basePlan: null,
      planner: () => {
        throw new Error('continuous replan: a day with no plan is never solved');
      },
      policyConfig: options.policyConfig,
      scopeId: uid,
      date,
      now: nowIso,
      baseGeneration: undefined,
    });
    await acknowledgeIfPlanUnchanged(uid, date, storage, null, changeRowPaths(uid, changeDocPaths, options.changes));
    return {
      uid,
      date,
      changesProcessed: rawChanges.length,
      pipelineResult,
      planStored: false,
      userState: await userStateAfter(pipelineResult),
      skipped: null,
      offerOutcome: null,
      replanMode: null,
    };
  }

  // 3. Build PlanImpactView from stored plan if available. Both the impact
  // view and the diff base read the visible day: protected blocks where they
  // sit and the person's edits applied (#585, #610).
  const basePlan = storedPlan ? visiblePlanOf(storedPlan) : null;
  const planView: PlanImpactView | null = basePlan
    ? {
        scopeId: uid,
        horizon: basePlan.horizon,
        scheduled: basePlan.scheduled,
      }
    : null;

  /**
   * The offer on the table, and the day accepting it would install (#611
   * guards). Every change is judged against both. A meeting landing where the
   * offer would put a task overlaps nothing on the visible day: judged against
   * that alone it was `PLAN_STALE`, was drained, and left the offer acceptable
   * with a task under the meeting. The pipeline now re-solves, and the result
   * replaces the offer, keeps it, or withdraws it (step 6).
   *
   * The offer's day is what `acceptPlanProposal` installs and the client is
   * shown (`pendingProposalToDto`): the solver's placement, with the person's
   * removals kept off it. An expired offer is no offer (`pendingProposalOf`).
   */
  const pending = storedPlan ? pendingProposalOf(storedPlan, now) : null;
  const pendingView: PlanImpactView | null = pending && storedPlan && basePlan
    ? {
        scopeId: uid,
        horizon: basePlan.horizon,
        scheduled: planUnderKeptRemovals(pending.plan, storedPlan.edits.removals).scheduled,
      }
    : null;

  /**
   * Each change's own post-change facts (#605). Read after the gate, since a
   * switched-off account never reaches the evaluator, and before anything
   * writes. A read that fails here fails the run while its change rows are
   * still in place, so the next tick retries them.
   */
  const entityFactsByChangeId = options.entityFactsByChangeId
    ?? await resolveChangedEntityFacts(uid, rawChanges, { storage });

  /**
   * 4. The request the morning build would have solved (#585, #606).
   * `composeDailyPlanRequest` is the function `composeDailyPlan` calls, so the
   * two solvers of a day read the same routine, the same kept focus window
   * behind the same consent gate, busy time over the same horizon, and cannot
   * disagree about what is protected or how much room a person needs between
   * items.
   *
   * This solve once assembled its own request. Without the plan-layer
   * projection it treated every protected hour as ordinary flexible work, and
   * the blocks reconciled below, built from items that carried no protection,
   * wrote the new generation with the protection gone (#585). Without the
   * focus hint it solved a user who kept a focus window inside 08:00–20:00
   * instead, and repacked their day on every replan (#606). The solve, the
   * schedule sources and the reconciliation below all read `constraints`, the
   * reconciliation because of #585.
   *
   * The installed generation and any review offer retain these exact inputs
   * too (#586), so edits and replay describe the placement actually solved.
   */
  const { commitments, constraints, config } = await composeDailyPlanRequest({
    uid,
    date,
    timezone: settings.timezone,
    now: nowIso,
    userDocument: user,
    previousBlocks: storedPlan?.blocks ?? null,
  }, { storage });
  const sources = dailyPlanScheduleSources(constraints);

  // Planner solve closure. The diff is visible day against visible day
  // (#610): the plan as it would read once installed, measured against the
  // plan as the person sees it now. A local cause goes through #524's
  // freeze/re-solve engine. Anything the normalized causes cannot map
  // completely takes the canonical full path. With an offer on the table, a
  // cause that contradicts only that offer does too: freezing against the
  // visible day cannot localize a placement that is not installed yet.
  const removals = storedPlan?.edits.removals ?? [];
  const incrementalBasePlan = incrementalBasePlanOf(storedPlan);
  let replanMode: IncrementalPatchMode | null = null;
  let incrementalSolve: IncrementalSolveSnapshot | null = null;
  let reusedPendingSolveInputs: StoredPlanProposal['solveInputs'] | null = null;
  const planner = (causeChangeIds: readonly string[]) => {
    const causes = new Set(causeChangeIds);
    const relevantChanges = rawChanges.filter((change) => causes.has(change.changeId));
    const incrementalInputs = requestDeltaIsLocal(relevantChanges, storedPlan, constraints, config)
      ? incrementalImpactInputs(relevantChanges, entityFactsByChangeId, storedPlan)
      : null;
    if (incrementalInputs !== null) {
      // A fresh local signal can hit the visible day while adding no conflict
      // to the offer already on the table (for example, a short call wholly
      // inside the meeting that caused the offer). Keep that exact, replayable
      // question instead of letting overlapping fixed events force a full
      // solve that churns unrelated work into a different offer.
      if (relevantChanges.every((change) => change.source === 'calendar')
        && pending?.solveInputs
        && !scheduleCollidesWithFixedTime(pending.plan.scheduled, constraints.fixedEvents)) {
        reusedPendingSolveInputs = pending.solveInputs;
        incrementalSolve = pending.solveInputs.incrementalSolve ?? null;
        replanMode = incrementalSolve === null ? 'full_fallback' : 'incremental';
        const plan = pending.plan;
        return { plan, diff: diffPlans(basePlan!, planUnderKeptRemovals(plan, removals)) };
      }
      const closure = computeImpactClosure({
        blocks: storedPlan.blocks,
        items: constraints.items,
        changedBlockIds: incrementalInputs.changedBlockIds,
        changedFixedEvents: incrementalInputs.changedFixedEvents,
        resourceDependenciesOrder: config.resourceDependenciesOrder,
      });
      // A cause that hits only the pending offer cannot be localized against
      // the day in force. Re-solving it incrementally would freeze the very
      // offered placement it invalidated out of sight.
      if (pending !== null && closure.impactedBlockIds.length === 0) {
        replanMode = 'full_fallback';
        incrementalSolve = null;
        const plan = schedulePlan(constraints, config);
        return { plan, diff: diffPlans(basePlan!, planUnderKeptRemovals(plan, removals)) };
      }
      const result = planIncrementalPatch({
        basePlan: incrementalBasePlan,
        baseBlocks: storedPlan.blocks,
        closure,
        nextConstraints: constraints,
        config,
        baseGeneration: storedPlan.generation,
        resultGeneration: storedPlan.generation + 1,
        causeChangeIds,
      });
      replanMode = result.patch.mode;
      incrementalSolve = {
        basePlan: incrementalBasePlan,
        baseBlocks: storedPlan.blocks,
        closure,
        baseGeneration: storedPlan.generation,
        resultGeneration: storedPlan.generation + 1,
        causeChangeIds: [...causeChangeIds],
      };
      const plan = result.plan;
      return { plan, diff: diffPlans(basePlan!, planUnderKeptRemovals(plan, removals)) };
    }
    replanMode = 'full_fallback';
    incrementalSolve = null;
    const plan = schedulePlan(constraints, config);
    return basePlan ? { plan, diff: diffPlans(basePlan, planUnderKeptRemovals(plan, removals)) } : { plan };
  };

  // 5. Run continuous replan pipeline
  const pipelineResult = executeContinuousReplanPipeline({
    changes: rawChanges,
    planView,
    pendingView,
    entityFactsByChangeId,
    basePlan,
    planner,
    policyConfig: options.policyConfig,
    scopeId: uid,
    date,
    now: nowIso,
    baseGeneration: storedPlan?.generation,
  });

  let planStored = false;
  /**
   * Set when a write was refused because the plan moved underneath the run
   * (#610, AC 5). The change is then left for the next tick rather than
   * drained. The write that won may be a full rebuild that already accounts
   * for it, or it may be an older patch solved before it existed, and nothing
   * here can tell which. The next tick can, because it judges the change
   * against whatever is in force by then.
   */
  let lostToConcurrentWrite = false;
  /**
   * The document the drain must still find for the verdict to hold. The plan
   * the run read, unless this run wrote an offer (stored, extended or
   * withdrawn): then the document it wrote, since the drain's re-check now
   * compares the offer too (`offerIdOf`) and would otherwise refuse the run's
   * own write as a concurrent one.
   */
  let drainBasis: StoredDailyPlan | null = storedPlan;
  let offerOutcome: ContinuousReplanUserReport['offerOutcome'] = null;

  /**
   * The offer's causes as they stand now, and this run's own (#611 guards).
   *
   * `ownCauses`: with an offer pending, only the changes whose verdict
   * contradicted a placement, on the day or on the offer. A stale verdict
   * re-solves while an offer is pending, and its rows caused nothing.
   * `carriedFacts`: each cause of the pending offer, re-read from the entity
   * it names, since its change row was drained when the offer was stored.
   */
  const ownCauses = pending === null || pipelineResult.impact.decision === 'REPLAN_REQUIRED'
    ? pipelineResult.impactingChangeIds
    : [];
  const changesById = new Map(rawChanges.map((change) => [change.changeId, change] as const));
  const carriedFacts: EntityFactsByChangeId = pending?.causeRefs && pending.causeRefs.length > 0
    ? await resolveChangedEntityFacts(uid, pending.causeRefs.map((ref) => ({ ...ref, scopeId: uid })), { storage })
    : new Map();
  const causesFor = (plan: Plan, filterCarried = true) => causesOf({
    pending,
    own: ownCauses,
    changesById,
    carriedFacts,
    visible: basePlan,
    placed: planUnderKeptRemovals(plan, removals),
    filterCarried,
  });

  /**
   * Whether the day in force still has a conflict (#611 guards, round 3).
   *
   * Decided on the facts, not on the offer's causes: the visible day against
   * the time taken now (`fixedTimeInForce`, by `scheduleCollidesWithFixedTime`,
   * the read and the rule accept and the plan GET use). While an offer is
   * pending, this is one read of the day's fixed time per run. The causes are
   * for attribution and can miss a conflict: a meeting that arrived while the
   * offer was kept, a row cut by a cap, busy time with no change row at all.
   * The facts cannot.
   */
  const dayCollidesNow = pending !== null && storedPlan !== null && basePlan !== null
    ? scheduleCollidesWithFixedTime(basePlan.scheduled, await fixedTimeInForce(uid, storedPlan, nowIso, { storage, commitments }))
    : true;
  const conflictGone = pending !== null && !dayCollidesNow;

  /**
   * Withdraws the pending offer (#611 guards), in the same guarded
   * transaction as every other write here, so an offer the person answered,
   * or one a concurrent run replaced, is left alone and the change waits for
   * the next tick.
   *
   * Not a rejection. `rejectedProposals` and the ledger are untouched: the
   * person said nothing, and a placement they never declined must stay
   * offerable if the meeting comes back.
   */
  const withdrawOffer = async (judged: StoredDailyPlan): Promise<void> => {
    const withdrawn = await mutateStoredPlan<null>(uid, date, (current) => {
      if (!stillTheStateSolvedAgainst(current, judged)) return null;
      return { next: { ...current, proposal: null, updatedAt: nowIso }, result: null };
    }, storage);
    if (withdrawn) {
      drainBasis = withdrawn.stored;
      offerOutcome = 'withdrawn';
    } else {
      lostToConcurrentWrite = true;
    }
  };

  // 6. Act on policy decision
  if (conflictGone && storedPlan) {
    /**
     * The day in force has no conflict left (`dayCollidesNow`): nothing on the
     * visible day sits on time taken now. The meeting was cancelled, say. So
     * the offer has nothing left to fix and is withdrawn, whatever a fresh
     * solve would say: after the day's first slot has started a solve always
     * moves something (#500), and an offer kept alive by that drift would go
     * on citing a deleted meeting. While any conflict remains it is never
     * withdrawn here.
     */
    await withdrawOffer(storedPlan);
  } else if (pipelineResult.policyDecision?.action === 'auto_apply' && storedPlan && pipelineResult.newPlan) {
    const newPlan = pipelineResult.newPlan;
    /**
     * Which changes caused this generation (#527, AC 2).
     *
     * `pipelineResult.impactingChangeIds`, not
     * `queueEntry.request.causeChangeIds`. The two differ, and the difference
     * is the whole point: the request's list is every change in the batch —
     * `new Set(changes.map(...))`, no narrowing by impact — because a request
     * records what one replan subsumes. Two watchers firing in one sweep are
     * one request even when only one of them touched the plan, so storing that
     * list would make the Trust surface name a monitor that did nothing.
     * `impactingChangeIds` is the members of the groups whose own impact
     * matched the decision that ran the planner.
     *
     * Assigned unconditionally below: the document is built with
     * `...current`, so an omitted assignment would let this generation
     * inherit the previous generation's reason.
     */
    // An offer this generation subsumes gives the causes it still has too
    // (#611 guards): its moves are part of what is being installed. See
    // `causesOf`. With no offer pending this is `impactingChangeIds`.
    const causeChangeIds = causesFor(newPlan).changeIds;
    /**
     * Built inside the write's own transaction, from the document it reads
     * (#610, AC 1), the way `acceptPlanProposal` builds its document. A
     * document assembled from the snapshot read before the solve would
     * overwrite anything that landed since with the snapshot's values, and
     * the generation-only compare-and-set this replaced could not see it.
     */
    const written = await mutateStoredPlan<null>(uid, date, (current) => {
      if (!stillTheStateSolvedAgainst(current, storedPlan)) return null;
      const generation = current.generation + 1;
      // Moves dropped, removals kept, status carried (#610, AC 2 and 3). This
      // is the rule accepting a patch follows, and the diff the policy just
      // judged was computed on exactly this outcome (`planUnderKeptRemovals`).
      const { edits, status } = editsSurvivingReschedule(current);
      const blocks = applyEditsToBlocks(
        reconcileScheduleBlocks({
          constraints,
          plan: newPlan,
          generation,
          sources,
          previous: current.blocks,
        }),
        newPlan.scheduled,
        edits,
        generation,
      );
      return {
        next: {
          ...current,
          generation,
          replaces: { generation: current.generation, inputDigest: current.inputDigest },
          plan: newPlan,
          constraints,
          config,
          incrementalSolve,
          timezone: constraints.timezone,
          inputDigest: newPlan.inputDigest,
          explanation: replanExplanation(planUnderKeptRemovals(newPlan, edits.removals), { ...current, timezone: constraints.timezone }),
          // Mirrors the kept removals, as an edit's blocks do: a removed item
          // the planner placed again stays unplaced on its block.
          blocks,
          edits,
          status,
          updatedAt: nowIso,
          causeChangeIds,
          /**
           * Assigned, not omitted, for the reason `causeChangeIds` is: the
           * document is built with `...current`, so leaving the key out would
           * carry a patch of the *previous* generation into this one, where
           * its diff and its `baseGeneration` describe a plan that no longer
           * exists.
           */
          proposal: null,
        },
        result: null,
      };
    }, storage);

    if (written !== null) {
      planStored = true;
      await appendPlanEvent(
        uid,
        {
          type: 'plan_regenerated',
          date,
          at: nowIso,
          generation: written.stored.generation,
          inputDigest: written.stored.inputDigest,
          causeChangeIds,
        },
        storage,
      );
    } else {
      lostToConcurrentWrite = true;
    }
  } else if (pipelineResult.policyDecision?.action === 'propose_for_review' && storedPlan) {
    /**
     * The default mode's actual output (#523, "detect automatically → propose
     * a schedule patch").
     *
     * The ledger entry alone was not a proposal: it recorded that one had been
     * made, carrying the *old* generation and digest, while the solved plan
     * and the diff went out of scope with the function. Nothing could review
     * a patch that was never written down. So the patch is stored first, on
     * the generation it patches, and the event is appended only when that
     * write won its compare-and-set — an event announcing a proposal that a
     * concurrent rebuild refused would be the same lie in the other direction.
     */
    const causes = pipelineResult.newPlan ? causesFor(pipelineResult.newPlan) : null;
    const proposal: StoredPlanProposal | null = pipelineResult.newPlan && pipelineResult.policyDecision.diff && causes
      ? {
        proposalId: randomUUID(),
        proposedAt: nowIso,
        baseGeneration: storedPlan.generation,
        baseInputDigest: storedPlan.inputDigest,
        plan: pipelineResult.newPlan,
        solveInputs: reusedPendingSolveInputs ?? { constraints, config, incrementalSolve },
        diff: pipelineResult.policyDecision.diff,
        reason: pipelineResult.policyDecision.reason,
        userControlMode: pipelineResult.policyDecision.userControlMode,
        // Narrowed exactly as the auto-apply branch narrows it: the batch's
        // other changes did not cause this offer. With an offer pending, it
        // also carries that offer's causes that still block what this one
        // moves (#611 guards, `causesOf`).
        causeChangeIds: causes.changeIds,
        causeRefs: causes.refs,
      }
      : null;

    /**
     * The same guard as the auto-apply write, in the same transaction (#610).
     * `storePlanProposal` pins a patch to the generation alone, so a patch
     * solved before a dismissal or an edit would be stored after it, on a day
     * the person set aside or over placements they have just overruled.
     * `status` is untouched: the plan in force is still the plan in force.
     *
     * A patch the person already declined is not offered again (#587). The
     * check reads `rejectedProposals` from this transaction's own document,
     * so a rejection that commits while this run was solving is seen. It is
     * a decision, not a lost race: the rows are drained below like any other
     * verdict that stored nothing, rather than held and re-solved to the same
     * declined patch on every tick.
     */
    let alreadyRejected = false;
    /**
     * Supersede, don't stack (#611 guards). There is one `proposal` field, so
     * a new offer always replaces the old one; what this adds is that an offer
     * re-solved to the placement already on the table is not minted again. A
     * re-delivered change row, or a bulk re-sync straddling two ticks, would
     * otherwise replace the offer with an identical one under a new id and
     * write a second `plan_proposed` for one question. The offer on the table
     * is kept: its id, its `proposedAt` and its ledger entry. Its causes grow
     * only by an entity this run found contradicting a placement that the offer
     * does not name yet (a call landing on a task the offer already moves). A
     * re-announced entity adds nothing. The matching solve snapshot is refreshed
     * without minting another offer, including for pre-#586 stored offers.
     */
    let sameOffer = false;
    const keptCauses = pending !== null && pipelineResult.newPlan ? causesFor(pipelineResult.newPlan, false) : null;
    const stored = proposal
      ? await mutateStoredPlan<null>(uid, date, (current) => {
        alreadyRejected = false;
        sameOffer = false;
        if (!stillTheStateSolvedAgainst(current, storedPlan)) return null;
        if (proposalWasRejected(current, proposal)) {
          alreadyRejected = true;
          return null;
        }
        // The guard above has required the document to carry `pending`'s id.
        if (pending !== null && proposalFingerprint(pending.plan) === proposalFingerprint(proposal.plan)) {
          sameOffer = true;
          const refreshed = {
            ...pending,
            plan: proposal.plan,
            solveInputs: proposal.solveInputs,
            causeChangeIds: keptCauses!.changeIds,
            causeRefs: keptCauses!.refs,
          };
          if (isDeepStrictEqual(refreshed, pending)) return null;
          return {
            next: {
              ...current,
              proposal: refreshed,
              updatedAt: nowIso,
            },
            result: null,
          };
        }
        return { next: { ...current, proposal, updatedAt: nowIso }, result: null };
      }, storage)
      : null;
    if (stored) drainBasis = stored.stored;
    if (sameOffer) {
      // Kept, with any newly named cause written above: no new id, no
      // second `plan_proposed`.
      offerOutcome = 'kept';
    } else if (stored) {
      offerOutcome = 'offered';
      await appendPlanEvent(
        uid,
        {
          type: 'plan_proposed',
          date,
          at: nowIso,
          generation: storedPlan.generation,
          inputDigest: storedPlan.inputDigest,
          causeChangeIds: proposal!.causeChangeIds,
          proposalId: proposal!.proposalId,
        },
        storage,
      );
    } else if (proposal && !alreadyRejected && !sameOffer) {
      lostToConcurrentWrite = true;
    }
  } else if (pipelineResult.policyDecision?.action === 'discard' && storedPlan && pending) {
    // The re-solve says the visible day needs no change at all, so the offer
    // beside it is withdrawn too. This is the only way an offer stored before
    // `causeRefs` existed is withdrawn.
    await withdrawOffer(storedPlan);
  }

  // 7. Acknowledge/delete processed planning state changes (#610, AC 5).
  // A stored outcome drains. A refused write holds (`lostToConcurrentWrite`).
  // A verdict that stored nothing drains only if the plan it was judged
  // against is still in force (`acknowledgeIfPlanUnchanged`).
  if (planStored) {
    await acknowledgeChanges(uid, storage, changeDocPaths, options.changes);
  } else if (!lostToConcurrentWrite) {
    await acknowledgeIfPlanUnchanged(uid, date, storage, drainBasis, changeRowPaths(uid, changeDocPaths, options.changes));
  }

  // 8. Compose updated UserStateProjection
  const userState = await userStateAfter(pipelineResult);

  return {
    uid,
    date,
    changesProcessed: rawChanges.length,
    pipelineResult,
    planStored,
    userState,
    skipped: null,
    offerOutcome,
    replanMode,
  };
}

export interface ContinuousReplanTickTotals {
  examined: number;
  replanRequired: number;
  autoApplied: number;
  /** A new offer was decided on (stored, or refused as already declined or lost to a race). */
  proposed: number;
  /**
   * The re-solve landed on the placement already on offer, and it was kept
   * as it is (#611 guards). Counted apart from `proposed`: no new question
   * was asked.
   */
  kept: number;
  /** The offer on the table was withdrawn: its conflict is gone (#611 guards). */
  withdrawn: number;
  stale: number;
  noEffect: number;
  failed: number;
  /**
   * Accounts the run stopped for before judging anything: continuous
   * replanning switched off (#523, AC 9), where the changes are drained, or a
   * dismissed day (#610), where they are held for the day to come back.
   */
  skipped: number;
}

export interface ContinuousReplanTickOptions {
  storage?: StorageAdapter;
  now?: Date;
  limit?: number;
  /**
   * A control mode chosen in code, for tests of the automatic modes only.
   *
   * No production caller passes it: the scheduled route calls
   * `runContinuousReplanTick()` bare, and nothing reads a mode from storage,
   * so every account is solved under `CONTINUOUS_REPLAN_POLICY`'s default,
   * `always_require_confirmation` (#611's council decision). The automatic
   * modes stay in code and tested for a future opt-in, which is why this seam
   * exists; `tests/dailyPlan/replanProposalGuards.test.ts` pins that nothing
   * outside tests uses it.
   */
  policyConfig?: Partial<ReplanPolicyConfig>;
}

/**
 * Background tick for continuous replanning across accounts with pending state changes.
 */
export async function runContinuousReplanTick(
  options: ContinuousReplanTickOptions = {},
): Promise<ContinuousReplanTickTotals> {
  const storage = storageOf(options.storage);
  const now = options.now ?? new Date();

  const totals: ContinuousReplanTickTotals = {
    examined: 0,
    replanRequired: 0,
    autoApplied: 0,
    proposed: 0,
    kept: 0,
    withdrawn: 0,
    stale: 0,
    noEffect: 0,
    failed: 0,
    skipped: 0,
  };

  // Find users who have planningStateChanges
  const users = await storage.list<{ id?: string }>('users');
  for (const userRow of users) {
    const uid = userRow.id;
    const pendingChanges = await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES));
    if (pendingChanges.length === 0) continue;

    totals.examined += 1;
    try {
      const report = await processStateChangesForUser(uid, {
        storage,
        now,
        changes: pendingChanges.map((r) => r.data),
        ...(options.policyConfig ? { policyConfig: options.policyConfig } : {}),
      });

      // The sweep does not re-read the setting; it reports the decision the
      // one gate made. See `ContinuousReplanUserReport.skipped`.
      if (report.skipped !== null) {
        totals.skipped += 1;
        if (options.limit && totals.examined >= options.limit) break;
        continue;
      }

      if (report.pipelineResult.impact.decision === 'REPLAN_REQUIRED') {
        totals.replanRequired += 1;
      } else if (report.pipelineResult.impact.decision === 'PLAN_STALE') {
        totals.stale += 1;
      } else {
        totals.noEffect += 1;
      }

      if (report.offerOutcome === 'withdrawn') {
        totals.withdrawn += 1;
      } else if (report.offerOutcome === 'kept') {
        totals.kept += 1;
      } else if (report.pipelineResult.policyDecision?.action === 'auto_apply') {
        totals.autoApplied += 1;
      } else if (report.pipelineResult.policyDecision?.action === 'propose_for_review') {
        totals.proposed += 1;
      }
    } catch {
      totals.failed += 1;
    }

    if (options.limit && totals.examined >= options.limit) break;
  }

  return totals;
}
