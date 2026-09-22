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
  type StoredDailyPlan,
} from './planStore';
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
}

function storageOf(storage?: StorageAdapter): StorageAdapter {
  return storage ?? getStorage();
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
        },
        storage,
      );
    }
  } else if (pipelineResult.policyDecision?.action === 'propose_for_review' && storedPlan) {
    await appendPlanEvent(
      uid,
      {
        type: 'plan_proposed',
        date,
        at: nowIso,
        generation: storedPlan.generation,
        inputDigest: storedPlan.inputDigest,
      },
      storage,
    );
  }

  // 7. Acknowledge/delete processed planning state changes
  if (changeDocPaths.length > 0) {
    for (const docPath of changeDocPaths) {
      await storage.delete(docPath);
    }
  } else if (options.changes) {
    for (const change of options.changes) {
      await storage.delete(userSubDoc(uid, PLANNING_STATE_CHANGES, docIdForKey(change.changeId)));
    }
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
