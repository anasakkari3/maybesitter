/**
 * Three rules-path defects the staging runtime UAT found on 2026-09-30 (AI
 * off), which the capture chat's rules fallback inherits:
 *
 *   1. "Dentist tomorrow at 5pm and call mom on Sunday at 6pm" proposed
 *      nothing, while the same words with a full stop proposed two. Two
 *      commitments joined by "and" / «و» / «ו» / a comma, each with its own
 *      action and its own time, are two clauses — "coffee with Sam and Dana"
 *      is still one.
 *   2. "I have an internship every Saturday from 10 to 4" offered the weekly
 *      block «I have an internship». The lead-in goes: "internship», «تدريب»,
 *      «התמחות».
 *   3. A weekday the person named ("on Sunday", «يوم الأحد», «ביום ראשון»)
 *      came back `dateEstimated` — «حزرنا التاريخ». A named day is theirs,
 *      and a stated clock with its am/pm is not `timeEstimated` either. What
 *      is still ours stays marked: the month's end read as its last day, and
 *      the product's hour for a bare part of the day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { MemoryCaptureProposalStore, proposeCapture } from '../../lib/services/captureBoundary/index.ts';
import { splitCaptureClauses } from '../../src/extraction/clauseSplitter.ts';
import { decideExtractionDisposition } from '../../src/extraction/extractionPolicy.ts';
import { extractAndMap } from '../../src/extraction/extractionService.ts';
import { endOfRange } from '../../src/extraction/mapExtractionToCommand.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { weeklyBlockOfferFor } from '../../lib/weeklyBlocks/offer.ts';

const TZ = 'Asia/Jerusalem';
/** Wednesday 30 September 2026, 10:00 in Jerusalem. */
const NOW = new Date('2026-09-30T07:00:00.000Z');
const THURSDAY = '2026-10-01';
const SUNDAY = '2026-10-04';

async function rules(text: string) {
  return proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'runtime-uat-2026-09-30', requestedEngine: 'rules' },
    {
      store: new MemoryCaptureProposalStore(),
      persistence: { snapshot: async () => createEmptyDomainState(), persistAtomically: async () => ({ state: createEmptyDomainState() }) },
    } as never,
  );
}

const when = (iso: string | null) => {
  if (!iso) return null;
  const local = localTimeSpecFor(new Date(iso), TZ)!;
  return `${local.date} ${local.time}`;
};

/* ── 1. two timed commitments joined by "and" ─────────────────────── */

for (const [label, text, expected] of [
  ['en "and"', 'Dentist tomorrow at 5pm and call mom on Sunday at 6pm', [`${THURSDAY} 17:00`, `${SUNDAY} 18:00`]],
  ['en comma', 'Dentist tomorrow at 5pm, call mom on Sunday at 6pm', [`${THURSDAY} 17:00`, `${SUNDAY} 18:00`]],
  ['en noun after "and"', 'Pay rent tomorrow at 9am and dentist on Sunday at 4pm', [`${THURSDAY} 09:00`, `${SUNDAY} 16:00`]],
  ['ar «و»', 'بكرا الساعة 5 المسا عندي دكتور وأتصل بأمي يوم الأحد الساعة 6 المسا', [`${THURSDAY} 17:00`, `${SUNDAY} 18:00`]],
  ['he «ו»', 'מחר ב-17:00 רופא שיניים ולהתקשר לאמא ביום ראשון ב-18:00', [`${THURSDAY} 17:00`, `${SUNDAY} 18:00`]],
] as const) {
  test(`1 (${label}): two commitments each with its own action and time are two items`, async () => {
    const proposal = await rules(text);
    assert.equal(proposal.status, 'proposed', JSON.stringify(proposal));
    assert.deepEqual(proposal.items.map((item) => when(item.resolvedTime)), expected);
    assert.ok(proposal.items.every((item) => !item.needsClarification));
  });
}

for (const text of [
  'coffee with Sam and Dana tomorrow at 5pm',
  'buy bread and milk tomorrow at 5pm',
  'أحمد وسامي بكرا الساعة 5 المسا',
  'קפה עם דני ורוני מחר ב-17:00',
  // A restated hour is the same appointment, not a second one.
  'Interview on Tuesday and call at 3pm',
]) {
  test(`1: a bare "and" is not a boundary — «${text}» stays one clause`, () => {
    assert.equal(splitCaptureClauses(text).length, 1);
  });
}

test('1: "coffee with Sam and Dana" is still one item with its time', async () => {
  const proposal = await rules('coffee with Sam and Dana tomorrow at 5pm');
  assert.deepEqual(proposal.items.map((item) => [item.title, when(item.resolvedTime)]), [['coffee with Sam and Dana', `${THURSDAY} 17:00`]]);
});

/* ── 2. the weekly block's title ──────────────────────────────────── */

for (const [text, title] of [
  ['I have an internship every Saturday from 10 to 4', 'internship'],
  ['عندي تدريب كل سبت من الساعة 10 لـ 4', 'تدريب'],
  ['יש לי התמחות כל שבת מ-10 עד 4', 'התמחות'],
] as const) {
  test(`2: «${text}» is offered as the weekly block «${title}»`, async () => {
    const proposal = await rules(text);
    const offer = proposal.items[0]?.weeklyBlock;
    assert.ok(offer, JSON.stringify(proposal.items[0]));
    assert.equal(offer.title, title);
    assert.deepEqual([offer.weekdays, offer.start, offer.end], [[6], '10:00', '16:00']);
  });
}

test('2: a title that is only the lead-in keeps it, rather than becoming empty', () => {
  const offer = weeklyBlockOfferFor({ title: 'عندي كل سبت', needsClarification: false, recurrenceHint: { weekdays: [6], start: '10:00', end: '16:00' } }, TZ);
  assert.ok(offer?.title.length);
});

/* ── 3. said is not estimated ─────────────────────────────────────── */

for (const [text, date, time] of [
  ['Call mom on Sunday at 6pm', SUNDAY, '18:00'],
  ['Dentist tomorrow at 5pm', THURSDAY, '17:00'],
  ['بدي أتصل بأمي يوم الأحد الساعة 6 المسا', SUNDAY, '18:00'],
  ['להתקשר לאמא ביום ראשון ב-18:00', SUNDAY, '18:00'],
] as const) {
  test(`3: «${text}» — the day and the hour they said are not marked as guesses`, async () => {
    const item = (await rules(text)).items[0]!;
    assert.equal(when(item.resolvedTime), `${date} ${time}`);
    assert.equal(item.resolvedDate, date);
    assert.equal(item.dateEstimated, false, 'a named weekday was shown as «حزرنا التاريخ»');
    assert.equal(item.timeEstimated, false, 'a stated clock was shown as «حزرناها»');
  });
}

test('3: what is still ours stays marked — a bare part of the day, and the month’s end', async () => {
  const evening = (await rules('Call mom Sunday evening')).items[0]!;
  assert.equal(evening.timeEstimated, true, 'the product’s evening hour stopped being marked');
  assert.equal(evening.dateEstimated, false);
  const monthEnd = (await rules('لازم أحضّر تقرير آخر الشهر')).items[0]!;
  assert.equal(monthEnd.dateEstimated, true, 'the month’s end read as its last day stopped being marked');
});

/* ── Q-S2. Named month dates and «غدا» lunch ─────────────────────── */

const qContext = { now: new Date('2026-10-07T08:00:00.000Z'), timezone: TZ };
const NAMED_DATES: ReadonlyArray<{ text: string; date: string; time: string; title: string }> = [
  { text: 'flight to Amman on December 20 at 6 AM', date: '2026-12-20', time: '06:00', title: 'flight to Amman' },
  { text: 'فحص سنوي عند الدكتور يوم 3 نوفمبر الساعة 9 الصبح', date: '2026-11-03', time: '09:00', title: 'فحص سنوي عند الدكتور' },
  { text: 'مقابلة شغل يوم 22 أكتوبر الساعة 11 الصبح', date: '2026-10-22', time: '11:00', title: 'مقابلة شغل' },
  { text: 'renew passport on October 20 at 10 AM', date: '2026-10-20', time: '10:00', title: 'renew passport' },
  { text: 'سفر 20 ديسمبر الساعة 6 الصبح', date: '2026-12-20', time: '06:00', title: 'سفر' },
  { text: 'مراجعة 3 نوفمبر الساعة 9 الصبح', date: '2026-11-03', time: '09:00', title: 'مراجعة' },
  { text: 'call Maya Dec 20 at 6 PM', date: '2026-12-20', time: '18:00', title: 'call Maya' },
  { text: 'call Maya Oct 22 at 11 AM', date: '2026-10-22', time: '11:00', title: 'call Maya' },
  { text: 'call Maya 20 December at 6 PM', date: '2026-12-20', time: '18:00', title: 'call Maya' },
  { text: 'בדיקת רופא ב-3 בנובמבר בשעה 9:00', date: '2026-11-03', time: '09:00', title: 'בדיקת רופא' },
];

for (const expected of NAMED_DATES) {
  test(`Q-S2: named month date resolves and leaves the title — ${expected.text}`, () => {
    const result = extract(expected.text, qContext);
    assert.equal(result.localTimeSpec?.date, expected.date);
    assert.equal(result.localTimeSpec?.time, expected.time);
    assert.equal(result.title, expected.title);
  });
}

test('Q-S2: a named month date that already passed rolls to its next occurrence', () => {
  const result = extract('submit report on October 3 at 4 PM', qContext);
  assert.equal(result.localTimeSpec?.date, '2027-10-03');
  assert.equal(result.localTimeSpec?.time, '16:00');
  assert.equal(result.title, 'submit report');
});

test('Q-S2: an impossible named month date keeps its hour but asks for the day', () => {
  const result = extract('book venue on November 31 at 9 AM', qContext);
  assert.equal(result.localTimeSpec, null);
  assert.equal(result.dueAt, null);
  assert.equal(result.remindAt, null);
  assert.equal(result.undatedTime, '09:00');
  assert.equal(result.title, 'book venue');
  assert.ok(result.missingFields.includes('time'));
  assert.ok(result.ambiguityFlags.includes('vague_time'));
  assert.equal(decideExtractionDisposition(result), 'needs_clarification');
});

test('Q-S2: «غدا مع» is lunch when the clause explicitly says today', async () => {
  const mapped = await extractAndMap('غدا مع سارة اليوم من 1 لـ 2 الظهر', qContext, {
    llmProvider: async () => {
      throw new Error('rules-only test');
    },
  });
  assert.equal(mapped.engine, 'rule-based');
  assert.equal(mapped.result.localTimeSpec?.date, '2026-10-07');
  assert.equal(mapped.result.localTimeSpec?.time, '13:00');
  assert.equal(mapped.result.title, 'غدا مع سارة');
  assert.equal(mapped.result.rangeMinutes, 60);
  assert.equal(endOfRange(mapped.result), '2026-10-07T11:00:00.000Z');
});

test('Q-S2: bare «غدا» with no other day still means tomorrow', () => {
  const result = extract('غدا الساعة 5', qContext);
  assert.equal(result.localTimeSpec?.date, '2026-10-08');
});
