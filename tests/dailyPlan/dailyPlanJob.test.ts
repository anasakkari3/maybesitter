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
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { AUDIENCE_ENV_VAR, SCHEDULER_SA_ENV_VAR, type OidcPayload } from '../../lib/auth/schedulerOidc.ts';
import { handleDailyPlanRequest } from '../../lib/jobs/internalJobs.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  listDueAccounts,
  runDailyPlanTick,
  savePlanSettings,
  type DailyPlanTickTotals,
  type PlanReadyNotice,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { DomainState } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';
const SA = 'maybesitter-scheduler@example-project.iam.gserviceaccount.com';
const AUDIENCE = 'https://api.example.invalid';
const ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: SA, [AUDIENCE_ENV_VAR]: AUDIENCE };
const SCHEDULER: OidcPayload = { email: SA, email_verified: true, aud: AUDIENCE, iss: 'https://accounts.google.com' };

/** 2026-09-15 06:00 UTC is 09:00 in Jerusalem, comfortably past a 07:30 delivery. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
/** 04:00 UTC is 07:00 local: before the 07:30 delivery. */
const TOO_EARLY = new Date('2026-09-15T04:00:00.000Z');

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
    // is the real one, so the account is armed for a moment already past.
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
    assert.ok(await readStoredPlan('user_route_1', '2020-01-01', storage));
  });
});
