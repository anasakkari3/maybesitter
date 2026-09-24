/**
 * A morning plan's push is retried, push-only, until it lands or is dropped (#431).
 *
 * Three ways the plan was stored and the phone stayed silent — quiet hours, a
 * throwing FCM send, a crash between the plan write and the send — and one
 * mechanism for all three: a push-pending marker on the plan document, and a
 * push-only retry the same minute sweep re-arms from it.
 *
 * Every test here drives the real sweep, `runDailyPlanTick`, over memory
 * storage, with **no sender injected**: only the FCM client is faked, so the
 * production `sendToUser` path runs — its quiet-hours gate, its device list and
 * its `pushLog` dedupe lock. What is counted is what reached FCM.
 *
 * All clocks are Asia/Jerusalem, UTC+3 in September: 04:30Z is 07:30 local.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import type { FcmMessage, MessagingClient } from '../../lib/push/pushService.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand, createEmptyDomainState, type DomainState } from '../../src/domain/stateMachine.ts';
import {
  runDailyPlanTick,
  savePlanSettings,
  type DailyPlanTickTotals,
  type PlanReadyNotice,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import {
  appendPlanEvent,
  listPlanEvents,
  planPath,
  readStoredPlan,
  type StoredDailyPlan,
} from '../../lib/services/dailyPlan/planStore.ts';
import { acceptPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { planToDto } from '../../lib/services/dailyPlan/planDto.ts';
import {
  MAX_PLAN_PUSH_ATTEMPTS,
  MORNING_PLAN_PUSH_CUTOFF_LOCAL_TIME,
  PLAN_PUSH_LEASE_MS,
  PLAN_PUSH_RETRY_DELAY_MS,
  claimPlanPushRetry,
} from '../../lib/services/dailyPlan/planPushRetry.ts';
import { deleteAccount, type DeletionAuthAdmin } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
const TITLES = ['كتابة الملخص السري', 'לכתוב את הסיכום הסודי', 'Write the secret summary'];
/** 09:00 local, past a 07:30 delivery. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const MINUTE = 60_000;

function at(base: Date, plusMs: number): Date {
  return new Date(base.getTime() + plusMs);
}

function withCommitments(titles: readonly string[]): DomainState {
  let state = createEmptyDomainState();
  titles.forEach((title, index) => {
    const id = `cmt_${index}`;
    state = applyCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  });
  return state;
}

async function seed(storage: StorageAdapter, uid: string, options: { delivery?: string; quietHours?: { start: string; end: string } } = {}): Promise<void> {
  await persistParticipantState(uid, withCommitments(TITLES));
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(
    uid,
    { enabled: true, deliveryLocalTime: options.delivery ?? '07:30' },
    new Date('2026-09-14T12:00:00.000Z'),
    { storage },
  );
  await upsertDevice(uid, {
    installationId: 'install-0',
    fcmToken: `token0${uid.replace(/[^A-Za-z0-9]/g, '')}`,
    platform: 'ios',
    appVersion: '1.0.0',
    locale: 'en',
    timezone: TZ,
    pushPermission: 'granted',
  }, '2026-09-14T12:00:00.000Z', { storage });
  if (options.quietHours) {
    await saveRoutineProfile(uid, {
      timezone: TZ,
      sleepWindow: null,
      focusWindows: [],
      fixedCommitmentWindows: [],
      preferredReminderIntensity: 'softAwareness',
      quietHours: options.quietHours,
      surveySkipped: false,
    }, '2026-09-14T12:00:00.000Z', { storage });
  }
}

/**
 * An FCM client whose calls can be told to fail. `delivered` is what a phone
 * would have received; `calls` is every attempt, failed ones included.
 */
function fcm(fails: (call: number) => boolean = () => false): MessagingClient & { calls: FcmMessage[]; delivered: FcmMessage[] } {
  const calls: FcmMessage[] = [];
  const delivered: FcmMessage[] = [];
  return {
    calls,
    delivered,
    async send(message: FcmMessage) {
      calls.push(message);
      if (fails(calls.length)) throw Object.assign(new Error('internal'), { code: 'messaging/internal-error' });
      delivered.push(message);
      return `projects/x/messages/${delivered.length}`;
    },
  };
}

interface Logged { lines: string[] }

async function captureLogs<T>(logged: Logged, fn: () => Promise<T>): Promise<T> {
  const error = console.error;
  const warn = console.warn;
  const record = (...args: unknown[]) => { logged.lines.push(args.map(String).join(' ')); };
  console.error = record;
  console.warn = record;
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

async function tick(
  storage: StorageAdapter,
  messaging: MessagingClient,
  when: Date,
  logged: Logged = { lines: [] },
): Promise<DailyPlanTickTotals> {
  return captureLogs(logged, () => runDailyPlanTick({ storage, messaging, now: () => when }));
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

async function planOf(storage: StorageAdapter, uid: string, date = DATE): Promise<StoredDailyPlan> {
  const stored = await readStoredPlan(uid, date, storage);
  assert.ok(stored, `no plan for ${date}`);
  return stored!;
}

/** The plan as the user sees it: everything but the push bookkeeping. */
function withoutMarker(stored: StoredDailyPlan): Omit<StoredDailyPlan, 'pushPending'> {
  const { pushPending: _marker, ...rest } = stored;
  return rest;
}

const failsFirst = (call: number) => call === 1;
const failsAlways = () => true;

/* ── 1. Quiet hours: delivered at their end, not never ────────────── */

test('a 07:30 delivery inside quiet hours ending 08:00 is not pushed at 07:30 and is pushed once at 08:00', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_quiet_1';
    await seed(storage, uid, { quietHours: { start: '06:00', end: '08:00' } });
    const messaging = fcm();
    const delivery = new Date('2026-09-15T04:30:00.000Z'); // 07:30 local
    const quietEnd = new Date('2026-09-15T05:00:00.000Z'); // 08:00 local

    const first = await tick(storage, messaging, delivery);
    assert.deepEqual({ built: first.built, pushed: first.pushed }, { built: 1, pushed: 0 });
    assert.equal(messaging.calls.length, 0, 'the push went out inside quiet hours');
    const armed = (await planOf(storage, uid)).pushPending?.nextAttemptAt;

    for (const minute of [5, 15, 29]) {
      await tick(storage, messaging, at(delivery, minute * MINUTE));
      assert.equal(messaging.calls.length, 0, `pushed at 07:${30 + minute}, still inside quiet hours`);
    }

    const atEnd = await tick(storage, messaging, quietEnd);
    assert.equal(messaging.delivered.length, 1, 'the morning was not pushed at the end of quiet hours');
    assert.deepEqual({ retried: atEnd.retried, retryPushed: atEnd.retryPushed, built: atEnd.built }, { retried: 1, retryPushed: 1, built: 0 });
    assert.equal(armed, quietEnd.toISOString(), 'the retry was not armed for the end of quiet hours');
    for (const minute of [1, 5, 30]) await tick(storage, messaging, at(quietEnd, minute * MINUTE));

    assert.equal(messaging.delivered.length, 1, 'the morning was not delivered exactly once');
    assert.equal(messaging.delivered[0]!.data.planDate, DATE);
    assert.equal(messaging.delivered[0]!.apns.headers['apns-collapse-id'], `plan:${DATE}`);
    const stored = await planOf(storage, uid);
    assert.equal(stored.pushPending, undefined, 'a delivered push left its marker behind');
    assert.equal(stored.generation, 1, 'the retry rebuilt the plan');
  });
});

/* ── 2. A throwing send: the next sweep retries push-only ─────────── */

test('after FCM internal-error, the next sweep pushes once, push-only: the plan is not rebuilt (the #431 probe)', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_throw_1';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);
    const logged: Logged = { lines: [] };

    const first = await tick(storage, messaging, MORNING, logged);
    assert.deepEqual(
      { claimed: first.claimed, built: first.built, pushed: first.pushed, failed: first.failed },
      { claimed: 1, built: 1, pushed: 0, failed: 0 },
    );
    assert.equal(messaging.delivered.length, 0);
    const before = await planOf(storage, uid);

    // The issue's probe: on main this second sweep answered `due: 0` and sent nothing.
    const second = await tick(storage, messaging, at(MORNING, PLAN_PUSH_RETRY_DELAY_MS), logged);
    assert.equal(messaging.delivered.length, 1, 'the lost push was not delivered');
    assert.deepEqual(
      { attempts: before.pushPending?.attempts, failedSends: before.pushPending?.failedSends, reason: before.pushPending?.reason },
      { attempts: 1, failedSends: 1, reason: 'send_failed' },
    );
    assert.deepEqual(
      { due: second.due, built: second.built, retried: second.retried, retryPushed: second.retryPushed },
      { due: 0, built: 0, retried: 1, retryPushed: 1 },
    );
    // A fresh key, because the first key was taken by the send that threw; the
    // same notification identifier, so a phone that did get it sees one.
    assert.equal(messaging.delivered[0]!.android.collapseKey, `plan:${DATE}:retry1`);
    assert.equal(messaging.delivered[0]!.apns.headers['apns-collapse-id'], `plan:${DATE}`);
    assert.equal(messaging.delivered[0]!.android.notification.tag, `plan:${DATE}`);

    const after = await planOf(storage, uid);
    assert.equal(after.pushPending, undefined);
    assert.deepEqual(withoutMarker(after), withoutMarker(before), 'the retry changed the plan, which means it rebuilt');
    const ledger = (await listPlanEvents(uid, storage)).map((event) => event.type);
    assert.deepEqual(ledger, ['plan_proposed'], 'the retry wrote to the plan ledger');

    await tick(storage, messaging, at(MORNING, 2 * PLAN_PUSH_RETRY_DELAY_MS), logged);
    assert.equal(messaging.delivered.length, 1, 'a later sweep pushed again');
    assert.equal(logged.lines.some((line) => line.includes(uid)), false, 'the uid reached the log');
  });
});

/* ── 3. A crash between the plan write and the send ───────────────── */

/**
 * The process dies after `createIfAbsent` and before the push. Simulated by a
 * storage that fails the very next write after the plan, the `plan_proposed`
 * ledger row: nothing after the plan write runs, so no push is sent and
 * nothing records one.
 */
function crashingAfterPlanWrite(storage: StorageAdapter): StorageAdapter & { crashed: boolean } {
  const crashing = {
    crashed: false,
    get: storage.get.bind(storage),
    list: storage.list.bind(storage),
    listGroup: storage.listGroup.bind(storage),
    delete: storage.delete.bind(storage),
    deleteTree: storage.deleteTree.bind(storage),
    runTransaction: storage.runTransaction.bind(storage),
    async set<T>(path: string, value: T): Promise<void> {
      if (!crashing.crashed && path.includes('/planEvents/')) {
        crashing.crashed = true;
        throw new Error('the instance went away');
      }
      return storage.set(path, value);
    },
  };
  return crashing as StorageAdapter & { crashed: boolean };
}

test('a crash between writing the plan and sending the push is delivered by a later sweep, once', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_crash_1';
    await seed(storage, uid);
    const messaging = fcm();
    const crashing = crashingAfterPlanWrite(storage);

    const first = await captureLogs({ lines: [] }, () => runDailyPlanTick({ storage: crashing, messaging, now: () => MORNING }));
    assert.equal(crashing.crashed, true, 'the premise is wrong: nothing crashed');
    assert.equal(first.failed, 1);
    assert.ok(await readStoredPlan(uid, DATE, storage), 'the premise is wrong: the plan was not written before the crash');
    assert.equal(messaging.calls.length, 0, 'the premise is wrong: the push went out before the crash');

    // Inside the dead attempt's lease nobody may take the push: from outside,
    // a crashed attempt and a slow one look the same.
    await tick(storage, messaging, at(MORNING, PLAN_PUSH_LEASE_MS - MINUTE));
    assert.equal(messaging.calls.length, 0, 'a sweep took the push while its first attempt could still be sending');

    const later = await tick(storage, messaging, at(MORNING, PLAN_PUSH_LEASE_MS));
    assert.equal(messaging.delivered.length, 1, 'the crashed morning was never pushed');
    assert.deepEqual({ retried: later.retried, retryPushed: later.retryPushed, built: later.built }, { retried: 1, retryPushed: 1, built: 0 });
    await tick(storage, messaging, at(MORNING, PLAN_PUSH_LEASE_MS + 5 * MINUTE));
    assert.equal(messaging.delivered.length, 1, 'the crashed morning was not delivered exactly once');
    assert.equal(messaging.delivered[0]!.data.planDate, DATE);
    assert.equal((await planOf(storage, uid)).pushPending, undefined);
  });
});

test('the marker is already on the plan when the first push is being sent', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_same_write_1';
    await seed(storage, uid);
    let seenDuringSend: StoredDailyPlan | null = null;
    await captureLogs({ lines: [] }, () => runDailyPlanTick({
      storage,
      now: () => MORNING,
      push: async (_notice: PlanReadyNotice) => {
        seenDuringSend = await readStoredPlan(uid, DATE, storage);
        return { status: 'sent' };
      },
    }));
    const pending = (seenDuringSend as StoredDailyPlan | null)?.pushPending;
    assert.deepEqual(
      pending && { attempts: pending.attempts, reason: pending.reason, nextAttemptAt: pending.nextAttemptAt },
      { attempts: 1, reason: 'in_flight', nextAttemptAt: at(MORNING, PLAN_PUSH_LEASE_MS).toISOString() },
      'the plan was stored without the push it owes',
    );
  });
});

/* ── 4. The bound ─────────────────────────────────────────────────── */

test(`a send that fails every time is attempted ${MAX_PLAN_PUSH_ATTEMPTS} times, then the marker is cleared`, async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_bound_1';
    await seed(storage, uid);
    const messaging = fcm(failsAlways);
    const logged: Logged = { lines: [] };

    for (let sweep = 0; sweep < MAX_PLAN_PUSH_ATTEMPTS + 3; sweep += 1) {
      await tick(storage, messaging, at(MORNING, sweep * PLAN_PUSH_RETRY_DELAY_MS), logged);
    }

    assert.equal(messaging.calls.length, MAX_PLAN_PUSH_ATTEMPTS, 'the retries did not stop at the bound');
    assert.deepEqual(
      messaging.calls.map((call) => call.android.collapseKey),
      [`plan:${DATE}`, `plan:${DATE}:retry1`, `plan:${DATE}:retry2`, `plan:${DATE}:retry3`],
    );
    assert.equal((await planOf(storage, uid)).pushPending, undefined, 'an exhausted push kept its marker');
    assert.ok(logged.lines.some((line) => line.includes('plan_push_dropped') && line.includes('exhausted')), 'giving up was not logged');
  });
});

/* ── 5. Staleness: a morning plan is not pushed after local noon ──── */

test(`the cutoff is local ${MORNING_PLAN_PUSH_CUTOFF_LOCAL_TIME}: a retry that would land after it is dropped, not sent`, async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_noon_1';
    await seed(storage, uid, { delivery: '11:57' });
    const messaging = fcm(failsFirst);
    const logged: Logged = { lines: [] };
    const delivery = new Date('2026-09-15T08:57:00.000Z'); // 11:57 local

    await tick(storage, messaging, delivery, logged);
    assert.equal(messaging.calls.length, 1, 'the premise is wrong: the morning attempt was not made');
    for (const minutes of [5, 10, 60]) await tick(storage, messaging, at(delivery, minutes * MINUTE), logged);

    assert.equal(messaging.delivered.length, 0, 'a morning plan was pushed after noon');
    assert.equal((await planOf(storage, uid)).pushPending, undefined, 'the dropped push kept its marker');
    assert.ok(logged.lines.some((line) => line.includes('plan_push_dropped') && line.includes('stale')));
  });
});

test('a retry that fell due before noon but whose sweep only runs after noon is dropped, not sent', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_noon_2';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);

    await tick(storage, messaging, MORNING);
    const late = await tick(storage, messaging, new Date('2026-09-15T09:30:00.000Z')); // 12:30 local
    assert.deepEqual({ retried: late.retried, retryDropped: late.retryDropped }, { retried: 0, retryDropped: 1 });
    assert.equal(messaging.delivered.length, 0);
    assert.equal((await planOf(storage, uid)).pushPending, undefined);
  });
});

test('a pending push is dropped once the plan’s date has passed', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_nextday_1';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);

    await tick(storage, messaging, MORNING);
    // 07:00 on the 16th: after midnight, before that morning's own delivery.
    const nextDay = await tick(storage, messaging, new Date('2026-09-16T04:00:00.000Z'));
    assert.deepEqual({ built: nextDay.built, retried: nextDay.retried, retryDropped: nextDay.retryDropped }, { built: 0, retried: 0, retryDropped: 1 });
    assert.equal(messaging.delivered.length, 0, 'yesterday’s plan was pushed today');
  });
});

test('guard: the cutoff bounds retries only — a delivery the user set for 13:00 is still pushed at 13:00', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_afternoon_1';
    await seed(storage, uid, { delivery: '13:00' });
    const messaging = fcm();
    const totals = await tick(storage, messaging, new Date('2026-09-15T10:00:00.000Z'));
    assert.deepEqual({ built: totals.built, pushed: totals.pushed }, { built: 1, pushed: 1 });
    assert.equal(messaging.delivered.length, 1);
  });
});

/* ── 6. Overlapping sweeps ───────────────────────────────────────── */

test('two sweeps that overlap on a due retry push once', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_overlap_1';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);
    await tick(storage, messaging, MORNING);

    const when = at(MORNING, PLAN_PUSH_RETRY_DELAY_MS);
    const [left, right] = await captureLogs({ lines: [] }, () => Promise.all([
      runDailyPlanTick({ storage, messaging, now: () => when }),
      runDailyPlanTick({ storage, messaging, now: () => when }),
    ]));
    assert.equal(left.retried + right.retried, 1, 'both sweeps claimed the retry');
    assert.equal(messaging.delivered.length, 1, 'two sweeps woke the user twice');
  });
});

test('two sweeps that overlap at the end of quiet hours push once', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_overlap_2';
    await seed(storage, uid, { quietHours: { start: '06:00', end: '08:00' } });
    const messaging = fcm();
    await tick(storage, messaging, new Date('2026-09-15T04:30:00.000Z'));

    const when = new Date('2026-09-15T05:00:00.000Z');
    await captureLogs({ lines: [] }, () => Promise.all([
      runDailyPlanTick({ storage, messaging, now: () => when }),
      runDailyPlanTick({ storage, messaging, now: () => when }),
      runDailyPlanTick({ storage, messaging, now: () => when }),
    ]));
    assert.equal(messaging.delivered.length, 1);
  });
});

test('concurrent claims of one pending push: exactly one attempt is taken', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_overlap_3';
    await seed(storage, uid);
    await tick(storage, fcm(failsFirst), MORNING);

    const when = at(MORNING, PLAN_PUSH_RETRY_DELAY_MS);
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimPlanPushRetry(uid, DATE, when, storage)));
    assert.equal(claims.filter((claim) => claim.kind === 'claimed').length, 1);
  });
});

/**
 * The second layer. A process that sent and then died before recording leaves
 * the marker `in_flight`; when its lease runs out the retry reuses that
 * attempt's key, meets the lock the send took, and stands down.
 */
test('an attempt that sent and died before recording is not sent again when its lease runs out', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_sent_then_died_1';
    await seed(storage, uid);
    const messaging = fcm();
    await tick(storage, messaging, MORNING);
    assert.equal(messaging.delivered.length, 1);

    // What the plan looks like had the process died between the send and the
    // record: exactly as `createIfAbsent` wrote it.
    const stored = await planOf(storage, uid);
    await storage.set(planPath(uid, DATE), {
      ...stored,
      pushPending: { attempts: 1, failedSends: 0, nextAttemptAt: at(MORNING, PLAN_PUSH_LEASE_MS).toISOString(), reason: 'in_flight' },
    });

    const later = await tick(storage, messaging, at(MORNING, PLAN_PUSH_LEASE_MS));
    assert.equal(later.retried, 1, 'the premise is wrong: the stale lease was not re-taken');
    assert.equal(messaging.delivered.length, 1, 'the push that did go out was sent a second time');
    assert.equal((await planOf(storage, uid)).pushPending, undefined);
  });
});

/** Fails the test instead of hanging it when a step the test waits for never comes. */
async function within<T>(promise: Promise<T>, message: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message })), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open(): void } {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

/**
 * The claim layer on its own (injected senders, so no `pushLog` lock). An
 * attempt that outlives its lease reports late; the attempt that re-took the
 * lease is still in flight. The late report must not rewrite the marker —
 * if it did, its `send_failed` would mint a fresh key and re-arm the push
 * while the second attempt is still sending, and a third sweep would send it
 * again beside the second.
 */
test('a slow attempt that reports after its lease was re-taken does not re-arm the push under the newer attempt', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_late_report_1';
    await seed(storage, uid);
    const delivered: string[] = [];
    const firstEntered = gate();
    const firstRelease = gate();
    const secondEntered = gate();
    const secondRelease = gate();

    // One log capture around the whole interleaving: the sweeps overlap, and
    // nested captures would restore the console in the wrong order.
    await captureLogs({ lines: [] }, async () => {
      const first = runDailyPlanTick({
        storage,
        now: () => MORNING,
        push: async () => {
          firstEntered.open();
          await firstRelease.wait;
          throw new Error('internal');
        },
      });
      let second: Promise<unknown> = Promise.resolve();
      try {
        await within(firstEntered.wait, 'the premise is wrong: the morning attempt never started');

        second = runDailyPlanTick({
          storage,
          now: () => at(MORNING, PLAN_PUSH_LEASE_MS),
          push: async (notice: PlanReadyNotice) => {
            secondEntered.open();
            await secondRelease.wait;
            delivered.push(notice.dedupeKey);
            return { status: 'sent' };
          },
        });
        await within(secondEntered.wait, 'the expired lease was never re-taken, so there is no second attempt');

        // The first attempt finally reports, long after its lease.
        firstRelease.open();
        await first;

        await runDailyPlanTick({
          storage,
          now: () => at(MORNING, PLAN_PUSH_LEASE_MS + MINUTE),
          push: async (notice: PlanReadyNotice) => {
            delivered.push(notice.dedupeKey);
            return { status: 'sent' };
          },
        });
      } finally {
        firstRelease.open();
        secondRelease.open();
        await Promise.allSettled([first, second]);
      }
    });

    assert.deepEqual(delivered, [`plan:${DATE}`], 'a third sweep sent beside the attempt still in flight');
    assert.equal((await planOf(storage, uid)).pushPending, undefined);
  });
});

/* ── 7. Already opened: no retry push ─────────────────────────────── */

test('a plan the user opened before the retry fires gets no retry push, and its marker is cleared', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_opened_1';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);
    await tick(storage, messaging, MORNING);
    const stored = await planOf(storage, uid);
    // What `POST /api/mobile/plans/{date}/opened` appends (#533).
    await appendPlanEvent(uid, {
      type: 'plan_opened', date: DATE, at: at(MORNING, 2 * MINUTE).toISOString(), generation: stored.generation, inputDigest: stored.inputDigest,
    }, storage);

    const later = await tick(storage, messaging, at(MORNING, PLAN_PUSH_RETRY_DELAY_MS));
    assert.deepEqual({ retried: later.retried, retryDropped: later.retryDropped }, { retried: 0, retryDropped: 1 });
    assert.equal(messaging.delivered.length, 0, 'a plan already on screen was pushed');
    assert.equal((await planOf(storage, uid)).pushPending, undefined);
  });
});

test('a plan the user already accepted gets no retry push', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_accepted_1';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);
    await tick(storage, messaging, MORNING);
    await acceptPlan(uid, DATE, { storage, now: () => at(MORNING, 2 * MINUTE) });

    await tick(storage, messaging, at(MORNING, PLAN_PUSH_RETRY_DELAY_MS));
    assert.equal(messaging.delivered.length, 0);
    assert.equal((await planOf(storage, uid)).pushPending, undefined);
  });
});

test('an open of a different date does not stand this plan’s retry down', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_opened_other_1';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);
    await tick(storage, messaging, MORNING);
    await appendPlanEvent(uid, {
      type: 'plan_opened', date: '2026-09-14', at: at(MORNING, 2 * MINUTE).toISOString(), generation: 1, inputDigest: 'x',
    }, storage);

    await tick(storage, messaging, at(MORNING, PLAN_PUSH_RETRY_DELAY_MS));
    assert.equal(messaging.delivered.length, 1);
  });
});

/* ── Privacy: content-free, server-only, deleted with the account ─── */

test('the marker holds counts, an instant and a reason — no title, and it never reaches the plan DTO', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_content_1';
    await seed(storage, uid);
    await tick(storage, fcm(failsFirst), MORNING);
    const stored = await planOf(storage, uid);

    assert.deepEqual(Object.keys(stored.pushPending ?? {}).sort(), ['attempts', 'failedSends', 'nextAttemptAt', 'reason']);
    const wire = JSON.stringify(stored.pushPending);
    for (const title of TITLES) assert.equal(wire.includes(title), false);
    const dto = planToDto(stored, new Map());
    assert.equal('pushPending' in dto, false, 'the push bookkeeping reached the mobile API');
    assert.equal(JSON.stringify(dto).includes('nextAttemptAt'), false);
  });
});

/**
 * Confirmation, not new behaviour: `plans` is in `USER_SCOPED_COLLECTIONS`, so
 * the deletion engine's `deleteTree` already removes the document the marker
 * lives on. This proves the sweep then has nothing to find.
 */
test('deleting the account takes the pending push with it: the next sweep sends nothing', async () => {
  await withStorage(async (storage) => {
    const uid = 'retry_deleted_1';
    await seed(storage, uid);
    const messaging = fcm(failsFirst);
    await tick(storage, messaging, MORNING);
    assert.ok((await planOf(storage, uid)).pushPending, 'the premise is wrong: nothing was pending');

    process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = 'test-pepper-not-the-real-one';
    resetDeletionHooksForTests();
    const auth: DeletionAuthAdmin = { async revokeRefreshTokens() {}, async deleteUser() {} };
    try {
      await deleteAccount(uid, { initiatedBy: 'user', storage, auth });
    } finally {
      resetDeletionHooksForTests();
      delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
    }

    assert.equal(await readStoredPlan(uid, DATE, storage), null);
    const later = await tick(storage, messaging, at(MORNING, PLAN_PUSH_RETRY_DELAY_MS));
    assert.equal(later.retried, 0);
    assert.equal(messaging.delivered.length, 0, 'a deleted account was pushed');
  });
});
