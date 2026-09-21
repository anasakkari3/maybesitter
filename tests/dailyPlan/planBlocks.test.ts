/**
 * Schedule blocks end to end (Launch S3, issue #521): through the stored plan
 * document and the routes the React Native client actually calls.
 *
 * The identity scheme itself is pinned in `tests/planning/scheduleBlocks.test.ts`;
 * what is pinned here is the persistence and the transport half of the
 * acceptance criteria:
 *
 *  - a built plan document carries one block per occurrence, fixed work
 *    included, busy time excluded;
 *  - an identical replay — re-running the scheduler on the stored request —
 *    reproduces the stored blocks exactly;
 *  - a regeneration over unchanged commitments keeps every block id and
 *    interval, records its ancestry (`replaces`), and diffs to zero churn in
 *    the existing `PlanDiff`/`churnMinutes` vocabulary;
 *  - a move through the actions route lands on the block and provably does
 *    not land on the source commitment (the whole domain state is compared,
 *    not the one field).
 *
 * The routes are invoked in-process, the way `planActions.test.ts` does.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { loadDomainState, persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { replayStoredPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { dailyPlanScheduleSources } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { diffPlans, reconcileScheduleBlocks } from '../../lib/planning/scheduler/index.ts';
import { computePlanQualityMetrics } from '../../lib/planning/evaluation/metrics.ts';
import { scheduleBlockId, type ScheduleBlock } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as actionsPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('PlanBlocks');
const DATE = '2026-09-15';
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const FLOATING = ['cmt_float_1', 'cmt_float_2'];
const PINNED = 'cmt_pinned';

function request(path: string, options: { method?: string; body?: unknown } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(USER)}` });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

function seedState() {
  let state = createEmptyDomainState();
  for (const [index, id] of [...FLOATING, PINNED].map((id, index) => [index, id] as const)) {
    const timeSpec = id === PINNED
      // 10:00 in Asia/Jerusalem on that date, pinned: a fixed block.
      ? { kind: 'scheduled_event' as const, dueAt: '2026-09-15T07:00:00.000Z', remindAt: null, timezone: TZ }
      : { kind: 'due_by' as const, dueAt: null, remindAt: null, timezone: TZ };
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title: `task ${index}`, timeSpec },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  }
  return state;
}

interface Harness {
  storage: StorageAdapter;
  auth: FakeAuthControls;
  teardown(): void;
}

async function setup(): Promise<Harness> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  await persistParticipantState(USER, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(USER));
  await storage.set(userDoc(USER), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(USER, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(USER, MORNING, { storage });
  await buildAndStoreDailyPlan(claim!, { storage, now: () => MORNING });
  return {
    storage,
    auth,
    teardown() {
      auth.restore();
      resetStorageForTests();
    },
  };
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await setup();
  try {
    await fn(harness);
  } finally {
    harness.teardown();
  }
}

function blockOf(blocks: readonly ScheduleBlock[], sourceId: string): ScheduleBlock {
  const id = scheduleBlockId({ kind: 'commitment', id: sourceId });
  const found = blocks.find((block) => block.blockId === id);
  assert.ok(found, `expected a block ${id}`);
  return found;
}

/* ── The built document ──────────────────────────────────────────── */

test('a built plan carries one block per occurrence; fixed work is a block but never a movable item', async () => {
  await withHarness(async () => {
    const stored = await readStoredPlan(USER, DATE);
    assert.ok(stored, 'the morning build did not store a plan');

    // Every scheduled and unscheduled planner item maps to exactly one block.
    const itemIds = [
      ...stored.plan.scheduled.map((entry) => entry.itemId),
      ...stored.plan.unscheduled.map((entry) => entry.itemId),
    ];
    assert.deepEqual(itemIds.slice().sort(), FLOATING.slice().sort(), 'fixture: the floating commitments are the items');
    for (const itemId of itemIds) {
      assert.equal(
        stored.blocks.filter((block) => block.mobility === 'flexible' && block.source.id === itemId).length,
        1,
        `${itemId} must map to exactly one block`,
      );
    }

    // The pinned commitment is a fixed block with its source's interval, and
    // never entered the solver as a movable PlanningItem.
    const pinned = blockOf(stored.blocks, PINNED);
    assert.equal(pinned.mobility, 'fixed');
    assert.deepEqual(pinned.currentInterval, {
      startsAt: '2026-09-15T07:00:00.000Z',
      endsAt: stored.constraints.fixedEvents.find((event) => event.sourceCommitmentId === PINNED)!.interval.endsAt,
    });
    assert.ok(stored.constraints.items.every((entry) => entry.itemId !== PINNED));
    assert.ok(stored.plan.scheduled.every((entry) => entry.itemId !== PINNED));

    // Scheduled blocks sit where the plan put them, under the planner's name.
    for (const entry of stored.plan.scheduled) {
      const block = blockOf(stored.blocks, entry.itemId);
      assert.deepEqual(block.currentInterval, entry.interval);
      assert.equal(block.lastPlacedBy, 'planner');
      assert.equal(block.lastPlanGeneration, 1);
    }

    // No duplicates, no orphans, and ancestry starts empty.
    assert.equal(new Set(stored.blocks.map((block) => block.blockId)).size, stored.blocks.length);
    assert.ok(stored.blocks.every((block) => [...FLOATING, PINNED].includes(block.source.id)));
    assert.equal(stored.replaces, null);
  });
});

test('an identical replay reproduces the stored plan and the stored blocks exactly', async () => {
  await withHarness(async () => {
    const stored = await readStoredPlan(USER, DATE);
    assert.ok(stored);

    const replayed = replayStoredPlan(stored);
    assert.deepEqual(replayed, stored.plan);

    const replayedBlocks = reconcileScheduleBlocks({
      constraints: stored.constraints,
      plan: replayed,
      generation: stored.generation,
      sources: dailyPlanScheduleSources(stored.constraints),
      previous: null,
    });
    assert.deepEqual(replayedBlocks, stored.blocks);
  });
});

/* ── Regeneration ────────────────────────────────────────────────── */

test('regenerating over unchanged commitments keeps every block id and interval, with zero churn', async () => {
  await withHarness(async () => {
    const first = await readStoredPlan(USER, DATE);
    assert.ok(first);

    /*
     * Regenerated at the same instant the first plan was built at.
     *
     * The route reads the real clock, which is long after this date and would
     * be a *different* input: a plan gained a lower bound at "now" (#500), so
     * the 09:00-local build is bounded and a replay from outside the day is
     * not, and the two would differ by an hour through no fault of the block
     * machinery this test is about. "A no-op replan has zero churn" holds when
     * nothing has changed, and the clock is one of the things that can change.
     */
    mock.timers.enable({ apis: ['Date'], now: MORNING.getTime() });
    let response: Response;
    try {
      response = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, { method: 'POST' }), params(DATE));
    } finally {
      mock.timers.reset();
    }
    assert.equal(response.status, 200);
    const regenerated = await readStoredPlan(USER, DATE);
    assert.ok(regenerated);
    assert.equal(regenerated.generation, 2);

    // Block identity survives the regeneration: same ids, same intervals.
    assert.deepEqual(
      regenerated.blocks.map((block) => [block.blockId, block.currentInterval]),
      first.blocks.map((block) => [block.blockId, block.currentInterval]),
    );
    assert.ok(regenerated.blocks.every((block) => block.lastPlanGeneration === 2));

    // Generation ancestry: the document says which plan it replaced.
    assert.deepEqual(regenerated.replaces, { generation: 1, inputDigest: first.inputDigest });

    // Churn stays in the existing vocabulary, and a no-op replan has none.
    const diff = diffPlans(first.plan, regenerated.plan);
    assert.equal(diff.sameInputDigest, true);
    assert.ok(diff.changes.every((change) => change.kind === 'unchanged'));
    const metrics = computePlanQualityMetrics({
      plan: regenerated.plan,
      previousPlan: first.plan,
      availableMinutes: 480,
    });
    assert.equal(metrics.churnMinutes, 0);
  });
});

/* ── Moves ───────────────────────────────────────────────────────── */

test('a move through the actions route lands on the block and never on the source commitment', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE);
    assert.ok(before);
    const itemId = before.plan.scheduled[0]!.itemId;
    const beforeBlock = blockOf(before.blocks, itemId);
    const domainBefore = await loadDomainState(storage, USER);

    // A legal slot: later the same morning, inside the working window.
    const response = await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, {
      method: 'POST',
      body: { action: 'edit', moves: [{ itemId, startsAt: '2026-09-15T08:00:00.000Z' }] },
    }), params(DATE));
    assert.equal(response.status, 200);
    const body = await response.json() as { plan: Record<string, unknown> };
    // The DTO now includes the block protection list (#522), but otherwise
    // answers what it answered before blocks existed.
    assert.deepEqual(
      Object.keys(body.plan).sort(),
      ['acceptedAt', 'date', 'edited', 'explanation', 'generatedAt', 'generation', 'inputDigest', 'protections', 'scheduled', 'status', 'timezone', 'unscheduled'].sort(),
    );

    const after = await readStoredPlan(USER, DATE);
    assert.ok(after);
    const moved = blockOf(after.blocks, itemId);
    assert.equal(moved.blockId, beforeBlock.blockId, 'the move must not change the identity');
    assert.deepEqual(moved.source, beforeBlock.source);
    assert.equal(moved.durationMinutes, beforeBlock.durationMinutes);
    assert.deepEqual(moved.currentInterval, { startsAt: '2026-09-15T08:00:00.000Z', endsAt: '2026-09-15T08:30:00.000Z' });
    assert.equal(moved.lastPlacedBy, 'user');
    assert.equal(moved.lastPlanGeneration, after.generation);

    // The criterion, whole: the domain state — every commitment, every
    // timeSpec — is byte-for-byte what it was before the edit.
    const domainAfter = await loadDomainState(storage, USER);
    assert.deepEqual(domainAfter, domainBefore, 'a plan edit wrote onto a source commitment');
  });
});

test('a moved block keeps its identity and provenance through a later regeneration', async () => {
  await withHarness(async () => {
    const before = await readStoredPlan(USER, DATE);
    assert.ok(before);
    const itemId = before.plan.scheduled[0]!.itemId;
    const blockId = scheduleBlockId({ kind: 'commitment', id: itemId });

    const moved = await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, {
      method: 'POST',
      body: { action: 'edit', moves: [{ itemId, startsAt: '2026-09-15T08:00:00.000Z' }] },
    }), params(DATE));
    assert.equal(moved.status, 200);

    const regenerated = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, { method: 'POST' }), params(DATE));
    assert.equal(regenerated.status, 200);

    const after = await readStoredPlan(USER, DATE);
    assert.ok(after);
    const block = after.blocks.find((entry) => entry.blockId === blockId);
    assert.ok(block, 'the block survived the regeneration');
    assert.equal(block.source.id, itemId);
    assert.equal(block.lastPlanGeneration, 2);
  });
});

/* ── The read surface is unchanged ───────────────────────────────── */

test('GET answers the plan in the shape the client already reads', async () => {
  await withHarness(async () => {
    const response = await planGet(request(`/api/mobile/plans/${DATE}`), params(DATE));
    assert.equal(response.status, 200);
    const body = await response.json() as { plan: { scheduled: unknown[]; unscheduled: unknown[] } };
    const stored = await readStoredPlan(USER, DATE);
    assert.equal(body.plan.scheduled.length, stored!.plan.scheduled.length);
    assert.equal(body.plan.unscheduled.length, stored!.plan.unscheduled.length);
  });
});

/* ── Account and scope isolation ─────────────────────────────────── */

test('two accounts holding the same commitment ids hold separate, unreachable blocks', async () => {
  await withHarness(async ({ storage }) => {
    // A second account with byte-identical commitment ids: the hardest case
    // for a scope-local identity scheme, because the blockIds *do* collide.
    const other = uidFor('PlanBlocksOther');
    await persistParticipantState(other, seedState());
    const doc = await storage.get<Record<string, unknown>>(userDoc(other));
    await storage.set(userDoc(other), { ...(doc ?? {}), timezone: TZ, locale: 'en' });
    await savePlanSettings(other, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
    const claim = await claimDueDelivery(other, MORNING, { storage });
    await buildAndStoreDailyPlan(claim!, { storage, now: () => MORNING });

    const mine = await readStoredPlan(USER, DATE);
    const theirs = await readStoredPlan(other, DATE);
    assert.ok(mine && theirs);

    // The ids collide by design; the scope is what separates them.
    assert.deepEqual(
      theirs.blocks.map((block) => block.blockId),
      mine.blocks.map((block) => block.blockId),
      'fixture: the two accounts really do share blockIds',
    );
    assert.ok(mine.blocks.every((block) => block.scopeId === `${USER}:${DATE}`));
    assert.ok(theirs.blocks.every((block) => block.scopeId === `${other}:${DATE}`));
    assert.ok(mine.blocks.every((block) => !block.scopeId.includes(other)));

    // And nothing of the other account is reachable over the wire as me.
    const response = await planGet(request(`/api/mobile/plans/${DATE}`), params(DATE));
    assert.equal(response.status, 200);
    const body = await response.json() as { plan: { scheduled: { itemId: string }[] } };
    assert.deepEqual(
      body.plan.scheduled.map((entry) => entry.itemId).sort(),
      mine.plan.scheduled.map((entry) => entry.itemId).sort(),
    );
  });
});

test('a regeneration is isolated: the other account\'s plan and blocks do not move', async () => {
  await withHarness(async ({ storage }) => {
    const other = uidFor('PlanBlocksOther');
    await persistParticipantState(other, seedState());
    const doc = await storage.get<Record<string, unknown>>(userDoc(other));
    await storage.set(userDoc(other), { ...(doc ?? {}), timezone: TZ, locale: 'en' });
    await savePlanSettings(other, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
    const claim = await claimDueDelivery(other, MORNING, { storage });
    await buildAndStoreDailyPlan(claim!, { storage, now: () => MORNING });
    const theirsBefore = await readStoredPlan(other, DATE);
    assert.ok(theirsBefore);

    // My move and my regeneration, both authenticated as me.
    const itemId = (await readStoredPlan(USER, DATE))!.plan.scheduled[0]!.itemId;
    await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, {
      method: 'POST',
      body: { action: 'edit', moves: [{ itemId, startsAt: '2026-09-15T08:00:00.000Z' }] },
    }), params(DATE));
    await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, { method: 'POST' }), params(DATE));

    const theirsAfter = await readStoredPlan(other, DATE);
    assert.deepEqual(theirsAfter, theirsBefore, 'one account\'s plan edit reached another account');
  });
});

/* ── Idempotency of the stored document ──────────────────────────── */

test('re-applying the same edit leaves the stored blocks where the first one did', async () => {
  await withHarness(async () => {
    const itemId = (await readStoredPlan(USER, DATE))!.plan.scheduled[0]!.itemId;
    const body = { action: 'edit', moves: [{ itemId, startsAt: '2026-09-15T08:00:00.000Z' }] };

    const first = await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, { method: 'POST', body }), params(DATE));
    assert.equal(first.status, 200);
    const afterFirst = await readStoredPlan(USER, DATE);

    const second = await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, { method: 'POST', body }), params(DATE));
    assert.equal(second.status, 200);
    const afterSecond = await readStoredPlan(USER, DATE);

    assert.deepEqual(afterSecond!.blocks, afterFirst!.blocks);
    assert.deepEqual(afterSecond!.plan, afterFirst!.plan);
  });
});
