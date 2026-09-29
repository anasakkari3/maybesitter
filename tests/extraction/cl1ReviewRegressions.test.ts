/**
 * The review of the part-of-day and day-word boundaries (CL1, after aeafe7d0).
 *
 * I-1  The spoken Levantine parts of the day stopped being times on every
 *      path: «العصرية» (late afternoon), «الصبحية» (morning), «الضهرية»
 *      (midday) and «بالفترة المسائية» (in the evening period). Rules capture
 *      asked the hour, the model's correct hour was stripped by the day-only
 *      guard, and as a typed answer to "when?" they were not understood.
 *      Only «العصرية» has a second meaning ("modern"), and only in the
 *      adjective position, right after a noun with «ال»: «المدرسة العصرية».
 * I-2  A greeting in front of small talk made the small talk a commitment:
 *      "hello, tonight is the game" was proposed at 20:00. What follows a
 *      greeting is a commitment only with a request word or a leading action
 *      verb — "good morning, call mom tomorrow".
 * m-1  The email-share day reader matched «غدا» inside «الغداء».
 * m-2  «הבוקר» left the title of an item it gave no time to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { clarifyMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import {
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { resolveDayPhrase } from '../../lib/services/share/emailAnchor.ts';
import { extractCandidatesRuleBased } from '../../src/extraction/ruleBasedCandidateExtractor.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { classifyMessageKind } from '../../src/extraction/messageKind.ts';
import { dayPartHour, localTimeSpecFor, timeOfDayEvidence } from '../../src/extraction/timeLexicon.ts';

const TZ = 'Asia/Jerusalem';
/** Saturday 26 Sep 2026, 10:00 in Jerusalem. */
const NOW = new Date('2026-09-26T07:00:00.000Z');
const TOMORROW = '2026-09-27';

async function withStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  try {
    return await run();
  } finally {
    resetStorageForTests();
  }
}

const proposeRules = (text: string) =>
  withStorage(() => proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() }));

const hourOf = (iso: string | null | undefined) => (iso ? localTimeSpecFor(new Date(iso), TZ)?.time ?? null : null);

// ── I-1: the spoken parts of the day ────────────────────────────────

/** «ية» / «يه» left standing alone: the substring cut of «الصبحية». */
const STRAY_SUFFIX = new RegExp('(?:^|\\s)(?:ية|يه)(?:\\s|$)', 'u');

const SPOKEN: ReadonlyArray<readonly [string, string]> = [
  ['بكرا الصبحية عندي اجتماع', '09:00'],
  ['بكرا العصرية بدي أروح عالسوق', '14:00'],
  ['بدي أتصل بخالي بكرا الضهرية', '12:00'],
  ['يوم الأحد العصرية عندي درس', '14:00'],
  ['العصرية بكرا بدي أزور ستي', '14:00'],
  ['بدي أروح عالجيم بكرا الصبحيه', '09:00'],
  ['بدي أروح عالسوق بكرا بالفترة المسائية', '18:00'],
];

for (const [text, time] of SPOKEN) {
  test(`I-1 rules: «${text}» is tomorrow at ${time}`, async () => {
    const proposal = await proposeRules(text);
    assert.equal(proposal.items.length, 1, JSON.stringify(proposal));
    const [item] = proposal.items;
    assert.equal(item!.resolvedDate, TOMORROW);
    assert.equal(hourOf(item!.resolvedTime), time, JSON.stringify(item));
    // The word is the time, so it leaves the title whole — no «ية» behind.
    assert.ok(!STRAY_SUFFIX.test(item!.title), `title «${item!.title}»`);
  });
}

test('I-1 rules: «المدرسة العصرية» is "the modern school", not an afternoon', async () => {
  const proposal = await proposeRules('المدرسة العصرية بدها قسط بكرا');
  assert.equal(proposal.items.length, 1);
  assert.equal(proposal.items[0]!.resolvedTime, null);
  assert.ok(proposal.items[0]!.title.includes('المدرسة العصرية'), proposal.items[0]!.title);
  assert.equal(dayPartHour('الموسيقى العصرية'), null);
  assert.equal(dayPartHour('يوم الأحد العصرية'), 14);
  assert.equal(dayPartHour('اليوم العصرية'), 14);
});

for (const [text, time] of SPOKEN.slice(0, 3).concat([['بدي أروح عالسوق بكرا بالفترة المسائية', '18:00']])) {
  test(`I-1 model: the model's correct ${time} for «${text}» is kept`, async () => {
    assert.notEqual(timeOfDayEvidence(text), 'day_only');
    const answer = {
      type: 'task', action: 'مشوار مهم', title: 'مشوار مهم', person: null,
      dueAt: new Date(`${TOMORROW}T${time}:00+03:00`).toISOString(), remindAt: null,
      localTimeSpec: { date: TOMORROW, time, timezone: TZ },
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
      flexibility: 'movable', category: null, categoryConfidence: 0,
      confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.9, priority: 1 },
      missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
    };
    const provider = async (prompt: string): Promise<string> => {
      const lines = prompt.split('\n');
      const payload = JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
      return Array.isArray(payload)
        ? JSON.stringify({ items: payload.map((_, clauseIndex) => ({ clauseIndex, ...answer })) })
        : JSON.stringify(answer);
    };
    const contract = await proposeCapture(text, { now: NOW, timezone: TZ, scopeId: 'i1', requestedEngine: 'model' }, {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
      llmProvider: provider,
      llmEngine: 'gemini',
    });
    assert.equal(contract.items.length, 1);
    assert.equal(hourOf(contract.items[0]!.resolvedTime), time, JSON.stringify(contract.items[0]));
  });
}

// «بالمسا» is the «المسا» button's 19:00 since the FY1 re-review ruling (the
// lexicon's 18:00 until then): typed and tapped agree.
for (const [answer, time] of [['العصرية', '14:00'], ['الصبحية', '09:00'], ['الضهرية', '12:00'], ['عالعصرية', '14:00'], ['بالمسا', '19:00'], ['الصبح', '09:00']] as const) {
  test(`I-1 clarify: «${answer}» answers "when?" with ${time}`, () => withStorage(async () => {
    const proposal = await proposeMobileCapture({ text: 'بدي أروح عالسوق بكرا', timezone: TZ, referenceTime: NOW.toISOString(), scopeId: 's' });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time');
    const updated = await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId,
      freeText: answer, timezone: TZ, referenceTime: NOW.toISOString(), scopeId: 's',
    });
    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    assert.equal(answered.resolvedDate, TOMORROW);
    assert.equal(hourOf(answered.resolvedTime), time);
  }));
}

test('I-1 answer mode: every spoken form is an answer, «العصرية» included', () => {
  for (const [word, hour] of [['العصرية', 14], ['العصريه', 14], ['الصبحية', 9], ['الصبحيه', 9], ['الضهرية', 12], ['الظهرية', 12], ['الفترة المسائية', 18], ['بالفترة الصباحية', 9]] as const) {
    assert.equal(dayPartHour(word, { answer: true }), hour, word);
  }
});

// ── I-2: small talk after a greeting stays small talk ──────────────

const SMALL_TALK = [
  'hello, tonight is the game',
  'good morning! today is a beautiful day',
  'good morning! tomorrow is the big day',
  'hi, tomorrow is a holiday',
  "hi, today I'm working from home",
  'hey, happy friday',
  'ok, tomorrow then',
  'thanks, tomorrow works',
  'good night, see you tomorrow at 8',
  'בוקר טוב, היום יום יפה',
  'היי, היום אני בבית',
  'שלום, מחר חג',
];

for (const text of SMALL_TALK) {
  test(`I-2: «${text}» creates nothing, as it did before`, async () => {
    assert.equal(classifyMessageKind(text), 'greeting_or_chat');
    const proposal = await proposeRules(text);
    assert.equal(proposal.status, 'no_commitment', JSON.stringify(proposal));
    assert.equal(proposal.items.length, 0);
  });
}

for (const [text, title] of [
  ['good morning, call mom tomorrow', 'call mom'],
  ['בוקר טוב, להתקשר לאמא מחר', 'להתקשר לאמא'],
  ['صباح الخير، اتصل بأمي بكرا', 'اتصل بأمي'],
  ['good morning, call mom at 5pm', 'call mom'],
  ['hi, remind me to pay rent tomorrow', 'pay rent'],
] as const) {
  test(`I-2: «${text}» still captures «${title}»`, async () => {
    const proposal = await proposeRules(text);
    assert.equal(proposal.items.length, 1, JSON.stringify(proposal));
    assert.equal(proposal.items[0]!.title, title);
  });
}

// ── m-1: the other day readers ───────────────────────────────────────

test('m-1: the email-share day reader reads whole words', () => {
  assert.equal(resolveDayPhrase('بعد الغداء', NOW, TZ), null, '«غدا» inside «الغداء»');
  assert.equal(resolveDayPhrase('التقرير اليومي', NOW, TZ), null, '«اليوم» inside «اليومي»');
  assert.equal(resolveDayPhrase('למחרת', NOW, TZ), null);
  assert.equal(resolveDayPhrase('وبكرا', NOW, TZ), TOMORROW);
  assert.equal(resolveDayPhrase('למחר', NOW, TZ), TOMORROW);
  assert.equal(resolveDayPhrase('tomorrow', NOW, TZ), TOMORROW);
  assert.equal(resolveDayPhrase('بعد بكرا', NOW, TZ), '2026-09-28');
  assert.equal(resolveDayPhrase('النهاردة', NOW, TZ), '2026-09-26');
});

test('m-1: a memory candidate takes no day from «الغداء» or «اليومي»', () => {
  for (const text of ['ناوي أحضّر الغداء', 'ناوي أكتب التقرير اليومي']) {
    for (const candidate of extractCandidatesRuleBased(text, { now: NOW })) {
      assert.equal(candidate.temporal, undefined, `${text}: ${JSON.stringify(candidate.temporal)}`);
    }
  }
  const [tomorrow] = extractCandidatesRuleBased('ناوي أزور خالي وبكرا', { now: NOW });
  assert.equal(tomorrow?.temporal?.precision, 'day');
});

// ── m-2: «הבוקר» that is not the time stays in the title ─────────────

test('m-2: «לקנות לחם הבוקר» keeps «הבוקר» in the title — no day, so it gave no time', async () => {
  const proposal = await proposeRules('לקנות לחם הבוקר');
  assert.equal(proposal.items.length, 1);
  assert.equal(proposal.items[0]!.resolvedTime, null);
  assert.equal(proposal.items[0]!.title, 'לקנות לחם הבוקר');
});
