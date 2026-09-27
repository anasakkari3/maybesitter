/**
 * A part of the day is a whole word (CL1, found by the CL5a review).
 *
 * The part-of-day lexicon matched substrings, so a word that *contains* one
 * became a time the person never said:
 *
 *   «طلب المساعدة يوم الأحد»   «المسا» inside «المساعدة» (help)   → 18:00
 *   «المسافة» (the distance)    «المسا»                            → 18:00
 *   «המערב» (the west)          «ערב»                              → 18:00
 *   «ערבית» (Arabic)            «ערב»                              → 18:00
 *   "send the morning report"   "morning" naming a report          → 09:00
 *
 * The rule, per language:
 *   Arabic  the word may carry the proclitics the product already reads
 *           (و/ف, then ب/ل/ك or the spoken ع: «وبالمسا», «عالمسا»), and
 *           nothing after it but diacritics and the accusative alif of
 *           «صباحاً»/«مساءً». A nisba adjective («الصباحي», «المسائي») names
 *           a kind of thing, not a time. «صباح الخير» is a greeting.
 *   Hebrew  prefixes ו/ש, then ב/ל/כ (optionally with ה), ה, or מה —
 *           «ובערב», «הערב», «מהבוקר». Not a bare מ: «מערב» is "west" and
 *           «מבוקר» is "audited". Nothing after it. «בוקר טוב» is a greeting.
 *   English whole words, and framed as a time: after a day or a time
 *           preposition ("tomorrow morning", "in the morning", "Sunday
 *           evening", "at night") or closing its phrase ("call mom,
 *           evening"). Directly before another word it modifies it — "the
 *           morning report", "night shift" — and is not a time. "Good
 *           morning" is a greeting.
 *
 * When a word is ambiguous the answer is "no part of the day": a miss costs
 * the item one question, a false hit schedules an hour nobody said.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import {
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { dayPartHour, localTimeSpecFor, timeOfDayEvidence } from '../../src/extraction/timeLexicon.ts';

const TZ = 'Asia/Jerusalem';
/** Saturday 26 Sep 2026, 10:00 in Jerusalem. Sunday is the 27th. */
const NOW = new Date('2026-09-26T07:00:00.000Z');

async function proposeRules(text: string) {
  setStorageForTests(createMemoryStorage());
  try {
    // No participant: no AI consent, so the capture is read by the rules.
    return await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() });
  } finally {
    resetStorageForTests();
  }
}

type Item = Awaited<ReturnType<typeof proposeRules>>['items'][number];
/** The hour an item landed on, on the user's clock, or null for none. */
const localTime = (item: Item): string | null => item.resolvedTime
  ? localTimeSpecFor(new Date(item.resolvedTime), TZ)?.time ?? null
  : null;

// ── The literal probes, through the real capture service ─────────────

const NEGATIVES: ReadonlyArray<readonly [string, string]> = [
  ['طلب المساعدة يوم الأحد', 'المساعدة'],
  ['لازم أحسب المسافة بكرا', 'المسافة'],
  ['לבדוק את המערב מחר', 'המערב'],
  ['ללמוד ערבית מחר', 'ערבית'],
  ['send the morning report Sunday', 'morning report'],
  ['send morning report tomorrow', 'morning report'],
  ['الاجتماع الصباحي يوم الأحد', 'الصباحي'],
  ['بدي أحل المسائل بكرا', 'المسائل'],
  ['night shift on Sunday', 'night shift'],
];

for (const [text, word] of NEGATIVES) {
  test(`«${text}»: «${word}» is not a part of the day, so no hour is proposed`, async () => {
    const proposal = await proposeRules(text);
    assert.equal(proposal.items.length, 1, JSON.stringify(proposal.items));
    const [item] = proposal.items;
    assert.equal(localTime(item!), null, `an hour nobody said: ${localTime(item!)}`);
    assert.equal(item!.resolvedTime, null);
    // The day is still read, and the hour is asked.
    assert.equal(item!.clarification?.questionKey, 'ask_time');
    // And the word stays in the title whole.
    assert.ok(item!.title.includes(word.split(' ')[0]!), `title lost «${word}»: «${item!.title}»`);
  });
}

const POSITIVES: ReadonlyArray<readonly [string, string, string]> = [
  // text, local date, local time
  ['اتصل بأمي بكرا المسا', '2026-09-27', '18:00'],
  ['اتصل بأمي بكرا الصبح', '2026-09-27', '09:00'],
  ['اتصل بأمي بكرا العصر', '2026-09-27', '14:00'],
  ['اتصل بأمي بكرا بالليل', '2026-09-27', '20:00'],
  ['اتصل بأمي بكرا عالمسا', '2026-09-27', '18:00'],
  ['اتصل بأمي بكرا وبالمسا', '2026-09-27', '18:00'],
  ['اتصل بأمي بكرا مساءً', '2026-09-27', '18:00'],
  ['اتصل بأمي بكرا صباحًا', '2026-09-27', '09:00'],
  ['اتصل بأمي بكرا بعد الظهر', '2026-09-27', '14:00'],
  ['اتصل بأمي بكرا بالعصرية', '2026-09-27', '14:00'],
  ['اتصل بأمي الليلة', '2026-09-26', '20:00'],
  ['להתקשר לאמא מחר בערב', '2026-09-27', '18:00'],
  ['להתקשר לאמא מחר בבוקר', '2026-09-27', '09:00'],
  ['להתקשר לאמא מחר ובערב', '2026-09-27', '18:00'],
  ['להתקשר לאמא הערב', '2026-09-26', '18:00'],
  ['להתקשר לאמא מחר אחר הצהריים', '2026-09-27', '14:00'],
  ['call mom tomorrow evening', '2026-09-27', '18:00'],
  ['call mom tomorrow morning', '2026-09-27', '09:00'],
  ['call mom Sunday morning', '2026-09-27', '09:00'],
  ['call mom tomorrow in the morning', '2026-09-27', '09:00'],
  ['call mom tonight', '2026-09-26', '20:00'],
];

for (const [text, date, time] of POSITIVES) {
  test(`«${text}» is still ${date} ${time}`, async () => {
    const proposal = await proposeRules(text);
    assert.equal(proposal.items.length, 1, JSON.stringify(proposal.items));
    const [item] = proposal.items;
    assert.equal(item!.clarification ?? null, null, JSON.stringify(item!.clarification));
    assert.equal(item!.resolvedDate, date);
    assert.equal(localTime(item!), time);
  });
}

test('titles keep no stray proclitic from a part of the day', () => {
  const context = { now: NOW, timezone: TZ };
  assert.equal(extract('اتصل بأمي بكرا عالمسا', context).title, 'اتصل بأمي');
  assert.equal(extract('اتصل بأمي بكرا وبالمسا', context).title, 'اتصل بأمي');
  assert.equal(extract('اتصل بأمي بكرا صباحًا', context).title, 'اتصل بأمي');
  assert.equal(extract('send the morning report Sunday', context).title, 'send the morning report');
  // The preposition goes with it: "in the morning" leaves no "in the".
  // English noon and midnight stay in the title, as they always have.
  assert.equal(extract('call mom at noon tomorrow', context).title, 'call mom at noon');
  assert.equal(extract('call mom tomorrow in the morning', context).title, 'call mom');
});

// ── The lexicon ───────────────────────────────────────────────────

test('the lexicon: a part of the day inside another word is not one', () => {
  const none: ReadonlyArray<string> = [
    'المساعدة', 'المسافة', 'المسائل', 'المساحة', 'المسار', 'الصباحي', 'المسائي', 'أصبح', 'ظهري',
    'المعاصر', 'العصري', 'العصرية', 'المساعد', 'مسائية', 'صباحية',
    'המערב', 'מערב', 'ערבית', 'ערבים', 'מבוקר', 'לילות', 'הבוקרים',
    'mornings', 'nightly', 'overnight', 'evenings',
  ];
  for (const word of none) {
    assert.equal(dayPartHour(word), null, `«${word}» read as a part of the day`);
    assert.equal(timeOfDayEvidence(word), 'none', `«${word}» evidence`);
  }
});

test('the lexicon: a greeting is not a time', () => {
  for (const text of ['صباح الخير', 'مساء الخير', 'المسا الخير', 'صباح النور', 'בוקר טוב', 'ערב טוב', 'לילה טוב', 'צהריים טובים', 'good morning', 'Good evening', 'good night']) {
    assert.equal(dayPartHour(text), null, `«${text}»`);
    assert.equal(timeOfDayEvidence(text), 'none', `«${text}»`);
  }
  // A greeting does not hide a real part of the day after it.
  assert.equal(dayPartHour('صباح الخير، اتصل بأمي بكرا المسا'), 18);
  assert.equal(dayPartHour('good morning, call mom tomorrow evening'), 18);
});

test('the lexicon: every stated part of the day, with its prefixes', () => {
  const table: ReadonlyArray<readonly [string, number]> = [
    ['بكرا المسا', 18], ['بالمسا', 18], ['وبالمسا', 18], ['فبالمسا', 18], ['عالمسا', 18], ['المساء', 18], ['مساء', 18],
    ['مساءً', 18], ['مساءا', 18], ['الصبح', 9], ['بالصبح', 9], ['عالصبح', 9], ['الصباح', 9], ['صباحا', 9],
    ['صباحاً', 9], ['صباحًا', 9], ['العصر', 14], ['بالعصر', 14], ['بالعصرية', 14], ['بعد الظهر', 14],
    ['وبعد الضهر', 14], ['الظهر', 12], ['عالضهر', 12], ['بالليل', 20], ['الليل', 20], ['الليلة', 20],
    ['منتصف الليل', 0], ['بمنتصف الليل', 0],
    ['בערב', 18], ['ובערב', 18], ['הערב', 18], ['לערב', 18], ['ערב', 18], ['בבוקר', 9], ['הבוקר', 9], ['מהבוקר', 9],
    ['שבבוקר', 9], ['בצהריים', 12], ['אחרי הצהריים', 14], ['אחר הצהריים', 14], ['אחה"צ', 14], ['בלילה', 20],
    ['הלילה', 20], ['בחצות', 0],
    ['tomorrow evening', 18], ['tomorrow morning', 9], ['Sunday morning', 9], ['in the morning', 9],
    ['this evening', 18], ['every morning', 9], ['at night', 20], ['tonight', 20], ['at noon', 12],
    ['before noon', 12], ['at midnight', 0], ['in the afternoon', 14], ['call mom, evening', 18], ['call mom evening', 18],
    ['Friday night dinner', 20], ['tomorrow morning at the bank', 9], ['morning', 9], ['evening please', 18],
  ];
  for (const [text, hour] of table) {
    assert.equal(dayPartHour(text), hour, `«${text}»`);
    assert.equal(timeOfDayEvidence(text), 'daypart', `«${text}» evidence`);
  }
});

test('the lexicon: a part of the day that modifies the next word is not a time', () => {
  for (const text of ['the morning report', 'send morning report', 'night shift', 'evening class', 'the noon meeting', 'midnight snack']) {
    assert.equal(dayPartHour(text), null, `«${text}»`);
  }
});

test('a typed answer to "when?" is read as a time even before another word', () => {
  // The clarify step asked for the hour; whatever part of the day comes back
  // is the answer, so the modifier rule does not apply to it.
  assert.equal(dayPartHour('morning is fine', { answer: true }), 9);
  assert.equal(dayPartHour('evening works', { answer: true }), 18);
  // The word boundary still does.
  assert.equal(dayPartHour('المساعدة', { answer: true }), null);
  assert.equal(dayPartHour('המערב', { answer: true }), null);
});

// ── The model path: the guard no longer lets an invented hour through ──

test('on the model path, an hour the model invents for «طلب المساعدة يوم الأحد» is not kept', async () => {
  const text = 'طلب المساعدة يوم الأحد';
  const invented = {
    type: 'task', action: 'طلب المساعدة', title: 'طلب المساعدة', person: null,
    dueAt: '2026-09-27T15:00:00Z', remindAt: null,
    localTimeSpec: { date: '2026-09-27', time: '18:00', timezone: TZ },
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.9, priority: 1 },
    missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
  };
  const provider = async (prompt: string): Promise<string> => {
    const lines = prompt.split('\n');
    const payload = JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((_, clauseIndex) => ({ clauseIndex, ...invented })) })
      : JSON.stringify(invented);
  };
  const contract = await proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'daypart-boundary', requestedEngine: 'model' },
    {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
      llmProvider: provider,
      llmEngine: 'gemini',
    },
  );
  assert.equal(contract.items.length, 1);
  const [item] = contract.items;
  assert.equal(item!.resolvedTime, null, `the model's invented hour survived: ${item!.resolvedTime}`);
  assert.equal(item!.clarification?.questionKey, 'ask_time');
});
