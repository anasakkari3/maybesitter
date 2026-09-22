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
import {
  listPlanEvents,
  planPath,
  readStoredPlan,
  storePlanProposal,
  type StoredDailyPlan,
  type StoredPlanProposal,
} from '../../lib/services/dailyPlan/planStore.ts';
import { diffPlans } from '../../lib/planning/scheduler/index.ts';
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
  try {
    await seedAccount(USER, storage);
    await fn({
      storage,
      auth,
      teardown() { /* handled below */ },
    });
  } finally {
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
    // Everything but the offer and the timestamp is byte-for-byte the plan
    // that was there: a rejection is a decision about the offer, not the day.
    assert.deepEqual(
      { ...after, proposal: null, updatedAt: '' },
      { ...stored, proposal: null, updatedAt: '' },
    );
    assert.equal((await get()).body.proposal, null);
  });
});

/**
 * Recorded so that the silence is a decision rather than an oversight.
 *
 * There is no `PlanEventType` a rejection could honestly take: `plan_dismissed`
 * says the *plan* was set aside, which is not what happened, and a sixth
 * member would force a mapping decision in `lib/services/activity` that this
 * slice does not own. So a rejection writes no ledger row, and this is the
 * assertion that will fail if somebody changes that without meaning to.
 */
test('rejecting the proposal appends nothing to the plan ledger', async () => {
  await withHarness(async ({ storage }) => {
    await offerProposal(storage);
    const before = await listPlanEvents(USER, storage);

    assert.equal((await act('reject_proposal')).status, 200);

    assert.deepEqual(await listPlanEvents(USER, storage), before, 'a rejection is not a ledger event today');
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
