/**
 * Reading and answering the proposed replan patch (#523).
 *
 * #583 made the patch durable and nothing could read it. This is the read
 * surface and the two answers — accept it, or decline it — exercised over the
 * real route handlers and the real store, so what is asserted is the status
 * code and the body the React Native client will actually receive.
 *
 * ── The three things that must be impossible ─────────────────────
 *
 * 1. **A patch of a state that has moved must not be installed.** Tested on
 *    both halves of the base separately, because a case that only moves the
 *    `generation` cannot see the `inputDigest` guard at all — a
 *    generation-only compare-and-set passes it. The digest case is run as a
 *    genuine race (a writer lands between the read and the guarded write) for
 *    the same reason: a refusal that happened before the write was reached
 *    proves nothing about the write's own guard.
 *
 * 2. **A patch orphaned by a mutator must not be presented as actionable.**
 *    `acceptPlan`, `dismissPlan`, `editPlan` and `setBlockProtection` change
 *    the plan under a patch while moving neither number the patch is pinned
 *    to, so each of the four is walked separately. A loop over three of them
 *    would leave the fourth free to regress.
 *
 * 3. **One account's patch must be invisible to another.**
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, docIdForKey, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import {
  listPlanEvents,
  planPath,
  proposalFingerprint,
  readStoredPlan,
  storePlanProposal,
  type StoredDailyPlan,
  type StoredPlanProposal,
} from '../../lib/services/dailyPlan/planStore.ts';
import { diffPlans } from '../../lib/planning/scheduler/index.ts';
import { rejectPlanProposal } from '../../lib/services/dailyPlan/planActions.ts';
import { runContinuousReplanTick } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { replaceBusyBlocksAsFixture } from '../support/busyFixtures.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { Plan, TimeInterval } from '../../src/contracts/v1/planningContracts.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as actionsPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('ProposalUser');
const OTHER = uidFor('ProposalOtherUser');
const DATE = '2026-09-15';
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const PROPOSED_AT = '2026-09-15T09:30:00.000Z';
/** Inside the working window, clear of every other item this fixture places. */
const FREE_SLOT = '2026-09-15T12:00:00.000Z';

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
  const titles = ['Write the summary', 'Call the bank', 'Book the train'];
  for (let index = 0; index < titles.length; index += 1) {
    const id = `cmt_${index}`;
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title: titles[index]!, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  }
  return state;
}

async function seedAccount(uid: string, storage: StorageAdapter): Promise<void> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(uid, MORNING, { storage });
  assert.ok(claim, `${uid} must be due for a plan`);
  await buildAndStoreDailyPlan(claim, { storage, now: () => MORNING });
}

interface Harness {
  storage: StorageAdapter;
  auth: FakeAuthControls;
  teardown(): void;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  // The routes read the wall clock, and since the #611 guards an offer
  // expires with its day. Pinned to the moment the fixture's offer is made,
  // inside the plan's own day, so the routes answer about today and not about
  // whatever day the suite happens to run on.
  mock.timers.enable({ apis: ['Date'], now: Date.parse(PROPOSED_AT) });
  try {
    await seedAccount(USER, storage);
    await fn({
      storage,
      auth,
      teardown() { /* handled below */ },
    });
  } finally {
    mock.timers.reset();
    auth.restore();
    resetStorageForTests();
  }
}

/* ── Building a patch to offer ───────────────────────────────────── */

function shift(interval: TimeInterval, minutes: number): TimeInterval {
  return {
    startsAt: new Date(Date.parse(interval.startsAt) + minutes * 60_000).toISOString(),
    endsAt: new Date(Date.parse(interval.endsAt) + minutes * 60_000).toISOString(),
  };
}

/**
 * A patch of a plan: everything shifted, minus whatever the case takes away.
 *
 * `unschedule` moves an item into `unscheduled` with a real reason; `drop`
 * removes it from the plan's accounting altogether, the way a deleted
 * commitment leaves it. The two are different states and the acceptance must
 * treat them differently, so the fixture has to be able to produce both.
 */
function patchPlan(
  plan: Plan,
  options: { minutes?: number; unschedule?: readonly string[]; drop?: readonly string[] } = {},
): Plan {
  const minutes = options.minutes ?? 60;
  const unschedule = new Set(options.unschedule ?? []);
  const drop = new Set(options.drop ?? []);
  return {
    ...plan,
    scheduled: plan.scheduled
      .filter((item) => !unschedule.has(item.itemId) && !drop.has(item.itemId))
      .map((item) => ({
        itemId: item.itemId,
        interval: shift(item.interval, minutes),
        reservedInterval: shift(item.reservedInterval, minutes),
      })),
    unscheduled: [
      ...plan.unscheduled.filter((item) => !drop.has(item.itemId)),
      ...Array.from(unschedule, (itemId) => ({
        itemId,
        reason: { code: 'NO_FEASIBLE_SLOT' as const, itemId, detail: 'the calendar change left no slot' },
      })),
    ],
  };
}

/** The same plan, everything an hour later. A real patch with a real diff. */
function shiftedPlan(plan: Plan, minutes: number): Plan {
  return patchPlan(plan, { minutes });
}

function proposalFor(stored: StoredDailyPlan, overrides: Partial<StoredPlanProposal> = {}): StoredPlanProposal {
  const plan = shiftedPlan(stored.plan, 60);
  return {
    proposalId: 'prp_review',
    proposedAt: PROPOSED_AT,
    baseGeneration: stored.generation,
    baseInputDigest: stored.inputDigest,
    plan,
    solveInputs: { constraints: stored.constraints, config: stored.config },
    diff: diffPlans(stored.plan, plan),
    reason: 'user_requires_confirmation',
    userControlMode: 'always_require_confirmation',
    causeChangeIds: ['chg-calendar-moved'],
    ...overrides,
  };
}

/** Stores a live patch of the current generation and returns both. */
async function offerProposal(
  storage: StorageAdapter,
  uid = USER,
  overrides: (stored: StoredDailyPlan) => Partial<StoredPlanProposal> = () => ({}),
): Promise<{ stored: StoredDailyPlan; proposal: StoredPlanProposal }> {
  const before = await readStoredPlan(uid, DATE, storage);
  assert.ok(before, 'the morning build must have produced a plan');
  const proposal = proposalFor(before, overrides(before));
  const stored = await storePlanProposal(uid, DATE, proposal, storage);
  assert.ok(stored?.proposal, 'a patch of the current generation must be stored');
  return { stored, proposal };
}

interface ProposalBody {
  readonly success: boolean;
  readonly plan?: {
    generation: number;
    status: string;
    scheduled: Array<{ itemId: string; startsAt: string }>;
    unscheduled: Array<{ itemId: string; reasonCode: string }>;
    edited: boolean;
    protections: Array<{ blockId: string; itemId: string }>;
  };
  readonly proposal?: {
    proposalId: string;
    proposedAt: string;
    baseGeneration: number;
    reason: string;
    userControlMode: string;
    causeChangeIds: string[];
    scheduled: Array<{ itemId: string; title: string | null; startsAt: string; blockId: string | null }>;
    unscheduled: unknown[];
    protections: Array<{
      blockId: string;
      itemId: string;
      title: string | null;
      preferredInterval: TimeInterval | null;
      maxShiftMinutes: number | null;
      proposedInterval: TimeInterval | null;
      overridden: boolean;
    }>;
    changes: Array<{
      kind: string;
      itemId: string;
      title: string | null;
      from: TimeInterval | null;
      to: TimeInterval | null;
      shiftMinutes: number | null;
      fromReasonCode: string | null;
      toReasonCode: string | null;
    }>;
  } | null;
  readonly reason?: string;
  readonly error?: string;
}

async function get(uid = USER): Promise<{ status: number; body: ProposalBody }> {
  const response = await planGet(request(`/api/mobile/plans/${DATE}`, { uid }), params(DATE));
  return { status: response.status, body: await response.json() as ProposalBody };
}

async function act(action: string, uid = USER, extra: Record<string, unknown> = {}): Promise<{ status: number; body: ProposalBody }> {
  const response = await actionsPost(
    request(`/api/mobile/plans/${DATE}/actions`, { uid, body: { action, ...extra } }),
    params(DATE),
  );
  return { status: response.status, body: await response.json() as ProposalBody };
}

/* ── 1. The read surface ─────────────────────────────────────────── */

test('GET exposes the pending proposal beside the plan, with titles joined on', async () => {
  await withHarness(async ({ storage }) => {
    const { stored, proposal } = await offerProposal(storage);

    const { status, body } = await get();
    assert.equal(status, 200);
    assert.ok(body.proposal, 'the stored patch must be readable; a durable field nothing reads is not a read surface');
    assert.equal(body.proposal.proposalId, 'prp_review');
    assert.equal(body.proposal.proposedAt, PROPOSED_AT);
    assert.equal(body.proposal.baseGeneration, stored.generation);
    assert.equal(body.proposal.reason, 'user_requires_confirmation');
    assert.equal(body.proposal.userControlMode, 'always_require_confirmation');
    assert.deepEqual(body.proposal.causeChangeIds, ['chg-calendar-moved']);

    // The plan the patch would install, not the one in force.
    assert.equal(body.proposal.scheduled.length, proposal.plan.scheduled.length);
    assert.deepEqual(
      body.proposal.scheduled.map((item) => item.startsAt).sort(),
      proposal.plan.scheduled.map((item) => item.interval.startsAt).sort(),
    );
    assert.notDeepEqual(
      body.proposal.scheduled.map((item) => item.startsAt).sort(),
      body.plan!.scheduled.map((item) => item.startsAt).sort(),
      'a proposal that matched the plan in force would prove nothing',
    );
    // Ids joined to titles here as everywhere else: the commitment owns its words.
    assert.ok(body.proposal.scheduled.every((item) => typeof item.title === 'string'));
    assert.ok(body.proposal.scheduled.every((item) => typeof item.blockId === 'string'));

    const moved = body.proposal.changes.filter((change) => change.kind === 'moved');
    assert.equal(moved.length, proposal.plan.scheduled.length, 'every item moved by an hour');
    assert.ok(moved.every((change) => change.shiftMinutes === 60));
    assert.ok(moved.every((change) => change.from !== null && change.to !== null));
    assert.ok(moved.every((change) => typeof change.title === 'string'));

    // The plan in force is untouched by the offer beside it.
    assert.equal(body.plan!.generation, stored.generation);
  });
});

test('GET answers a null proposal when there is nothing being offered', async () => {
  await withHarness(async () => {
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.proposal, null, 'absence must be stated, not omitted');
  });
});

/* ── 2. Accepting it ─────────────────────────────────────────────── */

test('accepting the proposal installs it as the next generation and clears the offer', async () => {
  await withHarness(async ({ storage }) => {
    const { stored, proposal } = await offerProposal(storage);

    const { status, body } = await act('accept_proposal');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.proposal, null, 'the offer is gone once it has been taken');

    const after = await readStoredPlan(USER, DATE, storage);
    assert.ok(after);
    assert.equal(after.generation, stored.generation + 1);
    assert.deepEqual(after.replaces, { generation: stored.generation, inputDigest: stored.inputDigest });
    assert.deepEqual(after.plan.scheduled, proposal.plan.scheduled, 'the patch must become the plan');
    assert.equal(after.proposal ?? null, null);
    assert.deepEqual([...(after.causeChangeIds ?? [])], ['chg-calendar-moved']);
    // The blocks keep their identity and follow the new placement.
    assert.ok(after.blocks.length > 0);
    const placed = new Map(proposal.plan.scheduled.map((item) => [item.itemId, item.interval] as const));
    let checked = 0;
    for (const block of after.blocks) {
      if (block.mobility !== 'flexible') continue;
      const interval = placed.get(block.source.id);
      if (interval === undefined) continue;
      assert.deepEqual(block.currentInterval, interval, `${block.blockId} must sit where the accepted patch puts it`);
      assert.equal(block.lastPlanGeneration, after.generation);
      assert.equal(block.lastPlacedBy, 'planner');
      checked += 1;
    }
    // Both `continue`s above are silent; without this the loop would pass by
    // asserting on nothing at all.
    assert.ok(checked > 0, 'no flexible block was actually checked');
    assert.deepEqual(
      new Set(after.blocks.map((block) => block.blockId)),
      new Set(stored.blocks.map((block) => block.blockId)),
      'accepting a patch must not mint or drop block identities',
    );

    // And the response says the same thing the document does.
    assert.equal(body.plan!.generation, stored.generation + 1);
    assert.deepEqual(
      body.plan!.scheduled.map((item) => item.startsAt).sort(),
      proposal.plan.scheduled.map((item) => item.interval.startsAt).sort(),
    );

    const events = await listPlanEvents(USER, storage);
    const recorded = events.filter((event) => event.generation === after.generation && event.type === 'plan_regenerated');
    assert.equal(recorded.length, 1, 'the replaced plan must be in the ledger');
    assert.deepEqual([...(recorded[0]!.causeChangeIds ?? [])], ['chg-calendar-moved']);
  });
});

test('accepting the proposal drops the moves it invalidated', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const first = before!.plan.scheduled[0]!;
    const edit = await act('edit', USER, { moves: [{ itemId: first.itemId, startsAt: FREE_SLOT }] });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.plan!.edited, true);

    // The edit cleared any offer; make a fresh one against the edited document.
    const { proposal } = await offerProposal(storage);
    const accepted = await act('accept_proposal');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.plan!.edited, false, 'a move validated against the old placement must not be layered on the new one');

    const after = await readStoredPlan(USER, DATE, storage);
    assert.deepEqual(after!.edits, { moves: [], removals: [] });
    // The plan was never accepted, so `'edited'` falls back to what it was
    // before the edit rather than to a state the user never entered.
    assert.equal(after!.acceptedAt, null);
    assert.equal(after!.status, 'proposed', 'a plan with no edits left must not still read "edited"');
    assert.equal(accepted.body.plan!.status, 'proposed');
    assert.deepEqual(
      after!.plan.scheduled.map((item) => item.interval.startsAt).sort(),
      proposal.plan.scheduled.map((item) => item.interval.startsAt).sort(),
    );
  });
});

/**
 * The half of `PlanEdits` an acceptance must NOT discard.
 *
 * A removal is a bare item id: it needed no placement to be valid and a
 * reschedule does not make it stale. And the user cannot possibly have
 * consented to its return, because the diff is computed against the *stored*
 * plan — which still contains the removed item — so it shows as `unchanged`
 * and the review surface never mentions it. Resetting `edits` wholesale puts
 * work back on somebody's day that they took off it.
 */
test('accepting the proposal keeps the removals the user made', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const removed = before!.plan.scheduled[1]!.itemId;
    assert.equal((await act('edit', USER, { removals: [removed] })).status, 200);
    const afterEdit = await get();
    assert.ok(!afterEdit.body.plan!.scheduled.some((item) => item.itemId === removed), 'the removal must take effect');

    const { proposal } = await offerProposal(storage);
    // The premise: the patch the user is shown says nothing about the removed
    // item, because the diff is taken against the un-edited stored plan.
    const named = proposal.diff.changes.find((change) => change.itemId === removed);
    assert.equal(named?.kind, 'moved', 'this case only bites while the diff is computed against the stored plan');

    const accepted = await act('accept_proposal');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok(
      !accepted.body.plan!.scheduled.some((item) => item.itemId === removed),
      'accepting a patch must not put back an item the user removed',
    );

    const after = await readStoredPlan(USER, DATE, storage);
    assert.deepEqual([...after!.edits.removals], [removed]);
    assert.deepEqual(after!.edits.moves, []);
    assert.equal(after!.status, 'edited', 'a removal still standing is still an edit');
    assert.equal((await get()).body.plan!.edited, true);
  });
});

/* ── What the acceptance does to the blocks ──────────────────────── */

test('a block the patch leaves unscheduled loses its placement and keeps its provenance', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const moved = before!.plan.scheduled[0]!.itemId;
    // A user placement, so there is real provenance for the acceptance to destroy.
    assert.equal((await act('edit', USER, { moves: [{ itemId: moved, startsAt: FREE_SLOT }] })).status, 200);
    const edited = await readStoredPlan(USER, DATE, storage);
    const beforeBlock = edited!.blocks.find((block) => block.source.id === moved)!;
    assert.equal(beforeBlock.lastPlacedBy, 'user');
    const beforeGeneration = beforeBlock.lastPlanGeneration;

    await offerProposal(storage, USER, (stored) => {
      const plan = patchPlan(stored.plan, { unschedule: [moved] });
      return { plan, diff: diffPlans(stored.plan, plan) };
    });
    assert.equal((await act('accept_proposal')).status, 200);

    const after = await readStoredPlan(USER, DATE, storage);
    const block = after!.blocks.find((candidate) => candidate.source.id === moved);
    assert.ok(block, 'an unscheduled item still has a block; that is #521\'s whole point');
    assert.equal(block.currentInterval, null, 'the patch does not place it, so it holds no placement');
    assert.equal(block.lastPlacedBy, 'user', 'the provenance of the last real placement must survive');
    assert.equal(block.lastPlanGeneration, beforeGeneration, 'an unplaced block must not claim the new generation placed it');

    const body = (await get()).body;
    assert.ok(body.plan!.scheduled.every((item) => item.itemId !== moved));
  });
});

test('a block the patch accounts for in neither list is dropped, and its protection with it', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const gone = before!.plan.scheduled[2]!.itemId;
    const block = before!.blocks.find((candidate) => candidate.source.id === gone)!;
    assert.equal((await act('protect', USER, {
      blockId: block.blockId, ownership: 'protected_flexible', maxShiftMinutes: 30,
    })).status, 200);
    const protectedBody = await get();
    assert.equal(protectedBody.body.plan!.protections.length, 1);

    // A deleted commitment: the patch neither places it nor reports it unplaced.
    await offerProposal(storage, USER, (stored) => {
      const plan = patchPlan(stored.plan, { drop: [gone] });
      return { plan, diff: diffPlans(stored.plan, plan) };
    });
    assert.equal((await act('accept_proposal')).status, 200);

    const after = await readStoredPlan(USER, DATE, storage);
    assert.ok(
      !after!.blocks.some((candidate) => candidate.source.id === gone),
      'a block for work the plan does not account for is #521\'s orphan, and must not be stored',
    );
    assert.deepEqual(
      (await get()).body.plan!.protections,
      [],
      'a protection row for an item in neither list would be a row the client cannot render',
    );
  });
});

test('a protected block the patch re-places keeps its protection', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const kept = before!.plan.scheduled[0]!.itemId;
    const block = before!.blocks.find((candidate) => candidate.source.id === kept)!;
    assert.equal((await act('protect', USER, {
      blockId: block.blockId, ownership: 'protected_flexible', maxShiftMinutes: 45,
    })).status, 200);

    const { proposal } = await offerProposal(storage);
    assert.equal((await act('accept_proposal')).status, 200);

    const after = await readStoredPlan(USER, DATE, storage);
    const moved = after!.blocks.find((candidate) => candidate.source.id === kept);
    assert.ok(moved?.protection, 'a reschedule is not a release: #522\'s declaration must survive');
    assert.equal(moved.protection.ownership, 'protected_flexible');
    assert.equal(moved.protection.maxShiftMinutes, 45);
    // Re-anchored, exactly as a user's own drag re-anchors it. A preference
    // still naming the old hour is a state `withinMaxShift` rejects, and the
    // next regeneration would pull the item back and undo the approval.
    assert.deepEqual(
      moved.protection.preferredInterval,
      proposal.plan.scheduled.find((item) => item.itemId === kept)!.interval,
      'accepting a move must become the new preferred placement',
    );
    assert.deepEqual(
      moved.currentInterval,
      proposal.plan.scheduled.find((item) => item.itemId === kept)!.interval,
      'and it must actually have been re-placed, or this asserts nothing',
    );

    const rows = (await get()).body.plan!.protections;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.blockId, block.blockId);
  });
});

test('accepting when there is nothing on offer is 422, not a silent no-op', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const { status, body } = await act('accept_proposal');
    assert.equal(status, 422);
    assert.equal(body.reason, 'no_proposal');
    assert.deepEqual(await readStoredPlan(USER, DATE, storage), before, 'the stored plan must be unchanged');
  });
});

/* ── 3. Rejecting it ─────────────────────────────────────────────── */

test('rejecting the proposal clears it and leaves the plan exactly as it was', async () => {
  await withHarness(async ({ storage }) => {
    const { stored } = await offerProposal(storage);

    const { status, body } = await act('reject_proposal');
    assert.equal(status, 200);
    assert.equal(body.proposal, null);

    const after = await readStoredPlan(USER, DATE, storage);
    assert.ok(after);
    assert.equal(after.proposal ?? null, null);
    // Everything but the offer, the timestamp and the memory of the answer
    // (#587) is byte-for-byte the plan that was there: a rejection is a
    // decision about the offer, not the day.
    assert.deepEqual(
      { ...after, proposal: null, updatedAt: '', rejectedProposals: [] },
      { ...stored, proposal: null, updatedAt: '', rejectedProposals: [] },
    );
    assert.equal((await get()).body.proposal, null);
  });
});

/*
 * #587: the answer is the person's, and it is written down.
 *
 * Until #587 a rejection appended nothing and an acceptance appended only
 * `plan_regenerated`, the type that means "the system did this". The test
 * that stood here asserted that silence. These replace it.
 */
test('rejecting the proposal appends the person\'s decision to the plan ledger (#587)', async () => {
  await withHarness(async ({ storage }) => {
    const { stored, proposal } = await offerProposal(storage);
    const before = await listPlanEvents(USER, storage);

    assert.equal((await act('reject_proposal')).status, 200);

    const added = (await listPlanEvents(USER, storage)).filter((event) => !before.some((old) => old.id === event.id));
    assert.deepEqual(added.map((event) => event.type), ['plan_proposal_rejected'], 'a rejection is exactly one ledger entry');
    const [decision] = added;
    assert.equal(decision!.date, DATE);
    assert.equal(decision!.proposalId, 'prp_review');
    // The base the patch was solved against, which is what the offer's own
    // `plan_proposed` entry carries, so the answer joins to the offer.
    assert.equal(decision!.generation, stored.generation);
    assert.equal(decision!.inputDigest, stored.inputDigest);
    assert.deepEqual([...(decision!.causeChangeIds ?? [])], ['chg-calendar-moved']);
    assert.equal(decision!.proposalFingerprint, proposalFingerprint(proposal.plan));

    // And the plan remembers the declined placement for the replan tick.
    const after = await readStoredPlan(USER, DATE, storage);
    assert.deepEqual(after!.rejectedProposals, [{
      baseGeneration: stored.generation,
      baseInputDigest: stored.inputDigest,
      fingerprint: proposalFingerprint(proposal.plan),
    }]);
  });
});

test('accepting the proposal appends the person\'s decision beside the new generation (#587)', async () => {
  await withHarness(async ({ storage }) => {
    const { stored } = await offerProposal(storage);
    const before = await listPlanEvents(USER, storage);

    assert.equal((await act('accept_proposal')).status, 200);

    const added = (await listPlanEvents(USER, storage)).filter((event) => !before.some((old) => old.id === event.id));
    assert.deepEqual(
      added.map((event) => event.type).sort(),
      ['plan_proposal_accepted', 'plan_regenerated'],
      'one system fact (a new generation) and one decision (the person said yes), nothing else',
    );
    const decision = added.find((event) => event.type === 'plan_proposal_accepted')!;
    const regenerated = added.find((event) => event.type === 'plan_regenerated')!;

    assert.equal(decision.proposalId, 'prp_review');
    assert.equal(decision.date, DATE);
    assert.equal(decision.generation, stored.generation, 'the decision names the base it answered');
    assert.equal(decision.inputDigest, stored.inputDigest);
    // The Trust surface's join: "you accepted a change caused by X".
    assert.deepEqual([...(decision.causeChangeIds ?? [])], ['chg-calendar-moved']);

    // The generation chain is unbroken: the installed generation still has
    // its own `plan_regenerated`, carrying the same causes.
    assert.equal(regenerated.generation, stored.generation + 1);
    assert.deepEqual([...(regenerated.causeChangeIds ?? [])], ['chg-calendar-moved']);
    assert.equal(regenerated.at, decision.at, 'one act, one instant');
  });
});

test('a decision entry carries ids, hashes, dates and cause ids, and no words (#587)', async () => {
  for (const action of ['accept_proposal', 'reject_proposal'] as const) {
    await withHarness(async ({ storage }) => {
      await offerProposal(storage);
      assert.equal((await act(action)).status, 200);
      const decision = (await listPlanEvents(USER, storage))
        .find((event) => event.type === 'plan_proposal_accepted' || event.type === 'plan_proposal_rejected');
      assert.ok(decision, `${action} wrote no decision`);
      const allowed = ['at', 'causeChangeIds', 'date', 'generation', 'id', 'inputDigest', 'proposalId', 'type',
        ...(action === 'reject_proposal' ? ['proposalFingerprint'] : [])];
      assert.deepEqual(Object.keys(decision).sort(), allowed.sort(), `${action}: an unexpected field on a ledger entry`);
      const text = JSON.stringify(decision);
      for (const title of ['Write the summary', 'Call the bank', 'Book the train']) {
        assert.ok(!text.includes(title), `${action}: a title reached the ledger`);
      }
      // Neither does any interval: the fingerprint stands in for the placement.
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text.replace(`"at":"${decision.at}"`, '')), `${action}: an instant other than \`at\` reached the ledger`);
    });
  }
});

/**
 * The type names the actor, the way every other entry in the plan ledger does
 * (`plan_accepted`, `plan_edited`, `plan_dismissed` carry no actor field). That
 * only holds if nothing but a person's own request can write one, so this pins
 * the writers: one function each, reachable only from the authenticated
 * actions route. A replan tick, a job or a watcher that started writing one
 * would turn "the person decided" into a claim.
 */
test('only the person\'s own accept and reject write a decision entry (#587)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sources: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const relative = join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(entry.name)) sources.push({ file: relative, text: readFileSync(join(root, relative), 'utf8') });
    }
  };
  walk('lib');
  walk('src');

  const writers = sources.filter(({ text }) => /type:\s*'plan_proposal_(accepted|rejected)'/.test(text)).map(({ file }) => file);
  assert.deepEqual(writers, [join('lib', 'services', 'dailyPlan', 'planActions.ts')]);
  const actions = sources.find(({ file }) => file === writers[0])!.text;
  const within = (name: string, type: string): boolean => {
    const start = actions.indexOf(`export async function ${name}(`);
    const end = actions.indexOf('\nexport ', start + 1);
    return start >= 0 && actions.slice(start, end).includes(`type: '${type}'`);
  };
  assert.ok(within('acceptPlanProposal', 'plan_proposal_accepted'));
  assert.ok(within('rejectPlanProposal', 'plan_proposal_rejected'));
  assert.equal(actions.split("type: 'plan_proposal_").length - 1, 2, 'one writer each');

  const callers = sources
    // Importers, not mentions: a comment naming the function calls nothing.
    .filter(({ file, text }) => file !== writers[0]
      && /import\s*(type\s*)?\{[^}]*\b(acceptPlanProposal|rejectPlanProposal)\b[^}]*\}\s*from/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(callers, [join('src', 'app', 'api', 'mobile', 'plans', '[date]', 'actions', 'route.ts')]);
});

test('the answer commits in the same transaction as the plan it changes (#587)', async () => {
  for (const action of ['accept_proposal', 'reject_proposal'] as const) {
    await withHarness(async ({ storage }) => {
      await offerProposal(storage);
      // A write to the ledger outside a transaction fails. The answer must
      // still land, entry and all, because it never takes that path.
      const outsideOnly = new Proxy(storage, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === 'set') {
            return async (path: string, data: unknown) => {
              if (path.includes('/planEvents/')) throw new Error('a ledger entry was written outside the transaction');
              return target.set(path, data);
            };
          }
          return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
        },
      }) as StorageAdapter;
      const { acceptPlanProposal, rejectPlanProposal } = await import('../../lib/services/dailyPlan/planActions.ts');
      const answer = action === 'accept_proposal' ? acceptPlanProposal : rejectPlanProposal;
      await answer(USER, DATE, { storage: outsideOnly, now: () => new Date(PROPOSED_AT) });
      const types = (await listPlanEvents(USER, storage)).map((event) => event.type);
      assert.ok(
        types.includes(action === 'accept_proposal' ? 'plan_proposal_accepted' : 'plan_proposal_rejected'),
        `${action}: the decision did not commit with the plan`,
      );
    });
  }
});

test('a transaction that retries writes the decision once (#587)', async () => {
  await withHarness(async ({ storage }) => {
    await offerProposal(storage);
    const memory = storage as MemoryStorageAdapter;
    // The first attempt loses to a writer that touches nothing the patch is
    // pinned to, so the retry succeeds. Its ledger rows must not be doubled.
    memory.setBeforeCommitHookForTests(async ({ attempt }) => {
      if (attempt !== 1) return;
      const current = await readStoredPlan(USER, DATE, storage);
      await storage.set<StoredDailyPlan>(planPath(USER, DATE), { ...current!, updatedAt: '2026-09-15T09:31:00.000Z' });
    });
    try {
      assert.equal((await act('accept_proposal')).status, 200);
    } finally {
      memory.setBeforeCommitHookForTests(null);
    }
    const types = (await listPlanEvents(USER, storage)).map((event) => event.type);
    assert.equal(types.filter((type) => type === 'plan_proposal_accepted').length, 1);
    assert.equal(types.filter((type) => type === 'plan_regenerated').length, 1);
  });
});

test('a refused acceptance writes no decision (#587)', async () => {
  await withHarness(async ({ storage }) => {
    const { stored } = await offerProposal(storage);
    // Orphan the patch: its base digest no longer matches the plan.
    await storage.set<StoredDailyPlan>(planPath(USER, DATE), { ...stored, inputDigest: 'sha256-moved' });
    const before = await listPlanEvents(USER, storage);
    assert.equal((await act('accept_proposal')).status, 422);
    assert.deepEqual(await listPlanEvents(USER, storage), before, 'a refusal is not a decision');
  });
});

/*
 * #587, the council's gate before #611: a rejected patch is not raised again.
 *
 * Driven through the real tick (`runContinuousReplanTick`) with a real busy
 * block and real change rows, because the defect lives in what the tick does
 * after a rejection: the rejection clears the offer, the meeting is still on
 * the tasks the person chose to leave where they are, and so the next change
 * row about that meeting solves to the very patch they declined.
 */

const CALENDAR = 'device:calendar-1';
/** A two-hour meeting over the three morning tasks: a big shift, which every
 *  control mode short of `silent_auto` asks about rather than applies. */
const MEETING: TimeInterval = { startsAt: `${DATE}T06:00:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` };

async function syncCalendar(storage: StorageAdapter, blocks: ReadonlyArray<{ blockId: string; interval: TimeInterval }>): Promise<void> {
  await replaceBusyBlocksAsFixture(
    USER,
    CALENDAR,
    { startsAt: `${DATE}T00:00:00.000Z`, endsAt: '2026-09-17T00:00:00.000Z' },
    blocks.map((block) => ({
      blockId: block.blockId,
      sourceId: CALENDAR,
      sourceKind: 'device' as const,
      startAt: block.interval.startsAt,
      endAt: block.interval.endsAt,
      allDay: false,
    })),
    { storage },
  );
}

/** A change row, stored where a calendar producer stores one and the tick drains it. */
async function calendarChange(storage: StorageAdapter, changeId: string, entityId: string): Promise<void> {
  const change: PlanningStateChange = {
    schemaVersion: 'planning-state-change-v1',
    changeId,
    scopeId: USER,
    source: 'calendar',
    entityId,
    occurredAt: MORNING.toISOString(),
    changedFields: ['interval', 'blocking'],
    beforeDigest: null,
    afterDigest: `digest-${entityId}`,
    provenanceRef: 'calendar:refresh-1',
  };
  await storage.set(userSubDoc(USER, PLANNING_STATE_CHANGES, docIdForKey(changeId)), change);
}

function minutesAfterMorning(minutes: number): Date {
  return new Date(MORNING.getTime() + minutes * 60_000);
}

/** The meeting lands, the tick proposes, the person says no. Returns the declined patch. */
async function proposeThenReject(storage: StorageAdapter): Promise<StoredPlanProposal> {
  await syncCalendar(storage, [{ blockId: 'busy-meeting', interval: MEETING }]);
  await calendarChange(storage, 'chg-meeting', 'busy-meeting');
  const first = await runContinuousReplanTick({ storage, now: MORNING });
  assert.equal(first.proposed, 1, `fixture: the meeting must earn a proposal: ${JSON.stringify(first)}`);
  const offered = (await readStoredPlan(USER, DATE, storage))!.proposal;
  assert.ok(offered, 'fixture: the tick stored no proposal');
  await rejectPlanProposal(USER, DATE, { storage, now: () => minutesAfterMorning(1) });
  assert.equal((await readStoredPlan(USER, DATE, storage))!.proposal ?? null, null);
  return offered;
}

function proposalsIn(events: readonly { type: string }[]): number {
  return events.filter((event) => event.type === 'plan_proposed').length;
}

test('a rejected patch is not raised again when the same change is delivered again (#587)', async () => {
  await withHarness(async ({ storage }) => {
    await proposeThenReject(storage);
    const ledger = await listPlanEvents(USER, storage);

    // A producer retry: the very same change row, again.
    await calendarChange(storage, 'chg-meeting', 'busy-meeting');
    const again = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    // The premise: the tick really did solve again, and to the same patch.
    assert.equal(again.replanRequired, 1, `the meeting still overlaps the tasks: ${JSON.stringify(again)}`);

    assert.equal((await readStoredPlan(USER, DATE, storage))!.proposal ?? null, null, 'the declined patch was offered again');
    assert.equal(proposalsIn(await listPlanEvents(USER, storage)), proposalsIn(ledger), 'no second offer in the ledger');
    // A decision, not a lost race: the row is drained, not held for every
    // tick to re-solve and re-decline.
    assert.equal((await storage.list(userCol(USER, PLANNING_STATE_CHANGES))).length, 0);
  });
});

test('a rejected patch is not raised again by a re-sync of the same meeting under a new change id (#587)', async () => {
  await withHarness(async ({ storage }) => {
    const declined = await proposeThenReject(storage);

    // A bulk re-sync: the same meeting, announced by a new row.
    await syncCalendar(storage, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await calendarChange(storage, 'chg-meeting-resync', 'busy-meeting');
    const again = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    assert.equal(again.replanRequired, 1, `the premise: the tick solved again: ${JSON.stringify(again)}`);

    const after = await readStoredPlan(USER, DATE, storage);
    assert.equal(after!.proposal ?? null, null, 'the declined patch was offered again under a new change id');
    assert.equal(after!.generation, declined.baseGeneration, 'and nothing was applied in its place');
  });
});

test('a rejection that lands while the tick is solving still stops the same patch (#587)', async () => {
  await withHarness(async ({ storage }) => {
    await syncCalendar(storage, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await calendarChange(storage, 'chg-meeting', 'busy-meeting');
    assert.equal((await runContinuousReplanTick({ storage, now: MORNING })).proposed, 1);

    // The same meeting again, and this time the person's "no" commits after
    // the tick has read the plan and solved, just before it stores the patch.
    await calendarChange(storage, 'chg-meeting-resync', 'busy-meeting');
    const raced = racedStorage(storage, async () => {
      await rejectPlanProposal(USER, DATE, { storage, now: () => minutesAfterMorning(4) });
    });
    await runContinuousReplanTick({ storage: raced, now: minutesAfterMorning(5) });

    assert.equal(
      (await readStoredPlan(USER, DATE, storage))!.proposal ?? null,
      null,
      'the guard must read the rejection inside the write, not before it',
    );
  });
});

test('after a rejection, a patch that places things differently is still offered (#587)', async () => {
  await withHarness(async ({ storage }) => {
    const declined = await proposeThenReject(storage);

    // A second meeting that overlaps a task still on the visible day (so it
    // earns a replan) and runs into the hour the declined patch would have
    // used (so the next solve must place the tasks somewhere else).
    const next: TimeInterval = { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T09:00:00.000Z` };
    await syncCalendar(storage, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-next', interval: next }]);
    await calendarChange(storage, 'chg-next', 'busy-next');
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });

    const offered = (await readStoredPlan(USER, DATE, storage))!.proposal;
    assert.ok(offered, 'the guard must not mute every later offer, only the declined one');
    assert.notEqual(proposalFingerprint(offered.plan), proposalFingerprint(declined.plan));
  });
});

test('rejecting when there is nothing on offer is 422', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const { status, body } = await act('reject_proposal');
    assert.equal(status, 422);
    assert.equal(body.reason, 'no_proposal');
    assert.deepEqual(await readStoredPlan(USER, DATE, storage), before);
  });
});

/**
 * The four diff kinds `shiftedPlan` can never produce.
 *
 * `proposalChangeDto` flattens five variants with different keys onto one row,
 * and a fixture that only ever moves things leaves four of the five branches
 * unexecuted — including the one that reads `from`/`to` as reason *codes*
 * rather than as intervals.
 */
test('every kind of diff row is mapped, not just the moved one', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const [first, second, third] = before!.plan.scheduled;
    const at = { startsAt: third!.interval.startsAt, endsAt: third!.interval.endsAt };
    await offerProposal(storage, USER, (stored) => ({
      diff: {
        sameInputDigest: false,
        changes: [
          { kind: 'added', itemId: first!.itemId, to: at },
          { kind: 'removed', itemId: second!.itemId, from: at },
          { kind: 'unchanged', itemId: third!.itemId, at },
          { kind: 'reason_changed', itemId: 'cmt_absent', from: 'NO_FEASIBLE_SLOT', to: 'HORIZON_EXHAUSTED' },
        ],
      },
      plan: stored.plan,
    }));

    const rows = (await get()).body.proposal!.changes;
    assert.deepEqual(rows.map((row) => row.kind), ['added', 'removed', 'unchanged', 'reason_changed']);

    const [added, removed, unchanged, reason] = rows;
    assert.deepEqual(added!.to, at);
    assert.equal(added!.from, null);
    assert.equal(added!.shiftMinutes, null);
    assert.equal(typeof added!.title, 'string', 'a diff row names an item, so it carries the item\'s title');

    assert.deepEqual(removed!.from, at);
    assert.equal(removed!.to, null);

    assert.deepEqual(unchanged!.to, at, 'an unchanged row states where it stays');
    assert.equal(unchanged!.from, null);

    // The one row whose `from`/`to` are reason codes and not intervals.
    assert.equal(reason!.from, null);
    assert.equal(reason!.to, null);
    assert.equal(reason!.fromReasonCode, 'NO_FEASIBLE_SLOT');
    assert.equal(reason!.toReasonCode, 'HORIZON_EXHAUSTED');
    assert.equal(reason!.title, null, 'an item the commitments no longer name reads as null, not as a blank');
    for (const row of [added, removed, unchanged]) {
      assert.equal(row!.fromReasonCode, null);
      assert.equal(row!.toReasonCode, null);
    }
  });
});

/* ── 4. A base that has moved, on each half separately ───────────── */

/**
 * Writes a proposal whose base does not match the document, the way a writer
 * that forgot to clear the field would leave one. `storePlanProposal` refuses
 * to create this state, which is the point: the guards exist for the state no
 * supported writer produces.
 */
async function plantOrphan(
  storage: StorageAdapter,
  move: (stored: StoredDailyPlan) => Partial<StoredDailyPlan>,
): Promise<StoredDailyPlan> {
  const { stored } = await offerProposal(storage);
  const moved: StoredDailyPlan = { ...stored, ...move(stored) };
  await storage.set<StoredDailyPlan>(planPath(USER, DATE), moved);
  return moved;
}

test('a proposal whose base GENERATION has moved is neither shown nor acceptable', async () => {
  await withHarness(async ({ storage }) => {
    const moved = await plantOrphan(storage, (stored) => ({ generation: stored.generation + 1 }));

    assert.equal((await get()).body.proposal, null, 'a patch of a generation that is gone is not an offer');

    const { status, body } = await act('accept_proposal');
    assert.equal(status, 422);
    assert.equal(body.reason, 'stale_proposal');
    const after = await readStoredPlan(USER, DATE, storage);
    assert.equal(after!.generation, moved.generation, 'a refused acceptance writes nothing');
    assert.deepEqual(after!.plan.scheduled, moved.plan.scheduled);
  });
});

test('a proposal whose base INPUT DIGEST has moved is neither shown nor acceptable', async () => {
  await withHarness(async ({ storage }) => {
    // The generation is deliberately left alone: this is the case a
    // generation-only compare-and-set cannot see.
    const moved = await plantOrphan(storage, () => ({ inputDigest: 'sha256-something-else-entirely' }));
    assert.equal(moved.generation, moved.proposal!.baseGeneration, 'the generation must still match, or this proves nothing');

    assert.equal((await get()).body.proposal, null);

    const { status, body } = await act('accept_proposal');
    assert.equal(status, 422);
    assert.equal(body.reason, 'stale_proposal');
    const after = await readStoredPlan(USER, DATE, storage);
    assert.equal(after!.generation, moved.generation, 'a refused acceptance writes nothing');
    assert.deepEqual(after!.plan.scheduled, moved.plan.scheduled);
  });
});

/**
 * A storage adapter that lets one writer land between the read and the
 * guarded write.
 *
 * `acceptPlanProposal` reads the plan outside a transaction and then writes it
 * inside one. Everything above refuses before the write is ever reached, which
 * says nothing about the write's own guard — so this moves the document at
 * exactly the moment the transaction opens, which is the state
 * `replaceStoredPlanIfBaseMatches` exists for.
 */
function racedStorage(storage: StorageAdapter, onceBefore: () => Promise<void>): StorageAdapter {
  let fired = false;
  return new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'runTransaction') {
        return async (...args: unknown[]) => {
          if (!fired) { fired = true; await onceBefore(); }
          return (value as (...rest: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
    },
  }) as StorageAdapter;
}

test('a concurrent writer that changes only the input digest defeats the acceptance', async () => {
  await withHarness(async ({ storage }) => {
    const { stored } = await offerProposal(storage);
    const { acceptPlanProposal, PlanProposalRejected } = await import('../../lib/services/dailyPlan/planActions.ts');

    const raced = racedStorage(storage, async () => {
      const current = await readStoredPlan(USER, DATE, storage);
      // Generation untouched. A generation-only guard here would let the patch
      // overwrite a plan it was never solved against.
      await storage.set<StoredDailyPlan>(planPath(USER, DATE), { ...current!, inputDigest: 'sha256-raced' });
    });

    await assert.rejects(
      () => acceptPlanProposal(USER, DATE, { storage: raced, now: () => new Date(PROPOSED_AT) }),
      (error: unknown) => error instanceof PlanProposalRejected && error.reason === 'stale_proposal',
      'the guarded write must refuse a base whose digest moved under it',
    );

    const after = await readStoredPlan(USER, DATE, storage);
    assert.equal(after!.generation, stored.generation, 'nothing may have been written');
    assert.deepEqual(after!.plan.scheduled, stored.plan.scheduled);
  });
});

/* ── 5. Each of the four mutators orphans the patch ──────────────── */

/**
 * Walked one mutator at a time, and each asserts the two halves that matter:
 * the read surface no longer offers it, and the accept action reports there is
 * nothing to accept. Neither number the patch is pinned to moves in any of
 * these cases, so a reader that only compared `(generation, inputDigest)`
 * would go on presenting every one of them.
 */
const ORPHANING_MUTATORS: ReadonlyArray<{
  readonly name: string;
  readonly run: (storage: StorageAdapter, stored: StoredDailyPlan) => Promise<void>;
}> = [
  {
    name: 'accept',
    async run() { assert.equal((await act('accept')).status, 200); },
  },
  {
    name: 'dismiss',
    async run() { assert.equal((await act('dismiss')).status, 200); },
  },
  {
    name: 'edit',
    async run(_storage, stored) {
      const first = stored.plan.scheduled[0]!;
      const outcome = await act('edit', USER, { moves: [{ itemId: first.itemId, startsAt: FREE_SLOT }] });
      assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
    },
  },
  {
    name: 'protect',
    async run(_storage, stored) {
      const block = stored.blocks.find((candidate) => candidate.mobility === 'flexible');
      assert.ok(block, 'the fixture must have a flexible block to protect');
      const outcome = await act('protect', USER, {
        blockId: block.blockId,
        ownership: 'protected_flexible',
        maxShiftMinutes: 30,
      });
      assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
    },
  },
];

for (const mutator of ORPHANING_MUTATORS) {
  test(`a proposal the "${mutator.name}" action has orphaned is not presented as actionable`, async () => {
    await withHarness(async ({ storage }) => {
      const { stored } = await offerProposal(storage);
      const generationBefore = stored.generation;
      const digestBefore = stored.inputDigest;

      await mutator.run(storage, stored);

      const after = await readStoredPlan(USER, DATE, storage);
      assert.ok(after);
      // The premise: neither pinned number moved, so nothing downstream could
      // have told the patch apart from a live one.
      assert.equal(after.generation, generationBefore, `"${mutator.name}" must not move the generation`);
      assert.equal(after.inputDigest, digestBefore, `"${mutator.name}" must not move the input digest`);

      assert.equal(after.proposal ?? null, null, `"${mutator.name}" must clear the patch it invalidated`);
      assert.equal((await get()).body.proposal, null, `"${mutator.name}" must leave nothing on offer`);

      const attempt = await act('accept_proposal');
      assert.equal(attempt.status, 422, `"${mutator.name}" must leave nothing to accept`);
      assert.equal(attempt.body.reason, 'no_proposal');
    });
  });
}

test('a repeated protection that changes nothing keeps the offer it did not invalidate', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const block = before!.blocks.find((candidate) => candidate.mobility === 'flexible')!;
    assert.equal((await act('protect', USER, {
      blockId: block.blockId, ownership: 'protected_flexible', maxShiftMinutes: 30,
    })).status, 200);

    await offerProposal(storage);
    // The same protection again: the idempotent branch writes nothing, so it
    // has invalidated nothing either.
    assert.equal((await act('protect', USER, {
      blockId: block.blockId, ownership: 'protected_flexible', maxShiftMinutes: 30,
    })).status, 200);

    assert.ok((await get()).body.proposal, 'a no-op protection must not throw away a live offer');
  });
});

/* ── The lost update accept's own transaction must not allow ─────── */

/**
 * The race the `(generation, inputDigest)` guard is blind to.
 *
 * The existing race case lands a writer that changes the digest, which is the
 * one thing such a guard can see. The dangerous writer is the ordinary one:
 * `editPlan` moves neither number, so a document assembled before it landed
 * passes every compare-and-set and then overwrites the edit with pre-read
 * values — the removal destroyed, the status reverted, and the patch installed
 * on a plan that had just been edited under it.
 *
 * Nothing here is exotic: it is one phone editing while another taps Accept.
 */
test('an edit that lands between the read and the write is not clobbered by the acceptance', async () => {
  await withHarness(async ({ storage }) => {
    const { stored } = await offerProposal(storage);
    const removed = stored.plan.scheduled[1]!.itemId;
    const { acceptPlanProposal, PlanProposalRejected, editPlan } =
      await import('../../lib/services/dailyPlan/planActions.ts');

    const raced = racedStorage(storage, async () => {
      // A real edit through the real mutator, on the real storage.
      await editPlan(USER, DATE, { moves: [], removals: [removed] }, { storage });
    });

    // The outcome is captured rather than asserted first, so that the state of
    // the user's data is what fails when it is wrong. A lost update that also
    // reported success would otherwise be diagnosed as "no rejection thrown",
    // which names the symptom furthest from the damage.
    const failure: unknown = await acceptPlanProposal(USER, DATE, { storage: raced, now: () => new Date(PROPOSED_AT) })
      .then(() => null, (error: unknown) => error);

    const after = await readStoredPlan(USER, DATE, storage);
    assert.ok(after);
    assert.deepEqual([...after.edits.removals], [removed], 'the concurrent removal must survive');
    assert.equal(after.status, 'edited', 'the concurrent status change must survive');
    assert.equal(after.generation, stored.generation, 'the patch must not have been installed');
    assert.deepEqual(after.plan.scheduled, stored.plan.scheduled);
    assert.equal(after.proposal ?? null, null);
    assert.ok(
      failure instanceof PlanProposalRejected && failure.reason === 'no_proposal',
      'the edit orphaned the patch, so there is nothing left to accept',
    );

    // And the user still sees their edit, not the pre-read plan.
    const body = (await get()).body;
    assert.ok(!body.plan!.scheduled.some((item) => item.itemId === removed));
    assert.equal(body.proposal, null);
  });
});

/* ── What the patch would do to a protected hour ─────────────────── */

test('the proposal discloses the protections it would override', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const item = before!.plan.scheduled[0]!;
    const block = before!.blocks.find((candidate) => candidate.source.id === item.itemId)!;
    assert.equal((await act('protect', USER, {
      blockId: block.blockId, ownership: 'protected_flexible', maxShiftMinutes: 45,
    })).status, 200);

    // The default patch shifts everything by an hour — past a 45-minute bound.
    const { proposal } = await offerProposal(storage);
    const rows = (await get()).body.proposal!.protections;
    assert.equal(rows.length, 1, 'only protected blocks appear, as in the plan DTO');
    const row = rows[0]!;
    assert.equal(row.blockId, block.blockId);
    assert.equal(row.itemId, item.itemId);
    assert.equal(typeof row.title, 'string', 'a consent surface needs to name the thing being moved');
    assert.deepEqual(row.preferredInterval, item.interval, 'what the user asked to keep');
    assert.equal(row.maxShiftMinutes, 45);
    assert.deepEqual(
      row.proposedInterval,
      proposal.plan.scheduled.find((entry) => entry.itemId === item.itemId)!.interval,
      'and where the patch would put it instead',
    );
    assert.equal(row.overridden, true, 'a 60-minute move past a 45-minute bound is an override');
  });
});

test('a proposed move inside the declared bound is disclosed and not called an override', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const item = before!.plan.scheduled[0]!;
    const block = before!.blocks.find((candidate) => candidate.source.id === item.itemId)!;
    assert.equal((await act('protect', USER, {
      blockId: block.blockId, ownership: 'protected_flexible', maxShiftMinutes: 45,
    })).status, 200);

    await offerProposal(storage, USER, (stored) => {
      const plan = patchPlan(stored.plan, { minutes: 30 });
      return { plan, diff: diffPlans(stored.plan, plan) };
    });

    const row = (await get()).body.proposal!.protections[0]!;
    assert.equal(row.maxShiftMinutes, 45);
    assert.equal(row.overridden, false, '30 minutes is inside a 45-minute bound');
    assert.notDeepEqual(row.proposedInterval, row.preferredInterval, 'it still moved, and is still disclosed');
  });
});

test('a protected block the patch would leave unplaced is the strongest override', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const item = before!.plan.scheduled[0]!;
    const block = before!.blocks.find((candidate) => candidate.source.id === item.itemId)!;
    assert.equal((await act('protect', USER, {
      blockId: block.blockId, ownership: 'protected_flexible', maxShiftMinutes: null,
    })).status, 200);

    await offerProposal(storage, USER, (stored) => {
      const plan = patchPlan(stored.plan, { unschedule: [item.itemId] });
      return { plan, diff: diffPlans(stored.plan, plan) };
    });

    const row = (await get()).body.proposal!.protections[0]!;
    assert.equal(row.proposedInterval, null);
    assert.equal(
      row.overridden,
      true,
      'an unbounded protection would satisfy withinMaxShift; taking the placement away entirely must not read as "kept"',
    );
  });
});

/* ── 6. Account isolation ────────────────────────────────────────── */

test('one account\'s proposal is invisible and unacceptable to another', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(OTHER, storage);
    await offerProposal(storage);

    const mine = await get(USER);
    assert.ok(mine.body.proposal, 'the owner must see their own offer');

    const theirs = await get(OTHER);
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.proposal, null, 'the same date for another account carries no offer');

    const attempt = await act('accept_proposal', OTHER);
    assert.equal(attempt.status, 422);
    assert.equal(attempt.body.reason, 'no_proposal');

    // And the owner's offer survived the other account touching the same date.
    const still = await readStoredPlan(USER, DATE, storage);
    assert.equal(still!.proposal?.proposalId, 'prp_review');
    assert.ok((await get(USER)).body.proposal);
  });
});
