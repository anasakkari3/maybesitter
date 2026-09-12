/**
 * Consent, as another instance sees it (UC-2.1, #161).
 *
 * Revocation has to hold on the next request, and on Cloud Run the next
 * request is usually served by a different instance. The memory adapter cannot
 * show that: it is one process with one copy of everything. So the claim is
 * made here, through independent Firestore handles — which is what "another
 * instance" means from this side of the seam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { getAiConsent, readAiConsent, setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AiConsentRequiredError, consentGatedProvider } from '../../lib/llm/consentGatedProvider.ts';
import type { LlmProvider } from '../../src/extraction/llm/index.ts';

function uniqueUid(): string {
  return `consent_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function spyProvider(): LlmProvider & { calls: number } {
  let calls = 0;
  return {
    name: 'gemini',
    get calls() {
      return calls;
    },
    async generateJson() {
      calls += 1;
      return { text: '{}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  } as LlmProvider & { calls: number };
}

test('firestore: a grant written by one instance is seen by another, and so is the revocation', async () => {
  const uid = uniqueUid();
  const writer = createFirestoreStorage();
  const reader = createFirestoreStorage();
  try {
    // Never asked.
    assert.equal(await getAiConsent(uid, { storage: reader }), 'declined');

    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION, locale: 'ar' }, { storage: writer });
    assert.equal(await getAiConsent(uid, { storage: reader }), 'granted', 'the second instance did not see the grant');
    assert.equal((await readAiConsent(uid, { storage: reader }))?.locale, 'ar');

    await setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION }, { storage: writer });
    assert.equal(await getAiConsent(uid, { storage: reader }), 'declined', 'the revocation was not visible');
  } finally {
    await createFirestoreStorage().deleteTree(userDoc(uid)).catch(() => {});
    resetFirestoreForTests();
  }
});

test('firestore: the gate refuses immediately after a revocation written elsewhere', async () => {
  const uid = uniqueUid();
  const writer = createFirestoreStorage();
  const serving = createFirestoreStorage();
  try {
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION }, { storage: writer });

    const inner = spyProvider();
    const gated = consentGatedProvider(uid, { provider: inner, storage: serving });
    const body = { system: '', user: 'x', responseSchema: {}, purpose: 'capture_extraction' as const, uid };

    await gated.generateJson(body);
    assert.equal(inner.calls, 1);

    // Another instance revokes. No request in between, no cache to expire.
    await setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION }, { storage: writer });

    await assert.rejects(() => gated.generateJson(body), AiConsentRequiredError);
    assert.equal(inner.calls, 1, 'the serving instance reached the model after consent was revoked elsewhere');
  } finally {
    await createFirestoreStorage().deleteTree(userDoc(uid)).catch(() => {});
    resetFirestoreForTests();
  }
});

test('firestore: consent does not disturb the trust record sharing its document', async () => {
  // Both live on `users/{uid}`. A write that replaced the map instead of
  // merging into it would silently drop somebody's consents or their trust
  // state, and neither would be noticed until it mattered.
  const uid = uniqueUid();
  const storage = createFirestoreStorage();
  try {
    await storage.set(userDoc(uid), { uid, trust: { version: 'v1', participantId: uid, updatedAt: '2026-09-01T00:00:00.000Z' } });
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION }, { storage });

    const user = await createFirestoreStorage().get<{ trust?: unknown; consents?: unknown }>(userDoc(uid));
    assert.ok(user?.trust, 'writing consent erased the trust record');
    assert.ok(user?.consents, 'the consent was not stored');
  } finally {
    await createFirestoreStorage().deleteTree(userDoc(uid)).catch(() => {});
    resetFirestoreForTests();
  }
});
