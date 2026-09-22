/**
 * The stale-generation apply guard (#524): "Patch applies only if plan
 * generation still equals baseGeneration and current input digest matches
 * expected base. Otherwise recompute from newest state."
 *
 * These tests exercise the guard at the persistence boundary it belongs to —
 * `replaceStoredPlanIfBaseMatches` checks generation *and* digest inside the
 * storage transaction, and `applyIncrementalPlanPatch` drives the
 * read → compute → guarded-write loop around it, recomputing from the newest
 * state after every refusal. An in-memory-only assertion would pass every
 * fixture here except the two that matter: the competing write that lands
 * between compute and commit.
 *
 * The race is not mocked at the service level. `setBeforeCommitHookForTests`
 * interleaves a real write exactly where a second instance's commit would
 * land (the same mechanism the calendar and football suites use), and the
 * always-racing wrapper makes a competitor win every single attempt, which is
 * what proves the refusal path rather than the retry path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter, StorageTransaction } from '../../lib/storage/storageAdapter.ts';
import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { reconcileScheduleBlocks } from '../../lib/planning/scheduler/blocks.ts';
import { computeImpactClosure } from '../../lib/planning/incremental/impactClosure.ts';
import {
  IncrementalReplanError,
  planIncrementalPatch,
} from '../../lib/planning/incremental/freezeResolve.ts';
import {
  NO_EDITS,
  listPlanEvents,
  planPath,
  readStoredPlan,
  replaceStoredPlanIfBaseMatches,
  type StoredDailyPlan,
} from '../../lib/services/dailyPlan/planStore.ts';
import {
  applyIncrementalPlanPatch,
  type ComputedIncrementalPatch,
} from '../../lib/services/dailyPlan/incrementalPlanApply.ts';
import type { ScheduleBlockSources } from '../../lib/planning/scheduler/blocks.ts';
import type {
  Plan,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
} from '../../src/contracts/v1/planningContracts.ts';

const UID = 'user-incremental-apply';
const DATE = '2026-08-17';
const AT = '2026-08-17T07:00:00.000Z';
const AT_LATER = '2026-08-17T07:05:00.000Z';
const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';

const CONFIG: PlanningConfig = { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false };

function workingWindow() {
  return { windowId: 'w0', weekday: 1 as const, startMinute: 8 * 60, endMinute: 20 * 60, timezone: 'UTC' };
}

function item(itemId: string, minutes: number, overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId,
    title: itemId,
    effort: { kind: 'known', minutes },
    earliestStartAt: null,
    deadlineAt: null,
    priority: 1,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...overrides,
  };
}

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: UID,
    timezone: 'UTC',
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    workingWindows: [workingWindow()],
    fixedEvents: [],
    items: [],
    ...overrides,
  };
}

function sourcesFor(request: PlanningConstraints): ScheduleBlockSources {
  return {
    items: new Map(request.items.map((entry) => [entry.itemId, { kind: 'commitment' as const, id: entry.itemId }])),
    fixedEvents: new Map(),
  };
}

function blockIdOf(itemId: string): string {
  return `block:commitment:${itemId}`;
}

/** A stored plan built entirely by the real machinery. */
function storedPlanFor(request: PlanningConstraints, generation: number): StoredDailyPlan {
  const plan = schedulePlan(request, CONFIG);
  return {
    date: DATE,
    timezone: 'UTC',
    locale: 'en',
    status: 'accepted',
    plan,
    blocks: reconcileScheduleBlocks({
      constraints: request, plan, generation, sources: sourcesFor(request), previous: null,
    }),
    replaces: null,
    constraints: request,
    config: CONFIG,
    explanation: { text: 'a stored explanation', locale: 'en', source: 'template', validated: true },
    edits: NO_EDITS,
    generatedAt: AT,
    generation,
    inputDigest: plan.inputDigest,
    acceptedAt: AT,
    updatedAt: AT,
  };
}

/**
 * The caller's half of the contract: given a stored plan, compute the patch
 * against *it* and build the next-generation document. Records every base it
 * was handed, so the tests can see the recompute-from-newest happen.
 */
function patchComputer(
  nextConstraints: PlanningConstraints,
  changedBlockIds: readonly string[],
  seenBaseGenerations: number[],
) {
  return (current: StoredDailyPlan): ComputedIncrementalPatch => {
    seenBaseGenerations.push(current.generation);
    const closure = computeImpactClosure({
      blocks: current.blocks,
      items: current.constraints.items,
      changedBlockIds,
      resourceDependenciesOrder: CONFIG.resourceDependenciesOrder,
    });
    const { patch, plan } = planIncrementalPatch({
      basePlan: current.plan,
      baseBlocks: current.blocks,
      closure,
      nextConstraints,
      config: CONFIG,
      baseGeneration: current.generation,
      resultGeneration: current.generation + 1,
      causeChangeIds: ['chg-1'],
    });
    const generation = current.generation + 1;
    const document: StoredDailyPlan = {
      ...current,
      generation,
      replaces: { generation: current.generation, inputDigest: current.inputDigest },
      plan,
      blocks: reconcileScheduleBlocks({
        constraints: nextConstraints,
        plan,
        generation,
        sources: sourcesFor(nextConstraints),
        previous: current.blocks,
      }),
      constraints: nextConstraints,
      inputDigest: plan.inputDigest,
      updatedAt: AT_LATER,
    };
    return { patch, document };
  };
}

async function seed(storage: StorageAdapter, document: StoredDailyPlan): Promise<void> {
  await storage.set<StoredDailyPlan>(planPath(UID, DATE), document);
}

/** The ordinary three-item day and the change that grows `b`. */
function dayAndChange() {
  const baseRequest = constraints({ items: [item('a', 60), item('b', 60), item('c', 60)] });
  const next = constraints({ items: [item('a', 60), item('b', 90), item('c', 60)] });
  return { baseRequest, next, changed: [blockIdOf('b')] };
}

/* ── The happy path ─────────────────────────────────────────────── */

test('a patch against the current base applies, advances the generation, and logs it', async () => {
  const storage = createMemoryStorage();
  const { baseRequest, next, changed } = dayAndChange();
  await seed(storage, storedPlanFor(baseRequest, 1));

  const seen: number[] = [];
  const result = await applyIncrementalPlanPatch(UID, DATE, {
    at: AT_LATER,
    computePatch: patchComputer(next, changed, seen),
  }, storage);

  assert.equal(result.applied, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(seen, [1]);
  if (!result.applied) return;
  assert.equal(result.patch.mode, 'incremental');
  assert.equal(result.stored.generation, 2);
  assert.deepEqual(result.stored.replaces, {
    generation: 1,
    inputDigest: schedulePlan(baseRequest, CONFIG).inputDigest,
  });

  const stored = await readStoredPlan(UID, DATE, storage);
  assert.equal(stored?.generation, 2);
  assert.equal(stored?.inputDigest, schedulePlan(next, CONFIG).inputDigest);
  // The frozen half survived the round trip byte-identical.
  const basePlan = schedulePlan(baseRequest, CONFIG);
  for (const itemId of ['a', 'c']) {
    assert.deepEqual(
      stored?.plan.scheduled.find((entry) => entry.itemId === itemId),
      basePlan.scheduled.find((entry) => entry.itemId === itemId),
      `${itemId} moved in the stored plan`,
    );
  }

  const events = await listPlanEvents(UID, storage);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'plan_regenerated');
  assert.equal(events[0].generation, 2);
});

/* ── Stale base: recompute from newest, never overwrite ─────────── */

test('a competing write between compute and commit is recomputed against, not overwritten', async () => {
  const storage = createMemoryStorage();
  const { baseRequest, next, changed } = dayAndChange();
  await seed(storage, storedPlanFor(baseRequest, 1));

  // A concurrent full regeneration lands its generation 2 exactly between our
  // read/compute and our commit — where a second tick's write would.
  let armed = true;
  storage.setBeforeCommitHookForTests(async () => {
    if (!armed) return;
    armed = false;
    const current = await readStoredPlan(UID, DATE, storage);
    assert.ok(current, 'the hook ran before any plan existed');
    await storage.set<StoredDailyPlan>(planPath(UID, DATE), {
      ...current,
      generation: 2,
      replaces: { generation: 1, inputDigest: current.inputDigest },
      updatedAt: AT_LATER,
    });
  });

  try {
    const seen: number[] = [];
    const result = await applyIncrementalPlanPatch(UID, DATE, {
      at: AT_LATER,
      computePatch: patchComputer(next, changed, seen),
    }, storage);

    assert.equal(result.applied, true);
    assert.equal(result.attempts, 2, 'the first guarded write must have been refused');
    // The second attempt computed against the competitor's generation — the
    // newest state — not against the stale base it first read.
    assert.deepEqual(seen, [1, 2]);
    if (!result.applied) return;
    assert.equal(result.stored.generation, 3);
    assert.equal(result.patch.baseGeneration, 2);
  } finally {
    storage.setBeforeCommitHookForTests(null);
  }

  const stored = await readStoredPlan(UID, DATE, storage);
  assert.equal(stored?.generation, 3);
  assert.deepEqual(stored?.replaces, { generation: 2, inputDigest: schedulePlan(baseRequest, CONFIG).inputDigest });
});

test('a base that keeps moving under every attempt is refused, and never overwritten', async () => {
  const inner = createMemoryStorage();
  const { baseRequest, next, changed } = dayAndChange();
  await seed(inner, storedPlanFor(baseRequest, 1));

  // A competitor that wins *every* race: each guarded write finds the plan
  // one generation newer than the base the patch was computed from.
  const racerWrites: number[] = [];
  const racing: StorageAdapter = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'runTransaction') {
        return async <R,>(fn: (tx: StorageTransaction) => Promise<R>): Promise<R> => {
          const current = await readStoredPlan(UID, DATE, target);
          if (current !== null) {
            racerWrites.push(current.generation + 1);
            await target.set<StoredDailyPlan>(planPath(UID, DATE), {
              ...current,
              generation: current.generation + 1,
              replaces: { generation: current.generation, inputDigest: current.inputDigest },
              updatedAt: AT_LATER,
            });
          }
          return target.runTransaction(fn);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const seen: number[] = [];
  const result = await applyIncrementalPlanPatch(UID, DATE, {
    at: AT_LATER,
    computePatch: patchComputer(next, changed, seen),
    maxAttempts: 3,
  }, racing);

  assert.equal(result.applied, false);
  if (result.applied) return;
  assert.equal(result.reason, 'stale_base');
  assert.equal(result.attempts, 3);
  // Every attempt recomputed against the newest state it could see — the loop
  // never re-offered a stale patch.
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(racerWrites, [2, 3, 4]);

  // The stored plan is the racer's, untouched by any patch: generation 4,
  // and none of the patch's contents ever landed.
  const stored = await readStoredPlan(UID, DATE, inner);
  assert.equal(stored?.generation, 4);
  const basePlan: Plan = schedulePlan(baseRequest, CONFIG);
  assert.deepEqual(stored?.plan, basePlan);
  assert.deepEqual(await listPlanEvents(UID, inner), []);
});

test('there is nothing to patch when no plan is stored', async () => {
  const storage = createMemoryStorage();
  const { next, changed } = dayAndChange();
  const seen: number[] = [];
  const result = await applyIncrementalPlanPatch(UID, DATE, {
    at: AT_LATER,
    computePatch: patchComputer(next, changed, seen),
  }, storage);

  assert.equal(result.applied, false);
  if (result.applied) return;
  assert.equal(result.reason, 'no_stored_plan');
  assert.deepEqual(seen, []);
});

test('a patch not computed from the state it was handed is a caller bug, thrown not retried', async () => {
  const storage = createMemoryStorage();
  const { baseRequest, next, changed } = dayAndChange();
  await seed(storage, storedPlanFor(baseRequest, 1));

  const honest = patchComputer(next, changed, []);
  await assert.rejects(
    applyIncrementalPlanPatch(UID, DATE, {
      at: AT_LATER,
      computePatch: (current) => {
        const computed = honest(current);
        // A patch claiming a base it never saw: the guarded write would
        // report this as an ordinary race and the loop would recompute
        // forever, so the service refuses it loudly instead.
        return {
          ...computed,
          patch: { ...computed.patch, baseGeneration: current.generation + 41 },
        };
      },
    }, storage),
    IncrementalReplanError,
  );
  // Nothing was written while the bug was being reported.
  assert.equal((await readStoredPlan(UID, DATE, storage))?.generation, 1);
});

/* ── The guard itself, at the planStore boundary ────────────────── */

test('replaceStoredPlanIfBaseMatches refuses a matching generation with a different digest', async () => {
  const storage = createMemoryStorage();
  const { baseRequest } = dayAndChange();
  const base = storedPlanFor(baseRequest, 1);
  await seed(storage, base);

  const candidate: StoredDailyPlan = {
    ...base,
    generation: 2,
    replaces: { generation: 1, inputDigest: base.inputDigest },
    updatedAt: AT_LATER,
  };

  // Same generation, wrong digest: the state the patch was computed from is
  // not the state that is stored, and the write must not land.
  const refused = await replaceStoredPlanIfBaseMatches(
    UID,
    candidate,
    { generation: 1, inputDigest: 'plan-digest-v1:not-the-base' },
    storage,
  );
  assert.equal(refused, null);
  assert.equal((await readStoredPlan(UID, DATE, storage))?.generation, 1);

  // The matching base applies — the guard refuses staleness, not writes.
  const applied = await replaceStoredPlanIfBaseMatches(
    UID,
    candidate,
    { generation: 1, inputDigest: base.inputDigest },
    storage,
  );
  assert.equal(applied?.generation, 2);
  assert.equal((await readStoredPlan(UID, DATE, storage))?.generation, 2);
});

test('replaceStoredPlanIfBaseMatches refuses a stale generation even with a matching digest', async () => {
  const storage = createMemoryStorage();
  const { baseRequest } = dayAndChange();
  const base = storedPlanFor(baseRequest, 1);
  await seed(storage, base);

  const refused = await replaceStoredPlanIfBaseMatches(
    UID,
    { ...base, generation: 3, updatedAt: AT_LATER },
    { generation: 41, inputDigest: base.inputDigest },
    storage,
  );
  assert.equal(refused, null);
  assert.equal((await readStoredPlan(UID, DATE, storage))?.generation, 1);
});
