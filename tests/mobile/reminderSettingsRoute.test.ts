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
      // #197: nobody rings until they ask to, and the ceiling is the gentlest.
      hardEnabled: false,
      escalationCeiling: 'soft',
      mustThroughQuietHours: false,
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

/*
 * ── This endpoint may not move the profile's other windows ───────
 *
 * `timezone` on the routine profile is the zone `sleepWindow` and
 * `focusWindows` are wall-clock in, and the write-through used to take the
 * body's zone over the profile's. So a reminders screen that sent
 * `Europe/Berlin` with a quiet window shifted the sleep hours the survey had
 * stored by an hour, from a screen that shows neither of them.
 *
 * The app normally echoes the profile's own zone back, so this bites exactly
 * when it has fallen through to the handset's — which is the case where the
 * profile is the better authority, not the worse one. Changing the zone of an
 * existing profile belongs to the routine survey, where the user can see what
 * else moves.
 */
test('a zone in the body does not move the routine profile s other windows', async () => {
  const teardown = setup();
  try {
    // The survey first: a full profile, answered in Asia/Jerusalem.
    const { saveRoutineProfile } = await import('../../lib/services/mobile/routineProfileService.ts');
    await saveRoutineProfile(USER, {
      timezone: 'Asia/Jerusalem',
      sleepWindow: { start: '23:00', end: '07:00' },
      focusWindows: [{ start: '09:00', end: '12:00' }],
      fixedCommitmentWindows: [],
      preferredReminderIntensity: 'softAwareness',
      quietHours: null,
      surveySkipped: false,
    }, '2026-09-01T00:00:00.000Z');

    const response = await remindersPut(request({
      quietHours: { start: '21:30', end: '06:30', timezone: 'Europe/Berlin' },
    }));
    assert.equal(response.status, 200);

    const profile = await readRoutineProfile(USER);
    // The quiet hours are the new ones...
    assert.deepEqual(profile?.quietHours, { start: '21:30', end: '06:30' });
    // ...and everything else is exactly as the survey left it.
    assert.equal(profile?.timezone, 'Asia/Jerusalem', 'the body moved the profile s zone');
    assert.deepEqual(profile?.sleepWindow, { start: '23:00', end: '07:00' });
    assert.deepEqual(profile?.focusWindows, [{ start: '09:00', end: '12:00' }]);

    // And the push service reads the window on the profile's clock, not the body's.
    const quiet = await readQuietHours(USER);
    assert.equal(quiet.timezone, 'Asia/Jerusalem');
  } finally {
    teardown();
  }
});

test('the body s zone is still what creates a first profile', async () => {
  const teardown = setup();
  try {
    // Nothing to contradict it, so an account that never answered the survey
    // gets the zone the phone reported. Without this the write-through could
    // only ever store UTC for a new account, which is the defect the settings
    // screen's own zone fix exists to prevent.
    const response = await remindersPut(request({
      quietHours: { start: '22:30', end: '07:30', timezone: 'Europe/Berlin' },
    }));
    assert.equal(response.status, 200);
    assert.equal((await readRoutineProfile(USER))?.timezone, 'Europe/Berlin');
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
      ['escalationCeiling', 'hardEnabled', 'mustThroughQuietHours', 'softEnabled', 'softLeadMinutes', 'updatedAt'],
      'a second store of quiet hours appeared; the two would disagree on the first edit',
    );
  } finally {
    teardown();
  }
});

/*
 * ── Must reminders: the opt-in, the ceiling, and the survey that came first ──
 * (UC-3.12a, #197)
 */

async function surveyWith(intensity: 'none' | 'softAwareness' | 'followUp' | 'strongReminder'): Promise<void> {
  const { saveRoutineProfile } = await import('../../lib/services/mobile/routineProfileService.ts');
  await saveRoutineProfile(USER, {
    timezone: 'Asia/Jerusalem',
    sleepWindow: null,
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: intensity,
    quietHours: null,
    surveySkipped: false,
  }, '2026-09-01T00:00:00.000Z');
}

async function hardHalf(): Promise<Record<string, unknown>> {
  const body = await json(await remindersGet(request()));
  const settings = body.reminderSettings as Record<string, unknown>;
  return {
    hardEnabled: settings.hardEnabled,
    escalationCeiling: settings.escalationCeiling,
    mustThroughQuietHours: settings.mustThroughQuietHours,
  };
}

test('a legacy document written before #197 maps the old strong survey answer to the hard ceiling, not to ringing', async () => {
  const teardown = setup();
  try {
    // Exactly what #196 wrote: three fields, none of them about ringing.
    await getStorage().set(userDoc(USER), {
      reminderSettings: { softEnabled: true, softLeadMinutes: 30, updatedAt: '2026-09-10T00:00:00.000Z' },
    });

    await surveyWith('strongReminder');
    // "Be firm about the important ones" raises the ceiling and turns nothing on.
    assert.deepEqual(await hardHalf(), { hardEnabled: false, escalationCeiling: 'hard', mustThroughQuietHours: false });

    await surveyWith('followUp');
    assert.deepEqual(await hardHalf(), { hardEnabled: false, escalationCeiling: 'followUp', mustThroughQuietHours: false });

    for (const intensity of ['softAwareness', 'none'] as const) {
      await surveyWith(intensity);
      assert.deepEqual(await hardHalf(), { hardEnabled: false, escalationCeiling: 'soft', mustThroughQuietHours: false });
    }
  } finally {
    teardown();
  }
});

test('the settings screen s answer outranks the survey for good, once given', async () => {
  const teardown = setup();
  try {
    await surveyWith('strongReminder');
    const response = await remindersPut(request({ hardEnabled: false, escalationCeiling: 'followUp' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await hardHalf(), { hardEnabled: false, escalationCeiling: 'followUp', mustThroughQuietHours: false });

    // Re-answering the survey afterwards does not turn ringing back on.
    await surveyWith('strongReminder');
    assert.deepEqual(await hardHalf(), { hardEnabled: false, escalationCeiling: 'followUp', mustThroughQuietHours: false });
  } finally {
    teardown();
  }
});

test('any save freezes the answer the account had, so a later survey edit cannot start ringing', async () => {
  const teardown = setup();
  try {
    await surveyWith('softAwareness');
    // A save that only touches the lead time.
    await remindersPut(request({ softLeadMinutes: 15 }));
    await surveyWith('strongReminder');
    assert.deepEqual(await hardHalf(), { hardEnabled: false, escalationCeiling: 'soft', mustThroughQuietHours: false });
  } finally {
    teardown();
  }
});

test('turning Must reminders on stores all three, and they round-trip', async () => {
  const teardown = setup();
  try {
    const response = await remindersPut(request({ hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: true }));
    assert.equal(response.status, 200);
    const body = await json(response);
    const settings = body.reminderSettings as Record<string, unknown>;
    assert.equal(settings.hardEnabled, true);
    assert.equal(settings.escalationCeiling, 'hard');
    assert.equal(settings.mustThroughQuietHours, true);
    assert.deepEqual(await hardHalf(), { hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: true });
  } finally {
    teardown();
  }
});

test('a wrong type or an unknown ceiling is refused, not coerced', async () => {
  const teardown = setup();
  try {
    for (const [body, reason] of [
      [{ hardEnabled: 'true' }, 'invalid_hard_enabled'],
      [{ hardEnabled: 1 }, 'invalid_hard_enabled'],
      [{ escalationCeiling: 'loud' }, 'invalid_escalation_ceiling'],
      [{ escalationCeiling: 'HARD' }, 'invalid_escalation_ceiling'],
      [{ mustThroughQuietHours: 'yes' }, 'invalid_must_through_quiet_hours'],
    ] as const) {
      const response = await remindersPut(request(body));
      assert.equal(response.status, 400, `accepted ${JSON.stringify(body)}`);
      assert.equal((await json(response)).reason, reason);
    }
    // Nothing was written by any of them.
    assert.deepEqual(await hardHalf(), { hardEnabled: false, escalationCeiling: 'soft', mustThroughQuietHours: false });
  } finally {
    teardown();
  }
});

async function storeReminderSettings(value: Record<string, unknown>): Promise<void> {
  // Merged, not set: a `set` on the user document would also remove the
  // routine profile the survey stored, and the legacy mapping would then have
  // nothing to fall back to — which is how the first version of this test
  // passed against the mutation it was written for.
  await getStorage().runTransaction(async (tx) => {
    await tx.get(userDoc(USER));
    tx.merge(userDoc(USER), { reminderSettings: value });
  });
}

test('a stored ceiling that is present but unreadable is the gentlest one, never the survey s louder answer', async () => {
  const teardown = setup();
  try {
    await surveyWith('strongReminder');
    await storeReminderSettings({
      softEnabled: true,
      softLeadMinutes: 60,
      hardEnabled: true,
      escalationCeiling: 'maximum',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    // The survey still says strong, so an unreadable ceiling that read as
    // *absent* would come back `hard`.
    assert.equal((await readRoutineProfile(USER))?.preferredReminderIntensity, 'strongReminder');
    assert.equal((await hardHalf()).escalationCeiling, 'soft');
  } finally {
    teardown();
  }
});

test('an opt-in stored as anything but a boolean is not an opt-in', async () => {
  const teardown = setup();
  try {
    await surveyWith('softAwareness');
    for (const hardEnabled of ['true', 1, 'yes', {}]) {
      await storeReminderSettings({
        softEnabled: true,
        softLeadMinutes: 60,
        hardEnabled,
        escalationCeiling: 'hard',
        mustThroughQuietHours: 'yes',
        updatedAt: '2026-09-10T00:00:00.000Z',
      });
      assert.deepEqual(
        await hardHalf(),
        { hardEnabled: false, escalationCeiling: 'hard', mustThroughQuietHours: false },
        `read ${JSON.stringify(hardEnabled)} as an opt-in`,
      );
    }
  } finally {
    teardown();
  }
});
