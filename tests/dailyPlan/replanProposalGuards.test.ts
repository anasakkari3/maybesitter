import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { replayStoredPlan, editPlan, PlanEditRejected, fixedTimeForOffer } from '../../lib/services/dailyPlan/planActions.ts';
import { explanationFactsFrom, templateExplanation } from '../../lib/services/dailyPlan/explanationValidator.ts';
/**
 * The guards #611's council decision set before the calendar producer lands.
 *
 * The decision (issue #611, 2026-09-24, option B): every calendar-driven
 * replan is a proposal the person accepts or rejects, and before a producer
 * starts writing calendar changes, a proposal must not outlive its calendar,
 * its day or its plan. Six items, each driven through the real tick
 * (`runContinuousReplanTick`) and the real accept and reject functions or
 * routes, on memory storage, with real busy blocks and real change rows:
 *
 *  1. The default is `always_require_confirmation`, and nothing reaches the
 *     automatic modes.
 *  2. Compare-and-set against the calendar: a meeting that lands on the
 *     offer's placement supersedes the offer at the tick, and refuses it at
 *     accept until the tick has run. An offer whose cause is gone is withdrawn.
 *  3. A superseding offer keeps the causes of the one it replaces.
 *  4. An unanswered offer expires at the end of its plan's local day, and on
 *     regeneration, without being recorded as declined.
 *  5. A burst becomes one offer and one `plan_proposed`, within a tick and
 *     across two.
 *  6. Storing an offer pushes nothing.
 *
 * The fixture is #604's: three half-hour tasks at 06:00, 06:30 and 07:00 UTC
 * (09:00 in Jerusalem), and a meeting on the first. That meeting's offer puts
 * them at 06:30, 07:00 and 07:30.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, PUSH_LOG, docIdForKey, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { loadDomainState, persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import {
  MAX_CAUSE_ENTITIES,
  listPlanEvents,
  planPath,
  proposalExpiresAt,
  readStoredPlan,
  storePlanProposal,
  type StoredDailyPlan,
  type StoredPlanProposal,
} from '../../lib/services/dailyPlan/planStore.ts';
import {
  PlanProposalRejected,
  acceptPlanProposal,
  effectiveSchedule,
  regeneratePlan,
  rejectPlanProposal,
} from '../../lib/services/dailyPlan/planActions.ts';
import { runContinuousReplanTick } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { executeContinuousReplanPipeline } from '../../lib/planning/replan/index.ts';
import { replaceBusyBlocksAsFixture } from '../support/busyFixtures.ts';
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import { intervalsOverlap } from '../../lib/planning/shared/time.ts';
import { CONTINUOUS_REPLAN_POLICY } from '../../src/contracts/v1/replanContracts.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { Plan, PlannedItem, TimeInterval } from '../../src/contracts/v1/planningContracts.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as actionsPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
/** 09:00 in Jerusalem: past the 07:30 delivery, and the moment the tick runs. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const TASKS = ['cmt_a', 'cmt_b', 'cmt_c'] as const;
const CALENDAR = 'device:calendar-1';
/** The first task's slot. Its offer: a@06:30, b@07:00, c@07:30. */
const MEETING: TimeInterval = { startsAt: `${DATE}T06:00:00.000Z`, endsAt: `${DATE}T06:30:00.000Z` };
/** Where that offer puts c, and past the end of the visible day (c ends at 07:30). */
const ON_OFFER: TimeInterval = { startsAt: `${DATE}T07:30:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` };
/** The last task's slot on the visible day, and b's in the offer. */
const ON_LAST: TimeInterval = { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` };
/** Inside the day, clear of every placement any offer here makes. */
const EVENING: TimeInterval = { startsAt: `${DATE}T16:00:00.000Z`, endsAt: `${DATE}T17:00:00.000Z` };
/** The end of the plan's local day: midnight in Jerusalem (UTC+3 in September). */
const LOCAL_MIDNIGHT = '2026-09-15T21:00:00.000Z';
const TIME_ONLY = { userControlMode: 'automatic_time_only' } as const;
const BASE = 'http://127.0.0.1:4321';

/* ── Fixture ─────────────────────────────────────────────────────── */

function seedState() {
  let state = createEmptyDomainState();
  for (const id of TASKS) {
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title: id, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  }
  return state;
}

async function withStorage(fn: (storage: StorageAdapter) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    await fn(storage);
  } finally {
    resetStorageForTests();
  }
}

/** The morning's plan, built and stored through the real morning build. */
async function seedAccount(storage: StorageAdapter, uid: string, extra: Record<string, unknown> = {}): Promise<StoredDailyPlan> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(uid, MORNING, { storage });
  assert.ok(claim, 'fixture: the account must be due for a plan');
  await buildAndStoreDailyPlan(claim, { storage, now: () => MORNING });
  if (Object.keys(extra).length > 0) {
    const doc = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), { ...doc, ...extra });
  }
  const stored = await readStoredPlan(uid, DATE, storage);
  assert.ok(stored, 'fixture: the morning build stored no plan');
  assert.deepEqual(
    stored.plan.scheduled.map((item) => [item.itemId, item.interval.startsAt]),
    [['cmt_a', `${DATE}T06:00:00.000Z`], ['cmt_b', `${DATE}T06:30:00.000Z`], ['cmt_c', `${DATE}T07:00:00.000Z`]],
    'fixture: three half-hour tasks from 06:00',
  );
  return stored;
}

/** What a calendar sync writes: the source's current blocks, replaced as a set. */
async function syncCalendar(
  storage: StorageAdapter,
  uid: string,
  blocks: ReadonlyArray<{ blockId: string; interval: TimeInterval }>,
): Promise<void> {
  await replaceBusyBlocksAsFixture(
    uid,
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
async function storeChange(storage: StorageAdapter, uid: string, changeId: string, entityId: string, occurredAt = MORNING): Promise<void> {
  const change: PlanningStateChange = {
    schemaVersion: 'planning-state-change-v1',
    changeId,
    scopeId: uid,
    source: 'calendar',
    entityId,
    occurredAt: occurredAt.toISOString(),
    changedFields: ['interval', 'blocking'],
    beforeDigest: null,
    afterDigest: `digest-${entityId}`,
    provenanceRef: 'calendar:refresh-1',
  };
  await storage.set(userSubDoc(uid, PLANNING_STATE_CHANGES, docIdForKey(changeId)), change);
}

async function pendingChanges(storage: StorageAdapter, uid: string): Promise<number> {
  return (await storage.list(userCol(uid, PLANNING_STATE_CHANGES))).length;
}

function minutesAfterMorning(minutes: number): Date {
  return new Date(MORNING.getTime() + minutes * 60_000);
}

/** The meeting lands on the first task and the tick offers a patch for it. */
async function offerForMeeting(storage: StorageAdapter, uid: string): Promise<StoredPlanProposal> {
  await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
  await storeChange(storage, uid, 'chg-meeting', 'busy-meeting');
  const totals = await runContinuousReplanTick({ storage, now: MORNING });
  assert.equal(totals.proposed, 1, `fixture: the meeting must earn an offer: ${JSON.stringify(totals)}`);
  const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
  assert.ok(offer, 'fixture: the tick stored no offer');
  assert.deepEqual(
    offer.plan.scheduled.map((item) => [item.itemId, item.interval.startsAt]),
    [['cmt_a', `${DATE}T06:30:00.000Z`], ['cmt_b', `${DATE}T07:00:00.000Z`], ['cmt_c', `${DATE}T07:30:00.000Z`]],
    'fixture: the offer slides every task by half an hour',
  );
  assert.deepEqual(offer.causeChangeIds, ['chg-meeting']);
  return offer;
}

function underAny(items: readonly PlannedItem[], meetings: readonly TimeInterval[]): string[] {
  return items
    .filter((item) => meetings.some((meeting) => intervalsOverlap(item.reservedInterval, meeting)))
    .map((item) => item.itemId);
}

function typesOf(events: readonly { type: string }[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

async function refusalOf(action: Promise<unknown>): Promise<string | null> {
  try {
    await action;
    return null;
  } catch (error) {
    if (error instanceof PlanProposalRejected) return error.reason;
    throw error;
  }
}

/* ── Routes ──────────────────────────────────────────────────────── */

function routeRequest(uid: string, path: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const dateParams = { params: Promise.resolve({ date: DATE }) };

async function getPlan(uid: string, at: string): Promise<{ status: number; body: { proposal: { proposalId: string } | null } }> {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  try {
    const response = await planGet(routeRequest(uid, `/api/mobile/plans/${DATE}`), { params: Promise.resolve({ date: DATE }) });
    return { status: response.status, body: await response.json() };
  } finally {
    mock.timers.reset();
  }
}

async function act(uid: string, at: string, body: Record<string, unknown>): Promise<{ status: number; body: { reason?: string } }> {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  try {
    const response = await actionsPost(routeRequest(uid, `/api/mobile/plans/${DATE}/actions`, body), { params: Promise.resolve({ date: DATE }) });
    return { status: response.status, body: await response.json() };
  } finally {
    mock.timers.reset();
  }
}

/* ══ 1. The default asks ════════════════════════════════════════════ */

/*
 * The council's binding decision on #611 (2026-09-24, option B, all five
 * advisors): every calendar-driven replan is a proposal the person accepts
 * or rejects. `automatic_time_only`, the previous default, would have had the
 * producer's first production run rewrite plans silently with no undo, and
 * the churn budget measures how much the engine moved, not the harm. The
 * automatic modes stay in code for a future opt-in and no user can reach them.
 * Changing this constant reverses that decision; it needs the council's own
 * "when to revisit" conditions met first, and then only as an opt-in.
 */
test('1: the default control mode is always_require_confirmation (#611 council decision)', () => {
  assert.equal(CONTINUOUS_REPLAN_POLICY.defaultUserControlMode, 'always_require_confirmation');
});

test('1: under the default, a shift the time-only budget would apply is offered instead', async () => {
  await withStorage(async (storage) => {
    // Control: a 30-minute shift inside the 60-minute budget, which
    // `automatic_time_only` applies without asking. Without it the case below
    // could pass on a fixture that proposes under every mode.
    const control = 'user_guard_default_control';
    await seedAccount(storage, control);
    await syncCalendar(storage, control, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, control, 'chg-late', 'busy-late');
    const applied = await runContinuousReplanTick({ storage, now: MORNING, policyConfig: TIME_ONLY });
    assert.equal(applied.autoApplied, 1, `fixture: the time-only mode applies this shift: ${JSON.stringify(applied)}`);
    assert.equal((await readStoredPlan(control, DATE, storage))!.generation, 2);
  });
  await withStorage(async (storage) => {
    const uid = 'user_guard_default';
    const before = await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, 'chg-late', 'busy-late');

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.autoApplied, 0, `the default must never rewrite the plan: ${JSON.stringify(totals)}`);
    assert.equal(totals.proposed, 1);
    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, before.generation, 'the plan in force is untouched');
    assert.deepEqual(after!.plan, before.plan);
    assert.equal(after!.proposal?.userControlMode, 'always_require_confirmation');
    assert.equal(after!.proposal?.reason, 'user_requires_confirmation');
  });
});

test('1: no mode stored on the account is read: the tick still asks', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_stored_mode';
    // Every place a per-user mode could plausibly be kept, set to the most
    // autonomous mode there is. There is no such setting (#611: "no per-user
    // mode setting yet"), so none of them may reach the policy.
    const before = await seedAccount(storage, uid, { userControlMode: 'silent_auto', replanMode: 'silent_auto' });
    const doc = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), {
      ...doc,
      planSettings: { ...(doc?.planSettings as object), userControlMode: 'silent_auto', continuousReplanMode: 'silent_auto' },
    });
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, 'chg-late', 'busy-late');

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.autoApplied, 0, JSON.stringify(totals));
    assert.equal((await readStoredPlan(uid, DATE, storage))!.generation, before.generation);
    assert.equal((await readStoredPlan(uid, DATE, storage))!.proposal?.userControlMode, 'always_require_confirmation');
  });
});

test('1: no production code chooses a control mode', () => {
  const sources: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const relative = join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(entry.name)) sources.push({ file: relative, text: readFileSync(join(ROOT, relative), 'utf8') });
    }
  };
  walk('lib');
  walk('src');

  // Every call of the tick or of the per-account run, found in the syntax
  // tree rather than by searching text, so a call spelled across lines, with
  // a spread or through a wrapper still counts.
  const TARGETS = new Set(['runContinuousReplanTick', 'processStateChangesForUser']);
  const calls: Array<{ file: string; callee: string; args: readonly ts.Expression[]; inside: string | null; node: ts.CallExpression; source: ts.SourceFile }> = [];
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node, inside: string | null): void => {
      const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : inside;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TARGETS.has(node.expression.text)) {
        calls.push({ file, callee: node.expression.text, args: node.arguments, inside: name, node, source });
      }
      ts.forEachChild(node, (child) => visit(child, name));
    };
    visit(source, null);
  }

  // Outside the service, exactly one caller: the scheduled route, which
  // passes no options object at all.
  const service = join('lib', 'services', 'dailyPlan', 'continuousReplanService.ts');
  const outside = calls.filter((call) => call.file !== service);
  assert.deepEqual(
    outside.map((call) => [call.file, call.callee, call.args.length]),
    [[join('lib', 'jobs', 'internalJobs.ts'), 'runContinuousReplanTick', 0]],
  );
  // Inside it, the tick is the one caller of the per-account run, and the
  // only mode it can pass on is the one its own caller gave it.
  const inside = calls.filter((call) => call.file === service);
  assert.deepEqual(inside.map((call) => [call.callee, call.inside]), [['processStateChangesForUser', 'runContinuousReplanTick']]);
  const forwarded = inside[0]!.node.getText(inside[0]!.source);
  assert.doesNotMatch(forwarded, /userControlMode|automatic_time_only|silent_auto/);
  assert.match(forwarded, /policyConfig: options\.policyConfig/);

  // And no code outside the pipeline and the service names the seam at all.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.deepEqual(
    sources.filter(({ text }) => /\bpolicyConfig\b/.test(code(text))).map(({ file }) => file).sort(),
    [join('lib', 'planning', 'replan', 'continuousReplanPipeline.ts'), service],
  );
});

/* ══ 2. Compare-and-set against the calendar ═══════════════════════ */

/*
 * The #610 reviewer's reproduction, sequential and without a race: offer P is
 * stored; meeting M2 lands on P's placement, is judged against the visible day
 * (where it overlaps nothing), and is drained; the person accepts P and gets a
 * task under M2. The tick now judges M2 against P too and replaces P.
 */
test('2: a meeting that lands on the offer supersedes it at the tick, so accepting never puts a task under it', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_cas_tick';
    await seedAccount(storage, uid);
    const first = await offerForMeeting(storage, uid);

    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-on-offer', interval: ON_OFFER },
    ]);
    await storeChange(storage, uid, 'chg-on-offer', 'busy-on-offer', minutesAfterMorning(5));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    assert.equal(totals.replanRequired, 1, `the meeting contradicts the offer and must earn a re-solve: ${JSON.stringify(totals)}`);
    assert.equal(await pendingChanges(storage, uid), 0);

    const superseded = (await readStoredPlan(uid, DATE, storage))!.proposal;
    assert.ok(superseded, 'the offer must be replaced, not dropped: it still has a meeting to fix');
    assert.notEqual(superseded.proposalId, first.proposalId);
    assert.deepEqual(underAny(superseded.plan.scheduled, [MEETING, ON_OFFER]), []);

    const accepted = await acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(6) });
    assert.ok(accepted);
    assert.deepEqual(
      underAny(effectiveSchedule(accepted), [MEETING, ON_OFFER]),
      [],
      'the accepted day must put nothing under either meeting',
    );
  });
});

test('2: the tick records a meeting on the offer as overlapping the offer, not the day', () => {
  const plan = (starts: readonly string[]): Plan => ({
    scopeId: 'u',
    horizon: { startsAt: `${DATE}T00:00:00.000Z`, endsAt: `${DATE}T21:00:00.000Z`, timezone: TZ },
    scheduled: starts.map((startsAt, index) => {
      const interval = { startsAt, endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString() };
      return { itemId: TASKS[index]!, interval, reservedInterval: interval };
    }),
    unscheduled: [],
    inputDigest: 'digest',
  } as unknown as Plan);
  const day = plan([`${DATE}T06:00:00.000Z`, `${DATE}T06:30:00.000Z`, `${DATE}T07:00:00.000Z`]);
  const offer = plan([`${DATE}T06:30:00.000Z`, `${DATE}T07:00:00.000Z`, `${DATE}T07:30:00.000Z`]);
  const view = (of: Plan) => ({ scopeId: 'u', horizon: of.horizon, scheduled: of.scheduled });
  const change: PlanningStateChange = {
    schemaVersion: 'planning-state-change-v1', changeId: 'chg-on-offer', scopeId: 'u', source: 'calendar',
    entityId: 'busy-on-offer', occurredAt: MORNING.toISOString(), changedFields: ['interval'],
    beforeDigest: null, afterDigest: 'd', provenanceRef: 'calendar:1',
  };
  let solves = 0;
  const run = (pendingView: ReturnType<typeof view> | null) => executeContinuousReplanPipeline({
    changes: [change],
    planView: view(day),
    pendingView,
    entityFactsByChangeId: new Map([[change.changeId, { interval: ON_OFFER, blocking: true }]]),
    basePlan: day,
    planner: () => { solves += 1; return { plan: day }; },
    scopeId: 'u',
    date: DATE,
    now: MORNING.toISOString(),
  });

  const without = run(null);
  assert.equal(without.impact.decision, 'PLAN_STALE', 'against the visible day alone it overlaps nothing');
  assert.equal(solves, 0);

  const withOffer = run(view(offer));
  assert.equal(withOffer.impact.decision, 'REPLAN_REQUIRED');
  assert.equal(withOffer.impact.reason, 'overlaps_proposed_block');
  assert.equal(withOffer.queueEntry?.request.trigger, 'event_impact');
  assert.deepEqual(withOffer.impactingChangeIds, ['chg-on-offer']);
  assert.equal(solves, 1);
});

/*
 * The other half of the same scenario: the meeting is on the calendar but the
 * tick has not run yet (it runs every five minutes). Accept is the only thing
 * that can see it, so accept checks the offer against the busy time in force.
 */
test('2: before the tick has run, accept refuses an offer a meeting has landed on, and records nothing', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_cas_accept';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-on-offer', interval: ON_OFFER },
    ]);
    await storeChange(storage, uid, 'chg-on-offer', 'busy-on-offer', minutesAfterMorning(5));
    const before = await readStoredPlan(uid, DATE, storage);
    const ledger = await listPlanEvents(uid, storage);

    const reason = await refusalOf(acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(6) }));
    assert.equal(reason, 'stale_proposal', 'an offer with a task under a meeting must never be installed');
    assert.deepEqual(await readStoredPlan(uid, DATE, storage), before, 'a refusal writes nothing');
    assert.deepEqual(await listPlanEvents(uid, storage), ledger, 'a refusal is neither an acceptance nor a rejection');
    assert.equal((await readStoredPlan(uid, DATE, storage))!.rejectedProposals, undefined);

    // The tick then replaces the offer, and the replacement is acceptable.
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(7) });
    const accepted = await acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(8) });
    assert.ok(accepted);
    assert.deepEqual(underAny(effectiveSchedule(accepted), [MEETING, ON_OFFER]), []);
  });
});

test('2: a meeting elsewhere in the day does not make the offer unacceptable', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_cas_elsewhere';
    await seedAccount(storage, uid);
    const offer = await offerForMeeting(storage, uid);
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-evening', interval: EVENING },
    ]);
    // A collision check, not a fingerprint of the calendar: a meeting the
    // offer moves nothing onto is no reason to take the button away.
    const accepted = await acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(6) });
    assert.deepEqual(accepted!.plan.scheduled, offer.plan.scheduled);
  });
});

/*
 * The accept-first order: nothing is on the calendar yet when the person says
 * yes, and the meeting arrives after. The accepted day is then the plan in
 * force, and the tick judges the meeting against it like any other.
 */
test('2: a meeting that arrives after the acceptance is caught by the next tick against the installed day', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_cas_after';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    const accepted = await acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(1) });
    assert.equal(accepted!.generation, 2);

    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-on-offer', interval: ON_OFFER },
    ]);
    await storeChange(storage, uid, 'chg-on-offer', 'busy-on-offer', minutesAfterMorning(5));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    assert.equal(totals.replanRequired, 1, JSON.stringify(totals));
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
    assert.ok(offer, 'the installed day has a task under the meeting, so it gets an offer');
    assert.deepEqual(offer.causeChangeIds, ['chg-on-offer']);
    assert.deepEqual(underAny(offer.plan.scheduled, [MEETING, ON_OFFER]), []);
  });
});

/*
 * Withdrawal is decided by the conflict, not by the re-solve. After the day's
 * first slot has started, every solve moves something (work is not placed in
 * the past, #500), so waiting for a re-solve that changes nothing would keep
 * an offer about a deleted meeting alive all day. So each case runs the tick
 * some minutes after the offer was solved.
 */
for (const minutes of [5, 20, 45]) {
  test(`2: an offer whose meeting was deleted is withdrawn ${minutes} minutes on, and the withdrawal is not a rejection`, async () => {
    await withStorage(async (storage) => {
      const uid = `user_guard_withdrawn_${minutes}`;
      const before = await seedAccount(storage, uid);
      await offerForMeeting(storage, uid);
      const proposedEntries = typesOf(await listPlanEvents(uid, storage), 'plan_proposed');

      // The meeting is deleted: its block is gone and a row says so.
      await syncCalendar(storage, uid, []);
      await storeChange(storage, uid, 'chg-meeting-gone', 'busy-meeting', minutesAfterMorning(minutes));
      const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(minutes) });
      assert.equal(totals.withdrawn, 1, JSON.stringify(totals));
      assert.equal(totals.proposed, 0, 'and no drift-only offer takes its place');

      const after = await readStoredPlan(uid, DATE, storage);
      assert.equal(after!.proposal ?? null, null, 'an offer to move tasks off a meeting that no longer exists must go');
      assert.equal(after!.generation, before.generation);
      assert.deepEqual(after!.plan, before.plan);
      assert.equal(after!.rejectedProposals, undefined, 'the person declined nothing');
      const events = await listPlanEvents(uid, storage);
      assert.equal(typesOf(events, 'plan_proposal_rejected'), 0);
      assert.equal(typesOf(events, 'plan_proposed'), proposedEntries, 'and nothing new was offered');
      assert.equal(await pendingChanges(storage, uid), 0);
    });
  });
}

test('2: an offer whose meeting still blocks the day is not withdrawn by an unrelated change', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_not_withdrawn';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-evening', interval: EVENING }]);
    await storeChange(storage, uid, 'chg-evening', 'busy-evening', minutesAfterMorning(20));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(20) });
    assert.equal(totals.withdrawn, 0, JSON.stringify(totals));
    assert.ok((await readStoredPlan(uid, DATE, storage))!.proposal, 'the first task still sits under the meeting');
  });
});

/*
 * Round 3: withdrawal is decided on the facts of the day, not on the offer's
 * causes. Each of these left a task under a meeting with no offer when it was
 * decided on the causes.
 */
test('2: a call that lands while the offer is kept is named, and deleting the first meeting does not withdraw the offer', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_call_while_kept';
    await seedAccount(storage, uid);
    const first = await offerForMeeting(storage, uid);

    // A 15-minute call on a's slot: the offer already moves a off it.
    const CALL: TimeInterval = { startsAt: `${DATE}T06:00:00.000Z`, endsAt: `${DATE}T06:15:00.000Z` };
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-call', interval: CALL }]);
    await storeChange(storage, uid, 'chg-call', 'busy-call', minutesAfterMorning(5));
    const kept = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    assert.equal(kept.kept, 1, `fixture: the re-solve lands on the offer's placement: ${JSON.stringify(kept)}`);
    const named = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.equal(named.proposalId, first.proposalId, 'kept: the same offer');
    assert.equal(named.proposedAt, first.proposedAt);
    assert.deepEqual(named.causeChangeIds, ['chg-call', 'chg-meeting'], 'and the call is named');
    assert.equal(
      (await listPlanEvents(uid, storage)).filter((event) => event.type === 'plan_proposed' && event.proposalId !== undefined).length,
      1,
      'no second offer in the ledger',
    );

    // The first meeting is deleted. a is still under the call.
    await syncCalendar(storage, uid, [{ blockId: 'busy-call', interval: CALL }]);
    await storeChange(storage, uid, 'chg-meeting-gone', 'busy-meeting', minutesAfterMorning(10));
    const later = await runContinuousReplanTick({ storage, now: minutesAfterMorning(10) });
    assert.equal(later.withdrawn, 0, `a is under the call: ${JSON.stringify(later)}`);
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
    assert.ok(offer, 'an offer still stands for the call');
    assert.ok(offer.causeChangeIds.includes('chg-call'));
    assert.deepEqual(underAny(offer.plan.scheduled, [CALL]), []);
  });
});

test('2: busy time with no change row still blocks the day, so the offer is not withdrawn', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_rowless_busy';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    // A meeting on b arrives with no row (no producer writes one yet), and the
    // first meeting is deleted with one.
    const ON_B: TimeInterval = { startsAt: `${DATE}T06:30:00.000Z`, endsAt: `${DATE}T07:00:00.000Z` };
    await syncCalendar(storage, uid, [{ blockId: 'busy-no-row', interval: ON_B }]);
    await storeChange(storage, uid, 'chg-meeting-gone', 'busy-meeting', minutesAfterMorning(10));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(10) });
    assert.equal(totals.withdrawn, 0, `b is under a meeting: ${JSON.stringify(totals)}`);
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
    assert.ok(offer, 'the offer stands while the day has a conflict');
    assert.deepEqual(underAny(offer.plan.scheduled, [ON_B]), []);
  });
});

test('2: an offer stored before causeRefs existed is not withdrawn while its meeting still blocks', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_legacy_offer';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    // As an offer written before the field existed.
    const stored = (await readStoredPlan(uid, DATE, storage))!;
    const { causeRefs: _dropped, ...legacy } = stored.proposal!;
    await storage.set(planPath(uid, DATE), { ...stored, proposal: legacy });

    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-evening', interval: EVENING }]);
    await storeChange(storage, uid, 'chg-evening', 'busy-evening', minutesAfterMorning(40));
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(40) });
    await storeChange(storage, uid, 'chg-evening-again', 'busy-evening', minutesAfterMorning(45));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(45) });
    assert.equal(totals.withdrawn, 0, `a is still under the meeting: ${JSON.stringify(totals)}`);
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
    assert.ok(offer, 'the offer stands');
    assert.ok(offer.causeChangeIds.includes('chg-meeting'), 'and keeps the cause it could not re-read');
  });
});

/*
 * No calendar source writes change rows yet, so a meeting can land on an
 * offer with nothing to tell the tick. The plan GET withholds such an offer
 * by the check accept refuses on, so the person is never shown a button that
 * fails until midnight; the offer stays stored for the tick to replace.
 */
test('2: the plan GET withholds an offer a meeting has landed on, and shows one nothing sits on', async () => {
  await withStorage(async (storage) => {
    const uid = uidFor('GuardGetCollision');
    const auth = installFakeAuth();
    try {
      await seedAccount(storage, uid);
      const offer = await offerForMeeting(storage, uid);
      const at = minutesAfterMorning(10).toISOString();

      await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-evening', interval: EVENING }]);
      const clear = await getPlan(uid, at);
      assert.equal(clear.body.proposal?.proposalId, offer.proposalId, 'a meeting the offer moves nothing onto hides nothing');

      // No row, no tick: only the calendar changed.
      await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-on-offer', interval: ON_OFFER }]);
      const hidden = await getPlan(uid, at);
      assert.equal(hidden.status, 200);
      assert.equal(hidden.body.proposal, null, 'an offer that would put a task on a meeting is not shown');
      assert.equal((await readStoredPlan(uid, DATE, storage))!.proposal?.proposalId, offer.proposalId, 'it stays stored for the tick to replace');
    } finally {
      auth.restore();
    }
  });
});

/** Adds a commitment pinned to `startsAt`, confirmed, after the plan was built. */
async function pinCommitment(storage: StorageAdapter, uid: string, id: string, startsAt: string): Promise<void> {
  let state = await loadDomainState(storage, uid);
  state = applyDomainCommand(state, {
    type: 'CreateDraft',
    now: MORNING.toISOString(),
    commitment: { id, kind: 'task', title: id, timeSpec: { kind: 'scheduled_event', dueAt: startsAt, endAt: null, remindAt: startsAt, allDay: false, timezone: TZ } },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyDomainCommand(state, { type: 'ConfirmCommitment', commitmentId: id, now: MORNING.toISOString(), reminders: [] }).newState;
  await persistParticipantState(uid, state);
}

test('2: a commitment pinned onto the offer after it was solved refuses the accept and hides the offer', async () => {
  await withStorage(async (storage) => {
    const uid = uidFor('GuardPinned');
    const auth = installFakeAuth();
    try {
      await seedAccount(storage, uid);
      await offerForMeeting(storage, uid);
      // An appointment at 07:30, where the offer puts c. Not a calendar block.
      await pinCommitment(storage, uid, 'cmt_pinned', ON_OFFER.startsAt);
      const before = await readStoredPlan(uid, DATE, storage);

      assert.equal(await refusalOf(acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(10) })), 'stale_proposal');
      assert.deepEqual(await readStoredPlan(uid, DATE, storage), before, 'a refusal writes nothing');
      assert.equal((await getPlan(uid, minutesAfterMorning(10).toISOString())).body.proposal, null);
    } finally {
      auth.restore();
    }
  });
});

test('2: accepting names the offer on screen, and a newer one is not installed in its place', async () => {
  await withStorage(async (storage) => {
    const uid = uidFor('GuardProposalId');
    const auth = installFakeAuth();
    try {
      await seedAccount(storage, uid);
      const offer = await offerForMeeting(storage, uid);
      const at = minutesAfterMorning(10).toISOString();

      const stale = await act(uid, at, { action: 'accept_proposal', proposalId: 'prp_the_one_on_screen_before' });
      assert.equal(stale.status, 422);
      assert.equal(stale.body.reason, 'stale_proposal');
      assert.equal((await readStoredPlan(uid, DATE, storage))!.generation, 1, 'nothing was installed');

      const named = await act(uid, at, { action: 'accept_proposal', proposalId: offer.proposalId });
      assert.equal(named.status, 200, JSON.stringify(named.body));
      assert.equal((await readStoredPlan(uid, DATE, storage))!.generation, 2);
    } finally {
      auth.restore();
    }
  });
});

/** Runs `competing` once, right after the tick reads the plan and before it writes anything. */
function racingAfterPlanRead(storage: StorageAdapter, uid: string, competing: () => Promise<unknown>): { storage: StorageAdapter; fired: () => boolean } {
  let fired = false;
  const racing: StorageAdapter = Object.create(storage);
  racing.get = async <T>(path: string): Promise<T | null> => {
    const snapshot = await storage.get<T>(path);
    if (path === planPath(uid, DATE) && !fired) {
      fired = true;
      await competing();
    }
    return snapshot;
  };
  return { storage: racing, fired: () => fired };
}

test('2: declining names the offer on screen, and a newer one is neither cleared nor remembered as declined', async () => {
  await withStorage(async (storage) => {
    const uid = uidFor('GuardRejectProposalId');
    const auth = installFakeAuth();
    try {
      await seedAccount(storage, uid);
      const offer = await offerForMeeting(storage, uid);
      const at = minutesAfterMorning(10).toISOString();
      const before = await readStoredPlan(uid, DATE, storage);
      const ledger = await listPlanEvents(uid, storage);

      const stale = await act(uid, at, { action: 'reject_proposal', proposalId: 'prp_the_one_on_screen_before' });
      assert.equal(stale.status, 422);
      assert.equal(stale.body.reason, 'stale_proposal');
      assert.deepEqual(await readStoredPlan(uid, DATE, storage), before, 'the offer the person did not see stays, unmarked');
      assert.deepEqual(await listPlanEvents(uid, storage), ledger, 'and no decision is recorded');

      const named = await act(uid, at, { action: 'reject_proposal', proposalId: offer.proposalId });
      assert.equal(named.status, 200, JSON.stringify(named.body));
      const after = await readStoredPlan(uid, DATE, storage);
      assert.equal(after!.proposal ?? null, null);
      assert.equal(after!.rejectedProposals?.length, 1);
    } finally {
      auth.restore();
    }
  });
});

/*
 * The offer is part of the state a run judged against. Here the run re-solves
 * to the offer it read and would keep it, adding its new cause, while another
 * writer replaces that offer mid-run. Written from the run's snapshot, the
 * kept offer would overwrite the newer one. The write guard compares the
 * offer's id, so the run stands down and the change waits for the next tick.
 */
test('2: an offer replaced while the tick solves is not overwritten by the run\'s copy of the old one', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_offer_race';
    await seedAccount(storage, uid);
    const first = await offerForMeeting(storage, uid);
    await storeChange(storage, uid, 'chg-meeting-resync', 'busy-meeting', minutesAfterMorning(5));

    const newer: StoredPlanProposal = { ...first, proposalId: 'prp_newer', causeChangeIds: ['chg-newer'] };
    const race = racingAfterPlanRead(storage, uid, () => storePlanProposal(uid, DATE, newer, storage));
    await runContinuousReplanTick({ storage: race.storage, now: minutesAfterMorning(5) });
    assert.ok(race.fired(), 'fixture: the newer offer must have raced the tick');

    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.proposal?.proposalId, 'prp_newer', 'the newer offer must survive the run');
    assert.deepEqual(after!.proposal?.causeChangeIds, ['chg-newer']);
    assert.equal(await pendingChanges(storage, uid), 1, 'a run that stood down must not drain its change');
  });
});

/* ══ 3. A superseding offer keeps the causes it carries ════════════ */

test('3: an offer that replaces an unanswered one names the replaced offer\'s causes too (#527)', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_causes';
    const before = await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);

    // A second meeting on the last task. The new solve still moves a off the
    // first meeting: that move is on screen, and so must its cause be.
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-late', interval: ON_LAST },
    ]);
    await storeChange(storage, uid, 'chg-late', 'busy-late', minutesAfterMorning(5));
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });

    const second = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    const movedA = second.diff.changes.find((change) => change.itemId === 'cmt_a');
    assert.equal(movedA?.kind, 'moved', 'the premise: the new offer still carries a\'s move off the first meeting');
    assert.equal(
      before.plan.scheduled.find((item) => item.itemId === 'cmt_a')!.interval.startsAt,
      MEETING.startsAt,
      'the premise: a sat under the first meeting',
    );
    assert.deepEqual(second.causeChangeIds, ['chg-late', 'chg-meeting']);

    const offered = (await listPlanEvents(uid, storage)).filter((event) => event.type === 'plan_proposed' && event.proposalId === second.proposalId);
    assert.equal(offered.length, 1);
    assert.deepEqual(offered[0]!.causeChangeIds, ['chg-late', 'chg-meeting'], 'the ledger names both');

    await acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(6) });
    const decision = (await listPlanEvents(uid, storage)).find((event) => event.type === 'plan_proposal_accepted');
    assert.deepEqual(decision?.causeChangeIds, ['chg-late', 'chg-meeting'], 'and so does the person\'s answer');
    assert.deepEqual((await readStoredPlan(uid, DATE, storage))!.causeChangeIds, ['chg-late', 'chg-meeting']);
  });
});

test('3: two meetings that both still block what the offer moves keep both causes through a later re-solve', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_causes_both';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-late', interval: ON_LAST },
    ]);
    await storeChange(storage, uid, 'chg-late', 'busy-late', minutesAfterMorning(5));
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    const second = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.deepEqual(second.causeChangeIds, ['chg-late', 'chg-meeting']);

    // Forty minutes on, the first slot is in the past and an unrelated row
    // makes the tick re-solve: the new placement differs, and both meetings
    // still sit on the path of a task it moves.
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-late', interval: ON_LAST },
      { blockId: 'busy-evening', interval: EVENING },
    ]);
    await storeChange(storage, uid, 'chg-evening', 'busy-evening', minutesAfterMorning(40));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(40) });
    const third = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.equal(totals.proposed, 1, `the premise: a new offer replaced the old one: ${JSON.stringify(totals)}`);
    assert.notEqual(third.proposalId, second.proposalId);
    assert.deepEqual(third.causeChangeIds, ['chg-late', 'chg-meeting']);
    assert.deepEqual(third.causeRefs?.map((ref) => ref.entityId), ['busy-late', 'busy-meeting']);
  });
});

test('3: an unrelated meeting is not named as a cause of the offer, nor of the plan it installs', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_causes_unrelated';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);

    // A meeting at 16:00, which overlaps nothing the day or the offer places.
    // Forty minutes on, so the re-solve drifts (#500) and a new offer is
    // stored: the case where this run's rows could be named.
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-evening', interval: EVENING }]);
    await storeChange(storage, uid, 'chg-evening', 'busy-evening', minutesAfterMorning(40));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(40) });
    assert.equal(totals.proposed, 1, `the premise: a new offer replaced the old one: ${JSON.stringify(totals)}`);

    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.deepEqual(offer.causeChangeIds, ['chg-meeting'], 'the evening meeting moved nothing');
    await acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(41) });
    assert.deepEqual((await readStoredPlan(uid, DATE, storage))!.causeChangeIds, ['chg-meeting']);
    const decision = (await listPlanEvents(uid, storage)).find((event) => event.type === 'plan_proposal_accepted');
    assert.deepEqual(decision?.causeChangeIds, ['chg-meeting']);
  });
});

test('3: a cause whose meeting was deleted is not carried into the next offer', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_causes_dropped';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-late', interval: ON_LAST },
    ]);
    await storeChange(storage, uid, 'chg-late', 'busy-late', minutesAfterMorning(5));
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    assert.deepEqual((await readStoredPlan(uid, DATE, storage))!.proposal!.causeChangeIds, ['chg-late', 'chg-meeting']);

    // The second meeting is deleted. The first still blocks a, so the offer
    // stands and is re-solved; the deleted one must not be named any more.
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, 'chg-late-gone', 'busy-late', minutesAfterMorning(40));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(40) });
    assert.equal(totals.withdrawn, 0, JSON.stringify(totals));
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.deepEqual(offer.causeChangeIds, ['chg-meeting']);
    assert.deepEqual(offer.causeRefs, [{ changeId: 'chg-meeting', source: 'calendar', entityId: 'busy-meeting' }]);
  });
});

/*
 * The cap is by entity. Fifty rows about one meeting used to fill a cap of
 * fifty change ids, so a second meeting in the same tick was not named; and
 * with no ref for it, deleting the first meeting withdrew the offer while the
 * second still sat on a task.
 */
test('3: fifty rows about one meeting and one about another name both, and the second still counts once the first is gone', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_causes_cap_two';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-late', interval: ON_LAST }]);
    const burst = Array.from({ length: 50 }, (_, index) => `chg-burst-${String(index).padStart(2, '0')}`);
    for (let index = 0; index < burst.length; index += 1) {
      await storeChange(storage, uid, burst[index]!, 'busy-meeting', new Date(MORNING.getTime() + index * 1000));
    }
    await storeChange(storage, uid, 'chg-late', 'busy-late');
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
    const first = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.deepEqual(first.causeChangeIds, ['chg-burst-00', 'chg-burst-49', 'chg-late']);

    // The first meeting is deleted. c still sits under the second.
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, 'chg-meeting-gone', 'busy-meeting', minutesAfterMorning(40));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(40) });
    assert.equal(totals.withdrawn, 0, `a task is still under the second meeting: ${JSON.stringify(totals)}`);
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
    assert.ok(offer, 'the offer stands');
    assert.deepEqual(offer.causeChangeIds, ['chg-late']);
    assert.deepEqual(underAny(offer.plan.scheduled, [ON_LAST]), []);
  });
});

test('3: at most MAX_CAUSE_ENTITIES entities are named, this run\'s own before carried ones', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_causes_cap_entities';
    await seedAccount(storage, uid);
    const blocks = Array.from({ length: MAX_CAUSE_ENTITIES }, (_, index) => ({ blockId: `busy-${String(index).padStart(2, '0')}`, interval: MEETING }));
    await syncCalendar(storage, uid, blocks);
    for (const block of blocks) await storeChange(storage, uid, `chg-${block.blockId}`, block.blockId);
    await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal((await readStoredPlan(uid, DATE, storage))!.proposal!.causeChangeIds.length, MAX_CAUSE_ENTITIES, 'fixture: the cap is full');

    // A new meeting on c: a new offer, whose own new cause must be named.
    await syncCalendar(storage, uid, [...blocks, { blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, 'chg-late', 'busy-late', minutesAfterMorning(5));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    assert.equal(totals.proposed, 1, `the premise: a new offer: ${JSON.stringify(totals)}`);
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.ok(offer.causeChangeIds.includes('chg-late'), 'this run\'s own cause comes before carried ones');
    assert.equal(offer.causeChangeIds.length, MAX_CAUSE_ENTITIES);
    assert.equal(offer.causeRefs?.length, MAX_CAUSE_ENTITIES);
  });
});

test('3: a meeting re-announced on every tick does not pile up causes', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_causes_resync';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    // Eight ticks, five minutes apart, each with one more row about the same
    // meeting. Past 06:30 the re-solve also drifts (#500) and replaces the
    // offer, so both the kept and the superseded path are walked.
    const outcomes = { kept: 0, proposed: 0 };
    for (let tick = 1; tick <= 8; tick += 1) {
      await storeChange(storage, uid, `chg-resync-${tick}`, 'busy-meeting', minutesAfterMorning(5 * tick));
      const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5 * tick) });
      outcomes.kept += totals.kept;
      outcomes.proposed += totals.proposed;
      const offer = (await readStoredPlan(uid, DATE, storage))!.proposal;
      assert.ok(offer, `tick ${tick}: the first task is still under the meeting, so an offer stands`);
      assert.deepEqual(offer.causeChangeIds, ['chg-meeting'], `tick ${tick}: one meeting, one cause`);
    }
    assert.ok(outcomes.kept > 0 && outcomes.proposed > 0, `the premise: both paths were walked: ${JSON.stringify(outcomes)}`);
  });
});

/* ══ 4. Expiry ═════════════════════════════════════════════════════ */

test('4: the offer expires at local midnight in the plan\'s zone, not at UTC midnight', () => {
  assert.equal(proposalExpiresAt({ date: DATE, timezone: TZ }), LOCAL_MIDNIGHT);
  // The day Israel leaves summer time is 25 hours long, and the offer lives
  // all of them.
  assert.equal(proposalExpiresAt({ date: '2026-10-25', timezone: TZ }), '2026-10-25T22:00:00.000Z');
});

test('4: an unanswered offer is shown and acceptable until its day ends, then neither, and is not recorded as declined', async () => {
  await withStorage(async (storage) => {
    const uid = uidFor('GuardExpiry');
    const auth = installFakeAuth();
    try {
      await seedAccount(storage, uid);
      const offer = await offerForMeeting(storage, uid);
      const lastMoment = new Date(Date.parse(LOCAL_MIDNIGHT) - 1).toISOString();
      // 22:00 UTC is still the 15th in UTC and already the 16th in Jerusalem.
      const afterLocalMidnight = '2026-09-15T22:00:00.000Z';

      const live = await getPlan(uid, lastMoment);
      assert.equal(live.body.proposal?.proposalId, offer.proposalId, 'the last millisecond of the day still offers it');

      for (const at of [LOCAL_MIDNIGHT, afterLocalMidnight]) {
        assert.equal((await getPlan(uid, at)).body.proposal, null, `${at}: an offer about a day that is over is not shown`);
        const accept = await act(uid, at, { action: 'accept_proposal' });
        assert.equal(accept.status, 422, `${at}: an expired offer is not acceptable`);
        assert.equal(accept.body.reason, 'stale_proposal');
        const reject = await act(uid, at, { action: 'reject_proposal' });
        assert.equal(reject.status, 422, `${at}: nor is there anything to decline`);
        assert.equal(reject.body.reason, 'no_proposal');
      }

      const after = await readStoredPlan(uid, DATE, storage);
      assert.equal(after!.generation, 1, 'nothing was installed');
      assert.equal(after!.rejectedProposals, undefined, 'expiry is not the person\'s answer');
      const events = await listPlanEvents(uid, storage);
      assert.equal(typesOf(events, 'plan_proposal_rejected'), 0);
      assert.equal(typesOf(events, 'plan_proposal_accepted'), 0);
    } finally {
      auth.restore();
    }
  });
});

test('4: accept and reject called directly refuse an expired offer too', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_expiry_direct';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);
    const midnight = () => new Date(LOCAL_MIDNIGHT);
    assert.equal(await refusalOf(acceptPlanProposal(uid, DATE, { storage, now: midnight })), 'stale_proposal');
    assert.equal(await refusalOf(rejectPlanProposal(uid, DATE, { storage, now: midnight })), 'no_proposal');
    assert.equal((await readStoredPlan(uid, DATE, storage))!.rejectedProposals, undefined);
    assert.equal(typesOf(await listPlanEvents(uid, storage), 'plan_proposal_rejected'), 0);
  });
});

test('4: regenerating the plan ends the offer, and does not record it as declined', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_regenerated';
    await seedAccount(storage, uid);
    await offerForMeeting(storage, uid);

    const rebuilt = await regeneratePlan(uid, DATE, { storage, now: () => minutesAfterMorning(10) });
    assert.ok(rebuilt.ok, JSON.stringify(rebuilt));
    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, 2);
    assert.equal(after!.proposal ?? null, null, 'a rebuilt plan carries no offer of the plan it replaced');
    assert.equal(after!.rejectedProposals, undefined);
    assert.equal(typesOf(await listPlanEvents(uid, storage), 'plan_proposal_rejected'), 0);
    assert.equal(await refusalOf(acceptPlanProposal(uid, DATE, { storage, now: () => minutesAfterMorning(11) })), 'no_proposal');
  });
});

/* ══ 5. Bursts ═════════════════════════════════════════════════════ */

test('5: fifty rows announcing one meeting in one tick become one offer and one plan_proposed', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_burst_same';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    const ids = Array.from({ length: 50 }, (_, index) => `chg-burst-${String(index).padStart(2, '0')}`);
    for (let index = 0; index < ids.length; index += 1) {
      await storeChange(storage, uid, ids[index]!, 'busy-meeting', new Date(MORNING.getTime() + index * 1000));
    }

    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
    assert.equal(totals.proposed, 1, JSON.stringify(totals));
    const events = await listPlanEvents(uid, storage);
    assert.equal(events.filter((event) => event.type === 'plan_proposed' && event.proposalId !== undefined).length, 1);
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    // One meeting: the first row of the burst and the latest are named
    // (`MAX_CHANGE_IDS_PER_CAUSE`), not all fifty.
    assert.deepEqual(offer.causeChangeIds, [ids[0], ids[ids.length - 1]], 'one meeting, its first and latest rows');
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('5: fifty different meetings in one tick still become one offer', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_burst_many';
    await seedAccount(storage, uid);
    const blocks = Array.from({ length: 50 }, (_, index) => ({ blockId: `busy-${index}`, interval: MEETING }));
    await syncCalendar(storage, uid, blocks);
    for (const block of blocks) await storeChange(storage, uid, `chg-${block.blockId}`, block.blockId);

    await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
    const events = await listPlanEvents(uid, storage);
    assert.equal(events.filter((event) => event.type === 'plan_proposed' && event.proposalId !== undefined).length, 1);
    assert.ok((await readStoredPlan(uid, DATE, storage))!.proposal);
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('5: a re-sync of the same meeting in a later tick keeps the offer on the table instead of minting it again', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_burst_straddle';
    await seedAccount(storage, uid);
    const first = await offerForMeeting(storage, uid);

    // The rest of a bulk re-sync lands after the tick: the same meeting, new rows.
    for (let index = 0; index < 50; index += 1) {
      await storeChange(storage, uid, `chg-resync-${String(index).padStart(2, '0')}`, 'busy-meeting', minutesAfterMorning(5));
    }
    await storeChange(storage, uid, 'chg-meeting', 'busy-meeting', minutesAfterMorning(5));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
    assert.equal(totals.replanRequired, 1, `the premise: the tick solved again: ${JSON.stringify(totals)}`);
    assert.equal(totals.kept, 1, 'counted as kept');
    assert.equal(totals.proposed, 0, 'not as a new offer');

    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.deepEqual({ ...offer, plan: first.plan, solveInputs: first.solveInputs }, first,
      'the same question retains id, time and causes while refreshing exact solve inputs');
    assert.deepEqual(offer.plan.scheduled, first.plan.scheduled);
    assert.ok(offer.solveInputs);
    assert.deepEqual(schedulePlan(offer.solveInputs.constraints, offer.solveInputs.config), offer.plan);
    const events = await listPlanEvents(uid, storage);
    assert.equal(events.filter((event) => event.type === 'plan_proposed' && event.proposalId !== undefined).length, 1, 'one question, one entry');
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

/* ══ 6. No push per change ═════════════════════════════════════════ */

test('6: offering, superseding and keeping an offer push nothing', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_guard_no_push';
    await seedAccount(storage, uid);
    // A reachable phone, so a push, if anything sent one, would get as far
    // as claiming its dedupe key in `pushLog`.
    await upsertDevice(uid, {
      installationId: '5b1c3d2e-8f4a-4b6c-9d7e-0a1b2c3d4e5f',
      fcmToken: 'token-guard-no-push',
      platform: 'ios',
      appVersion: '1.0.0',
      locale: 'en',
      timezone: TZ,
      pushPermission: 'granted',
    }, '2026-09-14T12:00:00.000Z', { storage });

    const touched: string[] = [];
    const spying: StorageAdapter = Object.create(storage);
    spying.get = async <T>(path: string) => { touched.push(path); return storage.get<T>(path); };
    spying.list = async (path: string, options?: unknown) => { touched.push(path); return storage.list(path, options as never); };
    spying.set = async (path: string, data: unknown) => { touched.push(path); return storage.set(path, data as never); };

    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, 'chg-meeting', 'busy-meeting');
    const offered = await runContinuousReplanTick({ storage: spying, now: MORNING });
    assert.equal(offered.proposed, 1, `fixture: ${JSON.stringify(offered)}`);

    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-on-offer', interval: ON_OFFER }]);
    await storeChange(storage, uid, 'chg-on-offer', 'busy-on-offer', minutesAfterMorning(5));
    await storeChange(storage, uid, 'chg-meeting-again', 'busy-meeting', minutesAfterMorning(5));
    const superseded = await runContinuousReplanTick({ storage: spying, now: minutesAfterMorning(5) });
    assert.equal(superseded.failed, 0);
    assert.equal(offered.failed, 0);

    assert.deepEqual(touched.filter((path) => /\/(devices|pushLog)(\/|$)/.test(path)), [], 'the tick must not look for a phone to wake');
    assert.deepEqual(await storage.list(userCol(uid, PUSH_LOG)), [], 'nothing was pushed');
  });
});

test('6: the replan service has no path to the push sender', () => {
  const text = readFileSync(join(ROOT, 'lib', 'services', 'dailyPlan', 'continuousReplanService.ts'), 'utf8');
  assert.doesNotMatch(text, /from ['"][^'"]*push[^'"]*['"]/i, 'no import of a push module');
  assert.doesNotMatch(text, /\b(sendToUser|planReadyPushSender|PlanPushSender)\b/);
});


test('#586: accepted real offer installs replayable metadata, current busy time and a fresh visible-day explanation', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_metadata_accept';
    await seedAccount(storage, uid);
    const before = (await readStoredPlan(uid, DATE, storage))!;
    // A kept removal must not appear in the renewed narrative.
    await storage.set(planPath(uid, DATE), { ...before, edits: { moves: [], removals: ['cmt_c'] },
      explanation: { text: 'Superseded 09:00 story', locale: 'en', source: 'model', validated: true } });
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, 'chg-meeting', 'busy-meeting');
    await runContinuousReplanTick({ storage, now: MORNING });
    const offered = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.ok(offered.solveInputs);
    const after = (await acceptPlanProposal(uid, DATE, { storage, now: () => MORNING }))!;
    assert.deepEqual(after.constraints, offered.solveInputs.constraints);
    assert.deepEqual(after.config, offered.solveInputs.config);
    assert.equal(after.inputDigest, offered.plan.inputDigest);
    assert.notEqual(after.inputDigest, before.inputDigest);
    assert.deepEqual(replayStoredPlan(after), after.plan);
    assert.deepEqual(after.edits.removals, ['cmt_c']);
    const visible = { ...after.plan, scheduled: after.plan.scheduled.filter((item) => item.itemId !== 'cmt_c'),
      unscheduled: after.plan.unscheduled.filter((item) => item.itemId !== 'cmt_c') };
    assert.equal(after.explanation.text, templateExplanation(explanationFactsFrom(visible, new Map(), TZ, after.locale)));
    assert.equal(after.explanation.source, 'template');
    await assert.rejects(editPlan(uid, DATE, { moves: [{ itemId: 'cmt_a', startsAt: MEETING.startsAt, endsAt: MEETING.endsAt }], removals: [] }, { storage, now: () => MORNING }),
      (error: unknown) => error instanceof PlanEditRejected && error.reason === 'overlaps_fixed_event');
    const events = await listPlanEvents(uid, storage);
    assert.equal(events.find((event) => event.type === 'plan_regenerated')!.inputDigest, after.inputDigest);
    assert.equal(events.find((event) => event.type === 'plan_proposal_accepted')!.inputDigest, before.inputDigest);
  });
});

test('#586: old offers refuse without writes, remain rejectable, and a same-placement solve repairs their snapshot without offer churn', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_metadata_legacy';
    await seedAccount(storage, uid);
    const first = await offerForMeeting(storage, uid);
    const { solveInputs: _snapshot, ...legacy } = first;
    const current = (await readStoredPlan(uid, DATE, storage))!;
    const old = { ...current, proposal: legacy };
    await storage.set(planPath(uid, DATE), old);
    const ledger = await listPlanEvents(uid, storage);
    assert.equal(await refusalOf(acceptPlanProposal(uid, DATE, { storage, now: () => MORNING })), 'stale_proposal');
    assert.deepEqual(await readStoredPlan(uid, DATE, storage), old);
    assert.deepEqual(await listPlanEvents(uid, storage), ledger);
    // No pending row means no promise of an automatic legacy refresh.
    assert.equal(await pendingChanges(storage, uid), 0);
    await runContinuousReplanTick({ storage, now: MORNING });
    assert.deepEqual((await readStoredPlan(uid, DATE, storage))!.proposal, legacy);
    await storeChange(storage, uid, 'chg-meeting', 'busy-meeting');
    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.kept, 1);
    const refreshed = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.equal(refreshed.proposalId, first.proposalId);
    assert.equal(refreshed.proposedAt, first.proposedAt);
    assert.deepEqual(refreshed.plan.scheduled, first.plan.scheduled);
    assert.deepEqual(refreshed.causeRefs, first.causeRefs);
    assert.ok(refreshed.solveInputs);
    assert.deepEqual(await listPlanEvents(uid, storage), ledger);
    await storage.set(planPath(uid, DATE), old);
    await rejectPlanProposal(uid, DATE, { storage, now: () => MORNING });
    assert.equal((await readStoredPlan(uid, DATE, storage))!.proposal, null);
  });
});


test('#586: a timezone change installs and explains the offered solve zone', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_metadata_timezone';
    const before = await seedAccount(storage, uid);
    const account = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), { ...account, timezone: 'UTC' });
    const late = { startsAt: `${DATE}T22:00:00.000Z`, endsAt: `${DATE}T22:30:00.000Z` };
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }, { blockId: 'busy-late', interval: late }]);
    await storeChange(storage, uid, 'chg-meeting', 'busy-meeting');
    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.proposed, 1);
    const offer = (await readStoredPlan(uid, DATE, storage))!.proposal!;
    assert.equal(offer.solveInputs!.constraints.timezone, 'UTC');
    const taken = await fixedTimeForOffer(uid, (await readStoredPlan(uid, DATE, storage))!, MORNING, { storage });
    assert.ok(taken.some((event) => event.interval.startsAt === late.startsAt), 'GET checks the offered zone day, including time beyond the old day');
    assert.equal(before.timezone, TZ);
    const after = (await acceptPlanProposal(uid, DATE, { storage, now: () => MORNING }))!;
    assert.equal(after.timezone, 'UTC');
    assert.equal(after.explanation.text, templateExplanation(explanationFactsFrom(after.plan, new Map(), 'UTC', after.locale)));
    assert.notEqual(after.explanation.text, templateExplanation(explanationFactsFrom(after.plan, new Map(), TZ, after.locale)));
    assert.deepEqual(replayStoredPlan(after), after.plan);
  });
});


test('#586: same-ID solve-zone refresh during acceptance refuses against the old busy-time horizon', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_metadata_zone_race';
    await seedAccount(storage, uid);
    const first = await offerForMeeting(storage, uid);
    const current = (await readStoredPlan(uid, DATE, storage))!;
    const newer = { ...current, proposal: { ...first, solveInputs: {
      ...first.solveInputs!, constraints: { ...first.solveInputs!.constraints, timezone: 'UTC' },
    } } };
    const ledger = await listPlanEvents(uid, storage);
    const race = racingAfterPlanRead(storage, uid, () => storage.set(planPath(uid, DATE), newer));
    assert.equal(await refusalOf(acceptPlanProposal(uid, DATE, { storage: race.storage, now: () => MORNING })), 'stale_proposal');
    assert.equal(race.fired(), true);
    assert.deepEqual(await readStoredPlan(uid, DATE, storage), newer);
    assert.deepEqual(await listPlanEvents(uid, storage), ledger);
  });
});
