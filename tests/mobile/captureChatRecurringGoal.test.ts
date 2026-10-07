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
import { withProposalClashes } from '../../lib/services/captureChat/chatConflicts.ts';
import { renderRefModelAnswer } from './captureChatModelFixtures.ts';

const BASE = 'http://localhost:3000';
const TZ = 'Asia/Jerusalem';
const weekday = (name: string): string => resolveWeekdayDate(name, new Date(), TZ)!.date;
const recurringWeekday = (name: string, time: string): string => {
  const now = new Date();
  const localNow = localTimeSpecFor(now, TZ)!;
  const next = resolveWeekdayDate(name, now, TZ)!.date;
  const todayWeekday = new Date(`${localNow.date}T12:00:00Z`).getUTCDay();
  const namedWeekday = new Date(`${next}T12:00:00Z`).getUTCDay();
  // Match occurrenceDatesFor: a recurring weekday includes today only while
  // that occurrence is still ahead on the person's clock.
  return namedWeekday === todayWeekday && time > localNow.time ? localNow.date : next;
};
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
type ScriptedAnswer = unknown | ((prompt: string) => unknown);

let auth: FakeAuthControls | null = null;
function begin(answers: readonly ScriptedAnswer[]): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  let calls = 0;
  const provider: LLMProviderFunction = async (prompt) => {
    const scripted = answers[Math.min(calls++, answers.length - 1)];
    return renderRefModelAnswer(typeof scripted === 'function' ? scripted(prompt) : scripted, prompt);
  };
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

/**
 * The second answer, as production's review showed it: the Thursday session
 * was returned on Tuesday. The v5 fake model updates the two open session
 * refs and keeps the possible goal; the boundary applies the person's days.
 */
const SECOND_AS_PRODUCTION = (prompt: string) => prompt.includes('"ref":"s1"') ? ({
  reply: SECOND_REPLY,
  action: 'update',
  locked: [],
  open: [
    { ref: 's1', op: 'keep' },
    { ref: 'i1', op: 'update', fields: item('Study every Tuesday', 'تدرس', TUESDAY, '19:00'), source: SECOND },
    { ref: 'i2', op: 'update', fields: item('Study every Thursday', 'تدرس', TUESDAY, '19:00'), source: SECOND },
  ],
  added: [],
}) : ({
  reply: SECOND_REPLY,
  action: 'update',
  locked: [],
  open: [
    { ref: 'i1', op: 'update', fields: item('Study every Tuesday', 'تدرس', recurringWeekday('Tuesday', '19:00'), '19:00'), source: SECOND },
    { ref: 'i2', op: 'update', fields: item('Study every Thursday', 'تدرس', recurringWeekday('Tuesday', '19:00'), '19:00'), source: SECOND },
  ],
  added: [],
});

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
function twoSessions(body: Body, label: string, dates: readonly string[] = [TUESDAY, THURSDAY]): Item[] {
  const items = body.proposal!.items;
  assert.equal(items.length, 2, `${label}: ${JSON.stringify(items.map((entry) => [entry.title, entry.resolvedTime]))}`);
  assert.deepEqual(items.map((entry) => entry.resolvedTime).sort(), dates.map((date) => at(date, '19:00')).sort(), label);
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
      twoSessions(second!, 'second message', [recurringWeekday('Tuesday', '19:00'), recurringWeekday('Thursday', '19:00')]);
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

test('audit #1 recurring shared span also accepts the model returning Tuesday and Thursday', async () => {
  const rightDays = (prompt: string) => ({
    reply: SECOND_REPLY,
    action: 'update' as const,
    locked: [],
    open: [
      ...(prompt.includes('"ref":"s1"') ? [{ ref: 's1', op: 'keep' as const }] : []),
      { ref: 'i1', op: 'update' as const, fields: item('Study every Tuesday', 'تدرس', recurringWeekday('Tuesday', '19:00'), '19:00'), source: SECOND },
      { ref: 'i2', op: 'update' as const, fields: item('Study every Thursday', 'تدرس', recurringWeekday('Thursday', '19:00'), '19:00'), source: SECOND },
    ],
    added: [],
  });
  begin([FIRST_ANSWERS['Tuesday and Thursday'], rightDays]);
  try {
    const [, second] = await conversation(uidFor('AuditReactRightDays'), [FIRST, SECOND]);
    twoSessions(second!, 'right-days model shape', [recurringWeekday('Tuesday', '19:00'), recurringWeekday('Thursday', '19:00')]);
  } finally {
    end();
  }
});

test('an Arabic recurring shared span is one fact for both Tue/Tue and Tue/Thu model shapes', async () => {
  const firstMessage = 'بدي ادرس يوم التلاتا والخميس الساعة 7 المسا';
  const recurringMessage = 'كل تلاتا وخميس الساعة 7 المسا';
  for (const [label, secondDate] of [['production Tue/Tue', TUESDAY], ['right days Tue/Thu', THURSDAY]] as const) {
    begin([
      { reply: 'تمام.', action: 'propose', items: [
        item('Study on Tuesday', 'أدرس', TUESDAY, '19:00'),
        item('Study on Thursday', 'أدرس', THURSDAY, '19:00'),
      ] },
      {
        reply: 'تمام.', action: 'update', locked: [], added: [], open: [
          { ref: 'i1', op: 'update', fields: item('Study every Tuesday', 'أدرس', TUESDAY, '19:00'), source: recurringMessage },
          { ref: 'i2', op: 'update', fields: item('Study every Thursday', 'أدرس', secondDate, '19:00'), source: recurringMessage },
        ],
      },
    ]);
    try {
      const [, second] = await conversation(uidFor(`ArabicRecurring${label.length}`), [firstMessage, recurringMessage]);
      twoSessions(second!, label, [recurringWeekday('Tuesday', '19:00'), recurringWeekday('Thursday', '19:00')]);
    } finally {
      end();
    }
  }
});

test('audit #1: the two sessions confirm as two commitments on two days, with no clash warning between them', async () => {
  begin([FIRST_ANSWERS['nothing timed'], SECOND_AS_PRODUCTION]);
  try {
    const uid = uidFor('AuditReactConfirm');
    const [, second] = await conversation(uid, [FIRST, SECOND]);
    const recurringDates = [recurringWeekday('Tuesday', '19:00'), recurringWeekday('Thursday', '19:00')];
    const items = twoSessions(second!, 'before confirm', recurringDates);
    const response = await confirmPost(post('/api/mobile/capture/confirm', uid, {
      proposalId: second!.proposal!.proposalId, itemIds: items.map((entry) => entry.itemId),
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as { persisted: Array<{ resolvedTime: string | null }>; collisions: unknown[]; goalLinks: unknown[] };
    assert.deepEqual(result.persisted.map((entry) => entry.resolvedTime).sort(), recurringDates.map((date) => at(date, '19:00')).sort());
    assert.deepEqual(result.collisions, []);
    assert.deepEqual(result.goalLinks, []);
  } finally {
    end();
  }
});

test('a model-only idea kind becomes a seed without an item or a time question', async () => {
  const message = 'سفرة لتركيا مع الشباب';
  begin([{ reply: 'فهمت الفكرة.', action: 'propose', items: [
    { ...item(message, message, null, null), kind: 'idea' },
  ] }]);
  try {
    const [body] = await conversation(uidFor('ModelOnlyIdeaKind'), [message]);
    assert.deepEqual(body!.proposal!.items, []);
    assert.deepEqual(
      body!.proposal!.seeds.map((seed) => [seed.kind, seed.summary]),
      [['idea', message]],
    );
    assert.doesNotMatch(body!.reply, /إيمتى|ايمتى/);
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
  // The reading's hint is the whole list; the proposal narrows it to the
  // item's own day where the list's other days have items of their own.
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

test('copies the model stacked are spread when a list places them; exact copies with no list are one card (rounds 4, 5)', async () => {
  // No list to place them on: two identical cards at one instant are one thing (round 5).
  begin([{ reply: 'تمام، «تدرس» يوم الجمعة الساعة 7 المسا. أكّد من تحت.', action: 'propose', items: [
    item('Study', 'تدرس', FRIDAY, '19:00'), item('Study', 'تدرس', FRIDAY, '19:00'),
  ] }]);
  try {
    const [body] = await conversation(uidFor('DuplicatesKept'), ['study on Friday at 7 PM']);
    assert.equal(body!.proposal!.items.length, 1, JSON.stringify(body!.proposal!.items));
  } finally {
    end();
  }
  // A list places them: one on each day, the copies merged.
  for (const [message, title, appTitle, time] of [
    ['بدرس الثلاثاء والخميس الساعة 7 المسا', 'Study', 'أدرس', '19:00'],
    ["I'll be studying Tuesday and Thursday at 7pm", 'Study', 'Study', '19:00'],
    ['I have classes Tuesday and Thursday at 6pm', 'Class', 'Class', '18:00'],
    ['التلاتا وبالخميس عندي نادي الساعة 6 المسا', 'Gym', 'نادي', '18:00'],
  ] as const) {
    const { body } = await chatOnce(`Stacked${message.length}`, message, [item(title, appTitle, TUESDAY, time), item(title, appTitle, TUESDAY, time)], { locale: /[a-z]/i.test(message.slice(0, 3)) ? 'en' : 'ar' });
    assert.deepEqual(body.proposal!.items.map((entry) => entry.resolvedTime).sort(), [at(TUESDAY, time), at(THURSDAY, time)].sort(), message);
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
    const items = twoSessions(second!, 'with the goal', [recurringWeekday('Tuesday', '19:00'), recurringWeekday('Thursday', '19:00')]);
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
const MONDAY = weekday('Monday');
const TOMORROW_DAY = (() => { const today = localTimeSpecFor(new Date(), TZ)!.date; const [y, m, d] = today.split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); })();
const WEDNESDAY = weekday('Wednesday');

/** One chat message, with the model answering `items`; the proposal and reply. */
async function chatOnce(label: string, message: string, items: unknown[], options: { locale?: 'ar' | 'en' | 'he'; goals?: string[]; now?: Date } = {}) {
  begin([{ reply: 'OK. Confirm below.', action: 'propose', items }]);
  try {
    const uid = uidFor(label);
    const goals = [] as Array<{ id: string }>;
    for (const goal of options.goals ?? []) goals.push(await createManualMemory(uid, { kind: 'goal', content: goal, language: 'en' }, new Date().toISOString()));
    const response = await chatPost(post('/api/mobile/capture/chat', uid, {
      message, timezone: TZ, referenceTime: (options.now ?? new Date()).toISOString(), locale: options.locale ?? 'en',
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
  // "between Tuesday and Thursday" is a span, never a list (round 4 C).
  const between = await rulesAt('submit the report between Tuesday and Thursday at 5pm', MON_10);
  assert.equal(between.items.length, 1, JSON.stringify(between.items.map((entry) => [entry.title, local(entry.resolvedTime)])));
  // A recurrence whose days were not made into items keeps its words (round 4 D).
  const work = await rulesAt('كل ثلاثاء وخميس عندي شغل من 9 لـ 5', MON_10);
  assert.ok(work.items.every((entry) => entry.title.includes('كل ثلاثاء')), JSON.stringify(work.items.map((entry) => entry.title)));
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

/* ── 5. round 2 of the review (orchestrator: conservative; never invent or move what base kept) ── */

const timedAs = (entries: Item[]) => entries.map((entry) => [entry.title, entry.resolvedTime, entry.needsClarification]);

test('round 2 #1: a spread list never hides a dropped item from the multi-time check — it is asked', async () => {
  for (const text of ['Tuesday and Thursday at 7 and Friday at 9', 'study math Tuesday and Thursday at 7pm and study physics Wednesday at 7pm']) {
    const proposal = await rulesAt(text, MON_10);
    assert.ok(proposal.items.length > 0 && proposal.items.every((entry) => entry.needsClarification), `${text}: ${JSON.stringify(proposal.items.map((entry) => [entry.title, local(entry.resolvedTime)]))}`);
  }
  const { body } = await chatOnce('Round2Valve', 'every Tuesday and Thursday at 7pm and Friday at 9pm gym', [enItem('Gym', TUESDAY, '19:00')]);
  assert.ok(body.proposal!.items.every((entry) => entry.needsClarification), JSON.stringify(timedAs(body.proposal!.items)));
  // The gym's own list spreads it over Tuesday and Thursday — two instants —
  // and the dentist the model lost still has its 9pm counted as missing.
  const spread = await chatOnce('Round2ValveSpread', 'gym every Tuesday and Thursday at 7pm, and the dentist on Friday at 9pm', [enItem('Gym', TUESDAY, '19:00')]);
  assert.ok(spread.body.proposal!.items.every((entry) => entry.needsClarification), JSON.stringify(timedAs(spread.body.proposal!.items)));
});

test('round 2 #2: a recurring list that is another item\u2019s never invents a copy of this one', async () => {
  const work = await chatOnce('Round2Work', 'I work every Tuesday and Thursday at 9am, and I have a meeting with Dana Tuesday at 9am',
    [enItem('Work', TUESDAY, '09:00'), enItem('Work', THURSDAY, '09:00'), enItem('Meeting with Dana', TUESDAY, '09:00')]);
  const meetings = work.body.proposal!.items.filter((entry) => entry.title === 'Meeting with Dana');
  assert.deepEqual(meetings.map((entry) => entry.resolvedTime), [at(TUESDAY, '09:00')]);
  assert.equal((meetings[0] as Item & { recurrenceHint?: unknown }).recurrenceHint, undefined, 'the list is not the meeting\u2019s');
  const training = await chatOnce('Round2Training', 'كل ثلاثاء وخميس الساعة 5 المسا عندي تدريب، والثلاثاء الساعة 5 المسا عندي دكتور',
    [item('Training', 'تدريب', TUESDAY, '17:00'), item('Training', 'تدريب', THURSDAY, '17:00'), item('Doctor', 'دكتور', TUESDAY, '17:00')], { locale: 'ar' });
  assert.deepEqual(training.body.proposal!.items.filter((entry) => entry.title === 'دكتور').map((entry) => entry.resolvedTime), [at(TUESDAY, '17:00')]);
});

test('round 2 #3: a recurrence never moves another item off the day its own words name', async () => {
  begin([
    { reply: 'OK. Confirm below.', action: 'propose', items: [item('Study', 'أدرس', TUESDAY, '19:00')] },
    {
      reply: 'تمام. أكّد من تحت.', action: 'update',
      items: [item('Study', 'أدرس', TUESDAY, '19:00'), item('Study', 'أدرس', THURSDAY, '19:00'), item('Doctor', 'دكتور', FRIDAY, '16:00')],
      sources: [null, null, 'وكمان دكتور الجمعة الساعة 4 العصر'],
      expectedKeeps: [0, 1],
    },
  ]);
  try {
    const [, second] = await conversation(uidFor('Round2Doctor'), ['كل ثلاثاء وخميس الساعة 7 المسا بدي أدرس', 'وكمان دكتور الجمعة الساعة 4 العصر']);
    assert.deepEqual(second!.proposal!.items.filter((entry) => entry.title === 'دكتور').map((entry) => entry.resolvedTime), [at(FRIDAY, '16:00')]);
  } finally {
    end();
  }
  const gym = await chatOnce('Round2GymDentist', 'gym every Tuesday and Thursday at 7pm, and the dentist on Friday at 4pm',
    [enItem('Gym', TUESDAY, '19:00'), enItem('Gym', THURSDAY, '19:00'), enItem('Dentist', FRIDAY, '16:00')]);
  assert.deepEqual(gym.body.proposal!.items.filter((entry) => entry.title === 'Dentist').map((entry) => entry.resolvedTime), [at(FRIDAY, '16:00')]);
});

test('round 2 #4: a bare «Study» for something else is not a session of the goal, and is not linked to it', async () => {
  const { body } = await chatOnce('Round2Chemistry', 'I want to learn React; also study for the chemistry exam Tuesday at 6pm',
    [enItem('Learn React', null, null), enItem('Study', TUESDAY, '18:00')], { goals: ['Learn React'] });
  const study = body.proposal!.items.find((entry) => entry.title === 'Study');
  assert.ok(study, JSON.stringify(timedAs(body.proposal!.items)));
  assert.equal(study.goalLink, undefined);
  // The goal-like item is the goal itself, never a step of it.
  for (const entry of body.proposal!.items.filter((candidate) => candidate.title === 'Learn React')) assert.equal(entry.goalLink, undefined);
});

test('round 2 #5: an everyday verb or a general noun is never a goal link', async () => {
  for (const [label, goal, message, title, appTitle, locale] of [
    ['Play', 'Play guitar every day', 'Play football with Omar on Friday at 5pm', 'Play football with Omar', 'Play football with Omar', 'en'],
    ['House', 'Save money for a house', "House party at Dana's on Friday at 8pm", "House party at Dana's", "House party at Dana's", 'en'],
    ['Write', 'أكتب رسالة الماجستير', 'اكتب بطاقة عيد ميلاد لماما الجمعة الساعة 5 المسا', 'Write a birthday card for mom', 'اكتب بطاقة عيد ميلاد لماما', 'ar'],
  ] as const) {
    const time = label === 'House' ? '20:00' : '17:00';
    const { body } = await chatOnce(`Round2Link${label}`, message, [item(title, appTitle, FRIDAY, time)], { goals: [goal], locale });
    assert.equal(body.proposal!.items[0]!.goalLink, undefined, label);
  }
});

test('round 2 #6: said on Monday morning, «every Monday and Wednesday» keeps tonight\u2019s item, and "Gym (Mon)"/"Gym (Wed)" stay two', async () => {
  const monday = await chatOnce('Round2AbbrevToday', 'every Monday and Wednesday at 6pm gym',
    [item('Gym (Mon)', 'Gym (Mon)', '2026-10-05', '18:00'), item('Gym (Wed)', 'Gym (Wed)', '2026-10-07', '18:00')], { now: MON_10 });
  assert.deepEqual(monday.body.proposal!.items.map((entry) => [entry.title, local(entry.resolvedTime)]),
    [['Gym (Mon)', '2026-10-05 18:00'], ['Gym (Wed)', '2026-10-07 18:00']]);
});

test('round 2 #6: "Gym (Mon)" and "Gym (Wed)" stay two, each on its own day', async () => {
  const monday = '2026-10-05';
  const wednesday = '2026-10-07';
  const { body } = await chatOnce('Round2Abbrev', 'every Monday and Wednesday at 6pm gym',
    [enItem('Gym (Mon)', monday, '18:00'), enItem('Gym (Wed)', wednesday, '18:00')], { now: MON_10 });
  assert.deepEqual(body.proposal!.items.map((entry) => entry.resolvedTime).sort(), [at(monday, '18:00'), at(wednesday, '18:00')].sort());
});

test('round 2 #7: no weekly line for one day, while anything is asked, or when the reply already says weekly', async () => {
  const trash = await chatOnce('Round2Trash', 'every Friday at 8pm take out the trash', [enItem('Take out the trash', FRIDAY, '20:00')]);
  assert.doesNotMatch(trash.body.reply, /every week, tell me/, trash.body.reply);
  const asking = await chatOnce('Round2Asking', 'gym every Tuesday and Thursday at 7pm. I also need to call the bank', [enItem('Gym', TUESDAY, '19:00'), enItem('Call the bank', null, null)]);
  assert.ok(asking.body.proposal!.items.some((entry) => entry.needsClarification));
  assert.doesNotMatch(asking.body.reply, /every week, tell me/, asking.body.reply);
  begin([{ reply: 'تمام، نادي الثلاثاء والخميس الساعة 7 المسا، كل أسبوع. أكّد من تحت.', action: 'propose', items: [item('Gym', 'نادي', TUESDAY, '19:00')] }]);
  try {
    const [said] = await conversation(uidFor('Round2SaidWeekly'), ['gym every Tuesday and Thursday at 7pm']);
    assert.equal(said!.proposal!.items.length, 2);
    assert.doesNotMatch(said!.reply, /tell me what time it ends|قلّي لأي ساعة/, said!.reply);
  } finally {
    end();
  }
});

test('round 4 A: a later clause keeps the day said earlier; an Arabic card title speaks only for an item nothing else names', async () => {
  for (const [label, message, items, locale] of [
    ['V14', 'بكرا الساعة 3 دكتور وبعدين الساعة 5 اجتماع', [item('Doctor', 'دكتور', TOMORROW_DAY, '15:00'), item('Meeting', 'اجتماع', TOMORROW_DAY, '17:00')], 'ar'],
    ['W06', 'מחר ב-15:00 רופא ואחר כך ב-17:00 פגישה', [item('Doctor', 'רופא', TOMORROW_DAY, '15:00'), item('Meeting', 'פגישה', TOMORROW_DAY, '17:00')], 'he'],
    ['C30', 'بدي اتعلم سباحة الثلاثاء الساعة 6 المسا، ونفس الوقت اتصل بماما', [item('Learn swimming', 'اتعلم سباحة', TUESDAY, '18:00'), item('Call mom', 'اتصل بماما', TUESDAY, '18:00')], 'ar'],
  ] as const) {
    const { body } = await chatOnce(`Round4A${label}`, message, [...items], { locale });
    for (const entry of body.proposal!.items) assert.equal(entry.needsClarification, false, `${label}: ${JSON.stringify(timedAs(body.proposal!.items))}`);
  }
  // «…وأدرس الثلاثاء والخميس…»: the model's "Study" is named by its card title only; it is spread, not asked.
  const audit = await chatOnce('Round4AAudit', 'بدي أتعلم React وأدرس الثلاثاء والخميس الساعة 7 المسا',
    [item('Learn React', 'أتعلم React', TUESDAY, '19:00'), item('Study', 'أدرس', TUESDAY, '19:00'), item('Study', 'أدرس', TUESDAY, '19:00')], { locale: 'ar' });
  assert.deepEqual(
    audit.body.proposal!.items.map((entry) => [entry.title, entry.resolvedTime])
      .sort((left, right) => String(left[1]).localeCompare(String(right[1]))),
    [['أدرس', at(TUESDAY, '19:00')], ['أدرس', at(THURSDAY, '19:00')]]
      .sort((left, right) => left[1].localeCompare(right[1])),
  );
});

test('round 4 D: a lost time sends a spread back to its one reading; an old list hints no other day', async () => {
  // Base asked one item here; spread copies are not added to the question.
  const asked = await rulesAt('gym every Tuesday and Thursday at 7pm, and the dentist on Friday at 4pm', MON_10);
  assert.equal(asked.items.length, 1, JSON.stringify(asked.items.map((entry) => [entry.title, entry.resolvedDate, entry.needsClarification])));
  assert.equal(asked.items[0]!.needsClarification, true);
  begin([
    { reply: 'OK. Confirm below.', action: 'propose', items: [enItem('Gym', TUESDAY, '19:00'), enItem('Gym', THURSDAY, '19:00')] },
    { reply: 'OK. Confirm below.', action: 'update', items: [enItem('Gym', TUESDAY, '19:00')] },
  ]);
  try {
    const [, only] = await conversation(uidFor('Round4OnlyTuesdays'), ['gym every Tuesday and Thursday at 7pm', 'actually only Tuesdays']);
    const hint = (only!.proposal!.items[0] as Item & { recurrenceHint?: { weekdays: number[] } }).recurrenceHint;
    assert.deepEqual(hint?.weekdays, [2]);
  } finally {
    end();
  }
});

test('round 2 #8: rules titles lose the connectors and list days left at their edges', async () => {
  for (const [text, title] of [
    ['gym Tuesday and Thursday at 7pm', 'gym'],
    ['חדר כושר ביום שלישי וחמישי ב-19:00', 'חדר כושר'],
  ] as const) {
    const proposal = await rulesAt(text, MON_10);
    assert.deepEqual(Array.from(new Set(proposal.items.map((entry) => entry.title))), [title], text);
  }
  const off = await rulesAt("Monday and Tuesday I'm off, dentist Tuesday at 5pm", MON_10);
  for (const entry of off.items) assert.doesNotMatch(entry.title, /^(?:and|&)\s|\s(?:and|&)$/i, entry.title);
  const bare = await rulesAt('Every Tuesday and Thursday at 7 PM', MON_10);
  for (const entry of bare.items) assert.notEqual(entry.title, 'and');
});

/* ── 6. round 5 (independent sweep review-a4): exact inflections, exact copies ── */

const TUE_6 = '2026-10-06';
const THU_8 = '2026-10-08';
type HintItem = Item & { recurrenceHint?: { weekdays: number[] } | null };

test('round 5 #1: a list owned by a longer or different title never lends its days to a one-off', async () => {
  for (const [label, message, title, appTitle, time, locale] of [
    ['N01', 'اجتماعات كل ثلاثاء وخميس الساعة 10 الصبح، وعندي اجتماع مع المدير الثلاثاء الساعة 10 الصبح', 'Meeting with the manager', 'اجتماع مع المدير', '10:00', 'ar'],
    ['N03', 'I work every Tuesday and Thursday at 9am; worker coming Tuesday at 9am', 'Worker coming', 'Worker coming', '09:00', 'en'],
    ['N04', 'Classes every Tuesday and Thursday at 6pm, and the class party Tuesday at 6pm', 'Class party', 'Class party', '18:00', 'en'],
    ['N05', 'محاضرات كل ثلاثاء وخميس الساعة 8 الصبح، ومحاضرة ضيف الثلاثاء الساعة 8 الصبح', 'Guest lecture', 'محاضرة ضيف', '08:00', 'ar'],
    ['N07', 'swimming every Tuesday and Thursday at 6pm, and my swim test is Tuesday at 6pm', 'Swim test', 'Swim test', '18:00', 'en'],
  ] as const) {
    const { body } = await chatOnce(`Round5Leak${label}`, message, [item(title, appTitle, TUE_6, time)], { locale, now: MON_10 });
    const items = body.proposal!.items as HintItem[];
    assert.equal(items.length, 1, label);
    assert.ok(!items[0]!.recurrenceHint || items[0]!.recurrenceHint.weekdays.length < 2, `${label}: ${JSON.stringify(items[0])}`);
  }
});

test('round 5 #1: an inflected form of the item\u2019s own title still spreads its copies — «عالنادي», «اما الثلاثاء…»', async () => {
  for (const [label, message, title, appTitle, time] of [
    ['N09', 'بروح عالنادي الثلاثاء والخميس الساعة 6 المسا', 'Club', 'النادي', '18:00'],
    ['N13', 'اما الثلاثاء والخميس عندي جيم الساعة 7 المسا', 'Gym', 'جيم', '19:00'],
  ] as const) {
    const { body } = await chatOnce(`Round5Spread${label}`, message, [item(title, appTitle, TUE_6, time), item(title, appTitle, TUE_6, time)], { locale: 'ar', now: MON_10 });
    assert.deepEqual(body.proposal!.items.map((entry) => local(entry.resolvedTime)), [`${TUE_6} ${time}`, `${THU_8} ${time}`], label);
  }
});

test('round 5 #2: exact copies with no list are one card, and never clash with themselves', async () => {
  for (const [label, message, title, appTitle, time, locale] of [
    ['C18', 'dentist Tuesday at 4pm', 'Dentist', 'Dentist', '16:00', 'en'],
    ['N12', 'gym either Tuesday or Thursday at 7pm', 'Gym', 'Gym', '19:00', 'en'],
    ['N23', 'بكرا الساعة 5 المسا اتصل بماما', 'Call mom', 'اتصل بماما', '17:00', 'ar'],
    ['N24', 'الثلاثاء والخميس عندي دوام، وبكرا الساعة 5 المسا اتصل بماما', 'Call mom', 'اتصل بماما', '17:00', 'ar'],
  ] as const) {
    const { body } = await chatOnce(`Round5Copies${label}`, message, [item(title, appTitle, TUE_6, time), item(title, appTitle, TUE_6, time)], { locale, now: MON_10 });
    assert.equal(body.proposal!.items.length, 1, `${label}: ${JSON.stringify(timedAs(body.proposal!.items))}`);
    assert.equal(body.proposal!.items[0]!.conflicts, undefined, label);
    assert.doesNotMatch(body.reply, /clashes with|بيتعارض/, label);
  }
});

test('round 5 #1: one word that merely begins another is not the same word; a plural is', async () => {
  // "work" is not "worker": the worker's visit is not spread over the work days.
  const worker = await chatOnce('Round5Worker', 'I work every Tuesday and Thursday at 9am, and the worker comes too',
    [item('Worker', 'Worker', TUE_6, '09:00'), item('Worker', 'Worker', TUE_6, '09:00')], { now: MON_10 });
  assert.ok(worker.body.proposal!.items.every((entry) => !local(entry.resolvedTime)?.startsWith(THU_8)), JSON.stringify(timedAs(worker.body.proposal!.items)));
  // «محاضرات» is the plural of «محاضرة»: the lectures are spread.
  const lectures = await chatOnce('Round5Lectures', 'محاضرات كل ثلاثاء وخميس الساعة 8 الصبح',
    [item('Lecture', 'محاضرة', TUE_6, '08:00'), item('Lecture', 'محاضرة', TUE_6, '08:00')], { locale: 'ar', now: MON_10 });
  assert.deepEqual(lectures.body.proposal!.items.map((entry) => local(entry.resolvedTime)), [`${TUE_6} 08:00`, `${THU_8} 08:00`]);
});

test('round 5 #2: an item never clashes with its identical twin at the same instant', () => {
  const at6 = '2026-10-06T15:00:00.000Z';
  const proposal = { items: [{ itemId: 'a', title: 'Gym' }, { itemId: 'b', title: 'Gym' }, { itemId: 'c', title: 'Dinner' }] };
  const candidate = { dueAt: at6, endAt: null, kind: 'scheduled_event' as const };
  const shown = withProposalClashes(proposal, new Map([['a', candidate], ['b', candidate], ['c', candidate]]));
  assert.deepEqual(shown.items.map((entry) => (entry as { conflicts?: Array<{ title: string | null }> }).conflicts?.map((conflict) => conflict.title)),
    [['Dinner'], ['Dinner'], ['Gym', 'Gym']]);
});
