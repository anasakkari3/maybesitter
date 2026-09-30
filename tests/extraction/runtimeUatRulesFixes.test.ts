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
