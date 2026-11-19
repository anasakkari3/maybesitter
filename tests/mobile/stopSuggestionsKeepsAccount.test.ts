/**
 * «وقّف مشاركتك» stops suggestions and learning, and nothing else (V3-F35-07).
 *
 * The card promised «MaybeSitter بيوقف يقترح ويوقف يتعلّم منك. بياناتك بتضل»,
 * and the app sent `{ type: 'revoke' }` to `POST /api/mobile/pilot/trust`.
 * That stamped `trust.revokedAt`, and `requireMobileUser` then refused every
 * mobile route with 403 `revoked`: the account was locked behind «هالحساب
 * موقوف» with no way back, after sign-out and sign-in too (QA v3, S1).
 *
 * Owner decision 2026-11-19: the action must not lock the account. On the
 * mobile route `revoke` — still sent by every build already installed — now
 * does what those builds' words say: it declines the next-step and the
 * pattern-learning consents, the two switches the product already obeys
 * (`resolveNextStepAccess`, `personalizationGrowthAllowed`, the intelligence
 * routes). The account stays live, and switching either back on works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { getOrCreateTrust, readTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { getRecommendationConsent, setRecommendationConsent, RECOMMENDATION_CONSENT_VERSION } from '../../lib/consents/recommendationConsentService.ts';
import {
  personalizationGrowthAllowed,
  setPersonalizationConsent,
  PERSONALIZATION_CONSENT_VERSION,
} from '../../lib/consents/personalizationConsentService.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as trustPost } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { GET as consentsGet } from '../../src/app/api/mobile/consents/route.ts';
import { PUT as recommendationsPut } from '../../src/app/api/mobile/consents/recommendations/route.ts';
import { GET as profileGet } from '../../src/app/api/mobile/profile/route.ts';

const baseUrl = 'http://localhost:3000';
let auth: FakeAuthControls | null = null;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function authed(uid: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${baseUrl}${path}`, { ...init, headers });
}

/** An account that said yes to both questions, a moment ago. */
async function agreed(name: string): Promise<string> {
  const uid = uidFor(name);
  const before = new Date(Date.now() - 1000);
  await getOrCreateTrust(uid, before.toISOString());
  await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, at: before });
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: before });
  assert.equal(await getRecommendationConsent(uid), 'granted');
  assert.equal(await personalizationGrowthAllowed(uid), true);
  return uid;
}

async function stop(uid: string): Promise<Response> {
  return trustPost(authed(uid, '/api/mobile/pilot/trust', {
    method: 'POST',
    body: JSON.stringify({ action: { type: 'revoke' } }),
  }));
}

test('stopping does not lock the account', async () => {
  begin();
  try {
    const uid = await agreed('StopKeepsAccount');
    const response = await stop(uid);
    assert.equal(response.status, 200);
    const body = await response.json() as { trust: { revokedAt: string | null } };
    assert.equal(body.trust.revokedAt, null, 'the answer still says the account was revoked');
    assert.equal((await readTrust(uid))?.revokedAt ?? null, null, 'the stored trust record was revoked');

    // The rest of the app still answers: the account is not «موقوف».
    const profile = await profileGet(authed(uid, '/api/mobile/profile'));
    assert.notEqual(profile.status, 403, 'every route refuses the account after «وقّف مشاركتك»');
    const consents = await consentsGet(authed(uid, '/api/mobile/consents'));
    assert.equal(consents.status, 200);
  } finally {
    end();
  }
});

test('stopping turns off suggestions and learning, as its words say', async () => {
  begin();
  try {
    const uid = await agreed('StopStopsBoth');
    assert.equal((await stop(uid)).status, 200);
    assert.equal(await getRecommendationConsent(uid), 'declined', 'next-step suggestions are still on');
    assert.equal(await personalizationGrowthAllowed(uid), false, 'learning from the person is still on');
  } finally {
    end();
  }
});

test('there is a way back: suggestions can be switched on again after stopping', async () => {
  begin();
  try {
    const uid = await agreed('StopThenResume');
    assert.equal((await stop(uid)).status, 200);
    const resumed = await recommendationsPut(authed(uid, '/api/mobile/consents/recommendations', {
      method: 'PUT',
      body: JSON.stringify({ state: 'granted', version: RECOMMENDATION_CONSENT_VERSION }),
    }));
    assert.equal(resumed.status, 200);
    assert.equal(await getRecommendationConsent(uid), 'granted');
  } finally {
    end();
  }
});

test('a learning withdrawal that cannot be recorded is a 503, never a 200 with learning still on — and suggestions are already off', async () => {
  begin();
  try {
    const uid = await agreed('StopLearningBusy');
    // A personalization purge owns the fence: the withdrawal waits for it,
    // then refuses (M5B2A-R8-003). The stop must say so, not answer success.
    const { getStorage } = await import('../../lib/storage/index.ts');
    const { userDoc } = await import('../../lib/storage/paths.ts');
    const user = await getStorage().get<Record<string, unknown>>(userDoc(uid));
    await getStorage().set(userDoc(uid), { ...user, personalizationPurge: { state: 'purging', epoch: 3 } });
    const response = await stop(uid);
    assert.equal(response.status, 503, 'a stop whose learning half failed answered success');
    assert.equal((await response.json() as { reason?: string }).reason, 'purge_running');
    // Suggestions first: what failed leaves less switched on, never more.
    assert.equal(await getRecommendationConsent(uid), 'declined', 'suggestions were not stopped first');
    assert.equal((await readTrust(uid))?.revokedAt ?? null, null);
  } finally {
    end();
  }
});
