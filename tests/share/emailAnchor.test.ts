/**
 * What "by Monday" means (UC-3.8, #192 step 4).
 *
 * Every assertion here is about a *relationship* — "four days after the day the
 * email was sent" — and never about a calendar literal. A test that says
 * `'2026-09-14'` is a claim about the real calendar, and #382 is the record of
 * what that costs: the suite goes red on the day the wall clock walks past the
 * fixture, and the red says nothing about the code. So the anchors are fixed
 * instants, the expectations are computed from them by arithmetic this file
 * does itself, and nothing here reads `Date.now()`.
 *
 * The zone is `Pacific/Kiritimati` throughout, and that is deliberate too: it
 * is UTC+14, so a UTC instant and its local day differ for half the clock, and
 * no developer or CI host is set to it. A test that passed only because the
 * host happened to agree with the zone would be a test of the host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKeyOf, resolveDayPhrase } from '../../lib/services/share/emailAnchor.ts';

/** UTC+14, and nobody's host clock. */
const ZONE = 'Pacific/Kiritimati';

/** A Thursday. Asserted below rather than asserted *by* the name. */
const SENT_THURSDAY = new Date('2026-09-10T06:14:00.000Z');
/** A Tuesday, for the Hebrew fixture's own send date. */
const SENT_TUESDAY = new Date('2026-09-08T08:05:00.000Z');

/** The day `days` after `key`, by plain UTC arithmetic. A second opinion. */
function dayAfter(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekdayOf(instant: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long' }).format(instant);
}

test('the fixtures anchor the days this file reasons about', () => {
  // The setup, pinned. Without this the tests below would still pass if the
  // anchors silently became some other weekday — and they would be testing
  // arithmetic about a day nobody named.
  assert.equal(weekdayOf(SENT_THURSDAY), 'Thursday');
  assert.equal(weekdayOf(SENT_TUESDAY), 'Tuesday');
});

test('a weekday is the next one on or after the day the email was sent', () => {
  const sent = dayKeyOf(SENT_THURSDAY, ZONE);
  // Thursday → Monday is four days. Written as the arithmetic, not as a date.
  assert.equal(resolveDayPhrase('by Monday', SENT_THURSDAY, ZONE), dayAfter(sent, 4));
  assert.equal(resolveDayPhrase('before Friday', SENT_THURSDAY, ZONE), dayAfter(sent, 1));
  assert.equal(resolveDayPhrase('on Saturday', SENT_THURSDAY, ZONE), dayAfter(sent, 2));
});

test('the same weekday the email was sent on is that day, the way the extractor counts it', () => {
  // `nextWeekdayTz` in `src/extraction/ruleBasedExtractor.ts` is
  // `(target - current + 7) % 7`, which is 0 for the current day rather than 7.
  // If this file rounded up to "a week today" instead, every same-day deadline
  // in a shared email would move seven days and the two would disagree about
  // the one case a shared email makes most often.
  const sent = dayKeyOf(SENT_THURSDAY, ZONE);
  assert.equal(resolveDayPhrase('before Thursday', SENT_THURSDAY, ZONE), dayAfter(sent, 0));
});

test('Arabic and Hebrew weekdays resolve, and both spellings of the Arabic one do', () => {
  const thursday = dayKeyOf(SENT_THURSDAY, ZONE);
  const tuesday = dayKeyOf(SENT_TUESDAY, ZONE);
  // A word boundary does not work against Arabic or Hebrew at all, so these
  // three assertions are the only thing standing between a working detector
  // and two silently dead languages.
  assert.equal(resolveDayPhrase('قبل الاثنين', SENT_THURSDAY, ZONE), dayAfter(thursday, 4));
  assert.equal(resolveDayPhrase('قبل الإثنين', SENT_THURSDAY, ZONE), dayAfter(thursday, 4));
  assert.equal(resolveDayPhrase('עד יום חמישי', SENT_TUESDAY, ZONE), dayAfter(tuesday, 2));
});

test('today, tomorrow and the day after are relative to the email, in three languages', () => {
  const sent = dayKeyOf(SENT_THURSDAY, ZONE);
  for (const [phrase, days] of [
    ['today', 0], ['اليوم', 0], ['היום', 0],
    ['tomorrow', 1], ['بكرا', 1], ['מחר', 1],
    ['the day after tomorrow', 2], ['بعد بكرا', 2], ['מחרתיים', 2],
  ] as const) {
    assert.equal(resolveDayPhrase(phrase, SENT_THURSDAY, ZONE), dayAfter(sent, days), phrase);
  }
});

test('"day after tomorrow" is not read as "tomorrow"', () => {
  // It contains it. Order in `resolveDayPhrase` is what keeps them apart, and
  // getting it wrong moves every such deadline a day early.
  const sent = dayKeyOf(SENT_THURSDAY, ZONE);
  assert.notEqual(
    resolveDayPhrase('day after tomorrow', SENT_THURSDAY, ZONE),
    resolveDayPhrase('tomorrow', SENT_THURSDAY, ZONE),
  );
  assert.equal(resolveDayPhrase('day after tomorrow', SENT_THURSDAY, ZONE), dayAfter(sent, 2));
});

test('a phrase that names no day is null, and null is not a failure', () => {
  for (const phrase of ['as soon as you can', 'before the end of the month', 'في أقرب وقت', '', '   ']) {
    assert.equal(resolveDayPhrase(phrase, SENT_THURSDAY, ZONE), null, JSON.stringify(phrase));
  }
  assert.equal(resolveDayPhrase(null, SENT_THURSDAY, ZONE), null);
});

test('a weekday inside a longer word is not a weekday', () => {
  // "Sundays are quiet" and "Mondayish" are not deadlines. The edge class, not
  // `\b`, is what decides this — `\b` does not work against the Arabic half.
  assert.equal(resolveDayPhrase('Mondayish', SENT_THURSDAY, ZONE), null);
  assert.equal(resolveDayPhrase('by Monday.', SENT_THURSDAY, ZONE), dayAfter(dayKeyOf(SENT_THURSDAY, ZONE), 4));
});

test('a clock change between the anchor and the target cannot move the answer a day', () => {
  // The arithmetic is done on the day key, not on the instant. In a zone that
  // puts its clocks back that night, "anchor + 1 day" done on milliseconds
  // lands 23 hours later and can still read as the same date.
  const zone = 'America/New_York';
  const nightBefore = new Date('2026-10-31T20:00:00.000Z'); // 16:00 in New York
  const day = dayKeyOf(nightBefore, zone);
  assert.equal(resolveDayPhrase('tomorrow', nightBefore, zone), dayAfter(day, 1));
  assert.equal(resolveDayPhrase('the day after tomorrow', nightBefore, zone), dayAfter(day, 2));
});

test('the reader\'s own day is read in the reader\'s zone, not the host\'s', () => {
  // 11:00 UTC is already the next day in Kiritimati. A `dayKeyOf` that used the
  // host clock would answer the day before for half of every day, and the
  // past-day rule would then drop a deadline that has not arrived.
  const lateUtc = new Date('2026-09-10T11:00:00.000Z');
  assert.equal(dayKeyOf(lateUtc, ZONE), dayAfter(lateUtc.toISOString().slice(0, 10), 1));
});
