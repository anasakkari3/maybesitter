/**
 * Gmail triage (owner direction, 2026-11-10): decide from From, Subject and the
 * first lines whether a mail is worth the full (~0.21¢) Gemini read.
 *
 * - `scoreWithJev`: the request shape, both response wrappings, and every path
 *   that must answer `null` (and never log the key or the mail);
 * - `scoreEmailRelevance`: Jev first, the Gemini header fallback on its own
 *   daily counter (never the general capture caps), spend only when the add-on
 *   gate is on, `null` when both fail;
 * - the config clamps and the deterministic audit sample;
 * - through the real `runM5aScanStep`: off is unchanged, enforce skips only a
 *   low score outside the audit sample, shadow always reads, the person's own
 *   mail is never scored, and an older triage rule is re-examined.
 *
 * Nothing here reaches the network: every scorer and provider is a fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_SOURCE_MARKERS, PROVIDER_CONNECTIONS,
  createMemoryStorage, resetStorageForTests, setStorageForTests, userSubDoc,
} from '../../lib/storage';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';
import { GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore';
import type { GmailTransport } from '../../lib/integrations/gmail/production/gmailTransport';
import {
  legacyMarkerIdFor, markerDecision, providerMarkerIdFor, publicScanStatus, runM5aScanStep,
  type M5aMarker, type M5aScanDocument,
} from '../../lib/intelligence/m5aGmailScan';
import {
  DEFAULT_JEV_MODEL, RELEVANCE_INSTRUCTIONS, scoreWithJev,
} from '../../lib/llm/jevClient';
import {
  EMAIL_TRIAGE_ACTION, TRIAGE_RULE, isAuditSample, isConversationReply, scoreBucket, scoreEmailRelevance,
  triageAuditRate, triageMode, triageThreshold, type TriageInput, type TriageScore,
} from '../../lib/intelligence/emailTriage';
import { actionsToday, callsToday } from '../../lib/llm/usageGuard';
import { readMonthSpend } from '../../lib/features/spendLedger';
import type { LlmProvider, LlmStructuredRequest } from '../../src/extraction/llm/llmProvider';
import type { ShareStructuredGenerator } from '../../lib/llm/shareProvider';
import { createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';

const NOW = '2026-11-10T10:00:00.000Z';
const KEY = 'jev-secret-key-123';
const JEV_URL = 'https://jev.example/v1/decisions';
const KEYED = { MAYBESITTER_JEV_API_KEY: KEY, MAYBESITTER_JEV_URL: JEV_URL };
/** The Gemini fallback runs only while the monthly budget is enforced (review P1-4). */
const ENFORCED = { MAYBESITTER_ADDON_GATE_MODE: 'enforce' };
const ENV_KEYS = [
  'MAYBESITTER_EMAIL_TRIAGE_MODE', 'MAYBESITTER_EMAIL_TRIAGE_THRESHOLD', 'MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE',
  'MAYBESITTER_ADDON_GATE_MODE', 'MAYBESITTER_AI_DISABLED', 'MAYBESITTER_JEV_API_KEY',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetStorageForTests();
});

/** Collects console.warn lines while `run` runs. */
async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { result: await run(), lines }; } finally { console.warn = original; }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function recordingFetch(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return answer();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const direct = (noul: unknown, tokens: unknown = 120) => ({ model: 'typesafe-ai/jev', answers: { relevant: { noul } }, usage: { input_tokens: tokens } });

/* ─────────────────────────────── scoreWithJev ─────────────────────────────── */

test('Jev: POSTs the model, the state and one noul question with a bearer key to the configured URL', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(direct(0.42)));
  const score = await scoreWithJev({ state: 'From: a\nSubject: b\n\nbody' }, { fetchImpl, env: KEYED });
  assert.deepEqual(score, { probability: 0.42, inputTokens: 120, model: 'typesafe-ai/jev' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, JEV_URL);
  assert.equal(calls[0]!.init.method, 'POST');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    model: DEFAULT_JEV_MODEL,
    state: 'From: a\nSubject: b\n\nbody',
    questions: { relevant: { type: 'noul', instructions: RELEVANCE_INSTRUCTIONS } },
  });
  assert.ok(calls[0]!.init.signal, 'the request carries an abort signal');
});

test('Jev: the URL and model come from the environment on every call', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(direct(0.1)));
  await scoreWithJev({ state: 's' }, { fetchImpl, env: {
    MAYBESITTER_JEV_API_KEY: KEY, MAYBESITTER_JEV_URL: 'https://api.typesafe.ai/v1/systemone', MAYBESITTER_JEV_MODEL: 'jev-2',
  } });
  assert.equal(calls[0]!.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(JSON.parse(String(calls[0]!.init.body)).model, 'jev-2');
});

test('Jev: reads the jevai.org { code, message, data } wrapping and the direct one', async () => {
  const wrapped = recordingFetch(() => jsonResponse({ code: 0, message: 'ok', data: direct(0.07, 33) }));
  assert.deepEqual(await scoreWithJev({ state: 's' }, { fetchImpl: wrapped.fetchImpl, env: KEYED }),
    { probability: 0.07, inputTokens: 33, model: 'typesafe-ai/jev' });
  const bare = recordingFetch(() => jsonResponse({ answers: { relevant: { noul: 1 } } }));
  assert.deepEqual(await scoreWithJev({ state: 's' }, { fetchImpl: bare.fetchImpl, env: KEYED }),
    { probability: 1, inputTokens: 1, model: DEFAULT_JEV_MODEL }, 'missing usage is estimated from the state, never zero');
});

test('Jev: the jevai.org MCP endpoint is called as tools/call jev_decide and read from structuredContent', async () => {
  const env = { MAYBESITTER_JEV_API_KEY: KEY, MAYBESITTER_JEV_URL: 'https://www.jevai.org/api/mcp' };
  const ok = recordingFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: {
    content: [{ type: 'text', text: '{}' }], structuredContent: direct(0.2, 50),
  } }));
  assert.deepEqual(await scoreWithJev({ state: 's' }, { fetchImpl: ok.fetchImpl, env }),
    { probability: 0.2, inputTokens: 50, model: 'typesafe-ai/jev' });
  const sent = JSON.parse(String(ok.calls[0]!.init.body));
  assert.deepEqual([sent.jsonrpc, sent.method, sent.params.name, sent.params.arguments.state], ['2.0', 'tools/call', 'jev_decide', 's']);
  assert.equal((ok.calls[0]!.init.headers as Record<string, string>).Accept, 'application/json, text/event-stream');
  // What the owner's key answered on 2026-11-10: an MCP tool error is a missing score.
  const refused = recordingFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: {
    content: [{ type: 'text', text: 'The request credentials or model access were rejected.' }], isError: true,
  } }));
  const { result, lines } = await captureWarnings(() => scoreWithJev({ state: 's' }, { fetchImpl: refused.fetchImpl, env }));
  assert.equal(result, null);
  assert.deepEqual(lines, ['[llm/jev] unavailable: http']);
});

test('Jev: an SSE answer is read from its last data line; an oversized answer is a missing score', async () => {
  const env = { MAYBESITTER_JEV_API_KEY: KEY, MAYBESITTER_JEV_URL: 'https://www.jevai.org/api/mcp' };
  const sse = recordingFetch(() => new Response(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: direct(0.3, 9) } })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  assert.deepEqual(await scoreWithJev({ state: 's' }, { fetchImpl: sse.fetchImpl, env }), { probability: 0.3, inputTokens: 9, model: 'typesafe-ai/jev' });
  const huge = recordingFetch(() => jsonResponse({ data: direct(0.3), pad: 'x'.repeat(70 * 1024) }));
  const { result } = await captureWarnings(() => scoreWithJev({ state: 's' }, { fetchImpl: huge.fetchImpl, env: KEYED }));
  assert.equal(result, null);
});

test('Jev: no key or no URL means no request at all; there is no default endpoint', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(direct(0.5)));
  assert.equal(await scoreWithJev({ state: 's' }, { fetchImpl, env: {} }), null);
  assert.equal(await scoreWithJev({ state: 's' }, { fetchImpl, env: { MAYBESITTER_JEV_API_KEY: KEY } }), null);
  assert.equal(await scoreWithJev({ state: 's' }, { fetchImpl, env: { MAYBESITTER_JEV_URL: JEV_URL } }), null);
  assert.equal(await scoreWithJev({ state: 's' }, { fetchImpl, env: { MAYBESITTER_JEV_API_KEY: '  ' } }), null);
  assert.equal(calls.length, 0);
});

test('Jev: every failure answers null, and no line carries the key or the mail', async () => {
  const env = KEYED;
  const state = 'From: boss@example.com\nSubject: SECRET-SUBJECT\n\nprivate body';
  const fakeOk = (value: unknown) => (async () => ({ ok: true, status: 200, json: async () => value }) as unknown as Response) as typeof fetch;
  const cases: Array<[string, typeof fetch]> = [
    ['non-2xx', recordingFetch(() => jsonResponse(direct(0.1), 503)).fetchImpl],
    ['401', recordingFetch(() => jsonResponse({ error: 'bad key' }, 401)).fetchImpl],
    ['bad JSON', recordingFetch(() => new Response('not json{', { status: 200 })).fetchImpl],
    ['missing probability', recordingFetch(() => jsonResponse({ answers: {} })).fetchImpl],
    ['string probability', recordingFetch(() => jsonResponse(direct('0.3'))).fetchImpl],
    ['NaN probability', fakeOk(direct(Number.NaN))],
    ['probability 1.5', recordingFetch(() => jsonResponse(direct(1.5))).fetchImpl],
    ['negative probability', recordingFetch(() => jsonResponse(direct(-0.1))).fetchImpl],
    ['null body', recordingFetch(() => jsonResponse(null)).fetchImpl],
    ['network error', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch],
  ];
  for (const [name, fetchImpl] of cases) {
    const { result, lines } = await captureWarnings(() => scoreWithJev({ state }, { fetchImpl, env }));
    assert.equal(result, null, name);
    for (const line of lines) {
      assert.ok(!line.includes(KEY) && !line.includes('SECRET-SUBJECT') && !line.includes('private body'), `${name} logged content: ${line}`);
      assert.match(line, /^\[llm\/jev\] unavailable: [a-z]+$/, `${name}: ${line}`);
    }
  }
});

test('Jev: a slow answer times out to null', async () => {
  const hanging = ((_url: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  const started = Date.now();
  const { result, lines } = await captureWarnings(() => scoreWithJev({ state: 's' }, {
    fetchImpl: hanging, env: KEYED, timeoutMs: 20,
  }));
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(lines, ['[llm/jev] unavailable: timeout']);
});

/* ─────────────────────────── scoreEmailRelevance ──────────────────────────── */

const INPUT: TriageInput = { from: 'School <office@school.example>', subject: 'Parents evening', body: 'x'.repeat(5_000) };

function geminiFake(answer: (request: Parameters<ShareStructuredGenerator>[0]) => string | Promise<string>) {
  const requests: Array<Parameters<ShareStructuredGenerator>[0]> = [];
  const generate: ShareStructuredGenerator = async request => {
    requests.push(request);
    return { text: await answer(request), model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 50, outputTokens: 4 };
  };
  return { requests, generate };
}

test('scoring: Jev first, with From, Subject and the first 4000 characters of the body', async () => {
  const states: string[] = [];
  const gemini = geminiFake(() => '{"relevant_probability":0.9}');
  const score = await scoreEmailRelevance('u-jev', INPUT, {
    storage: createMemoryStorage(), now: () => new Date(NOW), env: {},
    jev: async input => { states.push(input.state); return { probability: 0.03, inputTokens: 900, model: 'jev' }; },
    gemini: gemini.generate,
  });
  assert.deepEqual(score, { probability: 0.03, scorer: 'jev' });
  assert.equal(gemini.requests.length, 0, 'Gemini is not asked when Jev answered');
  assert.equal(states[0], `From: ${INPUT.from}\nSubject: ${INPUT.subject}\n\n${'x'.repeat(4_000)}`);
});

test('scoring: Jev spend is recorded on gmail_reading only when the add-on gate is on', async () => {
  const jev = async () => ({ probability: 0.5, inputTokens: 1_000, model: 'jev' });
  const off = createMemoryStorage();
  await scoreEmailRelevance('u-spend', INPUT, { storage: off, now: () => new Date(NOW), env: {}, jev });
  assert.deepEqual((await readMonthSpend('u-spend', { storage: off, now: new Date(NOW) })).features, {});
  for (const mode of ['shadow', 'enforce']) {
    const on = createMemoryStorage();
    await scoreEmailRelevance('u-spend', INPUT, { storage: on, now: () => new Date(NOW), env: { MAYBESITTER_ADDON_GATE_MODE: mode }, jev });
    const month = await readMonthSpend('u-spend', { storage: on, now: new Date(NOW) });
    assert.equal(month.features.gmail_reading, 42_000, `${mode}: 1000 tokens at 42 n$`);
  }
});

test('scoring: when Jev cannot answer, Gemini reads From, Subject and only the first 600 characters', async () => {
  const gemini = geminiFake(() => '{"relevant_probability":0.08}');
  const score = await scoreEmailRelevance('u-fallback', { ...INPUT, body: `${'a'.repeat(600)}TAIL-NEVER-SENT` }, {
    storage: createMemoryStorage(), now: () => new Date(NOW), env: {}, jev: async () => null, gemini: gemini.generate,
  });
  assert.deepEqual(score, { probability: 0.08, scorer: 'gemini_header' });
  assert.equal(gemini.requests.length, 1);
  const request = gemini.requests[0]!;
  const text = request.parts.map(part => part.kind === 'text' ? part.text : '').join('\n');
  assert.ok(text.includes(`From: ${INPUT.from}`) && text.includes(`Subject: ${INPUT.subject}`));
  assert.ok(text.includes('a'.repeat(600)));
  assert.ok(!text.includes('TAIL-NEVER-SENT'), 'nothing past 600 characters reaches the model');
  assert.ok(!request.system.includes(INPUT.subject!), 'the mail is never in the instructions');
  // The live eval saw 16 cut every answer mid-key; never ask for less than 64.
  assert.ok((request.maxOutputTokens ?? 0) >= 64, `asked for ${request.maxOutputTokens}`);
  assert.equal(request.timeoutMs, 3_000);
  assert.equal(request.retry, false);
  assert.deepEqual((request.responseSchema as { required?: string[] }).required, ['relevant_probability']);
});

test('scoring: null when both scorers fail, never a throw', async () => {
  const base = { storage: createMemoryStorage(), now: () => new Date(NOW), env: {}, jev: async () => null };
  for (const answer of ['not json', '{"relevant_probability":1.5}', '{"relevant_probability":"high"}', '{}']) {
    assert.equal(await scoreEmailRelevance('u-none', INPUT, { ...base, gemini: geminiFake(() => answer).generate }), null, answer);
  }
  assert.equal(await scoreEmailRelevance('u-none', INPUT, {
    ...base, gemini: async () => { throw new Error('vertex down'); },
  }), null);
  assert.equal(await scoreEmailRelevance('u-none', INPUT, {
    ...base, jev: async () => { throw new Error('jev exploded'); }, gemini: async () => { throw new Error('vertex down'); },
  }), null);
});

test('scoring: the kill switch stops Jev too', async () => {
  process.env.MAYBESITTER_AI_DISABLED = 'true';
  let asked = 0;
  assert.equal(await scoreEmailRelevance('u-kill', INPUT, {
    storage: createMemoryStorage(), now: () => new Date(NOW), env: {},
    jev: async () => { asked += 1; return { probability: 0.1, inputTokens: 1, model: 'jev' }; },
  }), null);
  assert.equal(asked, 0);
});

test('scoring: the Gemini fallback spends the email-triage daily action, not the general caps or token budget', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const seen: LlmStructuredRequest[] = [];
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong verb'); },
    generateStructured: async request => {
      seen.push(request);
      return { text: '{"relevant_probability":0.6}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 200, outputTokens: 5 };
    },
  };
  const now = () => new Date(NOW);
  const score = await scoreEmailRelevance('u-reserve', INPUT, { storage, now, env: ENFORCED, jev: async () => null, provider });
  assert.deepEqual(score, { probability: 0.6, scorer: 'gemini_header' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.purpose, 'email_triage');
  assert.equal(await actionsToday('u-reserve', EMAIL_TRIAGE_ACTION, { storage, now: now() }), 1);
  const general = await callsToday('u-reserve', { storage, now: now() });
  assert.equal(general.user, 0, 'no general daily call was reserved');
  assert.equal(general.minuteCalls, 0, 'no general minute call was reserved');
  assert.equal(general.tokens, 0, 'no tokens counted against the general daily token cap');
});

test('scoring: without an enforced budget there is no Gemini fallback, so no Jev score means a full read', async () => {
  let asked = 0;
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong verb'); },
    generateStructured: async () => { asked++; return { text: '{"relevant_probability":0.01}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1 }; },
  };
  for (const env of [{}, { MAYBESITTER_ADDON_GATE_MODE: 'shadow' }]) {
    const score = await scoreEmailRelevance('u-off', INPUT, { storage: createMemoryStorage(), now: () => new Date(NOW), env, jev: async () => null, provider });
    assert.equal(score, null);
  }
  assert.equal(asked, 0);
});

test('scoring: a spent email-triage counter refuses the fallback, and the answer is null', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  let calls = 0;
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong verb'); },
    generateStructured: async () => { calls += 1; return { text: '{"relevant_probability":0.6}', model: 'g', latencyMs: 1, promptTokens: 1, outputTokens: 1 }; },
  };
  const score = await scoreEmailRelevance('u-capped', INPUT, {
    storage, now: () => new Date(NOW), env: ENFORCED, jev: async () => null, provider,
    reserveAction: async (_uid, action) => { assert.equal(action, EMAIL_TRIAGE_ACTION); return 'user_cap'; },
  });
  assert.equal(score, null);
  assert.equal(calls, 0);
});

/* ─────────────────────────────── config ──────────────────────────────────── */

test('config: mode defaults off; threshold and audit rate are clamped', () => {
  assert.equal(triageMode({}), 'off');
  assert.equal(triageMode({ MAYBESITTER_EMAIL_TRIAGE_MODE: 'Enforce ' }), 'enforce');
  assert.equal(triageMode({ MAYBESITTER_EMAIL_TRIAGE_MODE: 'shadow' }), 'shadow');
  assert.equal(triageMode({ MAYBESITTER_EMAIL_TRIAGE_MODE: 'yes' }), 'off');
  assert.equal(triageThreshold({}), 0.15);
  assert.equal(triageThreshold({ MAYBESITTER_EMAIL_TRIAGE_THRESHOLD: '0.3' }), 0.3);
  assert.equal(triageThreshold({ MAYBESITTER_EMAIL_TRIAGE_THRESHOLD: '0.9' }), 0.5, 'never aggressive');
  assert.equal(triageThreshold({ MAYBESITTER_EMAIL_TRIAGE_THRESHOLD: '-1' }), 0);
  assert.equal(triageThreshold({ MAYBESITTER_EMAIL_TRIAGE_THRESHOLD: 'abc' }), 0.15);
  assert.equal(triageAuditRate({}), 0.05);
  assert.equal(triageAuditRate({ MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE: '2' }), 1);
  assert.equal(triageAuditRate({ MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE: '-0.5' }), 0);
  assert.equal(triageAuditRate({ MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE: 'x' }), 0.05);
});

test('config: the audit sample is deterministic and close to its rate', () => {
  const ids = Array.from({ length: 4_000 }, (_, index) => `msg-${index}`);
  assert.deepEqual(ids.map(id => isAuditSample(id, 0.05)), ids.map(id => isAuditSample(id, 0.05)));
  const sampled = ids.filter(id => isAuditSample(id, 0.05)).length / ids.length;
  assert.ok(sampled > 0.03 && sampled < 0.07, `sampled ${sampled}`);
  assert.ok(ids.every(id => !isAuditSample(id, 0)));
  assert.ok(ids.every(id => isAuditSample(id, 1)));
  assert.equal(scoreBucket(0.07), 0);
  assert.equal(scoreBucket(0.3), 0.3);
  assert.equal(scoreBucket(0.99), 0.9);
  assert.equal(scoreBucket(1), 1);
});

test('markers: a triaged marker from an older rule is re-claimed; the current rule is counted', () => {
  const at = NOW;
  const base = { v: 2, state: 'done', outcome: 'triaged', triageScore: 0.05 } as const;
  const previous = { mode: process.env.MAYBESITTER_EMAIL_TRIAGE_MODE, threshold: process.env.MAYBESITTER_EMAIL_TRIAGE_THRESHOLD };
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  try {
    assert.equal(markerDecision({ ...base, triageRule: TRIAGE_RULE }, 'm5a', at), 'count');
    // Relaxing triage re-reads what it skipped (review P2-8).
    process.env.MAYBESITTER_EMAIL_TRIAGE_THRESHOLD = '0.04';
    assert.equal(markerDecision({ ...base, triageRule: TRIAGE_RULE }, 'm5a', at), 'claim', 'threshold lowered past the score');
    delete process.env.MAYBESITTER_EMAIL_TRIAGE_THRESHOLD;
    process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'shadow';
    assert.equal(markerDecision({ ...base, triageRule: TRIAGE_RULE }, 'm5a', at), 'claim', 'triage no longer enforced');
    process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  } finally {
    if (previous.mode === undefined) delete process.env.MAYBESITTER_EMAIL_TRIAGE_MODE; else process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = previous.mode;
    if (previous.threshold === undefined) delete process.env.MAYBESITTER_EMAIL_TRIAGE_THRESHOLD; else process.env.MAYBESITTER_EMAIL_TRIAGE_THRESHOLD = previous.threshold;
  }
  assert.equal(markerDecision({ ...base, triageRule: TRIAGE_RULE - 1 }, 'm5a', at), 'claim');
  assert.equal(markerDecision({ ...base }, 'm5a', at), 'claim', 'a rule-less triage marker is re-examined');
  assert.equal(markerDecision({ ...base, triageRule: TRIAGE_RULE - 1 }, 'base', at), 'skip');
});

/* ─────────────────────── through the real scan step ──────────────────────── */

const scanPath = (uid: string) => `users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/manualV2`;
const markerPath = (uid: string, messageId: string) =>
  `users/${uid}/${INTELLIGENCE_SOURCE_MARKERS}/${providerMarkerIdFor(uid, 'acct', messageId)}`;
const legacyPath = (uid: string, messageId: string) =>
  `users/${uid}/${INTELLIGENCE_SOURCE_MARKERS}/${legacyMarkerIdFor(messageId)}`;

interface Mail { id: string; sentByAccount?: boolean; isReply?: boolean; text?: string; subject?: string }

async function scanHarness(uid: string, mails: readonly Mail[], score: TriageScore | null | ((input: TriageInput) => TriageScore | null)) {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const calls = { model: 0, scorer: 0, inputs: [] as TriageInput[] };
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong provider verb'); },
    generateStructured: async request => {
      calls.model += 1;
      const text = JSON.stringify(request);
      const id = mails.find(mail => text.includes(`body-of-${mail.id}.`))?.id ?? 'unknown';
      return { text: JSON.stringify({ observations: [{ kind: 'request', evidence: `Please sign body-of-${id}.`, confidence: 0.95 }] }),
        model: 'fake-share', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null, fetchImpl: fetch,
    now: () => new Date(NOW), shareProvider: provider, captureProvider: provider,
    emailTriage: async (_uid, input) => {
      calls.scorer += 1;
      calls.inputs.push(input);
      return typeof score === 'function' ? score(input) : score;
    },
  };
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 3, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(scanPath(uid), {
    scanId: 'scan-1', kind: 'manual', status: 'running', origin: 'manual', providerAccountId: 'acct', emailEpoch: 3,
    query: 'after:1 before:9999999999', from: '2026-11-10T00:00:00.000Z', until: '2026-11-11T00:00:00.000Z',
    timezone: 'UTC', startedAt: NOW, finishedAt: null, failedAt: null, failure: null, pageToken: null,
    page: { ids: mails.map(mail => mail.id), nextPageToken: null, done: [] },
    leaseOwner: null, leaseUntil: null, queued: null, nextEligibleAt: NOW, waiting: null,
    messagesRead: 0, messagesSkippedBulk: 0, messagesUnanalysed: 0, messagesUnavailable: 0, messagesTrimmed: 0,
    observationsFound: 0, addedFromEmail: 0,
  });
  const transport = {
    listRecentMessageIds: async () => ({ ids: mails.map(mail => mail.id), nextPageToken: null }),
    getMessageById: async (id: string) => {
      const mail = mails.find(candidate => candidate.id === id)!;
      return { id, threadId: null, historyId: '101', receivedAt: '2026-11-10T09:00:00.000Z',
        from: mail.sentByAccount ? 'me@example.com' : 'Clinic <desk@clinic.example>', subject: mail.subject ?? `Subject ${id}`,
        text: mail.text ?? `Please sign body-of-${id}.`, sentByAccount: Boolean(mail.sentByAccount), isReply: Boolean(mail.isReply),
        isBulk: false, bodyFormat: 'text/plain' as const };
    },
  } as unknown as GmailTransport;
  return {
    storage, calls,
    step: () => runM5aScanStep(uid, 'manual', runtime, transport, async () => undefined),
    scan: async () => (await storage.get<M5aScanDocument>(scanPath(uid)))!,
    marker: (messageId: string) => storage.get<M5aMarker>(markerPath(uid, messageId)),
  };
}

const LOW: TriageScore = { probability: 0.04321, scorer: 'jev' };
const HIGH: TriageScore = { probability: 0.9, scorer: 'jev' };

test('scan, off (default): the scorer is never asked and the mail is read as before', async () => {
  const h = await scanHarness('scan-off', [{ id: 'm1' }], LOW);
  await h.step();
  assert.equal(h.calls.scorer, 0);
  assert.equal(h.calls.model, 1);
  const scan = await h.scan();
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, 1);
  assert.equal(scan.observationsFound, 1);
  assert.equal('messagesSkippedTriage' in scan, false, 'the scan document keeps its old shape');
  assert.equal((await h.marker('m1'))?.outcome, 'analyzed');
});

test('scan, enforce + low score: no model call, marker done/triaged, counter incremented, projection unchanged', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  process.env.MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE = '0';
  const h = await scanHarness('scan-low', [{ id: 'm1' }], LOW);
  await h.step();
  assert.equal(h.calls.scorer, 1);
  assert.equal(h.calls.model, 0, 'the full read was not bought');
  assert.deepEqual(h.calls.inputs[0], { from: 'Clinic <desk@clinic.example>', subject: 'Subject m1', body: 'Please sign body-of-m1.' });
  const marker = await h.marker('m1');
  assert.equal(marker?.state, 'done');
  assert.equal(marker?.outcome, 'triaged');
  assert.equal(marker?.triageRule, TRIAGE_RULE);
  assert.equal(marker?.triageScore, 0.043);
  assert.deepEqual(marker?.observationIds, []);
  assert.equal((await h.storage.get<M5aMarker>(legacyPath('scan-low', 'm1')))?.outcome, 'triaged');
  const scan = await h.scan();
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, 1);
  assert.equal(scan.messagesSkippedTriage, 1);
  assert.equal(scan.messagesSkippedBulk, 0);
  const projection = publicScanStatus(scan, true, true, true)!;
  assert.equal('messagesSkippedTriage' in projection, false, 'the mobile projection does not expose the counter');
});

test('scan, enforce + high score: the mail is read fully', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  process.env.MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE = '0';
  const h = await scanHarness('scan-high', [{ id: 'm1' }], HIGH);
  await h.step();
  assert.equal(h.calls.scorer, 1);
  assert.equal(h.calls.model, 1);
  assert.equal((await h.marker('m1'))?.outcome, 'analyzed');
  assert.equal((await h.scan()).observationsFound, 1);
});

test('scan, enforce + no score: fail open, the mail is read fully', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  process.env.MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE = '0';
  const h = await scanHarness('scan-null', [{ id: 'm1' }], null);
  await h.step();
  assert.equal(h.calls.scorer, 1);
  assert.equal(h.calls.model, 1);
  assert.equal((await h.marker('m1'))?.outcome, 'analyzed');
});

test('scan, enforce: a scorer that throws also reads the mail fully', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  const h = await scanHarness('scan-throw', [{ id: 'm1' }], () => { throw new Error('scorer broke'); });
  await h.step();
  assert.equal(h.calls.model, 1);
  assert.equal((await h.marker('m1'))?.outcome, 'analyzed');
});

test('scan, enforce: the person\'s own sent mail and self-replies are never scored', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  process.env.MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE = '0';
  const h = await scanHarness('scan-self', [
    { id: 'sent', sentByAccount: true },
    { id: 'reply', sentByAccount: true, isReply: true, text: 'Sure, Please sign body-of-reply.\n\nOn Mon, Nov 9, 2026 at 9:00 AM Clinic <desk@clinic.example> wrote:\n> can you?' },
  ], LOW);
  await h.step();
  await h.step();
  assert.equal(h.calls.scorer, 0, 'own mail feeds the email auto-add and is never triaged out');
  assert.equal(h.calls.model >= 2, true);
  assert.notEqual((await h.marker('sent'))?.outcome, 'triaged');
  assert.notEqual((await h.marker('reply'))?.outcome, 'triaged');
});

test('rule 2: replies and forwards are recognised in English, Hebrew and Arabic; ordinary subjects are not', () => {
  for (const subject of ['Re: project', 'RE:project', 'Fwd: invoice', 'FW: x', 'Re[2]: thread', 'AW: Termin', 'השב: פגישה', 'תשובה: שאלה', 'رد: الموعد', 'إعادة توجيه: ملف', '  re : spaced']) {
    assert.equal(isConversationReply(subject), true, subject);
  }
  for (const subject of ['Reminder: pay', 'Registration open', 'Return policy', 'Free webinar', 'رداء', '', null, undefined]) {
    assert.equal(isConversationReply(subject), false, String(subject));
  }
});

test('scan, enforce: a reply or forward is never scored and is always read fully (rule 2)', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  process.env.MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE = '0';
  const h = await scanHarness('scan-conversation', [{ id: 're', subject: 'Re:' }, { id: 'fwd', subject: 'Fwd: files' }, { id: 'plain' }], LOW);
  await h.step();
  await h.step();
  await h.step();
  assert.equal(h.calls.scorer, 1, 'only the ordinary mail is scored');
  assert.notEqual((await h.marker('re'))?.outcome, 'triaged');
  assert.notEqual((await h.marker('fwd'))?.outcome, 'triaged');
  assert.equal((await h.marker('plain'))?.outcome, 'triaged');
});

test('scan, enforce + audit sample: a low score is still read fully, and a miss is logged without content', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  process.env.MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE = '1';
  const h = await scanHarness('scan-audit', [{ id: 'm1' }], LOW);
  const { lines } = await captureWarnings(() => h.step());
  assert.equal(h.calls.model, 1);
  assert.equal((await h.marker('m1'))?.outcome, 'analyzed');
  const misses = lines.filter(line => line.includes('email_triage_audit_miss'));
  assert.equal(misses.length, 1);
  assert.deepEqual(JSON.parse(misses[0]!), { event: 'email_triage_audit_miss', scorer: 'jev', bucket: 0 });
});

test('scan, shadow: every mail is read fully and one content-free line records the bucket', async () => {
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'shadow';
  process.env.MAYBESITTER_EMAIL_TRIAGE_AUDIT_RATE = '0';
  const h = await scanHarness('scan-shadow', [{ id: 'm1' }, { id: 'm2' }], input => input.subject === 'Subject m1' ? LOW : HIGH);
  const { lines } = await captureWarnings(async () => { await h.step(); await h.step(); });
  assert.equal(h.calls.scorer, 2);
  assert.equal(h.calls.model, 2);
  assert.equal((await h.marker('m1'))?.outcome, 'analyzed');
  const shadow = lines.filter(line => line.includes('email_triage_shadow')).map(line => JSON.parse(line));
  assert.deepEqual(shadow, [
    { event: 'email_triage_shadow', scorer: 'jev', bucket: 0 },
    { event: 'email_triage_shadow', scorer: 'jev', bucket: 0.9 },
  ]);
  assert.equal('messagesSkippedTriage' in (await h.scan()), false);
});

test('scan: a triaged marker from the current rule is counted on a later scan without the scorer or the model', async () => {
  const h = await scanHarness('scan-count', [{ id: 'm1' }], LOW);
  const done: M5aMarker = { v: 2, state: 'done', providerAccountId: 'acct', processedAt: NOW, outcome: 'triaged',
    triageRule: TRIAGE_RULE, triageScore: 0.05, observationIds: [], autoAddId: null, receipts: {} };
  await h.storage.set(markerPath('scan-count', 'm1'), done);
  await h.storage.set(legacyPath('scan-count', 'm1'), done);
  // Counted only while triage is still enforced at that threshold (review P2-8).
  const previous = process.env.MAYBESITTER_EMAIL_TRIAGE_MODE;
  process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = 'enforce';
  try { await h.step(); } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_EMAIL_TRIAGE_MODE; else process.env.MAYBESITTER_EMAIL_TRIAGE_MODE = previous;
  }
  assert.equal(h.calls.scorer, 0);
  assert.equal(h.calls.model, 0);
  const scan = await h.scan();
  assert.equal(scan.messagesRead, 1);
  assert.equal(scan.messagesSkippedTriage, 1);
});

test('scan: a triaged marker from an older rule is re-claimed and read', async () => {
  const h = await scanHarness('scan-reclaim', [{ id: 'm1' }], LOW);
  const old: M5aMarker = { v: 2, state: 'done', providerAccountId: 'acct', processedAt: NOW, outcome: 'triaged',
    triageRule: TRIAGE_RULE - 1, triageScore: 0.05, observationIds: [], autoAddId: null, receipts: {} };
  await h.storage.set(markerPath('scan-reclaim', 'm1'), old);
  await h.storage.set(legacyPath('scan-reclaim', 'm1'), old);
  await h.step();
  assert.equal(h.calls.model, 1, 'the current rule (triage off here) read it fully');
  const marker = await h.marker('m1');
  assert.equal(marker?.outcome, 'analyzed');
  assert.equal((await h.scan()).observationsFound, 1);
});
