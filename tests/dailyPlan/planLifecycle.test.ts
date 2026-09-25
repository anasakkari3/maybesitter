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
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { loadDomainState, persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  type DomainState,
} from '../../src/domain/stateMachine.ts';
import { listPlanEvents, planPath, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { MAX_PLAN_REBUILDS_PER_DAY } from '../../lib/services/dailyPlan/planSettings.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as buildPost } from '../../src/app/api/mobile/plans/[date]/build/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { acceptPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { refreshStalePlan } from '../../lib/services/dailyPlan/planRefresh.ts';

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
