/**
 * The morning sweep: who is due, exactly once, and who is refused (UC-3.10a, #194).
 *
 * ── The heart of this file is idempotency ────────────────────────
 *
 * "Running the tick twice in the same window produces one plan document and one
 * push" is asserted twice over, because the two failures are different:
 *
 *  - **Sequentially** — Cloud Scheduler retried a request whose response was
 *    lost, or the minute cron simply fired again before the user's delivery
 *    instant had moved. Caught by the claim: `nextRunAt` has already advanced.
 *  - **Concurrently** — two Cloud Run instances tick at the same moment. Caught
 *    by the claim being a *transaction* over the field it reads, the same
 *    property `tests/scheduler/schedulerContention.test.ts` proves for job
 *    claiming. The assertion is not "roughly one" — it is exactly one document
 *    and exactly one push.
 *
 * Both assert the push count, not only the document count. A second document is
 * something an operator notices later; a second push is something a person is
 * woken up by.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { AUDIENCE_ENV_VAR, SCHEDULER_SA_ENV_VAR, type OidcPayload } from '../../lib/auth/schedulerOidc.ts';
import { handleDailyPlanRequest } from '../../lib/jobs/internalJobs.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  claimDueDeliveryOutcome,
  composeDailyPlan,
  listDueAccounts,
  runDailyPlanTick,
  savePlanSettings,
  type DailyPlanTickTotals,
  type PlanReadyNotice,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { busyBlockId, replaceBusyBlocks, type BusyBlock } from '../../lib/calendar/busyBlocks.ts';
import { dayHorizon } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { toEpochMs } from '../../lib/planning/shared/time.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { DomainState } from '../../src/domain/stateMachine.ts';
import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSnapshot,
} from '../../src/contracts/v1/readinessContracts.ts';
import {
  saveNormalizedReadinessSnapshot,
  saveSubjectiveEnergyCheckIn,
} from '../../lib/userState/userStateService.ts';

const TZ = 'Asia/Jerusalem';
const SA = 'maybesitter-scheduler@example-project.iam.gserviceaccount.com';
const AUDIENCE = 'https://api.example.invalid';
const ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: SA, [AUDIENCE_ENV_VAR]: AUDIENCE };
const SCHEDULER: OidcPayload = { email: SA, email_verified: true, aud: AUDIENCE, iss: 'https://accounts.google.com' };

/** 2026-09-15 06:00 UTC is 09:00 in Jerusalem, comfortably past a 07:30 delivery. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
/** 04:00 UTC is 07:00 local: before the 07:30 delivery. */
const TOO_EARLY = new Date('2026-09-15T04:00:00.000Z');

function lowReadiness(uid: string, computedAt = '2026-09-15T05:00:00.000Z'): ReadinessSnapshot {
  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId: uid,
    computedAt,
    windowStart: '2026-09-14T20:00:00.000Z',
    windowEnd: computedAt,
    band: 'low',
    score: 0.2,
    normalizedSignals: { restingHeartRate: 61, hrv: 42 },
    subjective: null,
    derived: { readinessBand: 'low', confidence: 0.8 },
    signals: [{
      signalId: 'healthkit-summary',
      source: { kind: 'healthkit' },
      metric: 'recovery',
      observedAt: computedAt,
      normalizedScore: 0.2,
      nativeValue: 42,
      nativeUnit: 'milliseconds',
      confidence: 0.8,
    }],
    sourceKinds: ['healthkit'],
    missingSourceKinds: ['health_connect', 'whoop', 'subjective'],
  };
}

function bearer(token: string | null) {
  return { headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? token : null) } };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

function withCommitments(titles: readonly string[]): DomainState {
  let state = createEmptyDomainState();
  titles.forEach((title, index) => {
    const id = `cmt_${index}`;
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  });
  return state;
}

/** An account with commitments, a zone, and delivery armed for `at`. */
async function seed(
  storage: StorageAdapter,
  uid: string,
  options: { titles?: readonly string[]; enabled?: boolean; deliveryLocalTime?: string; armedAt?: Date } = {},
): Promise<void> {
  await persistParticipantState(uid, withCommitments(options.titles ?? ['Write the summary', 'Call the bank']));
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(
    uid,
    { enabled: options.enabled ?? true, deliveryLocalTime: options.deliveryLocalTime ?? '07:30' },
    options.armedAt ?? new Date('2026-09-14T12:00:00.000Z'),
    { storage },
  );
}

function recorder() {
  const sent: PlanReadyNotice[] = [];
  return { sent, push: async (notice: PlanReadyNotice) => { sent.push(notice); } };
}

async function withStorage<T>(fn: (storage: StorageAdapter) => Promise<T>): Promise<T> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    return await fn(storage);
  } finally {
    resetStorageForTests();
  }
}

/* ── Who is due ──────────────────────────────────────────────────── */

test('an account is due only once its own local delivery time has passed', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_due_1');
    assert.deepEqual(await listDueAccounts(TOO_EARLY, { storage }), [], '07:00 local is not 07:30 local');
    assert.deepEqual(await listDueAccounts(MORNING, { storage }), ['user_due_1']);
  });
});

test('an account that switched delivery off is not due, and not merely filtered out', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_off_1');
    await savePlanSettings('user_off_1', { enabled: false }, new Date('2026-09-14T12:00:00.000Z'), { storage });
    const stored = await storage.get<{ planSettings: Record<string, unknown> }>(userDoc('user_off_1'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(stored!.planSettings, 'nextRunAt'),
      false,
      'a disabled account kept a nextRunAt, so Firestore would return it from every sweep for ever',
    );
    assert.deepEqual(await listDueAccounts(MORNING, { storage }), []);
  });
});

test('two accounts in different zones are both served by one sweep', async () => {
  await withStorage(async (storage) => {
    await persistParticipantState('user_nz', withCommitments(['Something']));
    const nz = await storage.get<Record<string, unknown>>(userDoc('user_nz'));
    await storage.set(userDoc('user_nz'), { ...(nz ?? {}), timezone: 'Pacific/Auckland', locale: 'en' });
    await savePlanSettings('user_nz', { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
    await seed(storage, 'user_il');

    // 2026-09-15 06:00Z is 18:00 in Auckland — its 07:30 has long passed —
    // and 09:00 in Jerusalem. One query, two clock faces.
    assert.deepEqual((await listDueAccounts(MORNING, { storage })).sort(), ['user_il', 'user_nz']);
  });
});

test('claiming moves the delivery on to the next local morning', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_claim_1');
    const claim = await claimDueDelivery('user_claim_1', MORNING, { storage });
    assert.equal(claim?.date, '2026-09-15');
    // 07:30 on 2026-09-16 in Jerusalem (UTC+3) is 04:30Z.
    assert.equal(claim?.settings.nextRunAt, '2026-09-16T04:30:00.000Z');
    assert.equal(await claimDueDelivery('user_claim_1', MORNING, { storage }), null, 'the same morning was claimed twice');
  });
});

/* ── The acceptance criterion: one document, one push ────────────── */

test('two ticks in the same window produce one plan document and one push', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_once_1');
    const push = recorder();

    const first = await runDailyPlanTick({ storage, push: push.push, now: () => MORNING });
    const second = await runDailyPlanTick({ storage, push: push.push, now: () => MORNING });

    assert.deepEqual(
      { built: first.built, pushed: first.pushed },
      { built: 1, pushed: 1 },
      'the first tick did not build the plan',
    );
    assert.deepEqual(
      { due: second.due, claimed: second.claimed, built: second.built, pushed: second.pushed },
      { due: 0, claimed: 0, built: 0, pushed: 0 },
      'the second tick built or pushed again',
    );
    assert.equal(push.sent.length, 1, 'the user was notified twice');
    assert.equal(push.sent[0]!.dedupeKey, 'plan:2026-09-15');

    const stored = await readStoredPlan('user_once_1', '2026-09-15', storage);
    assert.ok(stored, 'no plan was stored');
    assert.equal(stored!.generation, 1);
    assert.equal(stored!.status, 'proposed');

    const events = await listPlanEvents('user_once_1', storage);
    assert.deepEqual(events.map((event) => event.type), ['plan_proposed'], 'the ledger recorded the plan twice');

    // And the layer underneath: the same claim, replayed. This is the request
    // whose response Cloud Scheduler never saw, so the claim was spent but the
    // retry arrives holding it. Without `createIfAbsent` this writes a second
    // document and sends a second push, and the two counters above would not
    // notice — the sweep never runs again.
    const replayed = await buildAndStoreDailyPlan(
      { uid: 'user_once_1', date: '2026-09-15', settings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ } },
      { storage, push: push.push, now: () => MORNING },
    );
    assert.equal(replayed.created, false, 'a replayed claim wrote a second plan document');
    assert.equal(replayed.pushed, false, 'a replayed claim sent a second push');
    assert.equal(push.sent.length, 1);
    assert.deepEqual(replayed.stored, stored, 'the replay changed the stored plan');
  });
});

test('two concurrent ticks — two instances in the same minute — produce one plan document and one push', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_race_1');
    const push = recorder();

    const [left, right] = await Promise.all([
      runDailyPlanTick({ storage, push: push.push, now: () => MORNING }),
      runDailyPlanTick({ storage, push: push.push, now: () => MORNING }),
    ]);

    assert.equal(left.claimed + right.claimed, 1, 'both instances claimed the same morning');
    assert.equal(left.built + right.built, 1, 'two plan documents were written for one morning');
    assert.equal(push.sent.length, 1, 'the user was woken twice by two instances');

    const stored = await readStoredPlan('user_race_1', '2026-09-15', storage);
    assert.equal(stored!.generation, 1);
  });
});

test('a plan document that already exists is never overwritten, and never pushed again', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_exists_1');
    const push = recorder();
    await runDailyPlanTick({ storage, push: push.push, now: () => MORNING });
    const first = await readStoredPlan('user_exists_1', '2026-09-15', storage);

    // Re-arm the same morning by hand: this is the crashed-after-claim case,
    // where the claim is gone but the document is there.
    const user = await storage.get<Record<string, unknown>>(userDoc('user_exists_1'));
    await storage.set(userDoc('user_exists_1'), {
      ...(user ?? {}),
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, nextRunAt: '2026-09-15T04:30:00.000Z' },
    });

    const totals = await runDailyPlanTick({ storage, push: push.push, now: () => MORNING });
    assert.equal(totals.claimed, 1, 'the re-armed morning was not claimed');
    assert.equal(totals.built, 0, 'an existing plan was overwritten');
    assert.equal(push.sent.length, 1, 'a second push went out for a plan that already existed');
    assert.deepEqual(await readStoredPlan('user_exists_1', '2026-09-15', storage), first);
  });
});

/* ── AC-1, through the job rather than the mapping ───────────────── */

const SOURCE = 'device:1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const HORIZON_0915 = dayHorizon('2026-09-15', TZ);
/** Local `hours` on 2026-09-15 in Jerusalem, as an instant. */
const at0915 = (hours: number): string => new Date(toEpochMs(HORIZON_0915.startsAt) + hours * 3_600_000).toISOString();

function busyBlock(nativeId: string, fromHour: number, toHour: number): BusyBlock {
  return {
    blockId: busyBlockId(SOURCE, nativeId, at0915(fromHour)),
    sourceId: SOURCE,
    sourceKind: 'device',
    startAt: at0915(fromHour),
    endAt: at0915(toHour),
    allDay: false,
  };
}

/**
 * The issue's first criterion, end to end: the tick, the default busy-block
 * reader over stored blocks, and the stored document. `buildDailyPlan.test.ts`
 * proves the mapping with injected blocks and `busyPlanning.test.ts` proves one
 * stored block through a claim; this is the criterion as written — three items,
 * two blocks, the job, `plans/{date}`, and the digest across two runs.
 *
 * The blocks sit at 08:00–09:00 and 09:30–10:30, the first hours of the
 * fallback working window, where three half-hour items would otherwise go. The
 * control run without them proves that, so "no overlap" is not satisfied by a
 * planner that never looked at those hours.
 */
async function tickWithBusy(blocks: readonly BusyBlock[]) {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    await seed(storage, 'user_ac1', { titles: ['Write the summary', 'Call the bank', 'Book the train'] });
    await replaceBusyBlocks('user_ac1', SOURCE, HORIZON_0915, blocks, { storage, platform: 'ios', now: MORNING });
    const totals = await runDailyPlanTick({ storage, push: recorder().push, now: () => MORNING });
    assert.equal(totals.built, 1, 'the job did not write the plan');
    const stored = await readStoredPlan('user_ac1', '2026-09-15', storage);
    assert.ok(stored, 'plans/2026-09-15 was not written');
    return stored!;
  } finally {
    resetStorageForTests();
  }
}

test('AC-1: three confirmed items and two stored busy blocks — the job\'s plan never overlaps them, and its digest is stable', async () => {
  const blocks = [busyBlock('standup', 8, 9), busyBlock('lecture', 9.5, 10.5)];
  const overlaps = (interval: { startsAt: string; endsAt: string }) => blocks.some((block) => (
    toEpochMs(interval.startsAt) < toEpochMs(block.endAt) && toEpochMs(interval.endsAt) > toEpochMs(block.startAt)
  ));

  const control = await tickWithBusy([]);
  assert.ok(
    control.plan.scheduled.some((placed) => overlaps(placed.reservedInterval)),
    'without the blocks the planner never uses those hours, so the check below would prove nothing',
  );

  const first = await tickWithBusy(blocks);
  const second = await tickWithBusy(blocks);
  assert.equal(first.plan.scheduled.length, 3, 'the three items did not all fit around the busy blocks');
  for (const placed of first.plan.scheduled) {
    assert.equal(overlaps(placed.reservedInterval), false, `${placed.itemId} was placed inside a busy block`);
  }
  assert.equal(first.inputDigest, first.plan.inputDigest);
  assert.equal(second.inputDigest, first.inputDigest, 'the same input gave two digests on two runs');
  assert.deepEqual(second.plan.scheduled, first.plan.scheduled);
  assert.notEqual(control.inputDigest, first.inputDigest, 'the digest does not cover the busy blocks');
});

/* ── One bad account does not cost the others their morning ──────── */

test('an account that fails is counted and skipped; the rest still get their plan', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_bad_1');
    await seed(storage, 'user_good_1');
    const push = recorder();

    const totals = await quiet(() => runDailyPlanTick({
      storage,
      push: push.push,
      now: () => MORNING,
      busyBlocks: async (uid) => {
        if (uid === 'user_bad_1') throw new Error('the calendar is unreachable');
        return [];
      },
    }));

    assert.equal(totals.due, 2);
    assert.equal(totals.failed, 1);
    assert.equal(totals.built, 1);
    assert.equal(push.sent.length, 1);
    assert.ok(await readStoredPlan('user_good_1', '2026-09-15', storage), 'the healthy account lost its morning');
    assert.equal(await readStoredPlan('user_bad_1', '2026-09-15', storage), null);
  });
});

test('a failed account does not retry every minute for ever: its delivery has already moved', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_bad_2');
    await quiet(() => runDailyPlanTick({
      storage, now: () => MORNING, busyBlocks: async () => { throw new Error('nope'); },
    }));
    assert.deepEqual(await listDueAccounts(MORNING, { storage }), []);
  });
});

/* ── The route, and its guard ────────────────────────────────────── */

const REFUSED: Array<[string, string | null, OidcPayload | 'throws']> = [
  ['no token', null, SCHEDULER],
  ['a Firebase user ID token', 'Bearer user-token', { email: 'someone@example.com', email_verified: true, aud: 'example-project', iss: 'https://securetoken.google.com/example-project' }],
  ['a different service account', 'Bearer t', { ...SCHEDULER, email: 'other@other-project.iam.gserviceaccount.com' }],
  ['a token for the wrong audience', 'Bearer t', { ...SCHEDULER, aud: 'https://staging.example.invalid' }],
  ['a token Google does not verify', 'Bearer t', 'throws'],
];

for (const [label, header, payload] of REFUSED) {
  test(`daily-plan: ${label} is refused with 401 and builds nothing`, async () => {
    let swept = false;
    const response = await quiet(() => handleDailyPlanRequest(bearer(header), {
      env: ENV,
      verify: async () => {
        if (payload === 'throws') throw new Error('bad signature');
        return payload;
      },
      dailyPlan: async () => {
        swept = true;
        return { due: 0, claimed: 0, built: 0, pushed: 0, failed: 0 };
      },
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(swept, false, 'a refused request still built plans');
  });
}

test('daily-plan: missing configuration is 503 and builds nothing', async () => {
  let swept = false;
  const response = await quiet(() => handleDailyPlanRequest(bearer('Bearer t'), {
    env: { NODE_ENV: 'test' },
    verify: async () => SCHEDULER,
    dailyPlan: async () => {
      swept = true;
      return { due: 0, claimed: 0, built: 0, pushed: 0, failed: 0 };
    },
  }));
  assert.equal(response.status, 503);
  assert.equal(swept, false);
});

test('daily-plan: a valid scheduler token runs the real sweep', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_route_1');
    // No injected sweep: the route as deployed, over memory storage. The clock
    // is the real one, so the account is armed for a moment long past — which
    // is also the launch-path case, since the cron is provisioned by hand and
    // `PUT /settings/plan` is live before it.
    const user = await storage.get<Record<string, unknown>>(userDoc('user_route_1'));
    await storage.set(userDoc('user_route_1'), {
      ...(user ?? {}),
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, nextRunAt: '2020-01-01T00:00:00.000Z' },
    });

    const response = await handleDailyPlanRequest(bearer('Bearer scheduler-token'), { env: ENV, verify: async () => SCHEDULER });
    assert.equal(response.status, 200);
    const totals = (await response.json()) as DailyPlanTickTotals;
    assert.equal(totals.due, 1);
    assert.equal(totals.built, 1);
    // Derived here from the real clock through `Intl` rather than through the
    // module under test, and never written down as a literal: a date literal in
    // an assertion is a test that rots on a day nobody is watching (#382).
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    assert.ok(
      await readStoredPlan('user_route_1', today, storage),
      'the sweep did not build a plan for the day it ran on',
    );
    assert.equal(
      await readStoredPlan('user_route_1', '2020-01-01', storage),
      null,
      'a plan was written for a date that has passed; the phone would be pushed about a GET that 404s',
    );
  });
});

/* ── A stale claim dates the plan by the user's clock now ────────── */

test('a week-stale delivery builds today\'s plan, not a plan for a date that has passed', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_stale_1');
    const user = await storage.get<Record<string, unknown>>(userDoc('user_stale_1'));
    // Armed a week before the sweep ever ran: the cron is an owner action
    // (`infra/scheduler.sh`) and the settings route is live without it.
    await storage.set(userDoc('user_stale_1'), {
      ...(user ?? {}),
      planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, nextRunAt: '2026-09-08T04:30:00.000Z' },
    });

    const claim = await claimDueDelivery('user_stale_1', MORNING, { storage });
    assert.equal(claim?.date, '2026-09-15', 'the plan was dated by the stale instant rather than by the user\'s today');

    const push = recorder();
    const totals = await runDailyPlanTick({ storage, push: push.push, now: () => MORNING });
    assert.equal(totals.built, 0, 'the claim above already took the delivery');
    // And through the sweep, from a fresh arming: one plan, dated today.
    await storage.set(userDoc('user_stale_2'), { timezone: TZ, locale: 'en', planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: TZ, nextRunAt: '2026-09-08T04:30:00.000Z' } });
    await persistParticipantState('user_stale_2', withCommitments(['Write the summary']));
    const second = await runDailyPlanTick({ storage, push: push.push, now: () => MORNING });
    assert.equal(second.built, 1);
    assert.equal(push.sent.at(-1)!.dedupeKey, 'plan:2026-09-15');
    assert.ok(await readStoredPlan('user_stale_2', '2026-09-15', storage));
    assert.equal(await readStoredPlan('user_stale_2', '2026-09-08', storage), null);
  });
});

/* ── An unclaimable account does not take the batch with it ──────── */

/** Due by every raw field the query reads, and unreadable by `planSettingsOf`. */
async function seedUnreadable(storage: StorageAdapter, uid: string): Promise<void> {
  await storage.set(userDoc(uid), {
    timezone: TZ,
    locale: 'en',
    // A zone `Intl` does not know. Written by hand, or by a build that spelled
    // zones differently: the record is enabled and armed, and nothing in this
    // code can turn it into settings.
    planSettings: { enabled: true, deliveryLocalTime: '07:30', timezone: 'Mars/Olympus', nextRunAt: '2026-09-01T04:30:00.000Z' },
  });
}

test('an account whose settings cannot be read is disarmed and counted, not returned for ever', async () => {
  await withStorage(async (storage) => {
    await seedUnreadable(storage, 'user_unreadable_1');

    const outcome = await quiet(() => claimDueDeliveryOutcome('user_unreadable_1', MORNING, { storage }));
    assert.equal(outcome.kind, 'unreadable');

    const stored = await storage.get<{ planSettings: Record<string, unknown> }>(userDoc('user_unreadable_1'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(stored!.planSettings, 'nextRunAt'),
      false,
      'the record kept its nextRunAt, so it sorts first in every sweep from now until somebody notices',
    );
    assert.equal(stored!.planSettings.timezone, 'Mars/Olympus', 'the unreadable record was overwritten rather than disarmed');
    assert.deepEqual(await listDueAccounts(MORNING, { storage }), []);
  });
});

test('fifty unclaimable accounts do not disable the feature for everyone', async () => {
  await withStorage(async (storage) => {
    // `orderBy nextRunAt asc` puts the broken record first, and a batch of them
    // is the whole batch. With `limit: 1` that is exactly what one healthy
    // account behind one broken one experiences.
    await seedUnreadable(storage, 'user_blocker_1');
    await seed(storage, 'user_behind_1');
    const push = recorder();

    const first = await quiet(() => runDailyPlanTick({ storage, push: push.push, now: () => MORNING, limit: 1 }));
    assert.deepEqual(
      { due: first.due, claimed: first.claimed, built: first.built, failed: first.failed },
      { due: 1, claimed: 0, built: 0, failed: 1 },
      'a batch that went nowhere reported nothing wrong',
    );

    const second = await quiet(() => runDailyPlanTick({ storage, push: push.push, now: () => MORNING, limit: 1 }));
    assert.equal(second.built, 1, 'the healthy account is still stuck behind the broken one');
    assert.equal(push.sent.length, 1);
    assert.ok(await readStoredPlan('user_behind_1', '2026-09-15', storage));
  });
});

/* ── A move changes where the morning is ─────────────────────────── */

test('a profile timezone change moves the delivery without the user touching the setting', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_moved_1');
    const armed = await storage.get<{ planSettings: { nextRunAt?: string } }>(userDoc('user_moved_1'));
    assert.equal(armed!.planSettings.nextRunAt, '2026-09-15T04:30:00.000Z', '07:30 in Jerusalem');

    // The user moves. Nothing else about the settings changes — this is the
    // case the old snapshot could not see, and it kept delivering at 07:30
    // Israel time, which is 00:30 in New York.
    const user = await storage.get<Record<string, unknown>>(userDoc('user_moved_1'));
    await storage.set(userDoc('user_moved_1'), { ...(user ?? {}), timezone: 'America/New_York' });

    const push = recorder();
    const totals = await runDailyPlanTick({
      storage, push: push.push, now: () => new Date('2026-09-15T04:30:00.000Z'),
    });
    assert.equal(totals.built, 1);

    const settings = await storage.get<{ planSettings: { timezone: string; nextRunAt?: string } }>(userDoc('user_moved_1'));
    assert.equal(settings!.planSettings.timezone, 'America/New_York', 'the stored zone is still the one they left');
    assert.equal(
      settings!.planSettings.nextRunAt,
      '2026-09-15T11:30:00.000Z',
      'the next delivery is not 07:30 in New York, so the move never reached the schedule',
    );

    const stored = await readStoredPlan('user_moved_1', '2026-09-15', storage);
    assert.equal(stored!.timezone, 'America/New_York', 'the plan was built against the zone they left');
  });
});

/* ── Production UserState readiness projection ──────────────────── */

test('current subjective energy outranks wearable readiness in the canonical planner', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_readiness_precedence';
    await seed(storage, uid, { titles: ['Write the summary'] });
    assert.equal(await saveNormalizedReadinessSnapshot(uid, lowReadiness(uid), {
      storage,
      now: MORNING.toISOString(),
    }), 'stored');

    const wearablePlan = await composeDailyPlan(uid, '2026-09-15', { timezone: TZ }, 1, {
      storage,
      now: () => MORNING,
    });
    assert.ok(wearablePlan.constraints.items.length > 0);
    assert.ok(wearablePlan.constraints.items.every((item) => item.bufferAfterMinutes === 15));

    assert.equal(await saveSubjectiveEnergyCheckIn(uid, {
      energy: 5,
      observedAt: '2026-09-15T05:30:00.000Z',
    }, { storage, now: MORNING.toISOString() }), 'stored');
    const userPlan = await composeDailyPlan(uid, '2026-09-15', { timezone: TZ }, 2, {
      storage,
      now: () => MORNING,
    });
    assert.ok(userPlan.constraints.items.every((item) => item.bufferAfterMinutes === 0));

    const user = await storage.get<Record<string, unknown>>(userDoc(uid));
    const context = user!.readinessContext as { recentReadiness: ReadinessSnapshot };
    assert.deepEqual(context.recentReadiness.normalizedSignals, {}, 'raw normalized health measurements were persisted');
    assert.ok(context.recentReadiness.signals.every((signal) => signal.nativeValue === null));
    assert.equal(Object.prototype.hasOwnProperty.call(user!, 'userState'), false, 'a projection was persisted as a second state system');
  });
});

test('a stale subjective statement cannot override a recent readiness snapshot', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_readiness_stale_subjective';
    await seed(storage, uid, { titles: ['Prepare the brief'] });
    await saveNormalizedReadinessSnapshot(uid, lowReadiness(uid), { storage, now: MORNING.toISOString() });
    await saveSubjectiveEnergyCheckIn(uid, {
      energy: 5,
      observedAt: '2026-09-14T10:00:00.000Z',
    }, { storage, now: MORNING.toISOString() });

    const plan = await composeDailyPlan(uid, '2026-09-15', { timezone: TZ }, 1, {
      storage,
      now: () => MORNING,
    });
    assert.ok(plan.constraints.items.every((item) => item.bufferAfterMinutes === 15));
  });
});

test('readiness snapshots cannot cross account boundaries or roll freshness backwards', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'user_readiness_a', { titles: ['A'] });
    await seed(storage, 'user_readiness_b', { titles: ['B'] });
    await assert.rejects(
      saveNormalizedReadinessSnapshot('user_readiness_b', lowReadiness('user_readiness_a'), { storage }),
      /another account/,
    );
    assert.equal(
      await saveNormalizedReadinessSnapshot('user_readiness_a', lowReadiness('user_readiness_a'), {
        storage,
        now: MORNING.toISOString(),
      }),
      'stored',
    );
    assert.equal(
      await saveNormalizedReadinessSnapshot(
        'user_readiness_a',
        lowReadiness('user_readiness_a', '2026-09-15T04:00:00.000Z'),
        { storage, now: MORNING.toISOString() },
      ),
      'stale_ignored',
    );
    const other = await storage.get<Record<string, unknown>>(userDoc('user_readiness_b'));
    assert.equal(Object.prototype.hasOwnProperty.call(other!, 'readinessContext'), false);
  });
});

/* ── The index the sweep needs is declared ───────────────────────── */

test('the composite index the due-account query needs is in firestore.indexes.json', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const config = JSON.parse(readFileSync(join(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
    indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order?: string }> }>;
  };
  // The fields are read out of the service rather than retyped, so renaming a
  // queried field without touching the index file fails here instead of in
  // production, where it is a 400 on the first sweep of the morning.
  const source = readFileSync(join(repoRoot, 'lib/services/dailyPlan/dailyPlanService.ts'), 'utf8');
  const queried = Array.from(source.matchAll(/\['(planSettings\.[A-Za-z]+)',\s*'(?:==|<=)'/g), (match) => match[1]!);
  assert.deepEqual(queried, ['planSettings.enabled', 'planSettings.nextRunAt'], 'the sweep no longer asks what this test thinks it asks');

  const declared = config.indexes
    .filter((index) => index.collectionGroup === 'users' && index.queryScope === 'COLLECTION')
    .map((index) => index.fields.map((field) => field.fieldPath));
  assert.ok(
    declared.some((fields) => fields.length === queried.length && fields.every((field, at) => field === queried[at])),
    `no users index covers ${queried.join(' + ')}; Firestore answers 400 FAILED_PRECONDITION on every sweep. Declared: ${JSON.stringify(declared)}`,
  );
});
