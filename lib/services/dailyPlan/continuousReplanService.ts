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
 *  - Idempotency & Concurrency: When auto-applying, uses `replaceStoredPlan`
 *    with expected generation to ensure the plan has not been edited or replaced
 *    underfoot.
 *  - User State: Reuses `UserStateProjection` from `userStateProjectionContracts.ts`
 *    and `composeCurrentUserState`. Does not create a second user state model.
 *  - Canonical writes: Proposes time changes or updates plan proposals; never
 *    mutates canonical `Commitment` records directly.
 */

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
  readStoredPlan,
  replaceStoredPlan,
  storePlanProposal,
  type StoredDailyPlan,
  type StoredPlanProposal,
} from './planStore';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DELIVERY_LOCAL_TIME, DEFAULT_PLAN_ENABLED, localDateOf, planSettingsOf } from './planSettings';
import { DEFAULT_MOBILE_TIMEZONE } from '../mobile/time';
import { buildDailyPlanInput, dailyPlanScheduleSources } from './buildDailyPlan';
import { reconcileScheduleBlocks, schedulePlan } from '../../planning/scheduler';
import { readBusyBlocksForPlanning } from '../../calendar/busyBlocks';
import { loadDomainState } from '../mobile/participantState';
import { readRoutineProfile } from '../mobile/routineProfileService';
import { composeCurrentUserState, type CurrentUserState } from '../../userState/userStateService';
import { executeContinuousReplanPipeline } from '../../planning/replan';
import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';
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
  readonly entityFacts?: ChangedEntityFacts | null;
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
  readonly skipped: 'continuous_replan_disabled' | null;
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
  if (changeDocPaths.length > 0) {
    for (const docPath of changeDocPaths) {
      await storage.delete(docPath);
    }
    return;
  }
  if (!supplied) return;
  for (const change of supplied) {
    await storage.delete(userSubDoc(uid, PLANNING_STATE_CHANGES, docIdForKey(change.changeId)));
  }
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

  // 3. Build PlanImpactView from stored plan if available
  const planView: PlanImpactView | null = storedPlan
    ? {
        scopeId: uid,
        horizon: storedPlan.plan.horizon,
        scheduled: storedPlan.plan.scheduled,
      }
    : null;

  // 4. Pre-load commitments, busy blocks, and routine for planner invocation
  const domain = await loadDomainState(storage, uid);
  const routine = await readRoutineProfile(uid, { storage });
  const horizon = storedPlan?.plan.horizon ?? {
    startsAt: `${date}T00:00:00.000Z`,
    endsAt: `${date}T23:59:59.999Z`,
  };

  const busyBlocks = await readBusyBlocksForPlanning(uid, horizon, { storage });

  const inputArgs = {
    uid,
    date,
    timezone: settings.timezone,
    commitments: Object.values(domain.commitments),
    busyBlocks,
    profile: routine,
    builtAt: nowIso,
  };

  const dailyInput = buildDailyPlanInput(inputArgs);
  const sources = dailyPlanScheduleSources(dailyInput.constraints);

  // Planner solve closure
  const planner = () => {
    const plan = schedulePlan(dailyInput.constraints, dailyInput.config);
    return { plan };
  };

  // 5. Run continuous replan pipeline
  const pipelineResult = executeContinuousReplanPipeline({
    changes: rawChanges,
    planView,
    entityFacts: options.entityFacts ?? null,
    basePlan: storedPlan?.plan ?? null,
    planner,
    policyConfig: options.policyConfig,
    scopeId: uid,
    date,
    now: nowIso,
    baseGeneration: storedPlan?.generation,
  });

  let planStored = false;

  // 6. Act on policy decision
  if (pipelineResult.policyDecision?.action === 'auto_apply' && storedPlan && pipelineResult.newPlan) {
    const nextGeneration = storedPlan.generation + 1;
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
     * `...storedPlan`, so an omitted assignment would let this generation
     * inherit the previous generation's reason.
     */
    const causeChangeIds = pipelineResult.impactingChangeIds;
    const updatedPlan: StoredDailyPlan = {
      ...storedPlan,
      generation: nextGeneration,
      replaces: {
        generation: storedPlan.generation,
        inputDigest: storedPlan.inputDigest,
      },
      plan: pipelineResult.newPlan,
      blocks: reconcileScheduleBlocks({
        constraints: dailyInput.constraints,
        plan: pipelineResult.newPlan,
        generation: nextGeneration,
        sources,
        previous: storedPlan.blocks,
      }),
      status: 'accepted',
      updatedAt: nowIso,
      causeChangeIds,
      /**
       * Assigned, not omitted, for the reason `causeChangeIds` is: the
       * document is built with `...storedPlan`, so leaving the key out would
       * carry a patch of the *previous* generation into this one, where its
       * diff and its `baseGeneration` describe a plan that no longer exists.
       */
      proposal: null,
    };

    const replaced = await replaceStoredPlan(uid, updatedPlan, storedPlan.generation, storage);
    if (replaced !== null) {
      planStored = true;
      await appendPlanEvent(
        uid,
        {
          type: 'plan_regenerated',
          date,
          at: nowIso,
          generation: updatedPlan.generation,
          inputDigest: updatedPlan.inputDigest,
          causeChangeIds,
        },
        storage,
      );
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

    const stored = proposal ? await storePlanProposal(uid, date, proposal, storage) : null;
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
        },
        storage,
      );
    }
  }

  // 7. Acknowledge/delete processed planning state changes
  await acknowledgeChanges(uid, storage, changeDocPaths, options.changes);

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
  /** Accounts whose pending changes were drained without a replan (#523, AC 9). */
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
