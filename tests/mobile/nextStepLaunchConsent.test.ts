import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { RECOMMENDATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { getMobileNextStep, MobilePilotError } from '../../lib/services/mobile/pilotService.ts';

/**
 * Which consent opens the next step (UC-2.9, #170).
 *
 * ── The bug this file exists for ─────────────────────────────────
 *
 * The gate used to read `trust.recommendationConsent` — the closed pilot's
 * admission flag. It is created `false`, and the only thing that sets it is the
 * Trust centre's `grant_recommendation_consent` action.
 *
 * Onboarding (#171) does not call that. It records the launch consent in
 * `users/{uid}.consents.recommendations`, versioned against the words the user
 * was shown. So a user who agreed during onboarding was refused with 403
 * `consent_required` until they went and found a switch in Settings — which is
 * to say the feature was off for everyone who used the product as designed.
 */

const UID = 'LaunchConsentUser';
const AT = '2026-09-13T09:00:00.000Z';
const ZONE = 'Asia/Jerusalem';

function setup() {
  setStorageForTests(createMemoryStorage());
  const previous = {
    MAYBESITTER_FEATURE_RECOMMENDATION: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
  };
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  return () => {
    resetStorageForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * A quiet window that certainly contains this moment.
 *
 * `getMobileNextStep` reads the real clock — that is the point of testing it at
 * the service level rather than the resolver's — so the window is computed from
 * now rather than hard-coded. A fixed 22:30–07:30 would make these tests pass
 * only at night. The window arithmetic itself is covered, with an explicit
 * `at`, in nextStepAccess.test.ts.
 */
function windowAroundNow(): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  const nowMinutes = hour * 60 + minute;
  const asClock = (total: number) => {
    const wrapped = ((total % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  return { start: asClock(nowMinutes - 60), end: asClock(nowMinutes + 60) };
}

const ROUTINE = {
  timezone: ZONE,
  sleepWindow: null,
  focusWindows: [],
  fixedCommitmentWindows: [],
  preferredReminderIntensity: 'softAwareness' as const,
  surveySkipped: false,
};

async function onboardingConsent(uid: string): Promise<void> {
  await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
}

async function refusalReason(uid: string): Promise<string | undefined> {
  try {
    await getMobileNextStep(uid, { locale: 'en' });
    return undefined;
  } catch (error) {
    assert.ok(error instanceof MobilePilotError);
    return error.reason;
  }
}

test('onboarding consent alone opens the next step', async () => {
  const cleanup = setup();
  try {
    // No `grant_recommendation_consent`. This is the state every real user is
    // in after onboarding, and it used to be refused.
    await onboardingConsent(UID);
    const result = await getMobileNextStep(UID, { locale: 'en' });
    assert.equal(result.exposure.allowed, true);
    assert.equal(result.exposure.reason, 'authorized');
  } finally {
    cleanup();
  }
});

test('the closed pilot flag alone opens nothing', async () => {
  const cleanup = setup();
  try {
    await applyTrustAction(UID, { type: 'grant_recommendation_consent', at: AT });
    assert.equal(await refusalReason(UID), 'consent_required');
  } finally {
    cleanup();
  }
});

test('a fresh account has never been asked, so it has not agreed', async () => {
  const cleanup = setup();
  try {
    assert.equal(await refusalReason(UID), 'consent_required');
  } finally {
    cleanup();
  }
});

test('declining in onboarding closes it again', async () => {
  const cleanup = setup();
  try {
    await onboardingConsent(UID);
    await setRecommendationConsent(UID, { state: 'declined', version: RECOMMENDATION_CONSENT_VERSION });
    assert.equal(await refusalReason(UID), 'consent_required');
  } finally {
    cleanup();
  }
});

test('revoking still comes before any consent', async () => {
  const cleanup = setup();
  try {
    await onboardingConsent(UID);
    await applyTrustAction(UID, { type: 'revoke', at: AT });
    assert.equal(await refusalReason(UID), 'revoked');
  } finally {
    cleanup();
  }
});

test('inside the user’s own quiet window there is no card, and no error', async () => {
  const cleanup = setup();
  try {
    await onboardingConsent(UID);
    await saveRoutineProfile(UID, { ...ROUTINE, quietHours: windowAroundNow() }, AT);
    // Nothing is wrong; the user asked not to be spoken to right now.
    const result = await getMobileNextStep(UID, { locale: 'en' });
    assert.equal(result.exposure.allowed, false);
    assert.equal(result.exposure.reason, 'quiet_hours');
    assert.equal(result.recommendation.state, 'empty');
    assert.equal(result.recommendation.primaryStep, null);
    assert.deepEqual(result.recommendation.availableActions, []);
  } finally {
    cleanup();
  }
});

test('no proposal is computed at all during quiet hours', async () => {
  const cleanup = setup();
  try {
    await onboardingConsent(UID);
    await saveRoutineProfile(UID, { ...ROUTINE, quietHours: windowAroundNow() }, AT);
    const result = await getMobileNextStep(UID, { locale: 'en' });
    // An empty proposalId is the tell: nothing was selected, rather than
    // something selected and withheld. The selector must not be reading a
    // person's commitments to decide something nobody will be shown.
    assert.equal(result.recommendation.proposalId, '');
  } finally {
    cleanup();
  }
});
