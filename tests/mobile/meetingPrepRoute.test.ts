/**
 * `POST /api/mobile/meetings/prepare` — «حضّرني» (closure lane CL5a).
 *
 * Everything runs for real except the network: the route, the auth guard, the
 * bounded body read, the daily cap, the consent read, the gated and metered
 * provider, its call log, the pipeline and the proposal store. The last hop —
 * the `@google/genai` SDK — is replaced with a recorded answer, the way the
 * fixture exporter records the Gemini capture.
 *
 * What these hold:
 *   - auth before anything, and a body bounded while it is read (#659);
 *   - the capture limit on the notes, answered the way capture answers it;
 *   - a per-account daily cap that a refused request never spends;
 *   - with consent, a recorded model answer becomes one prep step and a
 *     follow-up, confirmed through the capture confirm and visible on the
 *     lists; without consent, zero model calls and still one prep step;
 *   - the notes are in no log line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { reserveDailyAction } from '../../lib/llm/usageGuard.ts';
import { resetProviderForTests } from '../../src/extraction/llm/index.ts';
import { MAX_MEETING_PREPS_PER_DAY } from '../../lib/services/mobile/meetingPrepService.ts';
import { POST as preparePost } from '../../src/app/api/mobile/meetings/prepare/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';

const BASE = 'http://127.0.0.1:4321';
const UID = uidFor('MeetingPrepRouteUser');
const MINUTE = 60_000;
const SENTINEL = 'ZZQXPREPROUTESENTINELQZZ';
const NOTE = `اجتماع مع المدير عن ميزانية الربع الجاي. ${SENTINEL}\nبدي أراجع أرقام المصاريف وأطبع التقرير.\nبعد الاجتماع لازم أبعت الملخص لسامي.`;

// ── the recorded model ─────────────────────────────────────────────

const GENAI_STUB_URL = 'maybesitter-meeting-prep:google-genai';
const GENAI_STUB_SOURCE = `
export class GoogleGenAI {
  constructor(options) { this.options = options; }
  get models() { return { generateContent: async (input) => globalThis.__maybesitterPrepGenerate(input) }; }
}
`;
type Stub = (input: { config: Record<string, unknown>; contents: unknown }) => Promise<unknown>;
type StubGlobals = typeof globalThis & { __maybesitterPrepGenerate?: Stub };

/**
 * What Gemini answered, verbatim, in the live run of this prompt
 * (gemini-2.5-flash, europe-west1; scratchpad/sdd/reports/CL5a-live-run-round1b.txt):
 * one prep step, and a follow-up with a day and no hour, because the notes
 * said «يوم الأحد الصبح» and wrote no clock time.
 */
const LIVE_ANSWER_TEXT = '{"prepStep": {"action": "أراجع جدول المصاريف تبع آخر ٣ شهور وأطبع التقرير"}, "followUps": [{"action": "أبعت الملخص لسامي", "deadlineDate": "2026-10-04", "deadlineTime": null}]}';
const RECORDED_ANSWER = {
  text: LIVE_ANSWER_TEXT,
  modelVersion: 'gemini-2.5-flash',
  usageMetadata: { promptTokenCount: 574, candidatesTokenCount: 65 },
};
const PREP_TITLE = 'أراجع جدول المصاريف تبع آخر ٣ شهور وأطبع التقرير';

function withGemini(): { calls: Array<{ config: Record<string, unknown>; contents: unknown }>; restore: () => void } {
  const calls: Array<{ config: Record<string, unknown>; contents: unknown }> = [];
  (globalThis as StubGlobals).__maybesitterPrepGenerate = async (input) => {
    calls.push(input);
    return RECORDED_ANSWER;
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@google/genai') return { url: GENAI_STUB_URL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === GENAI_STUB_URL) return { format: 'module', source: GENAI_STUB_SOURCE, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  const previous = { provider: process.env.MAYBESITTER_LLM_PROVIDER, location: process.env.MAYBESITTER_VERTEX_LOCATION };
  process.env.MAYBESITTER_LLM_PROVIDER = 'gemini';
  process.env.MAYBESITTER_VERTEX_LOCATION = 'europe-west1';
  resetProviderForTests();
  return {
    calls,
    restore: () => {
      hooks.deregister();
      delete (globalThis as StubGlobals).__maybesitterPrepGenerate;
      if (previous.provider === undefined) delete process.env.MAYBESITTER_LLM_PROVIDER;
      else process.env.MAYBESITTER_LLM_PROVIDER = previous.provider;
      if (previous.location === undefined) delete process.env.MAYBESITTER_VERTEX_LOCATION;
      else process.env.MAYBESITTER_VERTEX_LOCATION = previous.location;
      resetProviderForTests();
    },
  };
}

// ── harness ────────────────────────────────────────────────────────

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

function block(startInMinutes = 180) {
  const now = Date.now();
  return {
    startAt: new Date(now + startInMinutes * MINUTE).toISOString(),
    endAt: new Date(now + (startInMinutes + 45) * MINUTE).toISOString(),
  };
}

function request(body: unknown, options: { uid?: string | null; raw?: string } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  const uid = options.uid === undefined ? UID : options.uid;
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${BASE}/api/mobile/meetings/prepare`, {
    method: 'POST', headers, body: options.raw ?? JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

/** Every console line written while `run` runs, as one string. */
async function logsDuring<T>(run: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const originals = { info: console.info, log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(originals) as (keyof typeof originals)[]) {
    console[level] = (...args: unknown[]) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name}:${arg.message}` : String(arg))).join(' ')); };
  }
  try {
    const result = await run();
    return { result, logs: lines.join('\n') };
  } finally {
    Object.assign(console, originals);
  }
}

// ── refusals ───────────────────────────────────────────────────────

test('an unauthenticated prep is refused before the body is read', async () => {
  begin();
  try {
    const response = await preparePost(request({ notes: NOTE, ...block() }, { uid: null }));
    assert.equal(response.status, 401);
  } finally { end(); }
});

test('a body larger than the route reads is refused while it is read', async () => {
  begin();
  try {
    const response = await preparePost(request(null, { raw: JSON.stringify({ notes: 'x'.repeat(40_000), ...block() }) }));
    assert.equal(response.status, 413);
    // The byte bound, not the character check after it: the read stopped.
    assert.equal((await json(response)).reason, 'payload_too_large');
  } finally { end(); }
});

test('bad requests say which: not JSON, not an object, no notes, no block, a block too soon', async () => {
  begin();
  try {
    assert.equal((await preparePost(request(null, { raw: '{not json' }))).status, 400);
    assert.equal((await preparePost(request(null, { raw: 'null' }))).status, 400);
    const noNotes = await preparePost(request({ notes: '  ', ...block() }));
    assert.equal(noNotes.status, 400);
    assert.equal((await json(noNotes)).reason, 'notes_required');
    const noBlock = await preparePost(request({ notes: NOTE }));
    assert.equal(noBlock.status, 400);
    assert.equal((await json(noBlock)).reason, 'invalid_block');
    const soon = await preparePost(request({ notes: NOTE, ...block(3) }));
    assert.equal(soon.status, 400);
    assert.equal((await json(soon)).reason, 'meeting_too_soon');
  } finally { end(); }
});

test('notes past the capture limit are answered as capture answers them', async () => {
  begin();
  try {
    const response = await preparePost(request({ notes: 'x'.repeat(2_001), ...block() }));
    assert.equal(response.status, 413);
    const body = await json(response);
    assert.equal(body.reason, 'text_too_long');
    assert.equal(body.maxCharacters, 2_000);
  } finally { end(); }
});

test('the daily cap answers 429 with the scope the client reads, and a refused request never spends one', async () => {
  begin();
  try {
    // A refusal first: it must not count.
    await preparePost(request({ notes: '', ...block() }));
    for (let i = 0; i < MAX_MEETING_PREPS_PER_DAY - 1; i += 1) {
      assert.equal(await reserveDailyAction(UID, 'meeting_prepare', MAX_MEETING_PREPS_PER_DAY), 'ok');
    }
    const last = await preparePost(request({ notes: NOTE, ...block() }));
    assert.equal(last.status, 200, 'the twentieth prep of the day is still allowed');
    const over = await preparePost(request({ notes: NOTE, ...block() }));
    assert.equal(over.status, 429);
    const body = await json(over);
    assert.equal(body.reason, 'meeting_prep_rate_limited');
    assert.equal(body.scope, 'user_daily');
    assert.equal(typeof body.retryAfterSeconds, 'number');
    assert.equal(over.headers.get('retry-after'), String(body.retryAfterSeconds));
  } finally { end(); }
});

// ── the chain ──────────────────────────────────────────────────────

test('with consent, the recorded Gemini answer becomes a prep step and a follow-up, confirmed onto the lists', async () => {
  begin();
  await setAiConsent(UID, { state: 'granted', version: AI_CONSENT_VERSION });
  const gemini = withGemini();
  try {
    const times = block();
    const { result: response, logs } = await logsDuring(() => preparePost(request({ notes: NOTE, ...times, timezone: 'Asia/Jerusalem' })));
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(gemini.calls.length, 1, 'the notes never reached the provider');
    assert.equal(typeof gemini.calls[0]!.config.systemInstruction, 'string', 'the rules travelled as content');
    assert.ok(!String(gemini.calls[0]!.config.systemInstruction).includes(SENTINEL), 'the notes travelled as instructions');

    assert.equal(body.success, true);
    assert.deepEqual(body.proposal.provenance, { requestedEngine: 'model', executedEngine: 'gemini', fallbackUsed: false });
    assert.equal(body.proposal.items.length, 2);
    assert.equal(body.proposal.items[0].itemId, body.prep.itemId);
    assert.equal(body.proposal.items[0].title, PREP_TITLE);
    assert.equal(body.proposal.items[1].title, 'أبعت الملخص لسامي');
    assert.equal(body.proposal.items[1].resolvedTime, null, 'a day with no written hour is not given one');
    assert.equal(Date.parse(body.prep.remindAt), Date.parse(times.startAt) - 60 * MINUTE);
    assert.equal(body.prep.dueAt, times.startAt, 'the phone rings at dueAt − 60, so dueAt is the start');
    assert.equal(body.prep.leadMinutes, 60);

    // Cost attribution rides the call's own log line: the meeting feature,
    // counted in tokens — and nothing the person wrote is in any line.
    assert.match(logs, /"purpose":"meeting_prep"/);
    assert.match(logs, /"feature":"meeting_intelligence"/);
    assert.ok(!logs.includes(SENTINEL), 'the notes reached a log line');
    assert.ok(!logs.includes('بدي أراجع'), 'the notes reached a log line');

    const confirmed = await confirmPost(new Request(`${BASE}/api/mobile/capture/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(UID)}` },
      body: JSON.stringify({ proposalId: body.proposal.proposalId, itemIds: body.proposal.items.map((item: { itemId: string }) => item.itemId) }),
    }));
    assert.equal(confirmed.status, 200);
    assert.equal((await json(confirmed)).persisted.length, 2);

    const headers = { authorization: `Bearer ${tokenFor(UID)}` };
    const today = await json(await todayGet(new Request(`${BASE}/api/mobile/commitments/today?timezone=Asia/Jerusalem`, { headers })));
    const upcoming = await json(await upcomingGet(new Request(`${BASE}/api/mobile/commitments/upcoming?timezone=Asia/Jerusalem`, { headers })));
    const titles = [...today.items, ...upcoming.items].map((item: { title: string }) => item.title);
    assert.ok(titles.includes(PREP_TITLE), `the prep step is on no list: ${JSON.stringify(titles)}`);
  } finally {
    gemini.restore();
    end();
  }
});

test('with consent off, zero model calls and still exactly one prep step from the notes', async () => {
  begin();
  const gemini = withGemini();
  try {
    const response = await preparePost(request({ notes: NOTE, ...block(), timezone: 'Asia/Jerusalem' }));
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(gemini.calls.length, 0);
    assert.deepEqual(body.proposal.provenance, { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false });
    assert.equal(body.proposal.items.length, 1);
    assert.equal(body.proposal.items[0].title, 'أراجع أرقام المصاريف وأطبع التقرير');
  } finally {
    gemini.restore();
    end();
  }
});
