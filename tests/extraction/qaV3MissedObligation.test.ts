/**
 * QA v3 (2026-11-19), V3-F04-03: the deterministic missed-thing reading
 * (`src/extraction/missedObligation.ts`), kept in a file of its own so the
 * reading can be removed whole. The other fixes are in qaV3CaptureTime.test.ts.
 *
 *   F04-03  a thing the person was supposed to do and did not («مبارح الساعة 9
 *           الصبح كان لازم أبعت الواجب للدكتور وما بعتته») is captured as a
 *           thing to do today (owner decision 2026-11-19: "to-do now"), its
 *           hour asked; nothing "late" or "missed". Something that only
 *           happened («امبارح كان عندي اجتماع») still makes nothing.
 *   F04-04  «بعد ساعة», «بعد ساعتين», «بعد نص ساعة», «بعد ربع ساعة», «بعد 3
 *           ساعات» (Arabic and Latin digits), "in 2 hours", «בעוד שעתיים» are
 *           now plus that much, on both engines (a model's 12-hour slip is
 *           overridden), and in the clarify box.
 *   F04-06  a «بكرا:» / «اليوم:» list head is the day of every point on its
 *           list that names no day of its own, on both engines.
 *   F04-07  «الأسبوع الجاي: يوم الاثنين» dated a Tuesday by the model is moved
 *           to the Monday (owner, NA2.3: only when the weekday differs).
 *   F04-08  a model reading with no usable title for «بكرا الساعة 5» no longer
 *           rejects the capture (a bare 400): the rules read it and ask.
 *
 * Synthetic text only. No model is called: the "model" is a scripted provider.
 */
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { MemoryCaptureProposalStore, proposeCapture } from '../../lib/services/captureBoundary/index.ts';
import { answerClarification } from '../../lib/services/captureBoundary/clarifyService.ts';
import { TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/persistenceAdapter.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { instantFromLocal, localTimeSpecFor, readRelativeOffsetMinutes } from '../../src/extraction/timeLexicon.ts';
import { isMissedObligation } from '../../src/extraction/missedObligation.ts';
import { splitCaptureClauseDetails, splitCaptureClauses } from '../../src/extraction/clauseSplitter.ts';
import { withoutUnsaidTime } from '../../lib/services/captureBoundary/chatEvidence.ts';
import { buildChatPrompt } from '../../lib/services/captureChat/chatPrompt.ts';

const TZ = 'Asia/Jerusalem';
/** Thursday 19 November 2026, 07:12 in Jerusalem (the device time in the report). */
const NOW = new Date('2026-11-19T05:12:00.000Z');
const TODAY = '2026-11-19';
const TOMORROW = '2026-11-20';

const at = (date: string, time: string) => instantFromLocal(date, time, TZ)!.toISOString();
const when = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const local = localTimeSpecFor(new Date(iso), TZ)!;
  return `${local.date} ${local.time}`;
};

type Provider = (prompt: string) => Promise<string>;

async function propose(text: string, options: { provider?: Provider; now?: Date } = {}) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now: options.now ?? NOW, timezone: TZ, scopeId: 'qa-v3-time', requestedEngine: options.provider ? 'model' : 'rules' },
    {
      store,
      persistence,
      extractor: guardedMobileExtract,
      ...(options.provider ? { llmProvider: options.provider, llmEngine: 'gemini' as const } : {}),
    },
  );
  return { contract, store };
}

/** One model object: a task, on `date` at `time` when given. */
const modelTask = (title: string | null, date: string | null, time: string | null, over: Record<string, unknown> = {}) => ({
  type: 'task', action: title, title, person: null,
  dueAt: date && time ? at(date, time) : null, remindAt: null,
  localTimeSpec: date ? { date, time, timezone: TZ } : null,
  priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
  flexibility: 'movable', category: null, categoryConfidence: 0,
  confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 1 },
  missingFields: time ? [] : ['time'], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
  ...over,
});

/** A provider answering a single prompt, or a batch of clauses one by one. */
function scripted(answer: (clause: string) => unknown): Provider {
  return async (prompt: string) => {
    const payload = JSON.parse(/BEGIN_UNTRUSTED_USER_MESSAGE\n([\s\S]*)\nEND_UNTRUSTED_USER_MESSAGE/.exec(prompt)![1]!);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((clause: string, clauseIndex: number) => ({ clauseIndex, ...(answer(clause) as object) })) })
      : JSON.stringify(answer(payload));
  };
}

/** A chat item's reading as the model gave it, before the guard. */
const chatReading = (date: string, time: string | null) => ({ ...modelTask('آخد الدوا', date, time), rawText: 'آخد الدوا' }) as unknown as Parameters<typeof withoutUnsaidTime>[0];

/* ── V3-F04-03: a missed thing is a thing to do today ────────────────── */

const MISSED = 'مبارح الساعة 9 الصبح كان لازم أبعت الواجب للدكتور وما بعتته';

function assertToDoToday(contract: Awaited<ReturnType<typeof propose>>['contract'], titleWords: RegExp) {
  assert.equal(contract.status, 'needs_clarification');
  assert.equal(contract.items.length, 1);
  const item = contract.items[0]!;
  assert.equal(item.resolvedDate, TODAY, 'on today');
  assert.equal(item.resolvedTime, null, 'no hour picked for the person');
  assert.match(item.title, titleWords);
  assert.ok(!/مبارح|امبارح|كان لازم|ما بعت|نسيت|yesterday|supposed|didn't|forgot/i.test(item.title), item.title);
  assert.equal(item.clarification?.questionKey, 'ask_time');
  assert.ok(item.clarification?.options.some((option) => option.optionId === 'none'), 'no specific time is offered');
}

test('F04-03 (rules): a missed thing is proposed for today, its hour asked', async () => {
  const { contract } = await propose(MISSED);
  assertToDoToday(contract, /أبعت الواجب للدكتور/);
});

test('F04-03 (narrowed, review round 3): «نسيت أتصل بأمي مبارح» is not read as a missed thing; the ordinary reading stands', async () => {
  assert.equal(isMissedObligation('نسيت أتصل بأمي مبارح'), false);
});

test('F04-03 (rules): "I was supposed to call the bank yesterday and didn\'t" is to do today', async () => {
  const { contract } = await propose("I was supposed to call the bank yesterday and didn't");
  assertToDoToday(contract, /call the bank/i);
});

test('F04-03 (model path): the model\'s yesterday 09:00 becomes today with no hour', async () => {
  const { contract } = await propose(MISSED, { provider: scripted(() => modelTask('أبعت الواجب للدكتور', '2026-11-18', '09:00')) });
  assertToDoToday(contract, /أبعت الواجب للدكتور/);
});

test('F04-03 (model path): a model "nothing here" for a missed thing is read by the rules instead', async () => {
  const { contract } = await propose(MISSED, { provider: scripted(() => modelTask(null, null, null, { type: 'informational_context' })) });
  assertToDoToday(contract, /أبعت الواجب للدكتور/);
});

for (const text of ['امبارح كان عندي اجتماع مع المدير', 'مبارح كان عندي موعد عند الدكتور الساعة 9', 'yesterday I had a meeting with the manager']) {
  test(`F04-03: «${text}» happened; nothing is made`, async () => {
    const { contract } = await propose(text);
    assert.equal(contract.status, 'no_commitment');
    assert.equal(contract.items.length, 0);
  });
}

test('F04-03: a missed thing the person puts on a day of their own keeps that day', async () => {
  const { contract } = await propose('نسيت أتصل بأمي مبارح، بدي أتصل فيها بكرا الساعة 5 المسا');
  assert.ok(contract.items.some((item) => when(item.resolvedTime) === `${TOMORROW} 17:00`), JSON.stringify(contract.items));
});

test('chat: a missed thing keeps today, the day the owner decided for it', () => {
  const kept = withoutUnsaidTime(chatReading(TODAY, null), [MISSED.replace('الساعة 9 الصبح ', '')], NOW, TZ);
  assert.equal(kept.result.localTimeSpec?.date, TODAY);
});

/* ── Review of #872: precision of the missed-thing reading, and the gaps ── */

for (const text of [
  // Somebody else's obligation.
  'كان لازم يبعتلي وما بعت',
  'كان لازم تبعتلي الواجب وما بعتيه',
  'كان لازم تيجي مبارح وما إجيت',
  // No obligation of the speaker's that was left undone.
  'كان لازم يكون هون بس ما كان',
  'كان لازم أنام بدري، ما بعرف شو صار',
  'مبارح كان لازم أشتغل بس ما تعبت',
  'كان لازم أروح للدكتور ومش عارف ليش ما رحت',
  // A question, or the obligation itself negated.
  'هل كان لازم أبعت الواجب وما بعتته؟',
  'مش كان لازم أبعت الواجب؟',
  'ما كان لازم أبعت الواجب',
  'ما نسيت أدفع الفاتورة',
  'لسا ما نسيت أبعت الواجب',
  "I didn't forget to pay",
  // «نسيت» / «ما لحقت» before something that is not a thing to do.
  'نسيت اسمه',
  'نسيت إنو اليوم عيد ميلادها',
  'نسيت شو كنت بدي أقول',
  'ما لحقت الباص',
  'بدي أنسى كل شي ما بدي أتذكر',
  'I forgot to tell you thanks',
  "I had to work yesterday and haven't slept",
  'I needed to buy milk, never mind, my wife did',
  // Something that happened.
  'مبارح كان عندي اجتماع',
]) {
  test(`review #872: «${text}» is not a missed thing, and no to-do today is made of it`, async () => {
    assert.equal(isMissedObligation(text), false);
    const { contract } = await propose(text);
    assert.ok(!contract.items.some((item) => item.resolvedDate === TODAY && item.resolvedTime === null && item.clarification?.questionKey === 'ask_time'
      && !/لازم|نسيت|لحقت|forgot|had to|needed/i.test(text.replace(item.title, ''))), JSON.stringify(contract.items));
  });
}

for (const [text, words] of [
  ['كنت لازم أبعت الواجب مبارح وما بعتّه', /أبعت الواجب/],
  ['كان لازم ابعت الواجب وما بعتتو', /ابعت الواجب/],
  ['كان المفروض أدفع الفاتورة أمس وما دفعت', /أدفع الفاتورة/],
  ['كان لازم أسلّم التقرير وما سلّمت', /أسلّم التقرير/],
  ['I should have called the bank this morning but I did not', /called the bank|call the bank/i],
  ['كان لازم أبعت الواجب للدكتور وما بعتّه', /^أبعت الواجب للدكتور$/],
  ['كنت لازم أسلّم التقرير مبارح وما سلّمته', /^أسلّم التقرير$/],
  ['I was supposed to call mom and didn\'t', /^call mom$/i],
] as const) {
  test(`review #872: «${text}» is still a thing to do today`, async () => {
    assert.equal(isMissedObligation(text), true);
    assertToDoToday((await propose(text)).contract, words);
  });
}

test('review #872 (M5): a missed thing beside a day ahead of the person\'s own is read as said, not as today', () => {
  assert.equal(isMissedObligation('نسيت أبعت الواجب وبدي أبعته بكرا'), false);
  assert.equal(isMissedObligation('كان لازم أبعت الواجب وما بعتته، يوم الأحد الساعة 5 بدي أبعته'), false);
});

for (const text of [
  // N2: the obligation itself negated, then a not-done.
  'ما كان لازم أدفع الفاتورة وما دفعتها',
  // N4: the second person's obligation, whose past reads like the speaker's.
  'كان لازم تتصل فيي وما اتصلت',
  // N5: the not-done words are another sentence's.
  'مبارح كان لازم أدفع الإيجار ودفعته. ما دفعت الكهربا لأنها مش عليّ',
]) {
  test(`review #872 (round 2): «${text}» is not a missed thing`, () => {
    assert.equal(isMissedObligation(text), false);
  });
}

/* ── Review round 3: one narrow pattern (coordinator decision) ────────── */

const SENTENCES = JSON.parse(readFileSync(new URL('./fixtures/qaV3MissedSentences.json', import.meta.url), 'utf8')) as {
  negatives: string[]; disputed: string[]; positives: string[]; notRead: string[];
  narrowedRound4: Record<string, string>; disputedStillRead: string[];
};

test('round 3: none of the reviewer\'s 337 non-missed sentences is read as a missed thing', () => {
  const read = SENTENCES.negatives.filter((text) => isMissedObligation(text));
  assert.deepEqual(read, []);
});

test('round 3: the reviewer\'s sentences of the defect\'s own shape are still read (39 since round 4)', () => {
  const unread = SENTENCES.positives.filter((text) => !isMissedObligation(text));
  assert.deepEqual(unread, []);
});

test('round 4: of the seven disputed in round 3, only «٣٠ دينار … وما دفعت…» — the positives\' own shape — is still read (coordinator: the others are not)', () => {
  assert.deepEqual(SENTENCES.disputed.filter((text) => isMissedObligation(text)), SENTENCES.disputedStillRead);
});

test('round 4: the round-3 positives given up by the narrowing are not read, each for its stated reason', () => {
  assert.equal(Object.keys(SENTENCES.narrowedRound4).length, 10);
  assert.deepEqual(Object.keys(SENTENCES.narrowedRound4).filter((text) => isMissedObligation(text)), []);
});

for (const text of [
  // The narrowed families: no longer read here (ordinary reading, chat prompt).
  'نسيت أبعت الواجب للدكتور', 'ما لحقت أدفع الفاتورة', 'فاتني أتصل بالدكتور', 'كنت ناوي أبعت الواجب وما بعتته',
  'I forgot to send the homework yesterday', "I didn't get to call the bank", 'I never got to call the bank',
  'שכחתי לשלם את החשבון', 'הייתי צריך להתקשר ולא התקשרתי', 'לא הייתי צריך להתקשר ולא התקשרתי',
  // Somebody else, or no speaker before the obligation (M13).
  "She was supposed to call and didn't", 'كان لازم أبعت بس هو ما بعت', 'كان لازم أروح بس هي ما راحت', 'كان لازم ابعت الواجب بس ما بعتلي حدا الرابط',
  // Negation, a question or a condition before it, with no question mark (M3, M16).
  'هل كان لازم أبعت الواجب وما بعتته', 'مش كان لازم أبعت الواجب وما بعتته', 'مو كنت لازم أدفع وما دفعت', 'مب كان لازم أدفع وما دفعت',
  'لو كان لازم أبعت الواجب وما بعتّه', 'ليش كان لازم أروح وما رحت', 'ممكن كان لازم أبعت الواجب وما بعتّه', 'قال كان لازم أبعت الواجب وما بعتّه',
  "If I was supposed to pay and didn't, tell me", "Why I had to pay and didn't",
  // A question mark alone (M15).
  'كان لازم أبعت الواجب وما بعتته؟',
  // Not the same verb (M1: first letter; C2: last letter).
  'كان لازم أبعت الواجب بس ما قدرت', 'كان لازم أدفع الفاتورة وما دريت',
  // Not the speaker's past: a bare «بعت» may be "he sent".
  'كان لازم أبعت الواجب وما بعت',
  // States, not things to do.
  'كان بدي أنام بس ما نمت', 'كان لازم أتأخر وما تأخرت', "I had to cry and didn't",
]) {
  test(`round 3: «${text}» is not a missed thing`, () => {
    assert.equal(isMissedObligation(text), false);
  });
}

test('round 3: a vowelled verb is still the same verb («أبعَث … بعَثتُه»)', () => {
  assert.equal(isMissedObligation('كان لازم أبعَت الواجب وما بعَتّه'), true);
});

test('round 3: the not-done verb in somebody else\'s past, or with its subject after it, is not the speaker\'s', () => {
  assert.equal(isMissedObligation('كان لازم أدفع الفاتورة وما دفع'), false);
  assert.equal(isMissedObligation('كان لازم أبعت الواجب بس ما بعته حدا'), false);
});

test('round 3: the card of a missed thing never says it is late', async () => {
  const { contract } = await propose(MISSED, { provider: scripted(() => modelTask('أبعت الواجب متأخر', '2026-11-18', '09:00')) });
  assert.ok(!/متأخر|فات/.test(contract.items[0]!.title), contract.items[0]!.title);
});

test('round 3: a filler before the obligation does not hide it («أنا كان لازم…»)', () => {
  assert.equal(isMissedObligation('أنا كان لازم أبعت الواجب وما بعتته'), true);
  assert.equal(isMissedObligation('والله كان لازم أدفع الفاتورة وما دفعتها'), true);
});

/* ── Review round 4: an action verb onto a real object, said by the speaker ── */

const ROUND4 = JSON.parse(readFileSync(new URL('./fixtures/qaV3MissedRound4.json', import.meta.url), 'utf8')) as {
  negatives: Record<'neg' | 'neg2' | 'dis' | 'misc' | 'guard', string[]>;
  pinned: string[]; positives: string[]; narrowedPositives: Record<string, string>;
};

for (const group of ['neg', 'neg2', 'dis', 'misc', 'guard'] as const) {
  test(`round 4: none of the reviewer's «${group}» sentences is read as a missed thing`, () => {
    assert.deepEqual(ROUND4.negatives[group].filter((text) => isMissedObligation(text)), []);
  });
}

/** Framing, lateness or an English past form left in a card title. */
const UNCLEAN_TITLE = /كان|كنت|لازم|المفروض|علي |بدي|فاتني|متأخر|supposed|should|had to|needed|meant|didn|haven|never|^to |late|ed\b/i;

test('round 4: the reviewer\'s 48 positives are still read, each a to-do today with a clean title', async () => {
  const unread = ROUND4.positives.filter((text) => !isMissedObligation(text));
  assert.deepEqual(unread, []);
  for (const text of ROUND4.positives) {
    const { contract } = await propose(text);
    const item = contract.items[0]!;
    assert.equal(item.resolvedDate, TODAY, text);
    assert.equal(item.resolvedTime, null, text);
    assert.ok(!UNCLEAN_TITLE.test(item.title), `${text} → ${item.title}`);
  }
});

test('round 4: the two positives given up on purpose are not read (going somewhere; «بدي» is a wish)', () => {
  assert.deepEqual(Object.keys(ROUND4.narrowedPositives).filter((text) => isMissedObligation(text)), []);
});

test('round 4: «٣٠ دينار … وما دفعت…» keeps the positives\' exact shape and is read, pinned', () => {
  assert.ok(ROUND4.pinned.every((text) => isMissedObligation(text)));
});

test('round 4: an English title in the past is put back to the verb («should have renewed» → «renew»)', async () => {
  const { contract } = await propose("I should have renewed my license and I didn't");
  assert.equal(contract.items[0]!.title, 'renew my license');
});

test('round 4: a feeling the model rightly called nothing stays nothing — the reading never overrides it', async () => {
  for (const text of ['كان لازم أصبر وما صبرت', "I should have known and I didn't", 'كان لازم أحضر الحفلة مبارح وما حضرت']) {
    const { contract } = await propose(text, { provider: scripted(() => modelTask(null, null, null, { type: 'unknown' })) });
    assert.equal(contract.items.length, 0, text);
  }
});

for (const [text, label] of [
  ['كان لازم أدفع الفاتورة وأمي ما دفعت', 'somebody named before «ما»'],
  ['كان لازم أسلم الواجب بس الدكتورة ما سلمت', 'somebody after «بس»'],
  ['كان لازم أبعت الواجب وما بلغت', 'another verb with the same first and last letter'],
  ['كان لازم أصبر وما صبرت', 'a verb with no object'],
  ['كان لازم أكون هناك وما كنت', 'a place word as the only object'],
  ['كان لازم أرد عليه بقسوة وما رديت', 'a pronoun as the only object'],
  ['كان لازم أحضر الحفلة مبارح وما حضرت', 'an event whose time has gone'],
  ['كنت بدي أسافر وما سافرت', 'a wish («بدي»)'],
  ['كان لازم أدفع كل شهر وما دفعت', 'a recurrence'],
  ['كان لازم أدفع الفاتورة يوم ٢٥ نوفمبر وما دفعت', 'a calendar date of its own'],
  ['كان لازم أعمل واجبي ما عملته', 'no joiner before «ما»'],
  ['I was supposed to win and I didn\'t', 'an English verb with no object'],
  ['I had to forgive him and I didn\'t', 'an English pronoun object'],
  ['I was supposed to attend the meeting and I didn\'t', 'an English event'],
] as const) {
  test(`round 4: «${text}» (${label}) is not a missed thing`, () => {
    assert.equal(isMissedObligation(text), false);
  });
}

test('round 4: an opening filler is still allowed («So I was supposed to…»)', () => {
  assert.equal(isMissedObligation("So I was supposed to call the bank and I didn't"), true);
  assert.equal(isMissedObligation("Today I was supposed to call the bank and I didn't"), true);
});
