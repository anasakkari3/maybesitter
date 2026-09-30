/**
 * Consent to AI processing, and what the server does with it (UC-2.1, #161).
 *
 * ══ Since 2026-09-30: AI processing is always on ══════════════════
 *
 * The owner ruled that AI can no longer be turned off
 * (`lib/consents/aiProcessingPolicy`). The tests below that asserted the old
 * opt-in now assert that policy: a never-asked account reads as granted, a
 * `declined` write is refused (409 `ai_always_on` at the route) and writes
 * nothing, and the capture path always requests the model. The gate itself
 * is still tested with an injected consent reader, so the seam that refuses
 * a `declined` answer keeps its coverage. The text below is the original
 * reasoning, kept for the history.
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
import {
  AI_CONSENT_CLAIMS_V1,
  AI_CONSENT_VERSION,
  AI_PROCESSING_DISCLOSURE_CLAIMS_V1,
  AI_PROCESSING_DISCLOSURE_VERSION,
  aiConsentClaimsDigest,
} from '../../src/contracts/v1/consentContracts.ts';
import {
  AiProcessingAlwaysOnError,
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
import { GET as aiConsentGet, PUT as consentPut } from '../../src/app/api/mobile/consents/ai-processing/route.ts';

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

test('AI is always on: a user who has never been asked reads as granted, at the current version', async () => {
  begin();
  try {
    const uid = uidFor('NeverAsked');
    assert.equal(await getAiConsent(uid), 'granted');
    const record = await readAiConsent(uid);
    assert.equal(record?.state, 'granted');
    assert.equal(record?.version, AI_CONSENT_VERSION);
    // Nobody recorded a moment of agreement, so none is invented.
    assert.equal(record?.changedAt, '');

    const view = await aiConsentView(uid);
    assert.equal(view.aiProcessing.state, 'granted');
    // Nothing left to ask: the card must never be shown.
    assert.equal(view.aiProcessing.asked, true);
  } finally {
    end();
  }
});

test('granting is recorded; declining is refused and changes nothing', async () => {
  begin();
  try {
    const uid = uidFor('ChangesMind');
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION, locale: 'ar', platform: 'ios' });
    assert.equal(await getAiConsent(uid), 'granted');
    const granted = await readAiConsent(uid);
    assert.equal(granted?.locale, 'ar');
    assert.equal(granted?.platform, 'ios');
    assert.notEqual(granted?.changedAt, '', 'a recorded agreement keeps its moment');

    await assert.rejects(
      () => setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION }),
      (error: unknown) => error instanceof AiProcessingAlwaysOnError && error.code === 'ai_always_on',
    );
    assert.equal(await getAiConsent(uid), 'granted');
    assert.deepEqual(await readAiConsent(uid), granted, 'a refused decline rewrote the record');
  } finally {
    end();
  }
});

test('a declined record stored before the policy reads as granted', async () => {
  begin();
  try {
    const uid = uidFor('DeclinedBefore');
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    await storage.set(userDoc(uid), {
      consents: { aiProcessing: { state: 'declined', version: AI_CONSENT_VERSION, changedAt: '2026-09-01T00:00:00.000Z' } },
    });
    assert.equal(await getAiConsent(uid), 'granted');
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
    assert.equal((await readAiConsent(uid))?.changedAt, '', 'a refused write still changed the record');
  } finally {
    end();
  }
});

test('a record left over from a version this server no longer knows reads as granted at the current one', async () => {
  // Before the always-on policy this read as declined. Now the stored words do
  // not matter: the answer is the policy's, at the version this server knows.
  begin();
  try {
    const uid = uidFor('StaleVersion');
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    await storage.set(userDoc(uid), {
      consents: { aiProcessing: { state: 'granted', version: 'ai-consent-v0', changedAt: '2026-01-01T00:00:00.000Z' } },
    });

    assert.equal(await getAiConsent(uid), 'granted');
    assert.equal((await readAiConsent(uid))?.version, AI_CONSENT_VERSION);
  } finally {
    end();
  }
});

test('a recorded grant appends exactly one audit event, and a refused decline none', async () => {
  begin();
  try {
    const uid = uidFor('AuditTrail');
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    await getOrCreateTrust(uid, new Date().toISOString());

    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
    await assert.rejects(() => setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION }), AiProcessingAlwaysOnError);

    const events = (await storage.listGroup<{ eventType: string; reasonCode: string }>(AUDIT_EVENTS))
      .filter((row) => row.path.startsWith(`${userDoc(uid)}/`) && row.data.eventType === 'consent_changed');
    assert.equal(events.length, 1, `one change produced ${events.length} audit events`);
    assert.deepEqual(events.map((row) => row.data.reasonCode), ['ai_processing_granted']);
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
  // And the v1 claims are what v1 said, unedited: the record of what the
  // people who answered it were shown.
  assert.equal(aiConsentClaimsDigest(AI_CONSENT_CLAIMS_V1), '9a6b9ca899dd277e');
});

test('what the app discloses in place of the consent claims no choice, and is pinned', () => {
  // AI processing is always on (2026-09-30): the disclosure must not carry the
  // old card's "optional, changeable in settings", and a change to what it
  // claims is a new version, not an edit.
  assert.equal(AI_PROCESSING_DISCLOSURE_VERSION, 'ai-disclosure-v1');
  assert.equal(aiConsentClaimsDigest(AI_PROCESSING_DISCLOSURE_CLAIMS_V1), 'b363911d4e0ee2af');
  assert.ok(AI_PROCESSING_DISCLOSURE_CLAIMS_V1.includes('optional:no,always_on'));
  assert.ok(!AI_PROCESSING_DISCLOSURE_CLAIMS_V1.some((claim) => claim.includes('changeable_in_settings')));
  // Still names who reads it, as v1 did.
  const toWhom = AI_PROCESSING_DISCLOSURE_CLAIMS_V1.find((claim) => claim.startsWith('to_whom:'));
  assert.ok(toWhom?.includes('google_cloud_vertex_ai_gemini') && toWhom.includes('eu_region'));
  // v1's own "optional" claim is exactly what is no longer true.
  assert.ok(AI_CONSENT_CLAIMS_V1.includes('optional:changeable_in_settings'));
});

/* ── The API ──────────────────────────────────────────────────────── */

test('both consent endpoints refuse an unauthenticated caller', async () => {
  begin();
  try {
    assert.equal((await consentsGet(request(null))).status, 401);
    const put = await consentPut(request(null, { state: 'granted', version: AI_CONSENT_VERSION }, 'PUT'));
    assert.equal(put.status, 401);
    assert.equal((await aiConsentGet(request(null))).status, 401);
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

    // Turning AI off is refused, in either spelling, and changes nothing.
    for (const state of ['declined', 'denied']) {
      const refused = await consentPut(request(uid, { state, version: AI_CONSENT_VERSION }, 'PUT'));
      assert.equal(refused.status, 409, `${state} was not refused`);
      assert.equal((await refused.json() as { code: string }).code, 'ai_always_on');
      assert.equal(await getAiConsent(uid), 'granted');
    }

    const read = await aiConsentGet(request(uid));
    assert.equal(read.status, 200);
    const aiView = await read.json() as { aiProcessing: { state: string; asked: boolean; version: string }; currentVersion: string };
    assert.equal(aiView.aiProcessing.state, 'granted');
    assert.equal(aiView.aiProcessing.asked, true);
    assert.equal(aiView.currentVersion, AI_CONSENT_VERSION);
  } finally {
    end();
  }
});

/* ── Enforcement ──────────────────────────────────────────────────── */

test('layer 2: the gated provider reaches the model for an account that never answered', async () => {
  begin();
  try {
    const uid = uidFor('GateAlwaysOn');
    const inner = spyProvider();
    const gated = consentGatedProvider(uid, { provider: inner });
    const requestBody = { system: '', user: 'x', responseSchema: {}, purpose: 'capture_extraction' as const, uid };

    await gated.generateJson(requestBody);
    assert.equal(inner.calls, 1, 'an always-on account could not reach the model');
  } finally {
    end();
  }
});

test('the gate itself still refuses whatever reads as declined', async () => {
  // The seam is kept: a consent reader that says no is still obeyed, before
  // the model is asked. The policy only decides what the reader says.
  begin();
  try {
    const uid = uidFor('GateRefuses');
    const inner = spyProvider();
    const gated = consentGatedProvider(uid, { provider: inner, consent: async () => 'declined' });
    const requestBody = { system: '', user: 'x', responseSchema: {}, purpose: 'capture_extraction' as const, uid };

    await assert.rejects(
      () => gated.generateJson(requestBody),
      (error: unknown) => error instanceof AiConsentRequiredError && error.reason === 'consent_required',
    );
    assert.equal(inner.calls, 0, 'a declined reader let the model be asked');
  } finally {
    end();
  }
});

test('declining cannot switch the model off between two calls', async () => {
  begin();
  try {
    const uid = uidFor('Revoker');
    const inner = spyProvider();
    const gated = consentGatedProvider(uid, { provider: inner });
    const requestBody = { system: '', user: 'x', responseSchema: {}, purpose: 'capture_extraction' as const, uid };

    await gated.generateJson(requestBody);
    await assert.rejects(() => setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION }), AiProcessingAlwaysOnError);
    await gated.generateJson(requestBody);
    assert.equal(inner.calls, 2);
  } finally {
    end();
  }
});

test('layer 1: a capture from an account that never answered asks for the model', async () => {
  begin();
  try {
    const uid = uidFor('NoConsentCapture');
    const proposal = await proposeMobileCapture(
      { text: 'Remind me to call Ahmad tomorrow at 7 PM', timezone: 'UTC' },
      { participantId: uid },
    );

    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.provenance?.requestedEngine, 'model', 'AI is always on, but the capture asked for rules');
    // No provider is configured in tests: the rules answer, as the fallback.
    assert.equal(proposal.provenance?.executedEngine, 'rule-based');
  } finally {
    end();
  }
});

test('a client flag cannot choose the engine', async () => {
  // The engine is the server's decision. A body asking for rules changes
  // nothing, exactly as a body asking for the model never could.
  begin();
  try {
    const uid = uidFor('ForgedFlag');
    const proposal = await proposeMobileCapture(
      {
        text: 'Remind me to call Ahmad tomorrow at 7 PM',
        timezone: 'UTC',
        requestedEngine: 'rules',
        provenance: { requestedEngine: 'rules' },
      } as never,
      { participantId: uid },
    );

    assert.equal(proposal.provenance?.requestedEngine, 'model', 'a client flag decided the engine');
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
