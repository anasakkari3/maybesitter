/**
 * Continuous replanning service (#523, slice 2).
 *
 * Consumes normalized `PlanningStateChange` records (written e.g. by watchers or
 * external events) and executes continuous replanning against the user's active
 * daily plan using the continuous replanning pipeline:
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
  planPath,
  proposalWasRejected,
  readStoredPlan,
  type StoredDailyPlan,
  type StoredPlanProposal,
} from './planStore';
import { editsSurvivingReschedule, effectiveSchedule, planUnderKeptRemovals } from './planActions';
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
import { composeCurrentUserState, type CurrentUserState } from '../../userState/userStateService';
import { executeContinuousReplanPipeline } from '../../planning/replan';
import { resolveChangedEntityFacts, type EntityFactsByChangeId } from './changedEntityFacts';
import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';
import type { Plan, PlannedItem } from '../../../src/contracts/v1/planningContracts';
import { ownershipOf } from '../../../src/contracts/v1/scheduleBlockContracts';
import { toEpochMs } from '../../planning/shared/time';
import type {
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
    && isDeepStrictEqual(current.blocks ?? [], solved.blocks ?? []);
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
   * What does *not* read it is the stored document's own `constraints` field:
   * the auto-apply branch builds its document with `...current`, so that
   * field still describes the generation being replaced. That predates #585
   * and is left to its own issue rather than changed here.
   */
  const { constraints, config } = await composeDailyPlanRequest({
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
  // plan as the person sees it now.
  const removals = storedPlan?.edits.removals ?? [];
  const planner = () => {
    const plan = schedulePlan(constraints, config);
    return basePlan ? { plan, diff: diffPlans(basePlan, planUnderKeptRemovals(plan, removals)) } : { plan };
  };

  // 5. Run continuous replan pipeline
  const pipelineResult = executeContinuousReplanPipeline({
    changes: rawChanges,
    planView,
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

  // 6. Act on policy decision
  if (pipelineResult.policyDecision?.action === 'auto_apply' && storedPlan && pipelineResult.newPlan) {
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
    const causeChangeIds = pipelineResult.impactingChangeIds;
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
    const proposal: StoredPlanProposal | null = pipelineResult.newPlan && pipelineResult.policyDecision.diff
      ? {
        proposalId: randomUUID(),
        proposedAt: nowIso,
        baseGeneration: storedPlan.generation,
        baseInputDigest: storedPlan.inputDigest,
        plan: pipelineResult.newPlan,
        diff: pipelineResult.policyDecision.diff,
        reason: pipelineResult.policyDecision.reason,
        userControlMode: pipelineResult.policyDecision.userControlMode,
        // Narrowed exactly as the auto-apply branch narrows it: the batch's
        // other changes did not cause this offer.
        causeChangeIds: pipelineResult.impactingChangeIds,
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
    const stored = proposal
      ? await mutateStoredPlan<null>(uid, date, (current) => {
        alreadyRejected = false;
        if (!stillTheStateSolvedAgainst(current, storedPlan)) return null;
        if (proposalWasRejected(current, proposal)) {
          alreadyRejected = true;
          return null;
        }
        return { next: { ...current, proposal, updatedAt: nowIso }, result: null };
      }, storage)
      : null;
    if (stored) {
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
    } else if (proposal && !alreadyRejected) {
      lostToConcurrentWrite = true;
    }
  }

  // 7. Acknowledge/delete processed planning state changes (#610, AC 5).
  // A stored outcome drains. A refused write holds (`lostToConcurrentWrite`).
  // A verdict that stored nothing drains only if the plan it was judged
  // against is still in force (`acknowledgeIfPlanUnchanged`).
  if (planStored) {
    await acknowledgeChanges(uid, storage, changeDocPaths, options.changes);
  } else if (!lostToConcurrentWrite) {
    await acknowledgeIfPlanUnchanged(uid, date, storage, storedPlan, changeRowPaths(uid, changeDocPaths, options.changes));
  }

  // 8. Compose updated UserStateProjection
  const userState = await composeCurrentUserState(
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
        status: pipelineResult.planStatus,
        planId: storedPlan ? date : null,
        updatedAt: nowIso,
      },
    },
    { storage, userDocument: user },
  );

  return {
    uid,
    date,
    changesProcessed: rawChanges.length,
    pipelineResult,
    planStored,
    userState,
    skipped: null,
  };
}

export interface ContinuousReplanTickTotals {
  examined: number;
  replanRequired: number;
  autoApplied: number;
  proposed: number;
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

      if (report.pipelineResult.policyDecision?.action === 'auto_apply') {
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
