/**
 * A day word is a whole word, and a greeting does not swallow a commitment
 * (CL1, after the part-of-day fix).
 *
 * The relative days were read as substrings, the way the parts of the day
 * were:
 *
 *   «لازم أحضّر الغداء اليوم الساعة 2 الظهر»  «غدا» inside «الغداء» (lunch)
 *        → tomorrow 14:00, title «أحضّر ال ء»
 *   «أكتب التقرير اليومي»   «اليوم» inside «اليومي» (daily) → today,
 *        title «أكتب التقرير ي»
 *   «بدي أرتب اليومين الجاية»  «اليوم» inside «اليومين» (two days) → today
 *
 * They now follow the same rule as the parts of the day (`timeLexicon.ts`):
 * the proclitics the product reads may come before the word («واليوم»,
 * «ومחר», «למחר», «מהיום»), nothing but diacritics after it («غداً», «غدًا»),
 * and a title never loses letters to a partial match. "today's report" is a
 * possessive naming the report, as "the morning report" is: not a day.
 *
 * A greeting in front of a stated commitment used to make the whole message
 * small talk: "good morning, call mom tomorrow" and «בוקר טוב, להתקשר לאמא
 * מחר» created nothing. A greeting now creates nothing only when nothing but
 * greeting and small talk is left once it is taken out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { classifyMessageKind } from '../../src/extraction/messageKind.ts';
import { localTimeSpecFor, namesDay, timeOfDayEvidence } from '../../src/extraction/timeLexicon.ts';

const TZ = 'Asia/Jerusalem';
/** Saturday 26 Sep 2026, 10:00 in Jerusalem. */
const NOW = new Date('2026-09-26T07:00:00.000Z');
const TODAY = '2026-09-26';
const TOMORROW = '2026-09-27';
const AFTER_TOMORROW = '2026-09-28';

async function proposeRules(text: string, at: Date = NOW) {
  setStorageForTests(createMemoryStorage());
  try {
    // No participant: no AI consent, so the capture is read by the rules.
    return await proposeMobileCapture({ text, timezone: TZ, referenceTime: at.toISOString() });
  } finally {
    resetStorageForTests();
  }
}

type Proposal = Awaited<ReturnType<typeof proposeRules>>;
type Item = Proposal['items'][number];
const localTime = (item: Item): string | null => item.resolvedTime
  ? localTimeSpecFor(new Date(item.resolvedTime), TZ)?.time ?? null
  : null;

async function oneItem(text: string): Promise<Item> {
  const proposal = await proposeRules(text);
  assert.equal(proposal.items.length, 1, `${text}: ${JSON.stringify(proposal)}`);
  return proposal.items[0]!;
}

// ── Day words: the literal probes, through the real capture service ──

test('«لازم أحضّر الغداء اليوم الساعة 2 الظهر» is today at 14:00, and lunch stays in the title', async () => {
  const item = await oneItem('لازم أحضّر الغداء اليوم الساعة 2 الظهر');
  assert.equal(item.resolvedDate, TODAY, '«غدا» inside «الغداء» made it tomorrow');
  assert.equal(localTime(item), '14:00');
  assert.equal(item.title, 'أحضّر الغداء');
});

test('«أكتب التقرير اليومي» names no day: «اليومي» is "daily"', async () => {
  const item = await oneItem('أكتب التقرير اليومي');
  assert.equal(item.resolvedDate ?? null, null, `«اليومي» set a day: ${item.resolvedDate}`);
  assert.equal(item.resolvedTime, null);
  assert.equal(item.title, 'أكتب التقرير اليومي');
});

const DAY_CASES: ReadonlyArray<readonly [string, string | null, string]> = [
  // text, the day it lands on (null: none), its title
  ['لازم أكتب التقرير اليومي بكرا', TOMORROW, 'أكتب التقرير اليومي'],
  ['بدي أطبخ غداء بكرا', TOMORROW, 'أطبخ غداء'],
  ['أحضر الغدا بكرا', TOMORROW, 'أحضر الغدا'],
  ['بدي أرتب اليومين الجاية', null, 'أرتب اليومين الجاية'],
  ['لازم أخلص الشغل غداً', TOMORROW, 'أخلص الشغل'],
  ['لازم أخلص الشغل غدًا', TOMORROW, 'أخلص الشغل'],
  ['اتصل بأمي بعد بكرا', AFTER_TOMORROW, 'اتصل بأمي'],
  ['לסיים את הדוח היומי מחר', TOMORROW, 'לסיים את הדוח היומי'],
  ['להכין תיק למחר', TOMORROW, 'להכין תיק'],
  ['להתקשר לאמא מחרתיים', AFTER_TOMORROW, 'להתקשר לאמא'],
  ['להתקשר למחרוזת', null, 'להתקשר למחרוזת'],
  ['ללמוד למחרת המבחן', null, 'ללמוד למחרת המבחן'],
  ["finish today's report tomorrow", TOMORROW, "finish today's report"],
  ["read today's paper", null, "read today's paper"],
];

for (const [text, day, title] of DAY_CASES) {
  test(`«${text}»: ${day ?? 'no day'}, title «${title}»`, async () => {
    const item = await oneItem(text);
    assert.equal(item.resolvedDate ?? null, day);
    assert.equal(item.title, title);
  });
}

const TIMED_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  // text, day, local time, title
  ['اتصل بأمي واليوم المسا', TODAY, '18:00', 'اتصل بأمي'],
  ['اتصل بأمي هالمسا', TODAY, '18:00', 'اتصل بأمي'],
  ['اتصل بأمي بعد بكرة الصبح', AFTER_TOMORROW, '09:00', 'اتصل بأمي'],
  ['להתקשר לאמא ומחר בבוקר', TOMORROW, '09:00', 'להתקשר לאמא'],
  ['call mom this evening', TODAY, '18:00', 'call mom'],
  ['call mom this afternoon', TODAY, '14:00', 'call mom'],
];

for (const [text, day, time, title] of TIMED_CASES) {
  test(`«${text}» is ${day} ${time}`, async () => {
    const item = await oneItem(text);
    assert.equal(item.clarification ?? null, null, JSON.stringify(item.clarification));
    assert.equal(item.resolvedDate, day);
    assert.equal(localTime(item), time);
    assert.equal(item.title, title);
  });
}

test('"call mom this morning" is today\'s morning, and a passed one is treated as «اليوم الصبح» is', async () => {
  // 06:00 in Jerusalem: the morning is still ahead.
  const early = (await proposeRules('call mom this morning', new Date('2026-09-26T03:00:00.000Z'))).items;
  assert.equal(early.length, 1);
  assert.equal(early[0]!.resolvedDate, TODAY);
  assert.equal(localTime(early[0]!), '09:00');
  // 10:00: the morning has passed. Whatever the product does with a passed
  // «اليوم الصبح», it does with "this morning" — it is the same statement.
  const english = await proposeRules('call mom this morning');
  const arabic = await proposeRules('اتصل بأمي اليوم الصبح');
  assert.equal(english.status, arabic.status);
  assert.equal(english.items.length, arabic.items.length);
});

test('the lexicon: a day word inside another word is not a day', () => {
  for (const word of ['الغداء', 'غداء', 'الغدا', 'اليومي', 'اليومية', 'اليومين', 'יומי', 'היומי', 'מחרוזת', 'למחרת', 'todays', "today's"]) {
    assert.equal(namesDay(word), false, `«${word}» named a day`);
    assert.equal(timeOfDayEvidence(word), 'none', `«${word}» evidence`);
  }
  for (const word of ['اليوم', 'واليوم', 'بكرا', 'لبكرا', 'وبكرا', 'غدا', 'غداً', 'غدًا', 'بعد بكرا', 'היום', 'והיום', 'מהיום', 'מחר', 'ומחר', 'למחר', 'ממחר', 'מחרתיים', 'today', 'tomorrow', 'this evening']) {
    assert.equal(namesDay(word), true, `«${word}» named no day`);
  }
});

// ── A greeting does not swallow a commitment ─────────────────────────

const GREETED: ReadonlyArray<readonly [string, string, string]> = [
  // text, day, title
  ['good morning, call mom tomorrow', TOMORROW, 'call mom'],
  ['صباح الخير، ذكرني أتصل بأمي بكرا', TOMORROW, 'أتصل بأمي'],
  ['בוקר טוב, להתקשר לאמא מחר', TOMORROW, 'להתקשר לאמא'],
  ['Morning, call mom tomorrow', TOMORROW, 'call mom'],
  ['ok call mom tomorrow', TOMORROW, 'call mom'],
  // "run tomorrow" is captured, so "morning run tomorrow" is too. "Morning"
  // modifies "run" here, which by the part-of-day rule is not a stated time:
  // the day is kept and the hour asked.
  ['morning run tomorrow', TOMORROW, 'morning run'],
  ['evening walk with dad tomorrow', TOMORROW, 'evening walk with dad'],
  // «שלום» is a name here, and «الإسلام» only contains «سلام».
  ['להתקשר לשלום מחר', TOMORROW, 'להתקשר לשלום'],
  ['اقرأ عن الإسلام بكرا', TOMORROW, 'اقرأ عن الإسلام'],
];

for (const [text, day, title] of GREETED) {
  test(`«${text}» keeps its commitment`, async () => {
    const proposal = await proposeRules(text);
    assert.notEqual(proposal.status, 'no_commitment', `dropped as ${JSON.stringify(proposal)}`);
    assert.equal(proposal.items.length, 1, JSON.stringify(proposal.items));
    const [item] = proposal.items;
    assert.equal(item!.resolvedDate, day);
    assert.equal(item!.title, title);
    // A greeting is never the time.
    assert.equal(item!.resolvedTime, null, `a greeting became an hour: ${item!.resolvedTime}`);
  });
}

test('a greeting is a whole word: «לשלום», «الإسلام», «هلال» are not greetings', () => {
  for (const text of ['להתקשר לשלום', 'اقرأ عن الإسلام', 'شوف الهلال', 'לבדוק מה היית אמור']) {
    assert.equal(classifyMessageKind(text), 'request', text);
  }
});

test('a greeting with only small talk after it still creates nothing', () => {
  for (const text of [
    'good morning', 'صباح الخير', 'בוקר טוב', 'hey how are you', 'good morning صباح الخير', 'hi there',
    'good morning everyone', 'thanks, see you tomorrow', 'good night, see you tomorrow', 'ok thanks',
    'have a great day tomorrow', 'تصبح على خير، بشوفك بكرا', 'לילה טוב, נתראה מחר', 'Morning!',
  ]) {
    assert.equal(classifyMessageKind(text), 'greeting_or_chat', text);
  }
});
