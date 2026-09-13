/**
 * Who gets a next step, and when (UC-2.9, #170).
 *
 * ── The two properties this file is for ──────────────────────────
 *
 *  1. The launch consent is read, never the closed pilot's flag. The pilot
 *     flag defaults to false for everyone, so reading it at launch would hide
 *     the feature from every user who ever consented — and the bug would look
 *     like "the feature does not work" rather than like a wrong field.
 *
 *  2. Quiet hours are a wall-clock window in the *user's* zone, and they wrap
 *     midnight. Reading 22:30–07:30 as a forward range suppresses the card all
 *     day and shows it all night, which is exactly inverted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { isWithinWindow, resolveNextStepAccess } from '../../lib/services/mobile/nextStepAccess.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { RECOMMENDATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';

const UID = 'NextStepUser';
const AT = new Date('2026-09-13T09:00:00.000Z');

let previous: Record<string, string | undefined> = {};

function begin(flags: Record<string, string> = {}): void {
  setStorageForTests(createMemoryStorage());
  previous = {
    MAYBESITTER_FEATURE_RECOMMENDATION: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
  };
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  for (const [key, value] of Object.entries(flags)) process.env[key] = value;
}

function end(): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStorageForTests();
}

async function grant(): Promise<void> {
  await setRecommendationConsent(UID, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
}

const ROUTINE = {
  timezone: 'Asia/Jerusalem',
  sleepWindow: null,
  focusWindows: [],
  fixedCommitmentWindows: [],
  preferredReminderIntensity: 'softAwareness' as const,
  quietHours: { start: '22:30', end: '07:30' },
  surveySkipped: false,
};

// ── The consent that is read ─────────────────────────────────────

test('a fresh account has not agreed, so there is no card', async () => {
  begin();
  try {
    assert.deepEqual(await resolveNextStepAccess(UID, AT), { allowed: false, reason: 'consent_required' });
  } finally {
    end();
  }
});

test('the launch consent is what opens it — not the closed pilot flag', async () => {
  begin();
  try {
    // The pilot flag stays false, which is its default for everybody. If this
    // gate read it, the feature would be invisible to every consenting user.
    await grant();
    assert.deepEqual(await resolveNextStepAccess(UID, AT), { allowed: true, reason: 'authorized' });
  } finally {
    end();
  }
});

test('the pilot flag alone opens nothing', async () => {
  begin();
  try {
    await applyTrustAction(UID, { type: 'set_recommendation_consent', granted: true, at: AT.toISOString() });
    // Consented to the *pilot*, never to the launch question. No card.
    assert.deepEqual(await resolveNextStepAccess(UID, AT), { allowed: false, reason: 'consent_required' });
  } finally {
    end();
  }
});

test('withdrawing it closes the card again', async () => {
  begin();
  try {
    await grant();
    await setRecommendationConsent(UID, { state: 'declined', version: RECOMMENDATION_CONSENT_VERSION });
    assert.equal((await resolveNextStepAccess(UID, AT)).reason, 'consent_required');
  } finally {
    end();
  }
});

// ── The gates, in order ──────────────────────────────────────────

test('the feature flag and the kill switch each close it', async () => {
  begin({ MAYBESITTER_FEATURE_RECOMMENDATION: 'false' });
  try {
    await grant();
    assert.equal((await resolveNextStepAccess(UID, AT)).reason, 'feature_disabled');
  } finally {
    end();
  }

  begin({ MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'true' });
  try {
    await grant();
    assert.equal((await resolveNextStepAccess(UID, AT)).reason, 'kill_switch_active');
  } finally {
    end();
  }
});

test('a revoked or deleted account is refused before any flag is consulted', async () => {
  // The two states where the user told us to stop. No flag speaks over that,
  // so the kill switch being *off* must not turn a revocation into access.
  begin();
  try {
    await grant();
    await applyTrustAction(UID, { type: 'revoke', at: AT.toISOString() });
    assert.equal((await resolveNextStepAccess(UID, AT)).reason, 'revoked');
  } finally {
    end();
  }
});

test('quiet mode closes it, whatever the schedule says', async () => {
  begin();
  try {
    await grant();
    await applyTrustAction(UID, { type: 'set_quiet_mode', enabled: true, at: AT.toISOString() });
    assert.equal((await resolveNextStepAccess(UID, AT)).reason, 'quiet_mode');
  } finally {
    end();
  }
});

// ── Quiet hours ──────────────────────────────────────────────────

test('no card inside the user’s own quiet window', async () => {
  begin();
  try {
    await grant();
    await saveRoutineProfile(UID, ROUTINE, '2026-09-13T09:00:00.000Z');
    // 23:00 in Jerusalem is 20:00 UTC.
    const atNight = new Date('2026-09-13T20:00:00.000Z');
    assert.deepEqual(await resolveNextStepAccess(UID, atNight), { allowed: false, reason: 'quiet_hours' });
  } finally {
    end();
  }
});

test('a card again once the window ends', async () => {
  begin();
  try {
    await grant();
    await saveRoutineProfile(UID, ROUTINE, '2026-09-13T09:00:00.000Z');
    // 08:00 in Jerusalem is 05:00 UTC — past the 07:30 end.
    assert.equal((await resolveNextStepAccess(UID, new Date('2026-09-13T05:00:00.000Z'))).allowed, true);
  } finally {
    end();
  }
});

test('the window is read in the user’s zone, not the server’s', async () => {
  begin();
  try {
    await grant();
    await saveRoutineProfile(UID, { ...ROUTINE, timezone: 'America/New_York' }, '2026-09-13T09:00:00.000Z');
    // 23:00 in New York is 03:00 UTC the next day. A server reading its own
    // clock would see 03:00 — inside the window by luck — so this checks the
    // other direction too: 23:00 UTC is 19:00 in New York, and not quiet.
    assert.equal((await resolveNextStepAccess(UID, new Date('2026-09-14T03:00:00.000Z'))).reason, 'quiet_hours');
    assert.equal((await resolveNextStepAccess(UID, new Date('2026-09-13T23:00:00.000Z'))).allowed, true);
  } finally {
    end();
  }
});

test('an account with no routine has no quiet hours', async () => {
  begin();
  try {
    await grant();
    assert.equal((await resolveNextStepAccess(UID, new Date('2026-09-13T20:00:00.000Z'))).allowed, true);
  } finally {
    end();
  }
});

// ── The window arithmetic ────────────────────────────────────────

test('a window that wraps midnight is read as the night, not as nothing', () => {
  const night = { start: '22:30', end: '07:30' };
  const inside = ['2026-09-13T20:00:00.000Z', '2026-09-13T21:00:00.000Z', '2026-09-13T04:00:00.000Z'];
  const outside = ['2026-09-13T06:00:00.000Z', '2026-09-13T12:00:00.000Z', '2026-09-13T19:00:00.000Z'];
  for (const at of inside) {
    assert.equal(isWithinWindow(night, new Date(at), 'Asia/Jerusalem'), true, `${at} should be quiet`);
  }
  for (const at of outside) {
    assert.equal(isWithinWindow(night, new Date(at), 'Asia/Jerusalem'), false, `${at} should not be quiet`);
  }
});

test('a same-day window is read forwards', () => {
  const day = { start: '09:00', end: '17:00' };
  // 12:00 Jerusalem is 09:00 UTC; 20:00 Jerusalem is 17:00 UTC.
  assert.equal(isWithinWindow(day, new Date('2026-09-13T09:00:00.000Z'), 'Asia/Jerusalem'), true);
  assert.equal(isWithinWindow(day, new Date('2026-09-13T17:00:00.000Z'), 'Asia/Jerusalem'), false);
});

test('the start is inside the window and the end is outside it', () => {
  // Half-open, so two adjacent windows cannot both claim the same minute.
  const window = { start: '22:30', end: '07:30' };
  assert.equal(isWithinWindow(window, new Date('2026-09-13T19:30:00.000Z'), 'Asia/Jerusalem'), true);
  assert.equal(isWithinWindow(window, new Date('2026-09-13T04:30:00.000Z'), 'Asia/Jerusalem'), false);
});

test('a malformed window is not a quiet window', () => {
  // Refusing to suppress is the safe direction: the worst case is a card
  // somebody did not want, not silence they cannot explain.
  assert.equal(isWithinWindow({ start: '25:00', end: '07:30' }, AT, 'UTC'), false);
  assert.equal(isWithinWindow({ start: 'nonsense', end: '07:30' }, AT, 'UTC'), false);
});
