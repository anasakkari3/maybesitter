/**
 * `PUT /api/mobile/settings/reminders`, and the one-store rule (UC-3.11, #196).
 *
 * #196 asked for `users/{uid}.reminderSettings.quietHours`. They already live
 * on the routine profile, where the survey writes them, `resolveNextStepAccess`
 * reads them and the memory screen shows them. The decision recorded here is
 * that the profile stays authoritative and this route writes *through* to it —
 * so the last test in this file is the important one: it fails if a second copy
 * of quiet hours ever appears under `reminderSettings`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as remindersGet, PUT as remindersPut } from '../../src/app/api/mobile/settings/reminders/route.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { readRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { readQuietHours } from '../../lib/push/quietHours.ts';
import { resolveNextStepAccess } from '../../lib/services/mobile/nextStepAccess.ts';
import {
  RECOMMENDATION_CONSENT_VERSION,
  setRecommendationConsent,
} from '../../lib/consents/recommendationConsentService.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('ReminderUser');

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function request(body?: unknown, options: { uid?: string | null } = {}): Request {
  const headers = new Headers();
  if (options.uid !== null) headers.set('authorization', `Bearer ${tokenFor(options.uid ?? USER)}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}/api/mobile/settings/reminders`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('an account that has never chosen gets soft reminders on, an hour ahead', async () => {
  const teardown = setup();
  try {
    const body = await json(await remindersGet(request()));
    assert.deepEqual(body.reminderSettings, {
      softEnabled: true,
      softLeadMinutes: 60,
      quietHours: null,
      timezone: 'UTC',
      updatedAt: null,
    });
  } finally {
    teardown();
  }
});

test('no token is 401', async () => {
  const teardown = setup();
  try {
    assert.equal((await remindersGet(request(undefined, { uid: null }))).status, 401);
    assert.equal((await remindersPut(request({ softEnabled: false }, { uid: null }))).status, 401);
  } finally {
    teardown();
  }
});

test('the lead time is one of the three the screen offers', async () => {
  const teardown = setup();
  try {
    for (const softLeadMinutes of [60, 30, 15]) {
      const response = await remindersPut(request({ softLeadMinutes }));
      assert.equal(response.status, 200);
      assert.equal((await json(response)).reminderSettings!['softLeadMinutes' as never], softLeadMinutes as never);
    }
    const refused = await remindersPut(request({ softLeadMinutes: 45 }));
    assert.equal(refused.status, 400);
    assert.equal((await json(refused)).reason, 'invalid_lead_minutes');
  } finally {
    teardown();
  }
});

test('quiet hours written here are the quiet hours the next step and the push service read', async () => {
  const teardown = setup();
  try {
    const response = await remindersPut(request({
      softEnabled: true,
      softLeadMinutes: 30,
      quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Jerusalem' },
    }));
    assert.equal(response.status, 200);

    // The routine profile — the survey's own store — now holds them.
    const profile = await readRoutineProfile(USER);
    assert.deepEqual(profile?.quietHours, { start: '22:00', end: '07:00' });
    assert.equal(profile?.timezone, 'Asia/Jerusalem');

    // And the push service reads the same window.
    const quiet = await readQuietHours(USER);
    assert.deepEqual(quiet.window, { start: '22:00', end: '07:00' });

    // And the next-step gate agrees: 23:30 Jerusalem (20:30Z at +03:00).
    const previousFlag = process.env.MAYBESITTER_FEATURE_RECOMMENDATION;
    process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
    await setRecommendationConsent(USER, {
      state: 'granted',
      version: RECOMMENDATION_CONSENT_VERSION,
      at: new Date('2026-08-14T09:00:00.000Z'),
    });
    try {
      const access = await resolveNextStepAccess(USER, new Date('2026-08-14T20:30:00.000Z'));
      assert.equal(access.reason, 'quiet_hours');
    } finally {
      if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_RECOMMENDATION;
      else process.env.MAYBESITTER_FEATURE_RECOMMENDATION = previousFlag;
    }
  } finally {
    teardown();
  }
});

test('editing quiet hours here keeps the rest of the survey', async () => {
  const teardown = setup();
  try {
    await remindersPut(request({ quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Jerusalem' } }));
    // A full survey save, as the routine screen would make it.
    const { saveRoutineProfile } = await import('../../lib/services/mobile/routineProfileService.ts');
    await saveRoutineProfile(USER, {
      timezone: 'Asia/Jerusalem',
      sleepWindow: { start: '23:30', end: '07:30' },
      focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
      fixedCommitmentWindows: [],
      preferredReminderIntensity: 'followUp',
      quietHours: { start: '22:00', end: '07:00' },
      surveySkipped: false,
    }, '2026-09-14T09:00:00.000Z');

    await remindersPut(request({ quietHours: { start: '23:00', end: '06:00', timezone: 'Asia/Jerusalem' } }));

    const profile = await readRoutineProfile(USER);
    assert.deepEqual(profile?.quietHours, { start: '23:00', end: '06:00' });
    assert.deepEqual(profile?.sleepWindow, { start: '23:30', end: '07:30' });
    assert.equal(profile?.focusWindows.length, 1);
    assert.equal(profile?.preferredReminderIntensity, 'followUp');
  } finally {
    teardown();
  }
});

test('null quiet hours clears the window; omitting the key leaves it alone', async () => {
  const teardown = setup();
  try {
    await remindersPut(request({ quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Jerusalem' } }));

    await remindersPut(request({ softEnabled: false }));
    assert.deepEqual((await readRoutineProfile(USER))?.quietHours, { start: '22:00', end: '07:00' });

    await remindersPut(request({ quietHours: null }));
    assert.equal((await readRoutineProfile(USER))?.quietHours, null);
  } finally {
    teardown();
  }
});

test('a malformed window is refused rather than half-written', async () => {
  const teardown = setup();
  try {
    for (const quietHours of [
      { start: '25:00', end: '07:00', timezone: 'Asia/Jerusalem' },
      { start: '22:00', end: '22:00', timezone: 'Asia/Jerusalem' },
      { start: '22:00', end: '07:00', timezone: 'Mars/Olympus' },
    ]) {
      const response = await remindersPut(request({ quietHours }));
      assert.equal(response.status, 400, `accepted ${JSON.stringify(quietHours)}`);
    }
    assert.equal(await readRoutineProfile(USER), null);
  } finally {
    teardown();
  }
});

test('reminderSettings never grows a second copy of quiet hours', async () => {
  const teardown = setup();
  try {
    await remindersPut(request({
      softEnabled: false,
      softLeadMinutes: 15,
      quietHours: { start: '21:30', end: '06:30', timezone: 'Europe/Berlin' },
    }));

    const user = await getStorage().get<{ reminderSettings?: Record<string, unknown> }>(userDoc(USER));
    assert.deepEqual(
      Object.keys(user?.reminderSettings ?? {}).sort(),
      ['softEnabled', 'softLeadMinutes', 'updatedAt'],
      'a second store of quiet hours appeared; the two would disagree on the first edit',
    );
  } finally {
    teardown();
  }
});
