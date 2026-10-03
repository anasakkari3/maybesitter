/**
 * «احكيها», the production black-box audit of 2026-10-03, issues #1 and #6.
 *
 * The literal conversation: "I want to learn React and study on Tuesday and
 * Thursday evenings at 7 PM", then "Every Tuesday and Thursday at 7 PM". On
 * production the bot asked for the time again after the first message, then
 * proposed «تتعلم React» and two «تدرس», all on Tuesday at 19:00; it let them
 * be saved, and six clash warnings followed. The goal "Learn React" the
 * person already had stayed at «0 من 0».
 *
 * The model's answers vary, so the guarantees are deterministic, after it,
 * and are held here by replaying answers shaped like the ones production got
 * (no model is called): the goal and its sessions given no hour, or all at
 * one hour; the Thursday session on Thursday or on Tuesday; one item or two
 * for the sessions; duplicates. Whatever the model answered:
 *
 *   - an hour and days the person said are never asked again;
 *   - "every Tuesday and Thursday" is one session on the coming Tuesday and
 *     one on the coming Thursday — never two on one day;
 *   - "learn React" is not a timed item at a session's hour: it is offered
 *     as a «possible goal», or — when the person has that goal — the sessions
 *     offer to count toward it, and only the ones kept at confirm do;
 *   - two items at the same time are one when they are the same thing, and
 *     each names the other on its card when they are not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as chatPost } from '../../src/app/api/mobile/capture/chat/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { setCaptureChatDependenciesForTests } from '../../lib/services/captureChat/captureChatService.ts';
import { createManualMemory } from '../../lib/services/mobile/memoryService.ts';
import { deriveGoalGraphProgress } from '../../lib/goalGraph/deriveProgress.ts';
import { instantFromLocal, localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { readListedWeekdays, readRecurrence, resolveWeekdayDate, resolveWeekdayDates } from '../../src/extraction/weekdayLexicon.ts';
import type { LLMProviderFunction } from '../../src/extraction/llm/index.ts';
import { extractWithFallback } from '../../src/extraction/extractionService.ts';
import { chatTimeAllowance } from '../../lib/services/captureBoundary/chatEvidence.ts';
import { MemoryCaptureProposalStore, proposeCapture, TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { deleteMemory } from '../../lib/services/mobile/memoryService.ts';
import { duplicateItemIds, isGoalTitle, matchingGoal, occurrenceDatesFor } from '../../lib/services/captureBoundary/proposalShape.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';

const BASE = 'http://localhost:3000';
const TZ = 'Asia/Jerusalem';
const weekday = (name: string): string => resolveWeekdayDate(name, new Date(), TZ)!.date;
const TUESDAY = weekday('Tuesday');
const THURSDAY = weekday('Thursday');
const FRIDAY = weekday('Friday');
const at = (date: string, time: string): string => instantFromLocal(date, time, TZ)!.toISOString();

/** One model item in the extraction schema, as Gemini answers it with the app in Arabic. */
function item(title: string, appTitle: string, date: string | null, time: string | null): Record<string, unknown> {
  const instant = date && time ? at(date, time) : null;
  return {
    type: 'task', action: title, title, appTitle, person: null,
    dueAt: instant, remindAt: null,
    localTimeSpec: date ? { date, time, timezone: TZ } : null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.8, type: 1, action: 1, time: instant ? 1 : 0, priority: 1 },
    missingFields: instant ? [] : ['time'], ambiguityFlags: [],
    explicitReminderRequest: false, explicitPressureRequest: false,
  };
}

type Conflict = { title: string | null; startsAt: string; kind: string; inProposal?: boolean };
type Item = {
  itemId: string; title: string; resolvedTime: string | null; resolvedDate?: string; needsClarification: boolean;
  conflicts?: Conflict[]; goalLink?: { goalId: string; title: string }; weeklyBlock?: unknown;
};
type Body = {
  conversationId: string; reply: string; engine: string;
  proposal: { proposalId: string; items: Item[]; seeds: Array<{ kind: string; summary: string }> } | null;
};

let auth: FakeAuthControls | null = null;
function begin(answers: readonly unknown[]): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  let calls = 0;
  const provider: LLMProviderFunction = async () => JSON.stringify(answers[Math.min(calls++, answers.length - 1)]);
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
async function conversation(uid: string, messages: readonly string[]): Promise<Body[]> {
  const bodies: Body[] = [];
  for (const message of messages) {
    const response = await chatPost(post('/api/mobile/capture/chat', uid, {
      ...(bodies.length ? { conversationId: bodies[bodies.length - 1]!.conversationId } : {}),
      message, timezone: TZ, referenceTime: new Date().toISOString(), locale: 'ar',
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as Body;
    assert.equal(body.engine, 'model', `the replay did not reach the boundary: ${body.reply}`);
    bodies.push(body);
  }
  return bodies;
}

const FIRST = 'I want to learn React and study on Tuesday and Thursday evenings at 7 PM';
const SECOND = 'Every Tuesday and Thursday at 7 PM';
const FIRST_REPLY = 'تمام، بدك تتعلم React وتدرس يوم الثلاثاء والخميس الساعة 7 المسا. أكّد من تحت.';
const SECOND_REPLY = 'تمام، هلأ صار عندك «تتعلم React» يوم الثلاثاء الساعة 7 المسا، و«تدرس» كل ثلاثاء وخميس الساعة 7 المسا. أكّد من تحت.';

/** The second answer, as production's review showed it: the Thursday session moved onto Tuesday. */
const SECOND_AS_PRODUCTION = { reply: SECOND_REPLY, action: 'update', items: [
  item('Learn React', 'تتعلم React', TUESDAY, '19:00'),
  item('Study every Tuesday', 'تدرس', TUESDAY, '19:00'),
  item('Study every Thursday', 'تدرس', TUESDAY, '19:00'),
] };

const FIRST_ANSWERS = {
  // The goal and the sessions with no hour: production asked «إيمتى بدك «تدرس»؟».
  'nothing timed': { reply: FIRST_REPLY, action: 'propose', items: [item('Learn React', 'تتعلم React', null, null), item('Study', 'تدرس', null, null)] },
  // Everything on Tuesday at 19:00, the Thursday session included.
  'all on Tuesday': { reply: FIRST_REPLY, action: 'propose', items: [
    item('Learn React', 'تتعلم React', TUESDAY, '19:00'), item('Study on Tuesday', 'تدرس', TUESDAY, '19:00'), item('Study on Tuesday', 'تدرس', TUESDAY, '19:00'),
  ] },
  // Right days, the goal at the session's hour.
  'Tuesday and Thursday': { reply: FIRST_REPLY, action: 'propose', items: [
    item('Learn React', 'تتعلم React', TUESDAY, '19:00'), item('Study on Tuesday', 'تدرس', TUESDAY, '19:00'), item('Study on Thursday', 'تدرس', THURSDAY, '19:00'),
  ] },
} as const;

/** Two sessions, the coming Tuesday and the coming Thursday at 19:00, nothing asked, and no goal among the timed items. */
function twoSessions(body: Body, label: string): Item[] {
  const items = body.proposal!.items;
  assert.equal(items.length, 2, `${label}: ${JSON.stringify(items.map((entry) => [entry.title, entry.resolvedTime]))}`);
  assert.deepEqual(items.map((entry) => entry.resolvedTime).sort(), [at(TUESDAY, '19:00'), at(THURSDAY, '19:00')].sort(), label);
  for (const entry of items) {
    assert.equal(entry.needsClarification, false, `${label}: asked again: ${JSON.stringify(entry)}`);
    assert.doesNotMatch(entry.title, /React|تعلم/, `${label}: the goal is a timed item: ${entry.title}`);
  }
  assert.equal(new Set(items.map((entry) => entry.resolvedTime)).size, items.length, `${label}: two items at one time`);
  return items;
}

/* ── 1. the literal conversation, whatever the model answered ─────── */

for (const [label, firstAnswer] of Object.entries(FIRST_ANSWERS)) {
  test(`audit #1 «${FIRST}» → «${SECOND}»: Tuesday and Thursday 19:00, never asked again, the goal off the timed list (${label})`, async () => {
    begin([firstAnswer, SECOND_AS_PRODUCTION]);
    try {
      const [first, second] = await conversation(uidFor(`AuditReact${label.length}`), [FIRST, SECOND]);
      // The first message said the days and the hour: nothing is asked.
      assert.doesNotMatch(first!.reply, /[?؟]/, `the bot asked again: ${first!.reply}`);
      twoSessions(first!, 'first message');
      twoSessions(second!, 'second message');
      // The goal is offered on its own, as «يمكن هدف», and the reply says so.
      assert.deepEqual(second!.proposal!.seeds.map((seed) => [seed.kind, seed.summary]), [['possible_goal', 'تتعلم React']]);
      assert.match(first!.reply, /«تتعلم React»/);
      // The reply never describes a card that is not there.
      assert.doesNotMatch(second!.reply, /تتعلم React/, second!.reply);
      // Nothing on the list clashes with anything else on it.
      for (const entry of second!.proposal!.items) assert.equal(entry.conflicts, undefined, JSON.stringify(entry.conflicts));
    } finally {
      end();
    }
  });
}

test('audit #1: the two sessions confirm as two commitments on two days, with no clash warning between them', async () => {
  begin([FIRST_ANSWERS['nothing timed'], SECOND_AS_PRODUCTION]);
  try {
    const uid = uidFor('AuditReactConfirm');
    const [, second] = await conversation(uid, [FIRST, SECOND]);
    const items = twoSessions(second!, 'before confirm');
    const response = await confirmPost(post('/api/mobile/capture/confirm', uid, {
      proposalId: second!.proposal!.proposalId, itemIds: items.map((entry) => entry.itemId),
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as { persisted: Array<{ resolvedTime: string | null }>; collisions: unknown[]; goalLinks: unknown[] };
    assert.deepEqual(result.persisted.map((entry) => entry.resolvedTime).sort(), [at(TUESDAY, '19:00'), at(THURSDAY, '19:00')].sort());
    assert.deepEqual(result.collisions, []);
    assert.deepEqual(result.goalLinks, []);
  } finally {
    end();
  }
});

/* ── 2. the rules under it ─────────────────────────────────────────── */

test('a list of days is every day in it: "every Tuesday and Thursday", «كل ثلاثاء وخميس», «כל יום שלישי וחמישי»', () => {
  assert.deepEqual(readRecurrence('Every Tuesday and Thursday at 7 PM')?.weekdays, [2, 4]);
  assert.deepEqual(readRecurrence('every tuesday, thursday and saturday')?.weekdays, [2, 4, 6]);
  assert.deepEqual(readRecurrence('كل ثلاثاء وخميس الساعة 7 المسا')?.weekdays, [2, 4]);
  assert.deepEqual(readRecurrence('كل يوم ثلاثاء وخميس')?.weekdays, [2, 4]);
  assert.deepEqual(readRecurrence('כל יום שלישי וחמישי ב-19:00')?.weekdays, [2, 4]);
  assert.deepEqual(readRecurrence('every Saturday from 10 to 4')?.weekdays, [6]);
  assert.deepEqual(readListedWeekdays('study on Tuesday and Thursday evenings'), [2, 4]);
  assert.deepEqual(readListedWeekdays('بدي أدرس الثلاثاء والخميس'), [2, 4]);
  // Two days said apart are not a list.
  assert.deepEqual(readListedWeekdays('كان عندي موعد يوم الأحد بس صار يوم الاثنين الساعة 10'), []);
  assert.deepEqual(readListedWeekdays('dentist on Friday at 4pm and a meeting with Sara on Sunday morning'), []);
  assert.deepEqual(resolveWeekdayDates('on Tuesday and Thursday', new Date(), TZ).sort(), [TUESDAY, THURSDAY].sort());
});

test('every day of a list is a day the person said: the Thursday item is not moved onto Tuesday', async () => {
  // The chat's guard: a day nobody said is taken off, and with one day said
  // the item was moved onto it — Tuesday, the first of "Tuesday and Thursday".
  const allowance = chatTimeAllowance([FIRST], new Date(), TZ);
  assert.deepEqual(Array.from(allowance.namedDates).sort(), [TUESDAY, THURSDAY].sort());
  // The recurrence rule: an item already on one of its days stays there.
  const thursday = item('Study every Thursday', 'تدرس', THURSDAY, '19:00');
  const read = await extractWithFallback(SECOND, { now: new Date(), timezone: TZ, categories: [] } as never, {
    llmProvider: async () => JSON.stringify(thursday),
  } as never);
  assert.equal(read.result.localTimeSpec?.date, THURSDAY, JSON.stringify(read.result.localTimeSpec));
  assert.deepEqual(read.result.recurrenceHint?.weekdays, [2, 4]);
});

test('two days that span, or are a choice, are one item — "between Tuesday and Thursday", "Tuesday or Thursday"', async () => {
  for (const [message, title] of [
    ['finish the report between Tuesday and Thursday at 5pm', 'Finish the report'],
    ['call the plumber Tuesday or Thursday at 5pm', 'Call the plumber'],
  ] as const) {
    begin([{ reply: 'Got it. Confirm below.', action: 'propose', items: [{ ...item(title, title, TUESDAY, '17:00'), appTitle: undefined }] }]);
    try {
      const [body] = await conversation(uidFor(`Span${message.length}`), [message]);
      assert.equal(body!.proposal!.items.length, 1, `${message}: ${JSON.stringify(body!.proposal!.items)}`);
    } finally {
      end();
    }
  }
});

test('the same thing twice at the same time is one item, whatever the model returned', async () => {
  begin([{ reply: 'تمام، «تدرس» يوم الجمعة الساعة 7 المسا. أكّد من تحت.', action: 'propose', items: [
    item('Study', 'تدرس', FRIDAY, '19:00'), item('Study', 'تدرس', FRIDAY, '19:00'), item('study', 'تدرس ', FRIDAY, '19:00'),
  ] }]);
  try {
    const [body] = await conversation(uidFor('Duplicates'), ['study on Friday at 7 PM']);
    assert.equal(body!.proposal!.items.length, 1, JSON.stringify(body!.proposal!.items));
    assert.equal(body!.proposal!.items[0]!.resolvedTime, at(FRIDAY, '19:00'));
  } finally {
    end();
  }
});

test('two different things at one time each name the other on the card, before anything is saved, and the reply says so', async () => {
  begin([{ reply: 'تمام، الدكتور الجمعة الساعة 4 المسا ومكالمة سارة الساعة 4:15. أكّد من تحت.', action: 'propose', items: [
    item('Dentist appointment', 'موعد الدكتور', FRIDAY, '16:00'), item('Call with Sara', 'مكالمة مع سارة', FRIDAY, '16:15'),
  ] }]);
  try {
    const [body] = await conversation(uidFor('InProposalClash'), ['dentist appointment on Friday at 4pm and a call with Sara on Friday at 4:15pm']);
    const [dentist, sara] = body!.proposal!.items;
    assert.ok(dentist && sara, JSON.stringify(body!.proposal));
    assert.deepEqual(dentist.conflicts?.map((conflict) => [conflict.title, conflict.inProposal]), [['مكالمة مع سارة', true]]);
    assert.deepEqual(sara.conflicts?.map((conflict) => [conflict.title, conflict.inProposal]), [['موعد الدكتور', true]]);
    assert.match(body!.reply, /بيتعارض/, body!.reply);
  } finally {
    end();
  }
});

/* ── 3. audit #6: the goal the person already has ──────────────────── */

test('audit #6: with the goal "Learn React" active, the sessions offer to count toward it, and only kept links are made', async () => {
  begin([FIRST_ANSWERS['all on Tuesday'], SECOND_AS_PRODUCTION]);
  try {
    const uid = uidFor('AuditGoalLink');
    const goal = await createManualMemory(uid, { kind: 'goal', content: 'Learn React', language: 'en' }, new Date().toISOString());
    const [first, second] = await conversation(uid, [FIRST, SECOND]);
    const items = twoSessions(second!, 'with the goal');
    for (const entry of items) assert.deepEqual(entry.goalLink, { goalId: goal.id, title: 'Learn React' }, JSON.stringify(entry));
    // The goal exists: it is not offered again as a possible goal.
    assert.deepEqual(second!.proposal!.seeds, []);
    // Said once, when it is first offered.
    assert.match(first!.reply, /Learn React/, first!.reply);

    // Kept on one card, removed on the other.
    const [kept, removed] = items as [Item, Item];
    const response = await confirmPost(post('/api/mobile/capture/confirm', uid, {
      proposalId: second!.proposal!.proposalId, itemIds: [kept.itemId, removed.itemId], goalLinkItemIds: [kept.itemId],
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as { persisted: Array<{ itemId: string; commitmentId: string }>; goalLinks: Array<{ itemId: string; goalId: string; commitmentId: string }> };
    const keptCommitment = result.persisted.find((entry) => entry.itemId === kept.itemId)!.commitmentId;
    assert.deepEqual(result.goalLinks, [{ itemId: kept.itemId, goalId: goal.id, commitmentId: keptCommitment }]);

    // The goal's own progress counts it: «اكتمل 0 من 1».
    const progress = await deriveGoalGraphProgress({ scopeId: uid, goalMemoryId: goal.id, derivedAt: new Date().toISOString() });
    assert.equal(progress.confirmedCount, 1);
    assert.deepEqual(progress.nodes.map((node) => node.entityId), [keptCommitment]);
  } finally {
    end();
  }
});

test('audit #6: a confirm that keeps no link links nothing, and a goal id in the request is never read', async () => {
  begin([FIRST_ANSWERS['Tuesday and Thursday']]);
  try {
    const uid = uidFor('AuditGoalNoLink');
    const goal = await createManualMemory(uid, { kind: 'goal', content: 'Learn React', language: 'en' }, new Date().toISOString());
    const other = await createManualMemory(uid, { kind: 'goal', content: 'Run a marathon', language: 'en' }, new Date().toISOString());
    const [body] = await conversation(uid, [FIRST]);
    const items = twoSessions(body!, 'with two goals');
    for (const entry of items) assert.equal(entry.goalLink?.goalId, goal.id);
    const response = await confirmPost(post('/api/mobile/capture/confirm', uid, {
      proposalId: body!.proposal!.proposalId, itemIds: items.map((entry) => entry.itemId), goalId: other.id,
    }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { goalLinks: unknown[] }).goalLinks, []);
    for (const id of [goal.id, other.id]) {
      const progress = await deriveGoalGraphProgress({ scopeId: uid, goalMemoryId: id, derivedAt: new Date().toISOString() });
      assert.equal(progress.confirmedCount, 0);
    }
  } finally {
    end();
  }
});

test('audit #6: an unrelated capture carries no goal link', async () => {
  begin([{ reply: 'تمام، الدكتور يوم الجمعة الساعة 4 المسا. أكّد من تحت.', action: 'propose', items: [item('Dentist appointment', 'موعد الدكتور', FRIDAY, '16:00')] }]);
  try {
    const uid = uidFor('AuditGoalUnrelated');
    await createManualMemory(uid, { kind: 'goal', content: 'Learn React', language: 'en' }, new Date().toISOString());
    const [body] = await conversation(uid, ['dentist appointment on Friday at 4pm']);
    assert.equal(body!.proposal!.items[0]!.goalLink, undefined);
  } finally {
    end();
  }
});

test('the hour of an occurrence is the person’s clock on its own day', () => {
  // A guard against a zone slip in the fan-out: each day keeps 19:00 local.
  for (const date of [TUESDAY, THURSDAY]) assert.equal(localTimeSpecFor(new Date(at(date, '19:00')), TZ)!.time, '19:00');
});

/* ── 4. the adversarial review of this fix (2026-10-03), its exact inputs ── */

const SUNDAY = weekday('Sunday');

/** One chat message, with the model answering `items`; the proposal and reply. */
async function chatOnce(label: string, message: string, items: unknown[], options: { locale?: 'ar' | 'en' | 'he'; goals?: string[] } = {}) {
  begin([{ reply: 'OK. Confirm below.', action: 'propose', items }]);
  try {
    const uid = uidFor(label);
    const goals = [] as Array<{ id: string }>;
    for (const goal of options.goals ?? []) goals.push(await createManualMemory(uid, { kind: 'goal', content: goal, language: 'en' }, new Date().toISOString()));
    const response = await chatPost(post('/api/mobile/capture/chat', uid, {
      message, timezone: TZ, referenceTime: new Date().toISOString(), locale: options.locale ?? 'en',
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as Body;
    return { body, uid, goals };
  } finally {
    end();
  }
}
const enItem = (title: string, date: string | null, time: string | null) => item(title, title, date, time);
const when = (entries: Item[]) => entries.map((entry) => [entry.title, entry.resolvedTime]);

/** The rules path (no model), as the capture route reads it, at a fixed instant. */
async function rulesAt(text: string, now: Date) {
  return proposeCapture(text, { now, timezone: TZ, scopeId: 'review-a', requestedEngine: 'rules' }, {
    store: new MemoryCaptureProposalStore(), persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
  });
}
const MON_10 = new Date('2026-10-05T07:00:00Z');
const TUE_10 = new Date('2026-10-06T07:00:00Z');
const TUE_2030 = new Date('2026-10-06T17:30:00Z');
const local = (iso: string | null) => (iso ? `${localTimeSpecFor(new Date(iso), TZ)!.date} ${localTimeSpecFor(new Date(iso), TZ)!.time}` : null);

test('review #1: a list of days beside another thing never fans the model’s one item out', async () => {
  for (const [message, title, appTitle] of [
    ['الثلاثاء والخميس عندي دوام وعندي دكتور الخميس الساعة 5 المسا', 'Dentist', 'موعد الدكتور'],
    ['I am at the office Tuesday and Thursday and the dentist is on Thursday at 5pm', 'Dentist', 'Dentist'],
  ] as const) {
    const { body } = await chatOnce(`ReviewFan${message.length}`, message, [item(title, appTitle, THURSDAY, '17:00')], { locale: appTitle === 'Dentist' ? 'en' : 'ar' });
    assert.deepEqual(when(body.proposal!.items), [[appTitle, at(THURSDAY, '17:00')]], message);
  }
  const party = await chatOnce('ReviewFanParty', 'Exams on Tuesday and Thursday, party Thursday at 8pm', [enItem('Party', THURSDAY, '20:00')]);
  assert.deepEqual(when(party.body.proposal!.items), [['Party', at(THURSDAY, '20:00')]]);
  const report = await chatOnce('ReviewFanReport', 'Submit the report Tuesday and Thursday meeting at 5pm', [enItem('Submit the report', TUESDAY, null), enItem('Meeting', THURSDAY, '17:00')]);
  assert.equal(report.body.proposal!.items.length, 2, JSON.stringify(when(report.body.proposal!.items)));
  assert.equal(report.body.proposal!.items.filter((entry) => entry.title === 'Meeting').length, 1);
});

test('review #1: on the rules path too, "Exams on Tuesday and Thursday, party Thursday at 8pm" is one party, and the report is not four items', async () => {
  const party = await rulesAt('Exams on Tuesday and Thursday, party Thursday at 8pm', MON_10);
  assert.ok(party.items.filter((entry) => local(entry.resolvedTime)?.endsWith('20:00')).length <= 1, JSON.stringify(party.items.map((entry) => [entry.title, local(entry.resolvedTime)])));
  const report = await rulesAt('Submit the report Tuesday and Thursday meeting at 5pm', MON_10);
  assert.ok(report.items.length <= 2, JSON.stringify(report.items.map((entry) => [entry.title, local(entry.resolvedTime)])));
});

test('review #2: a real task beside a session is never turned into a goal', async () => {
  for (const [label, message, items] of [
    ['B', 'I need to improve the slides, and the presentation is on Tuesday at 10am', [enItem('Improve the slides', null, null), enItem('Presentation', TUESDAY, '10:00')]],
    ['B2', 'I have to learn my lines for the play, rehearsal of the play is Tuesday at 6pm', [enItem('Learn my lines', null, null), enItem('Play rehearsal', TUESDAY, '18:00')]],
    ['E', 'بدي أتعلم سباحة الثلاثاء الساعة 6 المسا، وكمان اتصل بماما الثلاثاء الساعة 6', [item('Learn swimming', 'تتعلم سباحة', TUESDAY, '18:00'), item('Call mom', 'تتصل بماما', TUESDAY, '18:00')]],
  ] as const) {
    const { body } = await chatOnce(`ReviewGoal${label}`, message, [...items], { locale: label === 'E' ? 'ar' : 'en' });
    assert.equal(body.proposal!.items.length, 2, `${label}: ${JSON.stringify(when(body.proposal!.items))}`);
    assert.deepEqual(body.proposal!.seeds, [], label);
  }
});

test('review #2: "improve" and «حسّن» name a task, not a goal; learning does', () => {
  for (const title of ['Improve the slides', 'improve my CV', 'أحسّن العرض', 'get better at chess']) assert.equal(isGoalTitle(title), false, title);
  for (const title of ['Learn React', 'تتعلم React', 'بدي أتعلم سواقة', 'ללמוד ריאקט']) assert.equal(isGoalTitle(title), true, title);
});

test('review #3: a goal link needs the item’s own topic — not "more", not a weekday, not the sentence around it', async () => {
  const milk = await chatOnce('ReviewLinkMilk', 'Buy more milk on Friday at 5pm', [enItem('Buy more milk', FRIDAY, '17:00')], { goals: ['Read more books'] });
  assert.equal(milk.body.proposal!.items[0]!.goalLink, undefined);
  const dentist = await chatOnce('ReviewLinkGym', 'Dentist Tuesday at 4pm', [enItem('Dentist', TUESDAY, '16:00')], { goals: ['Gym every Tuesday'] });
  assert.equal(dentist.body.proposal!.items[0]!.goalLink, undefined);
  const mixed = await chatOnce('ReviewLinkMixed', 'Dentist on Friday at 4pm, and I want to study React on Thursday at 7pm',
    [enItem('Dentist', FRIDAY, '16:00'), enItem('Study React', THURSDAY, '19:00')], { goals: ['Learn React'] });
  const [dentistItem, react] = mixed.body.proposal!.items;
  assert.equal(dentistItem!.goalLink, undefined, 'the dentist is not a step of learning React');
  assert.equal(react!.goalLink?.goalId, mixed.goals[0]!.id);
});

test('review #3: two goals with the same topic are a tie, and a tie links nothing', () => {
  assert.equal(matchingGoal('Study React', [{ goalId: 'a', title: 'Learn React' }, { goalId: 'b', title: 'Build a React portfolio' }]), null);
  assert.equal(matchingGoal('Study React', [{ goalId: 'a', title: 'Learn React' }, { goalId: 'b', title: 'Learn guitar' }])?.goalId, 'a');
});

test('review #3: a goal deleted between the proposal and the confirm is not linked; a live one is', async () => {
  for (const deleted of [true, false]) {
    begin([{ reply: 'OK. Confirm below.', action: 'propose', items: [enItem('Study React', THURSDAY, '19:00')] }]);
    try {
      const uid = uidFor(`ReviewLinkDeleted${deleted}`);
      const goal = await createManualMemory(uid, { kind: 'goal', content: 'Learn React', language: 'en' }, new Date().toISOString());
      const [body] = await conversation(uid, ['study React on Thursday at 7pm']);
      const only = body!.proposal!.items[0]!;
      assert.equal(only.goalLink?.goalId, goal.id);
      if (deleted) await deleteMemory(uid, goal.id, new Date().toISOString());
      const response = await confirmPost(post('/api/mobile/capture/confirm', uid, {
        proposalId: body!.proposal!.proposalId, itemIds: [only.itemId], goalLinkItemIds: [only.itemId],
      }));
      assert.equal(response.status, 200);
      const links = (await response.json() as { goalLinks: unknown[] }).goalLinks;
      assert.equal(links.length, deleted ? 0 : 1, `deleted=${deleted}`);
    } finally {
      end();
    }
  }
});

test('review #3: a list of days beside two hours fans nothing out — each day may have its own', () => {
  const result = {
    title: 'Study', action: 'Study', dueAt: at(TUESDAY, '19:00'), remindAt: null,
    localTimeSpec: { date: TUESDAY, time: '19:00', timezone: TZ }, allDay: false,
  } as unknown as ExtractionResult;
  assert.equal(occurrenceDatesFor(result, 'study Tuesday and Thursday at 7 and at 9', new Date(), TZ), null);
  assert.deepEqual(occurrenceDatesFor(result, 'study Tuesday and Thursday at 7pm', new Date(), TZ), [TUESDAY, THURSDAY].sort());
});

test('review #4: «عبي استمارة ٣ واستمارة ٤» and "Study math"/"Study physics" at one hour stay two items', async () => {
  const forms = await chatOnce('ReviewForms', 'عبي استمارة ٣ واستمارة ٤ الجمعة الساعة ٥ المسا',
    [item('Fill form 3', 'عبي استمارة ٣', FRIDAY, '17:00'), item('Fill form 4', 'عبي استمارة ٤', FRIDAY, '17:00')], { locale: 'ar' });
  assert.equal(forms.body.proposal!.items.length, 2, JSON.stringify(when(forms.body.proposal!.items)));
  const same = at(FRIDAY, '19:00');
  const items = [
    { itemId: 'm', title: 'تدرس', resolvedTime: same, needsClarification: false },
    { itemId: 'p', title: 'تدرس', resolvedTime: same, needsClarification: false },
    { itemId: 'm2', title: 'تدرس', resolvedTime: same, needsClarification: false },
  ];
  const sources = new Map([['m', 'Study math'], ['p', 'Study physics'], ['m2', 'study  math']]);
  assert.deepEqual(Array.from(duplicateItemIds(items as never, sources)), ['m2']);
  // Arabic-Indic and Latin digits are one number.
  const digits = [
    { itemId: 'a', title: 'عبي استمارة ٣', resolvedTime: same, needsClarification: false },
    { itemId: 'b', title: 'عبي استمارة 3', resolvedTime: same, needsClarification: false },
  ];
  assert.deepEqual(Array.from(duplicateItemIds(digits as never, new Map())), ['b']);
});

test('review #5: on the rules path a list of days leaves a clean title — «study», «gym» — one item per day', async () => {
  const study = await rulesAt('study every Tuesday and Thursday at 7pm', MON_10);
  assert.deepEqual(study.items.map((entry) => [entry.title, local(entry.resolvedTime)]), [['study', '2026-10-06 19:00'], ['study', '2026-10-08 19:00']]);
  const gym = await rulesAt('gym every Monday, Wednesday and Friday at 6pm', TUE_10);
  assert.deepEqual(gym.items.map((entry) => [entry.title, local(entry.resolvedTime)]),
    [['gym', '2026-10-07 18:00'], ['gym', '2026-10-09 18:00'], ['gym', '2026-10-12 18:00']]);
});

test('review #8: "every Tuesday…" said on Tuesday before 19:00 includes tonight; after it, next Tuesday', async () => {
  const morning = await rulesAt('study every Tuesday and Thursday at 7pm', TUE_10);
  assert.deepEqual(morning.items.map((entry) => local(entry.resolvedTime)), ['2026-10-06 19:00', '2026-10-08 19:00']);
  const evening = await rulesAt('study every Tuesday and Thursday at 7pm', TUE_2030);
  assert.deepEqual(evening.items.map((entry) => local(entry.resolvedTime)), ['2026-10-08 19:00', '2026-10-13 19:00']);
});

test('review #8: spoken lists — «التلاتا وبالخميس», «الأربعا والخميس», «الثلاثاء، الخميس»', () => {
  assert.deepEqual(readListedWeekdays('التلاتا وبالخميس الساعة 7'), [2, 4]);
  assert.deepEqual(readListedWeekdays('الأربعا والخميس الساعة 7'), [3, 4]);
  assert.deepEqual(readListedWeekdays('الثلاثاء، الخميس الساعة 7'), [2, 4]);
  assert.deepEqual(readRecurrence('كل تلاتا وخميس')?.weekdays, [2, 4]);
});

test('review #8: a weekly repeat with no end says, once, what makes it weekly', async () => {
  begin([FIRST_ANSWERS['nothing timed'], SECOND_AS_PRODUCTION, SECOND_AS_PRODUCTION]);
  try {
    const [, second, third] = await conversation(uidFor('ReviewWeeklyOffer'), [FIRST, SECOND, 'ok']);
    assert.match(second!.reply, /إذا بدك ياه كل أسبوع، قلّي لأي ساعة بيخلص/, second!.reply);
    assert.doesNotMatch(third!.reply, /كل أسبوع، قلّي/, 'said once');
  } finally {
    end();
  }
});
