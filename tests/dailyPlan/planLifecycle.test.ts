/**
 * The day's plan follows the day until the person touches it (L5).
 *
 * The owner's first-run repro: a fresh account opened «خطة اليوم», got an
 * empty plan (nothing had been captured yet), captured a few commitments, and
 * came back to the same empty plan. `buildDailyPlanOnDemand` and `GET` both
 * answered the stored document as it stood, and the only ways out were a
 * rebuild the person had to know to ask for (capped per day) or a replan
 * proposal no capture ever produces.
 *
 * Three rules are held here:
 *
 *  1. **Stale and untouched is rebuilt.** When what the plan was built from
 *     (its commitments: which are in the day, their deadlines, priorities and
 *     pinned times) differs from what they say now, and the person has not
 *     accepted, dismissed, edited or protected anything, reading the plan
 *     returns a new generation built from the current state. The rebuild does
 *     not spend the person's rebuilds.
 *  2. **Touched is never overwritten** (#626's rule). The stored plan comes
 *     back as it is, flagged `inputsChanged`, so the screen can offer the
 *     rebuild instead.
 *  3. **Timed commitments are on the plan.** A commitment pinned to a time
 *     today is a fixed row (`fixed`), not an invisible constraint.
 *
 * And the late build: `workingEndsAt` says when the day's hours end, so a plan
 * built after them can say so rather than show an empty list.
 *
 * Routes are invoked in-process on the memory adapter, as the rest of the
 * dailyPlan suite does, with the clock pinned.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, docIdForKey, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { loadDomainState, persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  type DomainState,
} from '../../src/domain/stateMachine.ts';
import { listPlanEvents, planPath, readStoredPlan, storePlanProposal, type StoredPlanProposal } from '../../lib/services/dailyPlan/planStore.ts';
import { MAX_PLAN_REBUILDS_PER_DAY } from '../../lib/services/dailyPlan/planSettings.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as buildPost } from '../../src/app/api/mobile/plans/[date]/build/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { acceptPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { refreshStalePlan } from '../../lib/services/dailyPlan/planRefresh.ts';
import { diffPlans } from '../../lib/planning/scheduler/index.ts';
import { runContinuousReplanTick } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { replaceBusyBlocksAsFixture } from '../support/busyFixtures.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { Plan, TimeInterval } from '../../src/contracts/v1/planningContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('LifecycleUser');
const DATE = '2026-09-15';
const TOMORROW = '2026-09-16';
/** 09:00 in Jerusalem. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
/** 10:00 in Jerusalem: after the capture. */
const LATER = new Date('2026-09-15T07:00:00.000Z');
/** 21:30 in Jerusalem: the fallback window (08:00–20:00) is over. */
const EVENING = new Date('2026-09-15T18:30:00.000Z');
/** 20:00 in Jerusalem on the plan's day, as an instant. */
const FALLBACK_END = '2026-09-15T17:00:00.000Z';

interface Harness { storage: StorageAdapter; auth: FakeAuthControls }

async function withHarness(fn: (harness: Harness) => Promise<void>, now: Date = MORNING): Promise<void> {
  mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  try {
    await fn({ storage, auth });
  } finally {
    auth.restore();
    resetStorageForTests();
    mock.timers.reset();
  }
}

function setClock(at: Date): void {
  mock.timers.setTime(at.getTime());
}

function request(path: string, body?: unknown): Request {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${tokenFor(USER)}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

interface PlanRow { itemId: string; title: string | null; startsAt: string; endsAt: string }
interface PlanBody {
  success: boolean;
  plan: {
    generation: number;
    status: string;
    scheduled: PlanRow[];
    unscheduled: Array<{ itemId: string; reasonCode: string }>;
    fixed: PlanRow[];
    inputsChanged: boolean;
    rebuildsLeft: number;
    workingEndsAt: string | null;
  };
}

async function readPlan(date = DATE): Promise<{ status: number; body: PlanBody }> {
  const response = await planGet(request(`/api/mobile/plans/${date}`), params(date));
  return { status: response.status, body: await response.json() as PlanBody };
}

async function build(date = DATE): Promise<{ status: number; body: PlanBody }> {
  const response = await buildPost(request(`/api/mobile/plans/${date}/build`, {}), params(date));
  return { status: response.status, body: await response.json() as PlanBody };
}

/** An account with a zone, a locale, and nothing captured yet. */
async function seedAccount(storage: StorageAdapter): Promise<void> {
  await persistParticipantState(USER, createEmptyDomainState());
  const user = await storage.get<Record<string, unknown>>(userDoc(USER));
  await storage.set(userDoc(USER), { ...(user ?? {}), timezone: TZ, locale: 'en' });
}

type TimeSpecInput =
  | { kind: 'due_by'; dueAt: string | null }
  | { kind: 'scheduled_event'; dueAt: string };

/**
 * Captures and confirms one commitment, the two domain commands the capture
 * confirmation applies, on top of whatever the account already holds.
 */
async function captureAndConfirm(
  storage: StorageAdapter,
  id: string,
  title: string,
  timeSpec: TimeSpecInput,
  at: Date,
): Promise<void> {
  let state: DomainState = await loadDomainState(storage, USER);
  const now = at.toISOString();
  const spec = timeSpec.kind === 'scheduled_event'
    ? { kind: 'scheduled_event' as const, dueAt: timeSpec.dueAt, remindAt: timeSpec.dueAt, timezone: TZ }
    : { kind: 'due_by' as const, dueAt: timeSpec.dueAt, remindAt: null, timezone: TZ };
  state = applyDomainCommand(state, {
    type: 'CreateDraft',
    now,
    commitment: { id, kind: 'task', title, timeSpec: spec },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyDomainCommand(state, { type: 'ConfirmCommitment', commitmentId: id, now, reminders: [] }).newState;
  await persistParticipantState(USER, state);
}

/** Today, 18:00 in Jerusalem. */
const DUE_TODAY = '2026-09-15T15:00:00.000Z';

type LaterCommand =
  | { type: 'Complete' }
  | { type: 'Drop' }
  | { type: 'Postpone'; postponedUntil: string };

/** One more domain command on a commitment the account holds. */
async function applyTo(storage: StorageAdapter, id: string, command: LaterCommand, at: Date): Promise<void> {
  const state = await loadDomainState(storage, USER);
  const now = at.toISOString();
  const next = command.type === 'Postpone'
    ? applyDomainCommand(state, { type: 'Postpone', commitmentId: id, postponedUntil: command.postponedUntil, now })
    : applyDomainCommand(state, { type: command.type, commitmentId: id, now });
  await persistParticipantState(USER, next.newState);
}

function shifted(interval: TimeInterval, minutes: number): TimeInterval {
  const by = (at: string) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
  return { startsAt: by(interval.startsAt), endsAt: by(interval.endsAt) };
}

/** A live replan offer on the current generation: every placement an hour later. */
async function offerShift(storage: StorageAdapter): Promise<StoredPlanProposal> {
  const stored = (await readStoredPlan(USER, DATE, storage))!;
  const plan: Plan = {
    ...stored.plan,
    scheduled: stored.plan.scheduled.map((item) => ({
      itemId: item.itemId,
      interval: shifted(item.interval, 60),
      reservedInterval: shifted(item.reservedInterval, 60),
    })),
  };
  const proposal: StoredPlanProposal = {
    proposalId: 'prp_l5',
    proposedAt: MORNING.toISOString(),
    baseGeneration: stored.generation,
    baseInputDigest: stored.inputDigest,
    plan,
    solveInputs: { constraints: stored.constraints, config: stored.config },
    diff: diffPlans(stored.plan, plan),
    reason: 'user_requires_confirmation',
    userControlMode: 'always_require_confirmation',
    causeChangeIds: ['chg-calendar-moved'],
  };
  assert.ok(await storePlanProposal(USER, DATE, proposal, storage), 'the setup is wrong: no offer stored');
  return proposal;
}

async function accept(): Promise<void> {
  const response = await actionPost(request(`/api/mobile/plans/${DATE}/actions`, { action: 'accept' }), params(DATE));
  assert.equal(response.status, 200, 'the setup is wrong: the plan was not accepted');
}

/* ── 1. The literal repro ──────────────────────────────────────── */

test('a plan built before anything was captured shows the commitment captured after it', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);

    const empty = await build();
    assert.equal(empty.status, 200);
    assert.equal(empty.body.plan.scheduled.length, 0, 'the setup is wrong: the first plan should be empty');
    assert.equal(empty.body.plan.generation, 1);

    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

    const read = await readPlan();
    assert.equal(read.status, 200);
    assert.deepEqual(
      read.body.plan.scheduled.map((row) => row.itemId),
      ['cmt_report'],
      'the plan still answers the empty day it was built for',
    );
    assert.equal(read.body.plan.generation, 2, 'the refreshed plan is not a new generation');
    assert.equal(read.body.plan.inputsChanged, false, 'a refreshed plan is current, not changed-under');
    assert.equal(read.body.plan.status, 'proposed');
    // Placed from now, not from the morning (#500).
    assert.ok(Date.parse(read.body.plan.scheduled[0]!.startsAt) >= LATER.getTime());

    const stored = await readStoredPlan(USER, DATE, storage);
    assert.equal(stored!.generation, 2);
    // No model call on a read: the refresh writes the deterministic template.
    assert.equal(stored!.explanation.source, 'template');
    assert.deepEqual(stored!.replaces?.generation, 1);
    assert.deepEqual(
      (await listPlanEvents(USER, storage)).map((event) => event.type),
      ['plan_proposed', 'plan_regenerated'],
    );
  });
});

test('the build route answers the refreshed plan too, not the stale one', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

    const again = await build();
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.plan.scheduled.map((row) => row.itemId), ['cmt_report']);
    assert.equal(again.body.plan.generation, 2);
  });
});

test('the automatic refresh does not spend the person\'s rebuilds', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

    const read = await readPlan();
    assert.equal(read.body.plan.generation, 2);
    assert.equal(read.body.plan.rebuildsLeft, MAX_PLAN_REBUILDS_PER_DAY, 'the refresh was charged as a rebuild');

    for (let rebuild = 1; rebuild <= MAX_PLAN_REBUILDS_PER_DAY; rebuild += 1) {
      const response = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, {}), params(DATE));
      assert.equal(response.status, 200, `rebuild ${rebuild} of ${MAX_PLAN_REBUILDS_PER_DAY} was refused`);
      const body = await response.json() as PlanBody;
      assert.equal(body.plan.rebuildsLeft, MAX_PLAN_REBUILDS_PER_DAY - rebuild);
    }
    const capped = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, {}), params(DATE));
    assert.equal(capped.status, 429, 'the cap stopped holding');
  });
});

test('nothing changed: reading later returns the same plan and writes nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    const first = await build();
    assert.equal(first.body.plan.scheduled.length, 1);

    // Hours later: the clock floor moved, which is not an input change.
    setClock(new Date('2026-09-15T11:07:00.000Z'));
    const read = await readPlan();
    assert.equal(read.body.plan.generation, 1, 'the passing of time alone rebuilt the plan');
    assert.equal(read.body.plan.inputsChanged, false);
    assert.equal((await listPlanEvents(USER, storage)).length, 1);
  });
});

test('a generation solved later than its generatedAt says is not stale for that alone', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    setClock(LATER);
    await build();
    // An automatic replan installs its solve over `...current` and keeps the
    // morning's `generatedAt`, so the stored request's clock floor is later
    // than the document's own timestamp. Nothing about the day changed.
    const stored = (await readStoredPlan(USER, DATE, storage))!;
    await storage.set(planPath(USER, DATE), { ...stored, generatedAt: MORNING.toISOString() });

    const read = await readPlan();
    assert.equal(read.body.plan.generation, 1, 'a clock floor alone made the plan read as stale');
    assert.equal(read.body.plan.inputsChanged, false);
  });
});

/* ── 2. Touched plans are never overwritten ───────────────────── */

test('an accepted plan is not rebuilt: it comes back as it was, flagged', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    const accepted = await actionPost(request(`/api/mobile/plans/${DATE}/actions`, { action: 'accept' }), params(DATE));
    assert.equal(accepted.status, 200);

    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

    const read = await readPlan();
    assert.equal(read.body.plan.generation, 1, 'an accepted plan was overwritten');
    assert.equal(read.body.plan.status, 'accepted');
    assert.equal(read.body.plan.scheduled.length, 0);
    assert.equal(read.body.plan.inputsChanged, true, 'the screen is not told the day changed under the plan');
  });
});

test('an edited plan is not rebuilt, and neither is a dismissed one', async () => {
  for (const touch of ['edit', 'dismiss'] as const) {
    await withHarness(async ({ storage }) => {
      await seedAccount(storage);
      await captureAndConfirm(storage, 'cmt_first', 'First thing', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
      await build();
      const body = touch === 'edit' ? { action: 'edit', removals: ['cmt_first'] } : { action: 'dismiss' };
      const touched = await actionPost(request(`/api/mobile/plans/${DATE}/actions`, body), params(DATE));
      assert.equal(touched.status, 200, `${touch} failed, so this proves nothing`);

      setClock(LATER);
      await captureAndConfirm(storage, 'cmt_second', 'Second thing', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

      const read = await readPlan();
      assert.equal(read.body.plan.generation, 1, `a plan the person chose to ${touch} was overwritten`);
      assert.ok(!read.body.plan.scheduled.some((row) => row.itemId === 'cmt_second'));
      assert.equal(read.body.plan.inputsChanged, true);
    });
  }
});

test('an accept that lands while the refresh is solving is not overwritten', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

    const judged = (await readStoredPlan(USER, DATE, storage))!;
    // The busy-time read happens after the refresh decided the plan was stale
    // and untouched, and before it writes: the person accepts in between.
    const refreshed = await refreshStalePlan(USER, judged, {
      storage,
      now: () => LATER,
      busyBlocks: async () => {
        await acceptPlan(USER, DATE, { storage, now: () => LATER });
        return [];
      },
    });

    const stored = await readStoredPlan(USER, DATE, storage);
    assert.equal(stored!.status, 'accepted', 'the refresh wrote over the plan the person had just accepted');
    assert.equal(stored!.generation, 1);
    assert.equal(refreshed.stored.status, 'accepted', 'the reader was answered the solve that lost');
  });
});

test('a past day\'s plan is never rebuilt', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    // The next day. Yesterday's plan is a record now, not a proposal.
    setClock(new Date('2026-09-16T07:00:00.000Z'));
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

    const read = await readPlan(DATE);
    assert.equal(read.body.plan.generation, 1);
    assert.equal(read.body.plan.scheduled.length, 0);
  });
});

/* ── Fix round 1 ──────────────────────────────────────────────── */

test('I1: a commitment timed for next week leaves today\'s untouched plan alone', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    const built = await build();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_dentist', 'Dentist', { kind: 'scheduled_event', dueAt: '2026-09-22T11:00:00.000Z' }, LATER);

    const read = await readPlan();
    assert.equal(read.body.plan.generation, 1, 'next week\'s appointment rebuilt today\'s plan');
    assert.deepEqual(read.body.plan.scheduled, built.body.plan.scheduled, 'today\'s placement moved');
    assert.deepEqual(read.body.plan.fixed, [], 'next week\'s appointment is on today');
    assert.equal(read.body.plan.inputsChanged, false);
  });
});

test('I2: on an accepted plan, finishing, dropping or snoozing a commitment off the day raises no notice', async () => {
  const cases: Array<[string, LaterCommand]> = [
    ['complete', { type: 'Complete' }],
    ['drop (delete)', { type: 'Drop' }],
    ['snooze to tomorrow', { type: 'Postpone', postponedUntil: '2026-09-16T07:00:00.000Z' }],
  ];
  for (const [label, command] of cases) {
    await withHarness(async ({ storage }) => {
      await seedAccount(storage);
      await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
      await build();
      await accept();
      setClock(LATER);
      await applyTo(storage, 'cmt_report', command, LATER);

      const read = await readPlan();
      assert.equal(read.body.plan.generation, 1);
      assert.equal(read.body.plan.inputsChanged, false, `${label} told the person something new arrived`);
    });
  }
});

test('I2: on an accepted plan, a commitment added to the day or re-timed within it raises the notice', async () => {
  // Added: covered for accept/edit/dismiss above. Re-timed: a pinned
  // commitment moved to later the same day.
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_dentist', 'Dentist', { kind: 'scheduled_event', dueAt: '2026-09-15T11:00:00.000Z' }, MORNING);
    await build();
    await accept();
    setClock(LATER);
    await applyTo(storage, 'cmt_dentist', { type: 'Postpone', postponedUntil: '2026-09-15T13:00:00.000Z' }, LATER);

    const read = await readPlan();
    assert.equal(read.body.plan.generation, 1);
    assert.equal(read.body.plan.inputsChanged, true, 'a pinned time moved within the day and nobody was told');
  });
  // Added with no date at all: an undated commitment that matters joins the day.
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    await accept();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_undated', 'Undated thing', { kind: 'due_by', dueAt: null }, LATER);
    const read = await readPlan();
    assert.equal(read.body.plan.inputsChanged, true, 'an undated commitment joined the day and nobody was told');
  });
  // Snoozed onto the day: a floating commitment pinned to later today.
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    await build();
    await accept();
    setClock(LATER);
    await applyTo(storage, 'cmt_report', { type: 'Postpone', postponedUntil: '2026-09-15T13:00:00.000Z' }, LATER);
    const read = await readPlan();
    assert.equal(read.body.plan.inputsChanged, true);
  });
});

test('I3: a declined replan offer makes the plan the person\'s: no refresh, the decline is remembered', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    await build();
    await offerShift(storage);
    const declined = await actionPost(request(`/api/mobile/plans/${DATE}/actions`, { action: 'reject_proposal' }), params(DATE));
    assert.equal(declined.status, 200, 'the setup is wrong: the offer was not declined');
    const before = (await readStoredPlan(USER, DATE, storage))!;
    assert.equal(before.rejectedProposals?.length, 1);

    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_second', 'Second thing', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);
    const read = await readPlan();
    assert.equal(read.body.plan.generation, before.generation, 'a refresh replaced a plan whose offer the person declined');
    assert.deepEqual((await readStoredPlan(USER, DATE, storage))!.rejectedProposals, before.rejectedProposals, 'the decline was forgotten');
    assert.equal(read.body.plan.inputsChanged, true);
  });
});

test('I3 (the review\'s probe): a plan carrying a decline mark is not refreshed, and the mark survives', async () => {
  // A document declined before `proposalAnswered` existed carries only the mark.
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    await build();
    const stored = (await readStoredPlan(USER, DATE, storage))!;
    const marks = [{ baseGeneration: stored.generation, baseInputDigest: stored.inputDigest, fingerprint: 'declined-shift' }];
    await storage.set(planPath(USER, DATE), { ...stored, rejectedProposals: marks });

    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_second', 'Second thing', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);
    const read = await readPlan();
    assert.equal(read.body.plan.generation, 1, 'the refresh rebuilt a plan the person had declined an offer on');
    assert.deepEqual((await readStoredPlan(USER, DATE, storage))!.rejectedProposals, marks);
  });
});

test('I3: an accepted replan offer makes the plan the person\'s: no refresh undoes it', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    await build();
    await offerShift(storage);
    const accepted = await actionPost(request(`/api/mobile/plans/${DATE}/actions`, { action: 'accept_proposal' }), params(DATE));
    assert.equal(accepted.status, 200, 'the setup is wrong: the offer was not accepted');
    const installed = (await readStoredPlan(USER, DATE, storage))!;
    assert.equal(installed.status, 'proposed', 'the setup is wrong: accepting an offer does not accept the day');

    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_second', 'Second thing', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);
    const read = await readPlan();
    assert.equal(read.body.plan.generation, installed.generation, 'a refresh undid the placement the person accepted');
    assert.deepEqual((await readStoredPlan(USER, DATE, storage))!.plan, installed.plan);
  });
});

test('I3: a pending offer is not discarded by a refresh', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    await build();
    const offer = await offerShift(storage);

    await captureAndConfirm(storage, 'cmt_second', 'Second thing', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    const read = await readPlan();
    assert.equal(read.body.plan.generation, 1, 'a refresh replaced a plan with an offer waiting on it');
    assert.equal((await readStoredPlan(USER, DATE, storage))!.proposal?.proposalId, offer.proposalId, 'the offer was discarded');
  });
});

test('I4: an accepted plan shows a commitment timed later today, and drops a finished one', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_dentist', 'Dentist', { kind: 'scheduled_event', dueAt: '2026-09-15T11:00:00.000Z' }, MORNING);
    await build();
    await accept();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_call', 'Call mum', { kind: 'scheduled_event', dueAt: '2026-09-15T14:00:00.000Z' }, LATER);
    await applyTo(storage, 'cmt_dentist', { type: 'Complete' }, LATER);

    const read = await readPlan();
    assert.equal(read.body.plan.status, 'accepted');
    assert.equal(read.body.plan.generation, 1, 'the accepted plan itself must not change');
    assert.deepEqual(read.body.plan.fixed.map((row) => [row.itemId, row.title]), [['cmt_call', 'Call mum']]);
    // And the solve the plan stands on is untouched.
    const stored = (await readStoredPlan(USER, DATE, storage))!;
    assert.ok(stored.constraints.fixedEvents.some((event) => event.sourceCommitmentId === 'cmt_dentist'));
  });
});

test('concurrent reads of a stale plan write one generation', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, LATER);

    const [left, right] = await Promise.all([readPlan(), readPlan()]);
    assert.equal(left.body.plan.generation, 2);
    assert.equal(right.body.plan.generation, 2);
    const stored = (await readStoredPlan(USER, DATE, storage))!;
    assert.equal(stored.generation, 2);
    assert.equal(stored.automaticGenerations, 1);
    assert.equal((await listPlanEvents(USER, storage)).filter((event) => event.type === 'plan_regenerated').length, 1);
  });
});

test('a replan tick that solved against the plan a refresh replaced writes nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    await build();
    const first = (await readStoredPlan(USER, DATE, storage))!;
    const placed = first.plan.scheduled[0]!.interval;
    await captureAndConfirm(storage, 'cmt_second', 'Second thing', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);
    // A meeting on the placed item, announced to the tick the way a calendar write announces it.
    await replaceBusyBlocksAsFixture(USER, 'device:cal-1', { startsAt: `${DATE}T00:00:00.000Z`, endsAt: '2026-09-17T00:00:00.000Z' }, [{
      blockId: 'busy-meeting', sourceId: 'device:cal-1', sourceKind: 'device' as const,
      startAt: placed.startsAt, endAt: placed.endsAt, allDay: false,
    }], { storage });
    await storage.set(userSubDoc(USER, PLANNING_STATE_CHANGES, docIdForKey('chg-meeting')), {
      schemaVersion: 'planning-state-change-v1', changeId: 'chg-meeting', scopeId: USER, source: 'calendar',
      entityId: 'busy-meeting', occurredAt: MORNING.toISOString(), changedFields: ['interval', 'blocking'],
      beforeDigest: null, afterDigest: 'digest-busy-meeting', provenanceRef: 'calendar:refresh-1',
    } satisfies PlanningStateChange);

    // The refresh lands after the tick has read the plan and before it writes.
    let fired = false;
    const racing: StorageAdapter = Object.create(storage);
    racing.get = async <T>(path: string): Promise<T | null> => {
      const snapshot = await storage.get<T>(path);
      if (path === planPath(USER, DATE) && !fired) {
        fired = true;
        await refreshStalePlan(USER, first, { storage, now: () => MORNING });
      }
      return snapshot;
    };
    await runContinuousReplanTick({ storage: racing, now: MORNING });

    assert.ok(fired, 'the setup is wrong: the tick never read the plan');
    const stored = (await readStoredPlan(USER, DATE, storage))!;
    assert.equal(stored.generation, 2, 'the refresh did not land');
    assert.equal(stored.automaticGenerations, 1);
    assert.equal(stored.proposal ?? null, null, 'the tick stored an offer against the plan the refresh replaced');
    assert.equal((await storage.list(userCol(USER, PLANNING_STATE_CHANGES))).length, 1, 'the change was drained without being judged against the plan in force');
  });
});

/* ── 3. Timed commitments are on the plan ────────────────────── */

test('a commitment pinned to a time today is a fixed row, and one pinned tomorrow is not', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    // 14:00 today and 14:00 tomorrow, Jerusalem.
    await captureAndConfirm(storage, 'cmt_dentist', 'Dentist', { kind: 'scheduled_event', dueAt: '2026-09-15T11:00:00.000Z' }, MORNING);
    await captureAndConfirm(storage, 'cmt_tomorrow', 'Tomorrow thing', { kind: 'scheduled_event', dueAt: '2026-09-16T11:00:00.000Z' }, MORNING);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: DUE_TODAY }, MORNING);

    const built = await build();
    assert.deepEqual(
      built.body.plan.fixed.map((row) => [row.itemId, row.title, row.startsAt]),
      [['cmt_dentist', 'Dentist', '2026-09-15T11:00:00.000Z']],
    );
    assert.ok(Date.parse(built.body.plan.fixed[0]!.endsAt) > Date.parse(built.body.plan.fixed[0]!.startsAt));
    assert.ok(!built.body.plan.scheduled.some((row) => row.itemId === 'cmt_dentist'));
    assert.deepEqual(built.body.plan.scheduled.map((row) => row.itemId), ['cmt_report']);
  });
});

test('a timed commitment captured after the plan was built shows up as a fixed row', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await build();
    setClock(LATER);
    await captureAndConfirm(storage, 'cmt_dentist', 'Dentist', { kind: 'scheduled_event', dueAt: '2026-09-15T11:00:00.000Z' }, LATER);

    const read = await readPlan();
    assert.deepEqual(read.body.plan.fixed.map((row) => row.itemId), ['cmt_dentist']);
  });
});

/* ── Late build ──────────────────────────────────────────────── */

test('a plan built after the day\'s hours says when they ended, and tomorrow can still be built', async () => {
  await withHarness(async ({ storage }) => {
    await seedAccount(storage);
    await captureAndConfirm(storage, 'cmt_report', 'Send the report', { kind: 'due_by', dueAt: null }, EVENING);

    const late = await build(DATE);
    assert.equal(late.status, 200);
    assert.equal(late.body.plan.scheduled.length, 0, 'the setup is wrong: nothing should fit after 20:00');
    assert.equal(late.body.plan.workingEndsAt, FALLBACK_END);

    const tomorrow = await build(TOMORROW);
    assert.equal(tomorrow.status, 200, 'tomorrow\'s plan could not be built in the evening');
    assert.deepEqual(tomorrow.body.plan.scheduled.map((row) => row.itemId), ['cmt_report']);
  }, EVENING);
});
