/**
 * "Suggest one next step" (UC-2.9, #170).
 *
 * ── What this file is really guarding ────────────────────────────
 *
 * Two consents now share one implementation, which is the right shape and also
 * the shape with a specific failure mode: one question's answer quietly
 * standing in for the other's. Several tests below grant exactly one and
 * require the other to stay declined, in both directions. If the two ever
 * collapse into one field, or one is defaulted from the other, they fail.
 *
 * The rest is the same contract UC-2.1 (#161) holds the AI consent to —
 * missing means declined, an unknown version is refused rather than upgraded,
 * revocation lands on the next call — asserted here rather than assumed from
 * the shared code, because the shared code is exactly what could change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  AI_CONSENT_VERSION,
  PERSONALIZATION_CONSENT_VERSION,
  RECOMMENDATION_CONSENT_CLAIMS_V1,
  RECOMMENDATION_CONSENT_VERSION,
  aiConsentClaimsDigest,
} from '../../src/contracts/v1/consentContracts.ts';
import { getAiConsent, setAiConsent } from '../../lib/consents/aiConsentService.ts';
import {
  getRecommendationConsent,
  readRecommendationConsent,
  setRecommendationConsent,
} from '../../lib/consents/recommendationConsentService.ts';
import { UnsupportedConsentVersionError } from '../../lib/consents/consentService.ts';
import { listAuditEvents } from '../../lib/pilot/pilotTrustStore.ts';
import { GET as consentsGet } from '../../src/app/api/mobile/consents/route.ts';
import { PUT as recommendationsPut } from '../../src/app/api/mobile/consents/recommendations/route.ts';
import { PUT as aiPut } from '../../src/app/api/mobile/consents/ai-processing/route.ts';

const baseUrl = 'http://127.0.0.1:4321';
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

function request(uid: string, path: string, body?: unknown, method = 'GET'): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

// ── The default ──────────────────────────────────────────────────

test('a fresh account has not agreed to recommendations', async () => {
  begin();
  try {
    const uid = uidFor('RecNeverAsked');
    assert.equal(await getRecommendationConsent(uid), 'declined');
    assert.equal(await readRecommendationConsent(uid), null);

    const view = await json(await consentsGet(request(uid, '/api/mobile/consents')));
    assert.equal(view.recommendations.state, 'declined');
    assert.equal(view.recommendations.asked, false, 'a fresh account looks like it was asked and said no');
  } finally {
    end();
  }
});

// ── The two consents are separate ────────────────────────────────

test('granting AI processing does not grant recommendations', async () => {
  begin();
  try {
    const uid = uidFor('AiOnly');
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });

    assert.equal(await getAiConsent(uid), 'granted');
    assert.equal(await getRecommendationConsent(uid), 'declined', 'AI consent leaked into recommendations');

    const view = await json(await consentsGet(request(uid, '/api/mobile/consents')));
    assert.equal(view.recommendations.asked, false, 'answering one question marked the other answered');
  } finally {
    end();
  }
});

test('granting recommendations does not grant AI processing', async () => {
  begin();
  try {
    const uid = uidFor('RecOnly');
    await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });

    assert.equal(await getRecommendationConsent(uid), 'granted');
    // The one that matters most: this must never be the thing that lets
    // somebody's sentences reach Google.
    assert.equal(await getAiConsent(uid), 'declined', 'recommendation consent bought a model call');
  } finally {
    end();
  }
});

test('answering one question leaves the other answer intact', async () => {
  begin();
  try {
    const uid = uidFor('BothAnswers');
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION, locale: 'ar' });
    await setRecommendationConsent(uid, { state: 'declined', version: RECOMMENDATION_CONSENT_VERSION });
    // The write merges into the consent map rather than replacing it.
    assert.equal(await getAiConsent(uid), 'granted', 'the second write erased the first');

    await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
    assert.equal(await getAiConsent(uid), 'granted');
    assert.equal(await getRecommendationConsent(uid), 'granted');
  } finally {
    end();
  }
});

// ── The version contract ─────────────────────────────────────────

test('an unknown recommendation version is refused, never silently upgraded', async () => {
  begin();
  try {
    const uid = uidFor('RecBadVersion');
    await assert.rejects(
      () => setRecommendationConsent(uid, { state: 'granted', version: 'rec-consent-v99' }),
      UnsupportedConsentVersionError,
    );
    // Including the *other* consent's version, which is a real mix-up a client
    // could make and must not be accepted as an answer to this question.
    await assert.rejects(
      () => setRecommendationConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION }),
      UnsupportedConsentVersionError,
    );
    assert.equal(await getRecommendationConsent(uid), 'declined');
  } finally {
    end();
  }
});

test('a record from a version this server no longer knows reads as declined', async () => {
  begin();
  try {
    const uid = uidFor('RecStaleVersion');
    await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });

    const { getStorage } = await import('../../lib/storage/index.ts');
    const { userDoc } = await import('../../lib/storage/paths.ts');
    await getStorage().runTransaction(async (tx) => {
      const current = await tx.get<any>(userDoc(uid));
      tx.merge(userDoc(uid), {
        consents: { ...current.consents, recommendations: { ...current.consents.recommendations, version: 'rec-consent-v0' } },
      });
    });

    assert.equal(await getRecommendationConsent(uid), 'declined', 'consent to older words still counts');
    assert.equal((await readRecommendationConsent(uid))?.state, 'declined');
  } finally {
    end();
  }
});

test('the recommendation consent version is pinned to the claims it makes', () => {
  // Editing the claims without bumping the version would hold somebody to an
  // answer they gave to different words. Bump both, or neither.
  assert.equal(aiConsentClaimsDigest(RECOMMENDATION_CONSENT_CLAIMS_V1), 'ce4c58b66ec84eba');
  assert.equal(RECOMMENDATION_CONSENT_VERSION, 'rec-consent-v1');
  assert.ok(
    RECOMMENDATION_CONSENT_CLAIMS_V1.some((claim) => claim.startsWith('how:first_party_deterministic_rules')),
    'the claims no longer promise that nothing reaches a model',
  );
});

// ── The route ────────────────────────────────────────────────────

test('the endpoint records the caller\'s own consent and refuses a bad body', async () => {
  begin();
  try {
    const uid = uidFor('RecEndpoint');
    const ok = await recommendationsPut(request(uid, '/api/mobile/consents/recommendations', {
      state: 'granted', version: RECOMMENDATION_CONSENT_VERSION, locale: 'he', platform: 'android',
      // Ignored: the account is the token's.
      uid: uidFor('SomebodyElse'),
    }, 'PUT'));
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).recommendations.locale, 'he');
    assert.equal(await getRecommendationConsent(uid), 'granted');
    assert.equal(await getRecommendationConsent(uidFor('SomebodyElse')), 'declined', 'the body chose the account');

    for (const [label, body] of [
      ['no state', { version: RECOMMENDATION_CONSENT_VERSION }],
      ['a third state', { state: 'maybe', version: RECOMMENDATION_CONSENT_VERSION }],
      ['no version', { state: 'granted' }],
    ] as const) {
      const bad = await recommendationsPut(request(uid, '/api/mobile/consents/recommendations', body, 'PUT'));
      assert.equal(bad.status, 400, `${label} was accepted`);
    }
  } finally {
    end();
  }
});

test('revocation takes effect on the very next call, with no cache in between', async () => {
  begin();
  try {
    const uid = uidFor('RecRevokes');
    await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
    assert.equal(await getRecommendationConsent(uid), 'granted');
    await setRecommendationConsent(uid, { state: 'declined', version: RECOMMENDATION_CONSENT_VERSION });
    assert.equal(await getRecommendationConsent(uid), 'declined', 'a cached grant outlived the revocation');
  } finally {
    end();
  }
});

test('each recommendation change appends exactly one audit event, naming which consent', async () => {
  begin();
  try {
    const uid = uidFor('RecAudited');
    await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
    await setRecommendationConsent(uid, { state: 'declined', version: RECOMMENDATION_CONSENT_VERSION });
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });

    const changes = (await listAuditEvents(uid)).filter((event) => event.eventType === 'consent_changed');
    assert.deepEqual(changes.map((event) => event.reasonCode).sort(), [
      'ai_processing_granted',
      'recommendations_declined',
      'recommendations_granted',
    ]);
  } finally {
    end();
  }
});

test('both consent endpoints refuse an unauthenticated caller', async () => {
  begin();
  try {
    const anonymous = (path: string, method: string) => new Request(`${baseUrl}${path}`, {
      method, headers: new Headers({ 'Content-Type': 'application/json' }), body: '{}',
    });
    assert.equal((await recommendationsPut(anonymous('/api/mobile/consents/recommendations', 'PUT'))).status, 401);
    assert.equal((await aiPut(anonymous('/api/mobile/consents/ai-processing', 'PUT'))).status, 401);
    assert.equal((await consentsGet(new Request(`${baseUrl}/api/mobile/consents`))).status, 401);
  } finally {
    end();
  }
});

test('GET /consents answers both questions and keeps #161\'s field', async () => {
  begin();
  try {
    const uid = uidFor('RecView');
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
    await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });

    const view = await json(await consentsGet(request(uid, '/api/mobile/consents')));
    assert.equal(view.aiProcessing.state, 'granted');
    assert.equal(view.recommendations.state, 'granted');
    assert.deepEqual(view.currentVersions, {
      aiProcessing: AI_CONSENT_VERSION,
      recommendations: RECOMMENDATION_CONSENT_VERSION,
      // UC-3.16 (#202)'s question, answered here too so a client reads every
      // version it may echo back from one call.
      personalization: PERSONALIZATION_CONSENT_VERSION,
    });
    // A client written against #161's response still finds what it reads.
    assert.equal(view.currentVersion, AI_CONSENT_VERSION);
  } finally {
    end();
  }
});
