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
import { PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import { GET as reminderSettingsGet } from '../../src/app/api/mobile/settings/reminders/route.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { parseRoutineProfileInput } from '../../src/contracts/v1/routineContracts.ts';
import { mock } from 'node:test';
import { phoneReminderEngine } from '../support/phoneReminderEngine.ts';

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
    assert.ok(titles.includes('أبعت الملخص لسامي'), `the follow-up is on no list: ${JSON.stringify(titles)}`);
  } finally {
    gemini.restore();
    end();
  }
});

test('AI is always on: an account that never answered gets the model prep', async () => {
  // Before 2026-09-30 this account stayed on the rules with zero model calls.
  begin();
  const gemini = withGemini();
  try {
    const response = await preparePost(request({ notes: NOTE, ...block(), timezone: 'Asia/Jerusalem' }));
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(gemini.calls.length, 1, 'an always-on account\u2019s notes never reached the model');
    assert.deepEqual(body.proposal.provenance, { requestedEngine: 'model', executedEngine: 'gemini', fallbackUsed: false });
  } finally {
    gemini.restore();
    end();
  }
});

test('with no model reachable, still exactly one prep step from the notes', async () => {
  // No provider configured: the model path falls back to the rules, which is
  // what every cap and outage does too.
  begin();
  try {
    const response = await preparePost(request({ notes: NOTE, ...block(), timezone: 'Asia/Jerusalem' }));
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.proposal.provenance, { requestedEngine: 'model', executedEngine: 'rule-based', fallbackUsed: true });
    assert.equal(body.proposal.items.length, 1);
    assert.equal(body.proposal.items[0].title, 'أراجع أرقام المصاريف وأطبع التقرير');
  } finally {
    end();
  }
});

// ── the reminder claimed is the one that rings (CL5a I-3) ──────────

/**
 * Prepare, confirm, then read back exactly what the phone reads — the
 * commitment from the lists and the reminder settings from their route — and
 * run the phone's own reminder engine on them. `prep.remindAt` must be its
 * first ring; `null` must mean it schedules nothing.
 */
async function claimedAndRung(
  startInMinutes: number,
  intensity: 'none' | 'softAwareness' | 'followUp' | 'strongReminder' = 'softAwareness',
  startAt?: string,
): Promise<{ remindAt: string | null; silentBecause: string | null; rings: number[] }> {
  const headers = { authorization: `Bearer ${tokenFor(UID)}` };
  const times = { startAt: startAt ?? new Date(Date.now() + startInMinutes * MINUTE).toISOString(), endAt: null };
  const prepared = await preparePost(request({ notes: NOTE, ...times, timezone: 'Asia/Jerusalem' }));
  assert.equal(prepared.status, 200);
  const body = await json(prepared);
  const confirmed = await confirmPost(new Request(`${BASE}/api/mobile/capture/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ proposalId: body.proposal.proposalId, itemIds: [body.prep.itemId] }),
  }));
  assert.equal(confirmed.status, 200);
  const commitmentId = (await json(confirmed)).persisted[0].commitmentId as string;
  const today = await json(await todayGet(new Request(`${BASE}/api/mobile/commitments/today?timezone=Asia/Jerusalem`, { headers })));
  const upcoming = await json(await upcomingGet(new Request(`${BASE}/api/mobile/commitments/upcoming?timezone=Asia/Jerusalem`, { headers })));
  const item = [...today.items, ...upcoming.items].find((entry: { id: string }) => entry.id === commitmentId);
  assert.ok(item, 'the confirmed prep step is on no list');
  const settings = (await json(await reminderSettingsGet(new Request(`${BASE}/api/mobile/settings/reminders`, { headers })))).reminderSettings;
  const phone = await phoneReminderEngine();
  const rings = phone.ringsFor({
    commitments: phone.toReminderCommitments([item]),
    now: new Date(),
    ...phone.fromSettingsDto(settings, intensity),
  });
  return { remindAt: body.prep.remindAt, silentBecause: body.prep.silentBecause, rings };
}

// Since R1 (FX1) the gentle stage rings the window's opening whatever the
// lead, so a meeting 20 or 40 minutes away rings too; silence is covered by
// the reminders-off, survey and quiet-hours cases.
for (const [ceiling, startInMinutes, rings] of [
  ['soft', 20, true], ['soft', 40, true], ['soft', 180, true],
  ['followUp', 20, true], ['followUp', 40, true], ['followUp', 180, true],
] as const) {
  test(`${ceiling}, a meeting ${startInMinutes} min away: prep.remindAt is what the phone rings${rings ? '' : ', and nothing is claimed when nothing rings'}`, async () => {
    begin();
    try {
      await saveReminderSettings(UID, { escalationCeiling: ceiling }, new Date().toISOString());
      const result = await claimedAndRung(startInMinutes);
      if (rings) {
        assert.ok(result.remindAt, 'no reminder claimed where one rings');
        assert.equal(new Date(result.rings[0]!).toISOString(), result.remindAt);
      } else {
        assert.equal(result.remindAt, null, `claimed ${result.remindAt}; the phone rings at ${result.rings.map((at) => new Date(at).toISOString())}`);
        assert.equal(result.silentBecause, 'too_close');
        assert.deepEqual(result.rings, []);
      }
    } finally { end(); }
  });
}

// ── what the stored profile says, read the way the phone reads it (I-5) ──

/**
 * Saves the survey the way its route does (`parseRoutineProfileInput` →
 * `saveRoutineProfile`). The route itself sits behind the memory module flag;
 * what matters here is the stored profile and the prep route's own read of it.
 */
async function saveRoutine(intensity: 'none' | 'followUp', quietHours: { start: string; end: string } | null): Promise<void> {
  await saveRoutineProfile(UID, parseRoutineProfileInput({
    timezone: 'Asia/Jerusalem', sleepWindow: null, focusWindows: [], fixedCommitmentWindows: [],
    preferredReminderIntensity: intensity, quietHours, surveySkipped: false,
  }), new Date().toISOString());
}

test('the survey said «صامتة» (stored `none`): the route claims no reminder, says it was the person\'s choice, and the phone rings nothing', async () => {
  begin();
  try {
    // The reminders switch stays on: only the stored survey answer silences them.
    await saveRoutine('none', null);
    const result = await claimedAndRung(180, 'none');
    assert.deepEqual(result.rings, []);
    assert.equal(result.remindAt, null);
    assert.equal(result.silentBecause, 'silent_choice');
  } finally { end(); }
});

test('quiet hours stored on the profile leave no moment to ring: meetings just after them and inside them both say `quiet_hours`, and the phone rings nothing', async () => {
  // 22:40 in Jerusalem, quiet 22:30–07:30: a meeting at 07:32, at 06:00 and at 00:00.
  const now = Date.parse('2026-09-27T19:40:00.000Z');
  for (const startAt of ['2026-09-28T04:32:00.000Z', '2026-09-28T03:00:00.000Z', '2026-09-27T21:00:00.000Z']) {
    begin();
    mock.timers.enable({ apis: ['Date'], now });
    try {
      await saveRoutine('followUp', { start: '22:30', end: '07:30' });
      const result = await claimedAndRung(0, 'followUp', startAt);
      assert.deepEqual(result.rings, [], startAt);
      assert.equal(result.remindAt, null, startAt);
      assert.equal(result.silentBecause, 'quiet_hours', startAt);
    } finally {
      mock.timers.reset();
      end();
    }
  }
});

// ── one time, before the meeting (post-UAT FX1, the 2026-09-27 repro) ──

/**
 * The phone shows a commitment at `timeSpec.dueAt ?? timeSpec.remindAt`
 * (`mobile/src/features/commitments/model.ts`, `toViewModel`) — on Today, the
 * Calendar and Details alike — and the conflict chip is drawn for that instant.
 */
function phoneShows(item: { timeSpec: { dueAt: string | null; remindAt: string | null } }): string | null {
  return item.timeSpec.dueAt ?? item.timeSpec.remindAt;
}

test('the UAT repro: a meeting Mon 15:00–16:00 prepared on Sunday is at 14:00 on Review, on the confirmation, on the lists and on the phone, and rings then', async () => {
  // Sunday 27 Sep 2026, 14:50 in Amman; the phone-calendar meeting is Monday 15:00–16:00.
  const previous = process.env.MAYBESITTER_FEATURE_PRIORITY;
  process.env.MAYBESITTER_FEATURE_PRIORITY = 'true';
  const sunday = Date.parse('2026-09-27T11:50:00.000Z');
  const startAt = '2026-09-28T12:00:00.000Z';
  const endAt = '2026-09-28T13:00:00.000Z';
  const fourteen = '2026-09-28T11:00:00.000Z';
  begin();
  mock.timers.enable({ apis: ['Date'], now: sunday });
  try {
    const headers = { authorization: `Bearer ${tokenFor(UID)}` };
    const prepared = await preparePost(request({ notes: NOTE, startAt, endAt, timezone: 'Asia/Amman' }));
    assert.equal(prepared.status, 200);
    const body = await json(prepared);
    const review = body.proposal.items.find((item: { itemId: string }) => item.itemId === body.prep.itemId);
    // Review, and the confirmation that repeats the item as it was confirmed.
    assert.equal(review.resolvedTime, fourteen, 'Review shows the prep step at 14:00');
    assert.equal(body.prep.remindAt, fourteen, 'the reminder claimed is 14:00');

    const confirmed = await confirmPost(new Request(`${BASE}/api/mobile/capture/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ proposalId: body.proposal.proposalId, itemIds: [body.prep.itemId] }),
    }));
    assert.equal(confirmed.status, 200);
    const commitmentId = (await json(confirmed)).persisted[0].commitmentId as string;

    const lists = async () => {
      const today = await json(await todayGet(new Request(`${BASE}/api/mobile/commitments/today?timezone=Asia/Amman`, { headers })));
      const upcoming = await json(await upcomingGet(new Request(`${BASE}/api/mobile/commitments/upcoming?timezone=Asia/Amman`, { headers })));
      const item = [...today.items, ...upcoming.items].find((entry: { id: string }) => entry.id === commitmentId);
      assert.ok(item, 'the confirmed prep step is on no list');
      return item;
    };
    const item = await lists();
    // Today, the Calendar and Details all read this one instant.
    assert.equal(phoneShows(item), fourteen, `the phone shows ${phoneShows(item)}, not the 14:00 Review promised`);
    const shown = Date.parse(phoneShows(item)!);
    assert.ok(shown < Date.parse(startAt), 'shown at or after the meeting it prepares for');
    assert.ok(!(shown >= Date.parse(startAt) && shown < Date.parse(endAt)), 'shown inside the meeting');

    // And the phone really rings at the time claimed, and at no other before the meeting.
    const settings = (await json(await reminderSettingsGet(new Request(`${BASE}/api/mobile/settings/reminders`, { headers })))).reminderSettings;
    const phone = await phoneReminderEngine();
    const rings = phone.ringsFor({ commitments: phone.toReminderCommitments([item]), now: new Date(), ...phone.fromSettingsDto(settings, 'softAwareness') });
    assert.deepEqual(rings.map((at) => new Date(at).toISOString()), [fourteen]);

    // Not «الوقت مرق» while the meeting has not started; late once it has.
    mock.timers.setTime(Date.parse('2026-09-28T11:30:00.000Z')); // Monday 14:30
    assert.ok(!((await lists()).reasonCodes ?? []).includes('overdue'), 'overdue before the meeting has started');
    mock.timers.setTime(Date.parse('2026-09-28T12:01:00.000Z')); // Monday 15:01
    assert.ok(((await lists()).reasonCodes ?? []).includes('overdue'), 'still on time after the meeting began');
  } finally {
    mock.timers.reset();
    end();
    if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_PRIORITY;
    else process.env.MAYBESITTER_FEATURE_PRIORITY = previous;
  }
});

// ── round 2: one window, [prep time shown, meeting start] (FX1 R1, R2) ──

const AMMAN_SUNDAY = Date.parse('2026-09-27T11:50:00.000Z'); // Sun 14:50 in Amman
const MEETING = { startAt: '2026-09-28T12:00:00.000Z', endAt: '2026-09-28T13:00:00.000Z' }; // Mon 15:00–16:00
const MON_1400 = '2026-09-28T11:00:00.000Z';

/** Runs `body` on the Amman Sunday clock, the priority module on, with a fresh store. */
async function onAmmanSunday(body: (headers: Record<string, string>) => Promise<void>): Promise<void> {
  const previous = process.env.MAYBESITTER_FEATURE_PRIORITY;
  process.env.MAYBESITTER_FEATURE_PRIORITY = 'true';
  begin();
  mock.timers.enable({ apis: ['Date'], now: AMMAN_SUNDAY });
  try {
    await body({ authorization: `Bearer ${tokenFor(UID)}` });
  } finally {
    mock.timers.reset();
    end();
    if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_PRIORITY;
    else process.env.MAYBESITTER_FEATURE_PRIORITY = previous;
  }
}

/** Prepare for the Monday meeting and confirm the prep step alone, with `edits` if any. */
async function prepareAndConfirm(headers: Record<string, string>, edit?: { resolvedTime: string | null }) {
  const prepared = await json(await preparePost(request({ notes: NOTE, ...MEETING, timezone: 'Asia/Amman' })));
  const itemId = prepared.prep.itemId as string;
  const response = await confirmPost(new Request(`${BASE}/api/mobile/capture/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ proposalId: prepared.proposal.proposalId, itemIds: [itemId], ...(edit ? { edits: [{ itemId, ...edit }] } : {}) }),
  }));
  const confirmed = await json(response);
  return { status: response.status, prepared, commitmentId: confirmed.persisted?.[0]?.commitmentId as string | undefined };
}

/** The commitment as the lists hand it to the phone, and what the phone rings for it. */
async function asThePhoneReadsIt(headers: Record<string, string>, id: string, intensity: 'softAwareness' | 'followUp' = 'softAwareness') {
  const today = await json(await todayGet(new Request(`${BASE}/api/mobile/commitments/today?timezone=Asia/Amman`, { headers })));
  const upcoming = await json(await upcomingGet(new Request(`${BASE}/api/mobile/commitments/upcoming?timezone=Asia/Amman`, { headers })));
  const item = [...today.items, ...upcoming.items].find((entry: { id: string }) => entry.id === id);
  assert.ok(item, 'the prep step is on no list');
  const settings = (await json(await reminderSettingsGet(new Request(`${BASE}/api/mobile/settings/reminders`, { headers })))).reminderSettings;
  const phone = await phoneReminderEngine();
  const rings = phone.ringsFor({ commitments: phone.toReminderCommitments([item]), now: new Date(), ...phone.fromSettingsDto(settings, intensity) });
  return { item, rings: rings.map((at) => new Date(at).toISOString()) };
}

/** What the phone rings for an ordinary step at `at` (no window), under the same settings. */
async function ordinaryRings(headers: Record<string, string>, at: string): Promise<string[]> {
  const settings = (await json(await reminderSettingsGet(new Request(`${BASE}/api/mobile/settings/reminders`, { headers })))).reminderSettings;
  const phone = await phoneReminderEngine();
  return phone.ringsFor({
    commitments: [{ id: 'ordinary', startsAt: at, status: 'active', priority: 'should', allDay: false, postponedUntil: null }],
    now: new Date(), ...phone.fromSettingsDto(settings, 'softAwareness'),
  }).map((ring) => new Date(ring).toISOString());
}

async function reasonCodesAt(headers: Record<string, string>, id: string, at: string): Promise<string[]> {
  mock.timers.setTime(Date.parse(at));
  const { item } = await asThePhoneReadsIt(headers, id);
  return item.reasonCodes ?? [];
}

for (const lead of [15, 30, 60] as const) {
  for (const ceiling of ['soft', 'followUp'] as const) {
    test(`R1: lead ${lead}, ceiling ${ceiling} — shown 14:00, rings 14:00, due by the 15:00 start, never «الوقت مرق» before it`, async () => {
      await onAmmanSunday(async (headers) => {
        await saveReminderSettings(UID, { softLeadMinutes: lead, escalationCeiling: ceiling }, new Date().toISOString());
        const { status, prepared, commitmentId } = await prepareAndConfirm(headers);
        assert.equal(status, 200);
        assert.equal(prepared.proposal.items[0].resolvedTime, MON_1400, 'Review');
        assert.equal(prepared.prep.remindAt, MON_1400, 'the reminder claimed');
        assert.equal(prepared.prep.dueAt, MEETING.startAt, 'the deadline is the meeting start');
        const { item, rings } = await asThePhoneReadsIt(headers, commitmentId!, ceiling === 'soft' ? 'softAwareness' : 'followUp');
        assert.equal(item.timeSpec.dueAt, MON_1400);
        assert.equal(item.timeSpec.endAt, MEETING.startAt, 'the window ends at the meeting start, whatever the lead');
        assert.equal(rings[0], MON_1400, `the phone first rings at ${rings[0]}`);
        assert.ok(rings.every((ring) => Date.parse(ring) >= Date.parse(MON_1400) && Date.parse(ring) < Date.parse(MEETING.startAt)), `a ring outside the window: ${rings}`);
        assert.ok(!(await reasonCodesAt(headers, commitmentId!, '2026-09-28T11:59:00.000Z')).includes('overdue'), 'late at 14:59');
        assert.ok((await reasonCodesAt(headers, commitmentId!, '2026-09-28T12:01:00.000Z')).includes('overdue'), 'not late at 15:01');
      });
    });
  }
}

/** R2: the literal Review edits (Amman, Sun 14:50, meeting Mon 15:00–16:00). */
const REVIEW_EDITS: Array<{ name: string; at: string | null; window: boolean }> = [
  { name: 'no time', at: null, window: false },
  { name: 'Mon 15:00, the start', at: '2026-09-28T12:00:00.000Z', window: false },
  { name: 'Mon 16:30, after the meeting', at: '2026-09-28T13:30:00.000Z', window: false },
  // Still before the meeting, so still its prep window (R2): rings Sun 20:00, late only after Mon 15:00.
  { name: 'Sun 20:00, the day before', at: '2026-09-27T17:00:00.000Z', window: true },
  { name: 'Mon 14:30, before the start', at: '2026-09-28T11:30:00.000Z', window: true },
];

for (const edit of REVIEW_EDITS) {
  test(`R2: a Review edit of the prep step to ${edit.name} saves, and reads and rings at the time chosen`, async () => {
    await onAmmanSunday(async (headers) => {
      const { status, commitmentId } = await prepareAndConfirm(headers, { resolvedTime: edit.at });
      assert.equal(status, 200, 'the confirm was refused');
      await expectChosen(headers, commitmentId!, edit);
    });
  });

  test(`R2: moving the confirmed prep step to ${edit.name} with PATCH saves, and reads and rings at the time chosen`, async () => {
    await onAmmanSunday(async (headers) => {
      const { commitmentId } = await prepareAndConfirm(headers);
      const response = await commitmentPatch(new Request(`${BASE}/api/mobile/commitments/${commitmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        // What the phone sends (`timePatch.ts`): a move is `dueDate` alone; «بلا وقت» clears both.
        body: JSON.stringify(edit.at === null ? { dueDate: null, reminderTime: null } : { dueDate: edit.at }),
      }), { params: Promise.resolve({ id: commitmentId! }) });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      await expectChosen(headers, commitmentId!, edit);
    });
  });
}

async function expectChosen(headers: Record<string, string>, id: string, edit: { at: string | null; window: boolean }): Promise<void> {
  const { item, rings } = await asThePhoneReadsIt(headers, id);
  assert.equal(item.timeSpec.dueAt, edit.at, 'read at another time than chosen');
  if (edit.at === null) {
    assert.equal(item.timeSpec.kind, 'unscheduled');
    assert.equal(item.timeSpec.endAt, null);
    assert.deepEqual(rings, []);
  } else if (edit.window) {
    // Still before the meeting: the window keeps the meeting start, the phone
    // rings at the time chosen, and it is late only once the meeting began.
    assert.equal(item.timeSpec.endAt, MEETING.startAt);
    assert.equal(rings[0], edit.at);
    assert.ok(!(await reasonCodesAt(headers, id, new Date(Date.parse(edit.at) + 30 * MINUTE).toISOString())).includes('overdue'), 'late half an hour after the time chosen');
    assert.ok(!(await reasonCodesAt(headers, id, '2026-09-28T11:59:00.000Z')).includes('overdue'), 'late at 14:59');
    assert.ok((await reasonCodesAt(headers, id, '2026-09-28T12:01:00.000Z')).includes('overdue'), 'not late at 15:01');
  } else {
    // No longer a prep window: an ordinary step at the time chosen, reminded
    // the way every other step is — nothing left pointing at Monday 14:00.
    assert.equal(item.timeSpec.endAt, null, 'a stale window end survived the edit');
    assert.deepEqual(rings, await ordinaryRings(headers, edit.at));
  }
}

// ── the evening-before window, edited (FX1 re-review N1) ──

/**
 * Quiet 22:00–07:30 and a meeting at Mon 07:32: the server itself puts the
 * prep step the evening before, at Sun 21:55 (`schedulePrepAt`). Moving it to
 * Sun 21:30, or sending 21:55 back unchanged (the sheet sends the time it
 * shows), must keep it a prep window: it rings at the time chosen and is not
 * «الوقت مرق» the night before.
 */
const EARLY_MEETING = { startAt: '2026-09-28T04:32:00.000Z', endAt: '2026-09-28T05:30:00.000Z' }; // Mon 07:32 in Amman

async function prepareEarly(headers: Record<string, string>, edit?: { resolvedTime: string }) {
  await saveRoutine('followUp', { start: '22:00', end: '07:30' });
  const prepared = await json(await preparePost(request({ notes: NOTE, ...EARLY_MEETING, timezone: 'Asia/Amman' })));
  assert.equal(prepared.proposal.items[0].resolvedTime, '2026-09-27T18:55:00.000Z', 'the evening-before prep is not Sun 21:55');
  const itemId = prepared.prep.itemId as string;
  const response = await confirmPost(new Request(`${BASE}/api/mobile/capture/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ proposalId: prepared.proposal.proposalId, itemIds: [itemId], ...(edit ? { edits: [{ itemId, ...edit }] } : {}) }),
  }));
  assert.equal(response.status, 200);
  return (await json(response)).persisted[0].commitmentId as string;
}

async function expectEveningWindow(headers: Record<string, string>, id: string, at: string): Promise<void> {
  const { item, rings } = await asThePhoneReadsIt(headers, id, 'followUp');
  assert.equal(item.timeSpec.dueAt, at);
  assert.equal(item.timeSpec.endAt, EARLY_MEETING.startAt, 'the evening-before window was dropped');
  assert.equal(rings[0], at, `the phone rings at ${rings[0]}, not at the time chosen`);
  assert.ok(!(await reasonCodesAt(headers, id, '2026-09-27T18:59:00.000Z')).includes('overdue'), 'late at Sun 21:59');
  assert.ok(!(await reasonCodesAt(headers, id, '2026-09-28T04:31:00.000Z')).includes('overdue'), 'late at Mon 07:31');
  assert.ok((await reasonCodesAt(headers, id, '2026-09-28T04:33:00.000Z')).includes('overdue'), 'not late at Mon 07:33');
}

for (const [name, at] of [['Sun 21:30', '2026-09-27T18:30:00.000Z'], ['the same Sun 21:55', '2026-09-27T18:55:00.000Z']] as const) {
  test(`N1: the evening-before prep step edited in Review to ${name} stays a window, rings then, and is not late the night before`, async () => {
    await onAmmanSunday(async (headers) => {
      const id = await prepareEarly(headers, { resolvedTime: at });
      await expectEveningWindow(headers, id, at);
    });
  });

  test(`N1: the evening-before prep step moved with PATCH to ${name} stays a window, rings then, and is not late the night before`, async () => {
    await onAmmanSunday(async (headers) => {
      const id = await prepareEarly(headers);
      const response = await commitmentPatch(new Request(`${BASE}/api/mobile/commitments/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ dueDate: at }),
      }), { params: Promise.resolve({ id }) });
      assert.equal(response.status, 200);
      await expectEveningWindow(headers, id, at);
    });
  });
}
