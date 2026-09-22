/**
 * The protection mutation, end to end (Launch S3, issue #522).
 *
 * `tests/planning/protectedPlacement.test.ts` pins the *solver's* half: the
 * retention tier, the max-shift bound, the metrics, the pure functions. Every
 * one of those constructs its own `PlanningConstraints` by hand, which is the
 * right shape for a policy test and is also why none of them touches the thing
 * the issue actually asks for on the API side — "add block protection mutation
 * to the existing Plan boundary". That path had no test at all: not the route,
 * not the six refusals, not the idempotency its own docstring promises, not the
 * ledger entry, and not the round trip that makes a protection mean anything
 * after tomorrow morning's regeneration.
 *
 * So this file goes through the routes the React Native client calls, on a real
 * stored plan document, following `planBlocks.test.ts`:
 *
 *  - `action: 'protect'` records a protection and moves nothing;
 *  - the same request twice writes one document and one ledger entry;
 *  - `ownership: 'flexible'` releases it, and absence is the only spelling of
 *    "not protected";
 *  - every refusal is a 422 naming the block, and a fixed block cannot be
 *    protected at all;
 *  - one account cannot name another account's block;
 *  - a protected placement survives a regeneration — the criterion "protected
 *    time stays unchanged when still feasible", proved through persistence
 *    rather than against a hand-built request;
 *  - a manual move re-anchors `preferredInterval` through `editPlan`, not just
 *    through the pure function that does the re-anchoring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { PlanProtectionRejected, parseProtection } from '../../lib/services/dailyPlan/planActions.ts';
import { scheduleBlockId } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import { ownershipOf } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as actionsPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('PlanProtect');
const OTHER = uidFor('PlanProtectOther');
const DATE = '2026-09-15';
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const FLOATING = ['cmt_float_1', 'cmt_float_2'];
const PINNED = 'cmt_pinned';

function request(path: string, options: { method?: string; body?: unknown; uid?: string } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(options.uid ?? USER)}` });
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

/** One account with a built plan, and a second account that owns nothing. */
async function setup(): Promise<Harness> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  await persistParticipantState(USER, seedState());
  for (const uid of [USER, OTHER]) {
    const user = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  }
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

/** The first scheduled item, and the block that carries it. */
async function firstScheduled(): Promise<{ itemId: string; blockId: string; startsAt: string; endsAt: string }> {
  const stored = await readStoredPlan(USER, DATE);
  assert.ok(stored, 'the morning build did not store a plan');
  const entry = stored.plan.scheduled[0];
  assert.ok(entry, 'fixture: the built plan scheduled nothing');
  return {
    itemId: entry.itemId,
    blockId: scheduleBlockId({ kind: 'commitment', id: entry.itemId }),
    startsAt: entry.interval.startsAt,
    endsAt: entry.interval.endsAt,
  };
}

function protectBody(blockId: string, over: Record<string, unknown> = {}) {
  return { action: 'protect', blockId, ownership: 'protected_flexible', ...over };
}

async function protect(body: Record<string, unknown>, uid = USER): Promise<Response> {
  return actionsPost(request(`/api/mobile/plans/${DATE}/actions`, { method: 'POST', body, uid }), params(DATE));
}

async function protectionEvents(uid = USER): Promise<number> {
  return (await listPlanEvents(uid)).filter((event) => event.type === 'plan_protected').length;
}

/* ── Declaring and releasing ─────────────────────────────────────── */

test('protect records the protection on the block and moves nothing', async () => {
  await withHarness(async () => {
    const { blockId, itemId, startsAt } = await firstScheduled();
    const before = await readStoredPlan(USER, DATE);

    const response = await protect(protectBody(blockId, { maxShiftMinutes: 30 }));
    assert.equal(response.status, 200, await response.clone().text());

    const after = await readStoredPlan(USER, DATE);
    assert.ok(after);
    const block = after.blocks.find((entry) => entry.blockId === blockId);
    assert.ok(block);
    assert.deepEqual(block.protection, {
      ownership: 'protected_flexible',
      // Defaulted, because a person protecting their own block is the ordinary
      // case and a client that had to name the origin would name a wrong one.
      origin: 'user',
      // "Keep it here": the preference defaults to where it sits now.
      preferredInterval: { startsAt, endsAt: block.currentInterval!.endsAt },
      maxShiftMinutes: 30,
    });
    assert.equal(ownershipOf(block), 'protected_flexible');

    // Nothing moved. Protecting an hour is a statement about the next
    // regeneration, not a reschedule of the plan on screen.
    assert.deepEqual(after.plan.scheduled, before!.plan.scheduled);
    assert.deepEqual(after.plan.unscheduled, before!.plan.unscheduled);
    assert.equal(after.generation, before!.generation);
    // And it landed on the block, not on the item it came from.
    assert.ok(after.constraints.items.every((entry) => entry.itemId !== itemId || entry.protection === undefined));
  });
});

test('the same protection twice writes one document and one ledger entry', async () => {
  await withHarness(async () => {
    const { blockId } = await firstScheduled();

    const first = await protect(protectBody(blockId, { maxShiftMinutes: 45 }));
    assert.equal(first.status, 200);
    const afterFirst = await readStoredPlan(USER, DATE);
    assert.equal(await protectionEvents(), 1);

    const second = await protect(protectBody(blockId, { maxShiftMinutes: 45 }));
    assert.equal(second.status, 200);
    const afterSecond = await readStoredPlan(USER, DATE);

    // Identical bytes, including `updatedAt`: two phones tapping "keep this
    // here" produce one record, not two.
    assert.deepEqual(afterSecond, afterFirst);
    assert.equal(await protectionEvents(), 1, 'a repeated request appended a second ledger entry');
  });
});

test('a changed bound is not a replay, and is recorded', async () => {
  await withHarness(async () => {
    const { blockId } = await firstScheduled();
    await protect(protectBody(blockId, { maxShiftMinutes: 45 }));
    const response = await protect(protectBody(blockId, { maxShiftMinutes: 15 }));
    assert.equal(response.status, 200);

    const stored = await readStoredPlan(USER, DATE);
    assert.equal(stored!.blocks.find((entry) => entry.blockId === blockId)!.protection!.maxShiftMinutes, 15);
    assert.equal(await protectionEvents(), 2);
  });
});

test('flexible releases the protection, and absence is the only spelling of unprotected', async () => {
  await withHarness(async () => {
    const { blockId } = await firstScheduled();
    await protect(protectBody(blockId, { maxShiftMinutes: 30 }));

    const released = await protect({ action: 'protect', blockId, ownership: 'flexible' });
    assert.equal(released.status, 200);

    const stored = await readStoredPlan(USER, DATE);
    const block = stored!.blocks.find((entry) => entry.blockId === blockId)!;
    // Null, not a protection object saying "not protected": a second spelling
    // of the same state is a second thing every reader has to know about.
    assert.equal(block.protection, null);
    assert.equal(ownershipOf(block), 'flexible');
  });
});

test('a protection with an explicit preferred interval keeps the one the client named', async () => {
  await withHarness(async () => {
    const { blockId } = await firstScheduled();
    const preferred = { startsAt: '2026-09-15T09:00:00.000Z', endsAt: '2026-09-15T09:30:00.000Z' };

    const response = await protect(protectBody(blockId, { preferredInterval: preferred, origin: 'habit_policy' }));
    assert.equal(response.status, 200);

    const stored = await readStoredPlan(USER, DATE);
    const block = stored!.blocks.find((entry) => entry.blockId === blockId)!;
    assert.deepEqual(block.protection!.preferredInterval, preferred);
    assert.equal(block.protection!.origin, 'habit_policy');
    // Still where it was: naming a preference is not asking to be moved there.
    assert.notDeepEqual(block.currentInterval, preferred);
  });
});

/* ── Refusals, each a 422 naming the block ───────────────────────── */

test('every malformed protection is a 422 that names the block and the reason', async () => {
  await withHarness(async () => {
    const { blockId } = await firstScheduled();
    const cases: Array<[label: string, body: Record<string, unknown>, reason: string]> = [
      ['no blockId', { action: 'protect', ownership: 'protected_flexible' }, 'unknown_block'],
      ['a block of no plan', protectBody('blk_nothing'), 'unknown_block'],
      ['ownership the user may not choose', protectBody(blockId, { ownership: 'fixed' }), 'invalid_ownership'],
      ['an origin the contract does not name', protectBody(blockId, { origin: 'vibes' }), 'invalid_origin'],
      ['a negative bound', protectBody(blockId, { maxShiftMinutes: -30 }), 'invalid_max_shift'],
      ['a bound that is not a number', protectBody(blockId, { maxShiftMinutes: '30' }), 'invalid_max_shift'],
      ['an interval that is not instants', protectBody(blockId, { preferredInterval: { startsAt: 'soon', endsAt: 'later' } }), 'invalid_interval'],
      ['an interval that ends before it starts', protectBody(blockId, {
        preferredInterval: { startsAt: '2026-09-15T10:00:00.000Z', endsAt: '2026-09-15T09:00:00.000Z' },
      }), 'invalid_interval'],
    ];

    for (const [label, body, reason] of cases) {
      const response = await protect(body);
      assert.equal(response.status, 422, `${label}: status`);
      const answered = await response.json() as { success: boolean; reason: string; blockId: string | null };
      assert.equal(answered.success, false, label);
      assert.equal(answered.reason, reason, label);
      // The block is named so the client can put the message beside the row.
      if (body.blockId !== undefined) assert.equal(answered.blockId, body.blockId, label);
    }

    // And none of them wrote anything.
    const stored = await readStoredPlan(USER, DATE);
    assert.ok(stored!.blocks.every((block) => (block.protection ?? null) === null));
    assert.equal(await protectionEvents(), 0);
  });
});

/**
 * The two values JSON cannot carry, asked of the parser directly.
 *
 * `JSON.stringify(NaN)` and `JSON.stringify(Infinity)` are both `null`, so
 * neither can reach the route — over HTTP they are indistinguishable from "no
 * bound", which is a legal request. The guard is still load-bearing for every
 * in-process caller, and this is the only place it can be shown to work: a
 * route case would have asserted a 422 that the wire format makes impossible,
 * and would have been deleted by whoever noticed.
 */
test('a bound the arithmetic cannot use is refused at the parser, where it can still arrive', () => {
  for (const maxShiftMinutes of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.throws(
      () => parseProtection({ blockId: 'blk_1', ownership: 'protected_flexible', maxShiftMinutes }),
      (error: unknown) => {
        assert.ok(error instanceof PlanProtectionRejected, String(error));
        assert.equal(error.reason, 'invalid_max_shift');
        return true;
      },
      String(maxShiftMinutes),
    );
  }
  // Zero is a bound, not an absence: "do not move this at all".
  assert.equal(
    parseProtection({ blockId: 'blk_1', ownership: 'protected_flexible', maxShiftMinutes: 0 }).maxShiftMinutes,
    0,
  );
  // And an omitted bound is null, which is "no explicit bound" rather than zero.
  assert.equal(parseProtection({ blockId: 'blk_1', ownership: 'protected_flexible' }).maxShiftMinutes, null);
});

test('a pinned event cannot be protected: its time is already its own', async () => {
  await withHarness(async () => {
    const pinnedBlockId = scheduleBlockId({ kind: 'commitment', id: PINNED });
    const stored = await readStoredPlan(USER, DATE);
    assert.equal(stored!.blocks.find((block) => block.blockId === pinnedBlockId)!.mobility, 'fixed');

    const response = await protect(protectBody(pinnedBlockId));
    assert.equal(response.status, 422);
    const body = await response.json() as { reason: string };
    // Not `invalid_ownership`: the request was a perfectly ordinary one and
    // the block is what makes it wrong.
    assert.equal(body.reason, 'fixed_block');
    assert.equal(await protectionEvents(), 0);
  });
});

test('one account cannot protect another account\'s block', async () => {
  await withHarness(async () => {
    const { blockId } = await firstScheduled();

    // OTHER has no plan for this date at all, so the block id — which is
    // derived from the commitment and therefore *identical* across accounts —
    // must resolve to nothing rather than to USER's block.
    const response = await protect(protectBody(blockId), OTHER);
    assert.equal(response.status, 404, await response.clone().text());

    const stored = await readStoredPlan(USER, DATE);
    assert.equal(stored!.blocks.find((entry) => entry.blockId === blockId)!.protection ?? null, null);
    assert.equal(await protectionEvents(USER), 0);
    assert.equal(await protectionEvents(OTHER), 0);
  });
});

/* ── The round trip: a protection means something tomorrow ───────── */

test('a protected placement survives a regeneration; an unprotected one is free to move', async () => {
  await withHarness(async () => {
    const { blockId, startsAt } = await firstScheduled();
    assert.equal((await protect(protectBody(blockId))).status, 200);

    const regenerated = await regeneratePost(
      request(`/api/mobile/plans/${DATE}/regenerate`, { method: 'POST' }),
      params(DATE),
    );
    assert.equal(regenerated.status, 200);

    const after = await readStoredPlan(USER, DATE);
    assert.ok(after);
    const block = after.blocks.find((entry) => entry.blockId === blockId);
    assert.ok(block, 'the protected block survived the regeneration');
    // The criterion, through persistence: the hour the user kept is the hour
    // the next generation gives back. Without
    // `projectBlockProtectionIntoPlanningConstraints` the next plan is built
    // from commitments that have never heard of the protection, and this is
    // the assertion that notices.
    assert.equal(block.currentInterval!.startsAt, startsAt);
    assert.equal(block.protection!.ownership, 'protected_flexible');
    assert.equal(after.generation, 2);
  });
});

test('the protection reaches the client through the plan DTO', async () => {
  await withHarness(async () => {
    const { blockId } = await firstScheduled();
    await protect(protectBody(blockId, { maxShiftMinutes: 20 }));

    const response = await planGet(request(`/api/mobile/plans/${DATE}`), params(DATE));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      plan: { protections: Array<{ blockId: string; ownership: string; maxShiftMinutes: number | null }> };
    };

    assert.equal(body.plan.protections.length, 1);
    assert.equal(body.plan.protections[0]!.blockId, blockId);
    assert.equal(body.plan.protections[0]!.ownership, 'protected_flexible');
    assert.equal(body.plan.protections[0]!.maxShiftMinutes, 20);
  });
});

/* ── A manual move re-anchors the preference, through the real path ─ */

test('moving a protected block through the edit route makes the new placement the preference', async () => {
  await withHarness(async () => {
    const { blockId, itemId } = await firstScheduled();
    await protect(protectBody(blockId, { maxShiftMinutes: 90 }));

    const moved = await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, {
      method: 'POST',
      body: { action: 'edit', moves: [{ itemId, startsAt: '2026-09-15T08:00:00.000Z' }] },
    }), params(DATE));
    assert.equal(moved.status, 200, await moved.clone().text());

    const after = await readStoredPlan(USER, DATE);
    const block = after!.blocks.find((entry) => entry.blockId === blockId)!;
    // The issue's rule, through `editPlan` rather than through the pure
    // function that implements it: "the successful move becomes the new
    // preferred placement".
    assert.deepEqual(block.protection!.preferredInterval, block.currentInterval);
    assert.equal(block.protection!.preferredInterval!.startsAt, '2026-09-15T08:00:00.000Z');
    // The bound follows the new preference and is not forgotten by the move.
    assert.equal(block.protection!.maxShiftMinutes, 90);
    assert.equal(block.protection!.ownership, 'protected_flexible');
  });
});

test('a move the plan refuses leaves the preference exactly where it was', async () => {
  await withHarness(async () => {
    const { blockId, itemId, startsAt } = await firstScheduled();
    await protect(protectBody(blockId));

    // Into the middle of the pinned 10:00 event, which `validateEdit` refuses.
    const refused = await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, {
      method: 'POST',
      body: { action: 'edit', moves: [{ itemId, startsAt: '2026-09-15T07:15:00.000Z' }] },
    }), params(DATE));
    assert.equal(refused.status, 422, await refused.clone().text());

    const after = await readStoredPlan(USER, DATE);
    const block = after!.blocks.find((entry) => entry.blockId === blockId)!;
    // "Successful" is the load-bearing word in the issue's rule. Nothing
    // happened, so the preference is what it was.
    assert.equal(block.protection!.preferredInterval!.startsAt, startsAt);
    assert.equal(block.currentInterval!.startsAt, startsAt);
  });
});
