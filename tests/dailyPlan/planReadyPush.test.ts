/**
 * The morning plan reaches the phone through the real push path (UC-3.10a, #194).
 *
 * #194 merged with `PlanPushSender` defaulting to a no-op, because UC-3.0b
 * (#184) did not exist yet. #184 has since landed `sendToUser`, and nothing
 * connected the two: `handleDailyPlanRequest` calls `runDailyPlanTick()` with no
 * arguments, so in production a plan was built and nobody's phone rang. Every
 * test of "one plan, one push" injected a recorder, which is why that stayed
 * green.
 *
 * So these tests inject **no sender**. They inject only the FCM client — the
 * one thing that cannot run in a test — and count what reaches it, which is a
 * claim about the code path production takes rather than about a fake.
 *
 * The payload is checked against the phone's own router
 * (`mobile/src/notifications/routeFromNotification.ts`), because a push whose
 * `data` omits `kind: 'plan_ready'` still arrives, and the tap then opens Today
 * instead of the plan. That is a defect no server-side assertion on
 * `planDate` alone would notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { applyPilotTrustAction, createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';
import { docIdForKey, PUSH_LOG, userSubDoc } from '../../lib/storage/paths.ts';
import { readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { assertPushData, type FcmMessage, type MessagingClient } from '../../lib/push/pushService.ts';
import { runDailyPlanTick, savePlanSettings } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { PLAN_READY_COPY, planReadyMessage } from '../../lib/services/dailyPlan/planReadyPush.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand, createEmptyDomainState, type DomainState } from '../../src/domain/stateMachine.ts';
import type { UserLocale } from '../../lib/storage/userDocument.ts';
import { routeFromNotification } from '../../mobile/src/notifications/routeFromNotification.ts';

const TZ = 'Asia/Jerusalem';
/** 09:00 in Jerusalem, past a 07:30 delivery. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const TITLES = ['كتابة الملخص السري', 'לכתוב את הסיכום הסודי', 'Write the secret summary'];

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

async function seed(storage: StorageAdapter, uid: string, locale: UserLocale, devices: number): Promise<void> {
  await persistParticipantState(uid, withCommitments(TITLES));
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale });
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  for (let index = 0; index < devices; index += 1) {
    await upsertDevice(uid, {
      installationId: `install-${index}`,
      fcmToken: `token${index}${uid.replace(/[^A-Za-z0-9]/g, '')}`,
      platform: index % 2 === 0 ? 'ios' : 'android',
      appVersion: '1.0.0',
      locale,
      timezone: TZ,
      pushPermission: 'granted',
    }, '2026-09-14T12:00:00.000Z', { storage });
  }
}

function fakeMessaging(): MessagingClient & { sent: FcmMessage[] } {
  const sent: FcmMessage[] = [];
  return {
    sent,
    async send(message: FcmMessage) {
      sent.push(message);
      return `projects/x/messages/${sent.length}`;
    },
  };
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

test('with no sender injected, a built plan reaches every device once, and a second tick sends nothing', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'push_default_1', 'ar', 2);
    const messaging = fakeMessaging();

    const first = await runDailyPlanTick({ storage, messaging, now: () => MORNING });
    const second = await runDailyPlanTick({ storage, messaging, now: () => MORNING });

    assert.equal(first.built, 1, 'no plan was built');
    assert.equal(first.pushed, 1, 'the tick did not report the push it sent');
    assert.equal(messaging.sent.length, 2, 'the plan did not reach both devices exactly once');
    assert.deepEqual({ built: second.built, pushed: second.pushed }, { built: 0, pushed: 0 });
    assert.equal(messaging.sent.length, 2, 'the second tick pushed again');

    for (const sent of messaging.sent) {
      assert.deepEqual(
        routeFromNotification(sent.data),
        { kind: 'plan', planDate: '2026-09-15' },
        `the phone would not open the plan from this payload: ${JSON.stringify(sent.data)}`,
      );
      assert.equal(sent.android.collapseKey, 'plan:2026-09-15');
      assert.equal(sent.notification.title, PLAN_READY_COPY.ar.title, 'an Arabic account was not notified in Arabic');
    }
  });
});

test('two concurrent ticks with the production sender reach the phone once', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'push_race_1', 'he', 1);
    const messaging = fakeMessaging();

    const [left, right] = await Promise.all([
      runDailyPlanTick({ storage, messaging, now: () => MORNING }),
      runDailyPlanTick({ storage, messaging, now: () => MORNING }),
    ]);

    assert.equal(left.built + right.built, 1);
    assert.equal(messaging.sent.length, 1, 'two instances woke the user twice');
  });
});

test('a plan for an account with no reachable phone is built and not reported as pushed', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'push_nodevice_1', 'en', 0);
    const messaging = fakeMessaging();

    const totals = await runDailyPlanTick({ storage, messaging, now: () => MORNING });

    assert.equal(totals.built, 1);
    assert.equal(totals.pushed, 0, 'the totals claimed a push that reached nobody');
    assert.equal(messaging.sent.length, 0);
  });
});

test('the notification text is generic and localised, and never carries a commitment title', () => {
  const locales: UserLocale[] = ['en', 'ar', 'he'];
  for (const locale of locales) {
    const message = planReadyMessage({
      uid: 'u1',
      kind: 'plan_ready',
      dedupeKey: 'plan:2026-09-15',
      data: { planDate: '2026-09-15' },
      respectQuietHours: true,
      urgency: 'normal',
      locale,
    });
    assert.doesNotThrow(() => assertPushData(message), `the ${locale} plan push fails the push guard`);
    assert.equal(message.title, PLAN_READY_COPY[locale].title);
    assert.equal(message.body, PLAN_READY_COPY[locale].body);
    assert.equal(message.data.kind, 'plan_ready');
    assert.equal(message.respectQuietHours, true);
    const wire = JSON.stringify(message);
    for (const title of TITLES) assert.equal(wire.includes(title), false, `a commitment title reached the ${locale} push`);
  }
  // Arabic and Hebrew are not English with a different key.
  assert.match(PLAN_READY_COPY.ar.title, /[؀-ۿ]/);
  assert.match(PLAN_READY_COPY.he.title, /[֐-׿]/);
});

/* ── A push that did not happen is not reported as one (review F4) ─ */

/**
 * `pushed` is true only for `sent`. Each row is a real `sendToUser` outcome
 * reached through the production sender, with a device registered, so the
 * only reason nothing is delivered is the one the row names.
 */
const NOT_PUSHED: ReadonlyArray<readonly [string, (storage: StorageAdapter, uid: string) => Promise<void>]> = [
  ['quiet hours', async (storage, uid) => {
    await saveRoutineProfile(uid, {
      timezone: TZ,
      sleepWindow: null,
      focusWindows: [],
      fixedCommitmentWindows: [],
      preferredReminderIntensity: 'softAwareness',
      // 09:00 local, when the tick runs, is inside 06:00-10:00.
      quietHours: { start: '06:00', end: '10:00' },
      surveySkipped: false,
    }, '2026-09-14T12:00:00.000Z', { storage });
  }],
  ['a revoked account', async (storage, uid) => {
    const trust = applyPilotTrustAction(createPilotTrustState(uid, '2026-09-14T12:00:00.000Z'), { type: 'revoke', at: '2026-09-14T12:00:00.000Z' });
    const user = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), { ...(user ?? {}), trust });
  }],
  ['a key already spent', async (storage, uid) => {
    await storage.set(userSubDoc(uid, PUSH_LOG, docIdForKey('plan:2026-09-15')), {
      dedupeKey: 'plan:2026-09-15',
      kind: 'plan_ready',
      createdAt: '2026-09-15T05:00:00.000Z',
      expiresAt: '2026-09-22T05:00:00.000Z',
    });
  }],
];

for (const [label, arrange] of NOT_PUSHED) {
  test(`a plan whose push is refused for ${label} is built and not reported as pushed`, async () => {
    await withStorage(async (storage) => {
      const uid = `push_refused_${label.replace(/[^a-z]/g, '')}`;
      await seed(storage, uid, 'en', 1);
      await arrange(storage, uid);
      const messaging = fakeMessaging();

      const totals = await runDailyPlanTick({ storage, messaging, now: () => MORNING });

      assert.equal(messaging.sent.length, 0, `the premise is wrong: ${label} still reached FCM`);
      assert.deepEqual({ built: totals.built, pushed: totals.pushed, failed: totals.failed }, { built: 1, pushed: 0, failed: 0 });
    });
  });
}

/* ── A push that throws does not unmake the plan (review F2) ──────── */

/**
 * Before: the throw escaped `buildAndStoreDailyPlan`, the tick counted the
 * account `failed` and not `built`, while `plans/{date}` existed and
 * `nextRunAt` had already moved — so the totals described a morning that did
 * not happen and hid the one that did.
 */
test('an FCM failure after the plan is written counts the plan as built, and fails nothing', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'push_throws_1', 'he', 1);
    const messaging: MessagingClient = {
      async send() {
        throw Object.assign(new Error('internal'), { code: 'messaging/internal-error' });
      },
    };
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let totals;
    try {
      totals = await runDailyPlanTick({ storage, messaging, now: () => MORNING });
    } finally {
      console.error = error;
    }

    assert.deepEqual({ built: totals.built, pushed: totals.pushed, failed: totals.failed }, { built: 1, pushed: 0, failed: 0 });
    assert.ok(await readStoredPlan('push_throws_1', '2026-09-15', storage), 'the plan was lost with the push');
    assert.ok(logged.some((line) => line.includes('push_failed')), 'the failed push was not logged');
    assert.equal(logged.some((line) => line.includes('push_throws_1')), false, 'the uid reached the log');
  });
});

test('a sender that throws before reaching FCM is isolated the same way', async () => {
  await withStorage(async (storage) => {
    await seed(storage, 'push_throws_2', 'ar', 0);
    const error = console.error;
    console.error = () => undefined;
    let totals;
    try {
      totals = await runDailyPlanTick({
        storage,
        push: async () => { throw new Error('device registry unreadable'); },
        now: () => MORNING,
      });
    } finally {
      console.error = error;
    }
    assert.deepEqual({ built: totals.built, pushed: totals.pushed, failed: totals.failed }, { built: 1, pushed: 0, failed: 0 });
  });
});
