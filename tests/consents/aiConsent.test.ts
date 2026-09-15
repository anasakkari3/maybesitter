/**
 * Consent to AI processing, and what the server does with it (UC-2.1, #161).
 *
 * The single claim worth testing hardest: **a user who has never been asked has
 * not agreed**. Every other behaviour here follows from that one — the missing
 * record, the unknown version, the forged client flag, the revocation — and
 * getting it backwards means sending somebody's sentences to Google without
 * their knowledge.
 *
 * So there are two layers, and both are tested separately: the capture path
 * refuses to *request* a model without consent, and the provider refuses to
 * *be* one. The second exists because the features that will want a model next
 * have not been written, and the only thing that can protect them from an
 * omission is a seam that asks on their behalf.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { AUDIT_EVENTS, userDoc } from '../../lib/storage/paths.ts';
import { AI_CONSENT_VERSION, aiConsentClaimsDigest } from '../../src/contracts/v1/consentContracts.ts';
import {
  UnsupportedConsentVersionError,
  aiConsentView,
  getAiConsent,
  readAiConsent,
  setAiConsent,
} from '../../lib/consents/aiConsentService.ts';
import { AiConsentRequiredError, consentGatedProvider } from '../../lib/llm/consentGatedProvider.ts';
import type { LlmProvider } from '../../src/extraction/llm/index.ts';
import { getOrCreateTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { GET as consentsGet } from '../../src/app/api/mobile/consents/route.ts';
import { PUT as consentPut } from '../../src/app/api/mobile/consents/ai-processing/route.ts';

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

function request(uid: string | null, body?: unknown, method = 'GET'): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}/api/mobile/consents`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Records whether it was ever asked to answer. */
function spyProvider(): LlmProvider & { calls: number } {
  let calls = 0;
  return {
    name: 'gemini',
    get calls() {
      return calls;
    },
    async generateJson() {
      calls += 1;
      return { text: '{"type":"task"}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
    // Counted the same way: the gate has to refuse both calls, and a double
    // that only carried one could not show that (#183).
    async generateStructured() {
      calls += 1;
      return { text: '{"type":"task"}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  } as LlmProvider & { calls: number };
}

/* ── The record ───────────────────────────────────────────────────── */

test('a user who has never been asked has not agreed', async () => {
  begin();
  try {
    const uid = uidFor('NeverAsked');
    assert.equal(await getAiConsent(uid), 'declined');
    assert.equal(await readAiConsent(uid), null);

    const view = await aiConsentView(uid);
    assert.equal(view.aiProcessing.state, 'declined');
    // The client needs this to tell "not asked" from "said no", which is the
    // difference between showing the card and respecting an answer.
    assert.equal(view.aiProcessing.asked, false);
  } finally {
    end();
  }
});

test('granting and declining are both recorded, and the last answer wins', async () => {
  begin();
  try {
    const uid = uidFor('ChangesMind');
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION, locale: 'ar', platform: 'ios' });
    assert.equal(await getAiConsent(uid), 'granted');
    const granted = await readAiConsent(uid);
    assert.equal(granted?.locale, 'ar');
    assert.equal(granted?.platform, 'ios');

    await setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION });
    assert.equal(await getAiConsent(uid), 'declined');
    assert.equal((await aiConsentView(uid)).aiProcessing.asked, true);
  } finally {
    end();
  }
});

test('an unknown version is refused, never silently upgraded', async () => {
  begin();
  try {
    const uid = uidFor('UnknownVersion');
    await assert.rejects(
      () => setAiConsent(uid, { state: 'granted', version: 'ai-consent-v2' }),
      (error: unknown) => error instanceof UnsupportedConsentVersionError,
    );
    assert.equal(await getAiConsent(uid), 'declined', 'a refused write still changed the record');
  } finally {
    end();
  }
});

test('a record left over from a version this server no longer knows reads as declined', async () => {
  // Consent is consent to specific words. If those words are gone, the answer
  // someone gave is not an answer to the question being asked now.
  begin();
  try {
    const uid = uidFor('StaleVersion');
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    await storage.set(userDoc(uid), {
      consents: { aiProcessing: { state: 'granted', version: 'ai-consent-v0', changedAt: '2026-01-01T00:00:00.000Z' } },
    });

    assert.equal(await getAiConsent(uid), 'declined');
  } finally {
    end();
  }
});

test('each change appends exactly one audit event', async () => {
  begin();
  try {
    const uid = uidFor('AuditTrail');
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    await getOrCreateTrust(uid, new Date().toISOString());

    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
    await setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION });

    const events = (await storage.listGroup<{ eventType: string; reasonCode: string }>(AUDIT_EVENTS))
      .filter((row) => row.path.startsWith(`${userDoc(uid)}/`) && row.data.eventType === 'consent_changed');
    assert.equal(events.length, 2, `two changes produced ${events.length} audit events`);
    assert.deepEqual(
      events.map((row) => row.data.reasonCode).sort(),
      ['ai_processing_declined', 'ai_processing_granted'],
    );
  } finally {
    end();
  }
});

test('the consent version is pinned to the claims it makes', () => {
  // Editing what the card promises without bumping the version would hold
  // someone to an answer they never gave.
  assert.equal(AI_CONSENT_VERSION, 'ai-consent-v1');
  assert.equal(aiConsentClaimsDigest().length, 16);
  assert.notEqual(aiConsentClaimsDigest(['something else']), aiConsentClaimsDigest());
});

/* ── The API ──────────────────────────────────────────────────────── */

test('both consent endpoints refuse an unauthenticated caller', async () => {
  begin();
  try {
    assert.equal((await consentsGet(request(null))).status, 401);
    const put = await consentPut(request(null, { state: 'granted', version: AI_CONSENT_VERSION }, 'PUT'));
    assert.equal(put.status, 401);
  } finally {
    end();
  }
});

test('the endpoint records the caller\'s own consent and refuses a bad body', async () => {
  begin();
  try {
    const uid = uidFor('ApiCaller');
    const ok = await consentPut(request(uid, { state: 'granted', version: AI_CONSENT_VERSION, locale: 'he' }, 'PUT'));
    assert.equal(ok.status, 200);
    assert.equal(await getAiConsent(uid), 'granted');

    const view = await (await consentsGet(request(uid))).json() as { aiProcessing: { state: string }; currentVersion: string };
    assert.equal(view.aiProcessing.state, 'granted');
    assert.equal(view.currentVersion, AI_CONSENT_VERSION);

    for (const body of [{ state: 'maybe', version: AI_CONSENT_VERSION }, { version: AI_CONSENT_VERSION }]) {
      const bad = await consentPut(request(uid, body, 'PUT'));
      assert.equal(bad.status, 400, `${JSON.stringify(body)} was accepted`);
      assert.equal((await bad.json() as { reason: string }).reason, 'invalid_state');
    }

    const wrongVersion = await consentPut(request(uid, { state: 'granted', version: 'ai-consent-v9' }, 'PUT'));
    assert.equal(wrongVersion.status, 400);
    assert.equal((await wrongVersion.json() as { reason: string }).reason, 'unsupported_version');
  } finally {
    end();
  }
});

/* ── Enforcement ──────────────────────────────────────────────────── */

test('layer 2: the gated provider refuses an account that has not agreed', async () => {
  begin();
  try {
    const uid = uidFor('GateRefuses');
    const inner = spyProvider();
    const gated = consentGatedProvider(uid, { provider: inner });
    const requestBody = { system: '', user: 'x', responseSchema: {}, purpose: 'capture_extraction' as const, uid };

    await assert.rejects(
      () => gated.generateJson(requestBody),
      (error: unknown) => error instanceof AiConsentRequiredError && error.reason === 'consent_required',
    );
    assert.equal(inner.calls, 0, 'a declined account reached the model');

    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
    await gated.generateJson(requestBody);
    assert.equal(inner.calls, 1, 'a granted account could not reach the model');
  } finally {
    end();
  }
});

test('revocation takes effect on the very next call, with no cache in between', async () => {
  begin();
  try {
    const uid = uidFor('Revoker');
    const inner = spyProvider();
    const gated = consentGatedProvider(uid, { provider: inner });
    const requestBody = { system: '', user: 'x', responseSchema: {}, purpose: 'capture_extraction' as const, uid };

    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
    await gated.generateJson(requestBody);
    assert.equal(inner.calls, 1);

    await setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION });
    await assert.rejects(() => gated.generateJson(requestBody), AiConsentRequiredError);
    assert.equal(inner.calls, 1, 'a revoked account still reached the model once more');
  } finally {
    end();
  }
});

test('layer 1: a capture without consent is read by the rules, and says so', async () => {
  begin();
  try {
    const uid = uidFor('NoConsentCapture');
    const proposal = await proposeMobileCapture(
      { text: 'Remind me to call Ahmad tomorrow at 7 PM', timezone: 'UTC' },
      { participantId: uid },
    );

    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.provenance?.requestedEngine, 'rules', 'the server asked for a model without consent');
    assert.equal(proposal.provenance?.executedEngine, 'rule-based');
  } finally {
    end();
  }
});

test('a forged client flag cannot buy a model call', async () => {
  // The dangerous version of this endpoint believes the client. A body that
  // asks for the model, from an account that has not agreed, must change
  // nothing at all.
  begin();
  try {
    const uid = uidFor('ForgedFlag');
    const proposal = await proposeMobileCapture(
      {
        text: 'Remind me to call Ahmad tomorrow at 7 PM',
        timezone: 'UTC',
        requestedEngine: 'model',
        provenance: { requestedEngine: 'model' },
      } as never,
      { participantId: uid },
    );

    assert.equal(proposal.provenance?.requestedEngine, 'rules', 'a client flag decided the engine');
    assert.equal(proposal.provenance?.executedEngine, 'rule-based');
  } finally {
    end();
  }
});

test('with consent, the capture path does ask for a model', async () => {
  // Without this, every assertion above would pass on a system that never asks
  // for a model at all.
  begin();
  try {
    const uid = uidFor('ConsentedCapture');
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });

    const proposal = await proposeMobileCapture(
      { text: 'Remind me to call Ahmad tomorrow at 7 PM', timezone: 'UTC' },
      { participantId: uid },
    );

    assert.equal(proposal.provenance?.requestedEngine, 'model', 'consent did not reach the capture path');
    // No provider is configured in tests, so the model is unreachable and the
    // rule-based extractor answers. That is the fallback working, not consent
    // failing.
    assert.equal(proposal.provenance?.executedEngine, 'rule-based');
  } finally {
    end();
  }
});
