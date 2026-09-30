/**
 * The capture chat names a clash, and says why (owner request 2026-09-30:
 * "the agent cannot describe what the commitment is if there is a
 * collision, and he cannot explain why he suggests that to me").
 *
 * Every model answer here is scripted — no network — and every clash is
 * with something saved the way the person's own things are saved: a chat
 * proposal confirmed through the existing confirm route, a weekly block
 * created and materialized, a followed club's match projected, a synced
 * Google calendar's busy time.
 *
 * What is held:
 *   - a proposal whose time lands on a saved commitment, a weekly block or a
 *     followed match carries it on the item (`conflicts`), and the reply
 *     names it — the model's, or one short sentence added when the model's
 *     does not; the confirm still returns its own `collisions`;
 *   - the calendar's busy time has no title, and none is invented: the reply
 *     says the calendar shows the person busy, and a model sentence that
 *     names a title for it is taken out;
 *   - a reason is kept only when it is the person's words or the list's; one
 *     that brings in anything else is taken out; a clash claimed or an offer
 *     made when nothing clashes is taken out;
 *   - the assistant may offer another time only as a question: a plain "yes"
 *     applies it, anything else leaves the time as it was, and the model
 *     moving the item on its own is dropped by the invented-time guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as chatPost } from '../../src/app/api/mobile/capture/chat/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { setCaptureChatDependenciesForTests } from '../../lib/services/captureChat/captureChatService.ts';
import { safeChatReply } from '../../lib/services/captureChat/chatReply.ts';
import { groundedReply, withConflictsNamed } from '../../lib/services/captureChat/chatWhy.ts';
import { chatUserTurnsWithAcceptedOffers, isPlainYes, offerSentences } from '../../lib/services/captureBoundary/chatEvidence.ts';
import { splitPrompt } from '../../lib/llm/captureProvider.ts';
import { createWeeklyBlock } from '../../lib/weeklyBlocks/weeklyBlockService.ts';
import { busyBlockId, replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import { upsertFixtures } from '../../lib/football/fixtureStore.ts';
import { setFollowedClubs } from '../../lib/football/followedClubs.ts';
import { listActiveFixtureCommitments, projectFixturesForUser } from '../../lib/football/projectFixtures.ts';
import { instantFromLocal, localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { resolveWeekdayDate } from '../../src/extraction/weekdayLexicon.ts';
import {
  fixtureContentHash,
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  type Fixture,
  type FixtureCore,
} from '../../src/contracts/v1/fixtureContracts.ts';
import type { LLMProviderFunction } from '../../src/extraction/llm/index.ts';

const BASE = 'http://localhost:3000';
const TZ = 'Asia/Jerusalem';

/* ── the clock, read from the real one so no day here ever goes stale ── */

const FRIDAY = resolveWeekdayDate('Friday', new Date(), TZ)!.date;
const SATURDAY = resolveWeekdayDate('Saturday', new Date(), TZ)!.date;
const at = (date: string, time: string): string => instantFromLocal(date, time, TZ)!.toISOString();
const localClock = (iso: string | null): string | null => (iso ? localTimeSpecFor(new Date(iso), TZ)!.time : null);

/* ── the model's objects, in the extraction schema ─────────────────── */

function item(title: string, date: string | null, time: string | null): Record<string, unknown> {
  const instant = date && time ? at(date, time) : null;
  return {
    type: 'task',
    action: title,
    title,
    person: null,
    dueAt: instant,
    remindAt: instant,
    localTimeSpec: date ? { date, time, timezone: TZ } : null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.92, type: 0.95, action: 0.9, time: 0.9, priority: 0.7 },
    missingFields: time ? [] : ['time'],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
  };
}

function answer(reply: string, action: 'propose' | 'update' | 'ask' | 'chat', items: unknown[]): string {
  return JSON.stringify({ reply, action, items });
}

/** A scripted model: answers in order, and keeps every prompt it was sent. */
function scripted(...answers: string[]): { provider: LLMProviderFunction; prompts: string[] } {
  const prompts: string[] = [];
  const provider: LLMProviderFunction = async (prompt) => {
    prompts.push(prompt);
    return answers[Math.min(prompts.length - 1, answers.length - 1)]!;
  };
  return { provider, prompts };
}

/* ── harness ───────────────────────────────────────────────────────── */

let auth: FakeAuthControls | null = null;

function begin(provider: LLMProviderFunction): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  setCaptureChatDependenciesForTests({ llmProviderFor: () => provider });
}

function end(): void {
  setCaptureChatDependenciesForTests(null);
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function post(path: string, uid: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type Conflict = { title: string | null; startsAt: string; endsAt: string; kind: string };
type Item = { itemId: string; title: string; resolvedTime: string | null; needsClarification: boolean; conflicts?: Conflict[] };
type ChatBody = {
  conversationId: string;
  reply: string;
  engine: 'model' | 'rules';
  proposal: { proposalId: string; items: Item[] } | null;
  turns: Array<{ role: string; text: string }>;
};

async function chat(uid: string, message: string, options: { conversationId?: string; locale?: 'ar' | 'en' | 'he' } = {}): Promise<ChatBody> {
  const response = await chatPost(post('/api/mobile/capture/chat', uid, {
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    message,
    timezone: TZ,
    referenceTime: new Date().toISOString(),
    ...(options.locale ? { locale: options.locale } : {}),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, `chat answered ${response.status}: ${JSON.stringify(body)}`);
  return body as ChatBody;
}

async function confirmAll(uid: string, body: ChatBody): Promise<{ success: boolean; collisions: Array<{ title: string }> }> {
  const response = await confirmPost(post('/api/mobile/capture/confirm', uid, {
    proposalId: body.proposal!.proposalId,
    itemIds: body.proposal!.items.map((entry) => entry.itemId),
  }));
  assert.equal(response.status, 200);
  return await response.json() as { success: boolean; collisions: Array<{ title: string }> };
}

/** «عرس ابن عمي» (my cousin’s wedding) on Friday at 18:00, kept the way the person keeps anything: a chat proposal they confirmed. */
const WEDDING = 'عرس ابن عمي';
const SEED_WEDDING = answer('عرس ابن عمي الجمعة الساعة 6 المسا. أكّد من تحت.', 'propose', [item(WEDDING, FRIDAY, '18:00')]);
async function saveWedding(uid: string): Promise<void> {
  const seeded = await chat(uid, 'عندي عرس ابن عمي الجمعة الساعة 6 المسا', { locale: 'ar' });
  assert.equal(seeded.proposal!.items[0]!.resolvedTime, at(FRIDAY, '18:00'), 'the seed was not proposed at Friday 18:00');
  assert.equal((await confirmAll(uid, seeded)).success, true);
}

const DINNER = 'عشا مع أهلي';
const DINNER_MESSAGE = 'عندي عشا مع أهلي الجمعة الساعة 6 المسا';

/* ── 1. a saved commitment ─────────────────────────────────────────── */

test('a proposal on top of a saved commitment carries it, the reply names it, and the confirm still warns', async () => {
  const named = 'هاد بيتعارض مع «عرس ابن عمي» الجمعة الساعة 6. بدك نخليها الساعة 7 المسا؟';
  const model = scripted(SEED_WEDDING, answer(named, 'propose', [item(DINNER, FRIDAY, '18:00')]));
  begin(model.provider);
  try {
    const uid = uidFor('ChatClashCommitment');
    await saveWedding(uid);
    const body = await chat(uid, DINNER_MESSAGE, { locale: 'ar' });
    const [dinner] = body.proposal!.items;
    assert.equal(dinner!.resolvedTime, at(FRIDAY, '18:00'), 'the card must keep the time the person said');
    assert.deepEqual(dinner!.conflicts, [{ title: WEDDING, startsAt: at(FRIDAY, '18:00'), endsAt: at(FRIDAY, '18:30'), kind: 'commitment' }]);
    // The model named it: nothing is added, and the offer is a question.
    assert.equal(body.reply, named);

    // The model was shown the person's day as data, never as instructions.
    const { system, user } = splitPrompt(model.prompts[1]!);
    assert.ok(user.includes(`"savedSchedule":[{"title":"${WEDDING}","kind":"commitment","date":"${FRIDAY}","start":"18:00","end":"18:30"}]`), 'the saved wedding was not shown');
    assert.ok(!system.includes(WEDDING), 'a saved title leaked into the instructions');
    assert.match(system, /PROMPT VERSION: capture-chat-v5/);

    // The confirm path is unchanged: it returns its own collisions.
    const confirmed = await confirmAll(uid, body);
    assert.deepEqual(confirmed.collisions.map((collision) => collision.title), [WEDDING]);
  } finally {
    end();
  }
});

test('a reply that leaves the clash out gets one short sentence naming it, in the app language', async () => {
  const model = scripted(SEED_WEDDING, answer('تمام، عشا مع أهلك الجمعة الساعة 6 المسا لأنك قلت الجمعة الساعة 6 المسا. أكّد من تحت.', 'propose', [item(DINNER, FRIDAY, '18:00')]));
  begin(model.provider);
  try {
    const uid = uidFor('ChatClashAppended');
    await saveWedding(uid);
    const body = await chat(uid, DINNER_MESSAGE, { locale: 'ar' });
    assert.ok(body.reply.startsWith('تمام، عشا مع أهلك الجمعة الساعة 6 المسا لأنك قلت الجمعة الساعة 6 المسا.'), `the grounded reason was lost: ${body.reply}`);
    assert.match(body.reply, /بيتعارض مع «\u2068عرس ابن عمي\u2069» الجمعة الساعة \u206618:00\u2069\./);
    assert.equal(body.turns[body.turns.length - 1]!.text, body.reply, 'the stored turn is not what was shown');

    // The next message does not say it again: the person was already told.
    const next = await chat(uid, 'شكرا', { conversationId: body.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.items[0]!.conflicts?.[0]?.title, WEDDING, 'the card lost its clash line');
    assert.doesNotMatch(next.reply, /بيتعارض/, 'the clash was said twice');
  } finally {
    end();
  }
});

/* ── 2. a weekly block ─────────────────────────────────────────────── */

test('a proposal on top of a weekly block («ثابت أسبوعي») names the block and its hours', async () => {
  const model = scripted(answer('Dentist on Saturday at 11am, because you said Saturday at 11am. Confirm below.', 'propose', [item('Dentist', SATURDAY, '11:00')]));
  begin(model.provider);
  try {
    const uid = uidFor('ChatClashWeekly');
    await createWeeklyBlock(uid, { title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: TZ, confirmedAt: new Date().toISOString() });
    const body = await chat(uid, 'Dentist on Saturday at 11am', { locale: 'en' });
    const [dentist] = body.proposal!.items;
    assert.equal(dentist!.resolvedTime, at(SATURDAY, '11:00'));
    assert.deepEqual(dentist!.conflicts, [{ title: 'تدريب', startsAt: at(SATURDAY, '10:00'), endsAt: at(SATURDAY, '16:00'), kind: 'weekly' }]);
    assert.equal(body.reply, 'Dentist on Saturday at 11am, because you said Saturday at 11am. Confirm below. "Dentist" clashes with "تدريب" on Saturday 10:00–16:00.');
  } finally {
    end();
  }
});

/* ── 3. a followed match ───────────────────────────────────────────── */

function fixture(id: string, kickoffUtc: string): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

test('a proposal on top of a followed club’s match names the match', async () => {
  const model = scripted(answer('Call mom on Friday at 8:30pm. Confirm below.', 'propose', [item('Call mom', FRIDAY, '20:30')]));
  begin(model.provider);
  try {
    const uid = uidFor('ChatClashFixture');
    const now = new Date().toISOString();
    await setFollowedClubs(uid, ['barcelona'], now);
    await upsertFixtures([fixture('1', at(FRIDAY, '20:00'))]);
    await projectFixturesForUser(uid, now);
    const [match] = await listActiveFixtureCommitments(uid);
    assert.ok(match, 'the match was not projected');

    const body = await chat(uid, 'Call mom on Friday at 8:30pm', { locale: 'en' });
    const [call] = body.proposal!.items;
    assert.equal(call!.conflicts?.length, 1);
    assert.equal(call!.conflicts![0]!.kind, 'fixture');
    assert.equal(call!.conflicts![0]!.startsAt, at(FRIDAY, '20:00'));
    const title = call!.conflicts![0]!.title!;
    assert.ok(title.length > 0);
    assert.ok(body.reply.endsWith(`"Call mom" clashes with "${title}" on Friday at 20:00.`), body.reply);
  } finally {
    end();
  }
});

/* ── 4. the calendar's busy time: no title, and none invented ──────── */

async function busyOnFriday(uid: string): Promise<void> {
  const sourceId = 'google:primary';
  await replaceBusyBlocks(uid, sourceId, { startsAt: at(FRIDAY, '00:00'), endsAt: at(FRIDAY, '23:59') }, [{
    blockId: busyBlockId(sourceId, 'evt-1', at(FRIDAY, '17:30')),
    sourceId,
    sourceKind: 'google',
    startAt: at(FRIDAY, '17:30'),
    endAt: at(FRIDAY, '19:00'),
    allDay: false,
  }]);
}

test('busy time from the calendar is said as busy, with no title — and a model title for it is taken out', async () => {
  const model = scripted(answer('Dentist on Friday at 6pm. That clashes with "Gym session" on Friday. Confirm below.', 'propose', [item('Dentist', FRIDAY, '18:00')]));
  begin(model.provider);
  try {
    const uid = uidFor('ChatClashBusy');
    await busyOnFriday(uid);
    const body = await chat(uid, 'Dentist on Friday at 6pm', { locale: 'en' });
    const [dentist] = body.proposal!.items;
    assert.deepEqual(dentist!.conflicts, [{ title: null, startsAt: at(FRIDAY, '17:30'), endsAt: at(FRIDAY, '19:00'), kind: 'calendar_busy' }]);
    assert.doesNotMatch(body.reply, /Gym/, 'a title the calendar never gave reached the person');
    assert.equal(body.reply, 'Dentist on Friday at 6pm. Confirm below. Your calendar shows you busy on Friday 17:30–19:00, the same time as "Dentist".');

    // The model was shown the busy time without a title.
    const { user } = splitPrompt(model.prompts[0]!);
    assert.ok(user.includes(`{"title":null,"kind":"calendar_busy","date":"${FRIDAY}","start":"17:30","end":"19:00"}`), 'the busy time was not shown, or was shown with a title');
  } finally {
    end();
  }
});

test('the phone’s own calendar is the phone’s: a device busy block is not a server clash', async () => {
  const model = scripted(answer('Dentist on Friday at 6pm. Confirm below.', 'propose', [item('Dentist', FRIDAY, '18:00')]));
  begin(model.provider);
  try {
    const uid = uidFor('ChatClashDevice');
    const sourceId = 'device:6f1d1a2e-2c5f-4a7b-9f0e-3b2d4c5e6f70';
    await replaceBusyBlocks(uid, sourceId, { startsAt: at(FRIDAY, '00:00'), endsAt: at(FRIDAY, '23:59') }, [{
      blockId: busyBlockId(sourceId, 'evt-1', at(FRIDAY, '17:30')), sourceId, sourceKind: 'device',
      startAt: at(FRIDAY, '17:30'), endAt: at(FRIDAY, '19:00'), allDay: false,
    }]);
    const body = await chat(uid, 'Dentist on Friday at 6pm', { locale: 'en' });
    assert.equal(body.proposal!.items[0]!.conflicts, undefined);
    assert.equal(body.reply, 'Dentist on Friday at 6pm. Confirm below.');
  } finally {
    end();
  }
});

/* ── 5. why: only the person's words, or the list ──────────────────── */

test('a reason that is not the person’s words is taken out; one that is stays', async () => {
  const model = scripted(answer(
    'Dentist on Friday at 6pm, because you said Friday at 6pm. It is also better for your energy because evenings are calmer. Confirm below.',
    'propose',
    [item('Dentist', FRIDAY, '18:00')],
  ));
  begin(model.provider);
  try {
    const body = await chat(uidFor('ChatWhyUngrounded'), 'Dentist on Friday at 6pm', { locale: 'en' });
    assert.equal(body.reply, 'Dentist on Friday at 6pm, because you said Friday at 6pm. Confirm below.');
  } finally {
    end();
  }
});

test('reasons, checked: the day, the hour, the part of the day, a clash and an edit pass; anything else does not', () => {
  const grounds = (userTurns: string[], conflicts: Array<{ title: string | null; startsAt: string; endsAt: string; kind: 'commitment' | 'weekly' | 'fixture' | 'calendar_busy' }> = []) => ({
    userTurns,
    items: [{ title: 'اجتماع مع سارة', resolvedDate: FRIDAY, conflicts }],
    now: new Date(),
    timezone: TZ,
  });
  const morning = grounds(['عندي اجتماع مع سارة الجمعة الصبح']);
  // Grounded, kept whole.
  for (const reply of [
    'اجتماع مع سارة الجمعة الساعة 9 لأنك حكيت الصبح.',
    'الجمعة لأنك قلت يوم الجمعة.',
    'Friday at 9, because you said morning.',
  ]) assert.equal(groundedReply(reply, morning), reply, reply);
  // Not the person's words: taken out.
  for (const reply of [
    'الساعة 9 لأنه أحسن لطاقتك.',
    'الساعة 9 عشان الصبح بتكون مركّز أكتر.',
    'At 9, because mornings are better for focus.',
    'الساعة 10 لأنك حكيت الساعة 10.',
    'السبت لأنك قلت يوم السبت.',
  ]) assert.equal(groundedReply(reply, morning), '', reply);
  // A clash is a reason when there is one.
  const clashing = grounds(['عندي اجتماع مع سارة الجمعة الساعة 6 المسا'], [{ title: 'عرس ابن عمي', startsAt: at(FRIDAY, '18:00'), endsAt: at(FRIDAY, '18:30'), kind: 'commitment' }]);
  assert.equal(groundedReply('بدك نخليها الساعة 7؟ لأنها بتتعارض مع «عرس ابن عمي».', clashing), 'بدك نخليها الساعة 7؟ لأنها بتتعارض مع «عرس ابن عمي».');
  // The person's edit, from their accepted offer.
  const accepted = grounds(chatUserTurnsWithAcceptedOffers([
    { role: 'user', text: 'عندي اجتماع مع سارة الجمعة الساعة 6 المسا' },
    { role: 'assistant', text: 'هاد بيتعارض مع «عرس ابن عمي». بدك نخليها الساعة 7 المسا؟' },
    { role: 'user', text: 'اه' },
  ]), clashing.items[0]!.conflicts);
  assert.equal(groundedReply('تمام، الساعة 7 المسا لأنك وافقت.', accepted), 'تمام، الساعة 7 المسا لأنك وافقت.');
});

test('a clash, or an offer of another time, when nothing clashes is taken out', () => {
  const grounds = { userTurns: ['Dentist on Friday at 6pm'], items: [{ title: 'Dentist', resolvedDate: FRIDAY }], now: new Date(), timezone: TZ };
  assert.equal(groundedReply('Dentist on Friday at 6pm. That clashes with your meeting. Confirm below.', grounds), 'Dentist on Friday at 6pm. Confirm below.');
  assert.equal(groundedReply('Dentist on Friday at 6pm. Want me to make it 7pm instead?', grounds), 'Dentist on Friday at 6pm.');
  assert.equal(groundedReply('الموعد الجمعة الساعة 6. هاد بيتعارض مع موعد تاني.', { ...grounds, userTurns: ['موعد الجمعة الساعة 6'] }), 'الموعد الجمعة الساعة 6.');
  // The whole reply gone: the template answers instead.
  const safe = safeChatReply('That clashes with your gym session.', {
    language: 'en',
    proposal: { items: [{ title: 'Dentist', needsClarification: false, resolvedTime: at(FRIDAY, '18:00') }] },
    timezone: TZ,
    grounds,
  });
  assert.equal(safe.replaced, true);
  assert.doesNotMatch(safe.reply, /gym/i);
});

test('a clash sentence is added before the reply’s closing question, and not when the reply names it', () => {
  const conflict = { title: 'عرس ابن عمي', startsAt: at(FRIDAY, '18:00'), endsAt: at(FRIDAY, '18:30'), kind: 'commitment' as const };
  const items = [{ title: 'عشا مع أهلي', conflicts: [conflict] }];
  const context = { language: 'ar' as const, now: new Date(), timezone: TZ };
  const asked = withConflictsNamed('تمام. أي ساعة بدك «شي تاني»؟', items, context);
  assert.match(asked, /^تمام\. «\u2068عشا مع أهلي\u2069» بيتعارض مع «\u2068عرس ابن عمي\u2069» .+\. أي ساعة بدك «شي تاني»؟$/);
  assert.equal(withConflictsNamed('بيتعارض مع عرس ابن عمك.', items, context), 'بيتعارض مع عرس ابن عمك.');
  // Hebrew and English read the same clash in their own words.
  assert.match(withConflictsNamed('בסדר.', items, { ...context, language: 'he' }), /מתנגש עם "\u2068عرس ابن عمي\u2069"/);
  assert.match(withConflictsNamed('Okay.', items, { ...context, language: 'en' }), /^Okay\. "عشا مع أهلي" clashes with "عرس ابن عمي" .+ at 18:00\.$/);
});

/* ── 6. another time: offered as a question, applied only on a yes ── */

const OFFER = 'هاد بيتعارض مع «عرس ابن عمي» الجمعة الساعة 6. بدك نخليها الساعة 7 المسا؟';

test('offer, then "yes": the item moves to the offered hour', async () => {
  const model = scripted(
    SEED_WEDDING,
    answer(OFFER, 'propose', [item(DINNER, FRIDAY, '18:00')]),
    answer('تمام، الجمعة الساعة 7 المسا لأنك وافقت. أكّد من تحت.', 'update', [item(DINNER, FRIDAY, '19:00')]),
  );
  begin(model.provider);
  try {
    const uid = uidFor('ChatOfferYes');
    await saveWedding(uid);
    const first = await chat(uid, DINNER_MESSAGE, { locale: 'ar' });
    assert.equal(localClock(first.proposal!.items[0]!.resolvedTime), '18:00');
    const second = await chat(uid, 'اه', { conversationId: first.conversationId, locale: 'ar' });
    const [dinner] = second.proposal!.items;
    assert.equal(dinner!.resolvedTime, at(FRIDAY, '19:00'), 'the hour the person accepted was not applied');
    assert.equal(dinner!.needsClarification, false);
    assert.equal(dinner!.conflicts, undefined, 'moved clear of the wedding, it clashes with nothing');
    assert.equal(second.reply, 'تمام، الجمعة الساعة 7 المسا لأنك وافقت. أكّد من تحت.');

    // A later message keeps the accepted hour: it stays the person's.
    const third = await chat(uid, 'شكرا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(third.proposal!.items[0]!.resolvedTime, at(FRIDAY, '19:00'));
  } finally {
    end();
  }
});

test('offer, then anything but a yes: the time stays the one the person said', async () => {
  const model = scripted(
    SEED_WEDDING,
    answer(OFFER, 'propose', [item(DINNER, FRIDAY, '18:00')]),
    answer('تمام، خليناها الساعة 6 المسا متل ما قلت. أكّد من تحت.', 'chat', [item(DINNER, FRIDAY, '18:00')]),
  );
  begin(model.provider);
  try {
    const uid = uidFor('ChatOfferNo');
    await saveWedding(uid);
    const first = await chat(uid, DINNER_MESSAGE, { locale: 'ar' });
    const second = await chat(uid, 'لا، عادي', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(second.proposal!.items[0]!.resolvedTime, at(FRIDAY, '18:00'));
    assert.equal(second.proposal!.items[0]!.conflicts?.[0]?.title, WEDDING, 'the card lost its clash line');
  } finally {
    end();
  }
});

test('the model moving the item on its own, with no yes, is dropped by the invented-time guard', async () => {
  const model = scripted(
    SEED_WEDDING,
    answer(OFFER, 'propose', [item(DINNER, FRIDAY, '18:00')]),
    answer('تمام، الساعة 7 المسا. أكّد من تحت.', 'update', [item(DINNER, FRIDAY, '19:00')]),
    answer('تمام، السبت الساعة 6 المسا. أكّد من تحت.', 'update', [item(DINNER, SATURDAY, '18:00')]),
  );
  begin(model.provider);
  try {
    const uid = uidFor('ChatOfferIgnored');
    await saveWedding(uid);
    const first = await chat(uid, DINNER_MESSAGE, { locale: 'ar' });
    // Not a yes: the offered 19:00 is the assistant's, and the card keeps 18:00.
    const second = await chat(uid, 'مش متأكد', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(second.proposal!.items[0]!.resolvedTime, at(FRIDAY, '18:00'), 'an hour the assistant offered was applied without a yes');
    // Nor a day nobody said: the model moving it to Saturday is the case only
    // the chat's own guard (`withoutUnsaidTime`) catches — the validator
    // keeps a weekday the words do not name.
    const third = await chat(uid, 'مش متأكد', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(third.proposal!.items[0]!.resolvedTime, at(FRIDAY, '18:00'), 'a day the model picked on its own was applied');
  } finally {
    end();
  }
});

test('the model moving the item off the clash at proposal time is dropped too', async () => {
  const model = scripted(SEED_WEDDING, answer('خليتها الساعة 7 المسا عشان العرس. أكّد من تحت.', 'propose', [item(DINNER, FRIDAY, '19:00')]));
  begin(model.provider);
  try {
    const uid = uidFor('ChatClashMovedByModel');
    await saveWedding(uid);
    const body = await chat(uid, DINNER_MESSAGE, { locale: 'ar' });
    assert.notEqual(localClock(body.proposal!.items[0]!.resolvedTime), '19:00', 'the model moved the item on its own');
  } finally {
    end();
  }
});

test('what counts as a plain yes, and as an offer', () => {
  for (const yes of ['اه', 'آه', 'أيوه', 'اه خليها', 'ماشي', 'yes please', 'Sure', 'ok sounds good', 'כן', 'סבבה תודה']) assert.equal(isPlainYes(yes), true, yes);
  for (const not of ['لا', 'اه بس خليها الساعة 8', 'yes but at 8pm', 'no', 'مش متأكد', 'thanks', '', 'לא']) assert.equal(isPlainYes(not), false, not);
  assert.deepEqual(offerSentences('هاد بيتعارض. بدك نخليها الساعة 7 المسا؟'), ['بدك نخليها الساعة 7 المسا؟']);
  assert.deepEqual(offerSentences('It clashes. Want me to make it 7pm?'), ['Want me to make it 7pm?']);
  assert.deepEqual(offerSentences('أي ساعة بدك؟'), [], 'a question for the hour offers none');
  // A yes to a reply with no offer carries nothing; a yes after an offer carries exactly it.
  assert.deepEqual(chatUserTurnsWithAcceptedOffers([
    { role: 'user', text: 'dinner Friday 6pm' }, { role: 'assistant', text: 'Confirm below.' }, { role: 'user', text: 'yes' },
  ]), ['dinner Friday 6pm', 'yes']);
  assert.deepEqual(chatUserTurnsWithAcceptedOffers([
    { role: 'user', text: 'dinner Friday 6pm' }, { role: 'assistant', text: 'It clashes. Want me to make it 7pm?' }, { role: 'user', text: 'yes' },
  ]), ['dinner Friday 6pm', 'yes\nWant me to make it 7pm?']);
});
