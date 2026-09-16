/**
 * Reading a calendar into deadlines and busy time (UC-3.4, #188).
 *
 * The fixtures carry fixed dates, and so does `NOW` — which is the point:
 * `classifyIcs` takes the instant it judges against as an argument and never
 * reads a clock, so nothing here depends on the day or the zone the suite runs
 * in. The user zone is Asia/Jerusalem because it crosses a DST boundary inside
 * the busy window (25 October 2026), which is where a hand-rolled offset goes
 * wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IcsParseError,
  MAX_BUSY,
  MAX_DEADLINES,
  MAX_TITLE_LENGTH,
  classifyIcs,
  cleanTitle,
  namesDeadline,
  type IcsClassification,
} from '../../lib/calendar/icsImport.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(here, '..', 'fixtures', 'ics', name), 'utf8');

const NOW = new Date('2026-10-05T08:00:00Z');
const ZONE = 'Asia/Jerusalem';

function skipped(result: IcsClassification): Record<string, number> {
  return Object.fromEntries(result.skipped.map((entry) => [entry.reason, entry.count]));
}

function vcalendar(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(uid: string, summary: string, start: string, end: string | null, ...extra: string[]): string {
  return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`, 'DTSTAMP:20260915T080000Z', `DTSTART:${start}`,
    ...(end ? [`DTEND:${end}`] : []), ...extra, 'END:VEVENT'].join('\r\n');
}

/* ── The Moodle export ─────────────────────────────────────────────── */

test('a Moodle export yields its deadlines and its lectures, and no lecture is a deadline', () => {
  const result = classifyIcs(fixture('moodle.ics'), { now: NOW, timeZone: ZONE });

  assert.deepEqual(result.deadlines.map((d) => [d.title, d.dueAt, d.rule]), [
    ['Essay 1 is due', '2026-10-09T20:59:00.000Z', 'keyword'],
    ['Quiz 2 closes', '2026-10-11T20:00:00.000Z', 'keyword'],
    // The keyword is in CATEGORIES, not the title.
    ['الواجب 3', '2026-10-14T09:00:00.000Z', 'keyword'],
    // Zero length, no keyword: the Moodle shape alone.
    ['Project checkpoint 2', '2026-10-16T15:00:00.000Z', 'zero_duration'],
  ]);
  assert.deepEqual(result.busy.map((b) => [b.uid, b.startAt, b.endAt]), [
    ['1001@moodle.univ.example', '2026-10-05T10:00:00.000Z', '2026-10-05T11:30:00.000Z'],
    ['1002@moodle.univ.example', '2026-10-07T10:00:00.000Z', '2026-10-07T11:30:00.000Z'],
    ['1003@moodle.univ.example', '2026-10-12T10:00:00.000Z', '2026-10-12T11:30:00.000Z'],
    ['1004@moodle.univ.example', '2026-10-30T10:00:00.000Z', '2026-10-30T11:30:00.000Z'],
  ]);
  const lectureUids = new Set(result.busy.map((b) => b.uid));
  assert.ok(result.deadlines.every((d) => !lectureUids.has(d.uid) && !d.title.includes('Lecture')));
  assert.deepEqual(skipped(result), {
    all_day: 1, // Reading week
    opens_not_due: 1, // Quiz 2 opens
    outside_window: 4, // a lecture past +28d, one last week, a deadline past +120d, one already gone
  });
});

test('nothing but the title, the times and the identifiers comes out: DESCRIPTION and LOCATION are never read', () => {
  for (const name of ['moodle.ics', 'google-public.ics', 'vtodo.ics', 'injection.ics']) {
    const serialised = JSON.stringify(classifyIcs(fixture(name), { now: NOW, timeZone: ZONE }));
    assert.ok(!serialised.includes('MUST-NOT-LEAK'), name);
    assert.ok(!serialised.includes('token='), name);
  }
  const result = classifyIcs(fixture('moodle.ics'), { now: NOW, timeZone: ZONE });
  assert.deepEqual(Object.keys(result.busy[0]!).sort(), ['endAt', 'recurrenceId', 'startAt', 'uid']);
  assert.deepEqual(Object.keys(result.deadlines[0]!).sort(),
    ['allDay', 'dtstamp', 'dueAt', 'recurrenceId', 'rule', 'sequence', 'title', 'uid']);
});

/* ── Recurrence and time zones ─────────────────────────────────────── */

test('a weekly lecture expands with its EXDATE and its moved instance, across the DST change', () => {
  const result = classifyIcs(fixture('google-public.ics'), { now: NOW, timeZone: ZONE });
  const lectures = result.busy.filter((b) => b.uid === 'weekly-lecture@google.com');
  assert.deepEqual(lectures.map((b) => [b.recurrenceId, b.startAt, b.endAt]), [
    // 12 Oct is excluded. 19 Oct was moved from 09:00 to 14:00 local (+03:00).
    ['2026-10-19T06:00:00.000Z', '2026-10-19T11:00:00.000Z', '2026-10-19T12:30:00.000Z'],
    // After 25 Oct Israel is +02:00, so 09:00 local is 07:00Z, not 06:00Z.
    ['2026-10-26T07:00:00.000Z', '2026-10-26T07:00:00.000Z', '2026-10-26T08:30:00.000Z'],
    // Starts before the window closes (08:00Z on 2 Nov), so it overlaps it.
    ['2026-11-02T07:00:00.000Z', '2026-11-02T07:00:00.000Z', '2026-11-02T08:30:00.000Z'],
  ]);
});

test('the feed\'s own VTIMEZONE is not trusted: a bogus zero offset for Asia/Jerusalem changes nothing', () => {
  const result = classifyIcs(fixture('google-public.ics'), { now: NOW, timeZone: 'UTC' });
  const moved = result.busy.find((b) => b.recurrenceId === '2026-10-19T06:00:00.000Z');
  assert.equal(moved?.startAt, '2026-10-19T11:00:00.000Z');
});

test('transparent and cancelled events are not busy; a non-IANA TZID falls back to the user\'s zone and says so', () => {
  const result = classifyIcs(fixture('google-public.ics'), { now: NOW, timeZone: ZONE });
  assert.equal(result.busy.some((b) => b.uid === 'free-time@google.com'), false);
  assert.equal(result.busy.some((b) => b.uid === 'cancelled@google.com'), false);
  const outlook = result.busy.find((b) => b.uid === 'outlook@example.com');
  assert.deepEqual([outlook?.startAt, outlook?.endAt], ['2026-10-06T07:00:00.000Z', '2026-10-06T08:00:00.000Z']);
  assert.deepEqual(skipped(result), { cancelled: 1, outside_window: 6, timezone_fallback: 1, transparent: 1 });

  // The same wall clock under a different user zone lands elsewhere — proof the fallback is the user's zone.
  const inLondon = classifyIcs(fixture('google-public.ics'), { now: NOW, timeZone: 'Europe/London' });
  assert.equal(inLondon.busy.find((b) => b.uid === 'outlook@example.com')?.startAt, '2026-10-06T09:00:00.000Z');
});

test('a Mozilla-style TZID is read by its IANA tail, and a floating time is the user\'s', () => {
  const text = vcalendar(
    vevent('moz', 'Lab', '', null).replace('DTSTART:', 'DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20261006T100000\r\nDTEND;TZID=/mozilla.org/20050126_1/Europe/Berlin:20261006T110000'),
    vevent('floating', 'Seminar', '20261007T100000', '20261007T110000'),
  );
  const result = classifyIcs(text, { now: NOW, timeZone: ZONE });
  assert.equal(result.busy.find((b) => b.uid === 'moz')?.startAt, '2026-10-06T08:00:00.000Z');
  assert.equal(result.busy.find((b) => b.uid === 'floating')?.startAt, '2026-10-07T07:00:00.000Z');
});

test('VTODO with DUE is a deadline; done, dateless and all-day are handled; recurring deadlines carry their occurrence', () => {
  const result = classifyIcs(fixture('vtodo.ics'), { now: NOW, timeZone: ZONE });
  assert.deepEqual(result.deadlines.map((d) => [d.uid, d.recurrenceId, d.dueAt, d.allDay, d.sequence]), [
    ['weekly-quiz@tasks', '2026-10-06T20:00:00.000Z', '2026-10-06T20:00:00.000Z', false, 0],
    ['weekly-quiz@tasks', '2026-10-13T20:00:00.000Z', '2026-10-13T20:00:00.000Z', false, 0],
    ['todo-1@tasks', null, '2026-10-20T12:00:00.000Z', false, 1],
    ['weekly-quiz@tasks', '2026-10-20T20:00:00.000Z', '2026-10-20T20:00:00.000Z', false, 0],
    // An all-day due date is due at 23:59 in the user's zone (+03:00).
    ['todo-4@tasks', null, '2026-10-22T20:59:00.000Z', true, 0],
  ]);
  assert.deepEqual(skipped(result), { completed: 1, no_time: 1 });
});

test('an unbounded FREQ=SECONDLY rule stops at the expansion limit and is counted', () => {
  const text = vcalendar(vevent('bomb', 'Tick', '19700101T000000Z', '19700101T000001Z', 'RRULE:FREQ=SECONDLY'));
  const result = classifyIcs(text, { now: NOW, timeZone: ZONE });
  assert.equal(result.busy.length, 0);
  assert.equal(skipped(result).recurrence_limit, 1);
});

/* ── Untrusted text ────────────────────────────────────────────────── */

test('titles that try to instruct are skipped in English, Arabic and Hebrew, and the rest are cleaned', () => {
  const result = classifyIcs(fixture('injection.ics'), { now: NOW, timeZone: ZONE });
  assert.deepEqual(skipped(result), { missing_title: 1, prompt_injection: 4 });
  const titles = result.deadlines.map((d) => d.title);
  assert.equal(titles[0], 'Essay due second line');
  assert.equal(Array.from(titles[1]!).length <= MAX_TITLE_LENGTH, true);
  assert.ok(titles[1]!.startsWith('Very long deadline title'));
  // «موعد نهائى» with tatweel and alef maksura, and «מועד אחרון», are deadlines.
  assert.equal(titles[2], 'مـوعـد نهائى للمشروع');
  assert.equal(titles[3], 'מועד אחרון להגשת פרויקט');
  for (const title of titles) {
    assert.ok(!/[ --‪-‮⁦-⁩]/.test(title), title);
  }
});

test('cleanTitle strips controls and bidi overrides, keeps RLM, and cuts by code point', () => {
  assert.equal(cleanTitle('a b‮c⁦de'), 'a b c d e');
  assert.equal(cleanTitle('שלום‏ world'), 'שלום‏ world');
  const emoji = '📚'.repeat(200);
  assert.equal(Array.from(cleanTitle(emoji)).length, MAX_TITLE_LENGTH);
  assert.equal(cleanTitle(42), '');
});

test('the deadline words match in all three languages, inside Arabic and Hebrew words, and not inside English ones', () => {
  for (const yes of ['Essay due', 'DEADLINE', 'Submission 2', 'Quiz closes', 'موعد التسليم', 'التسليم النهائي',
    'آخر موعد للواجب', 'موعد نهائى', 'مـوعـد نهائي', 'הגשה 3', 'להגשה', 'מועד אחרון']) {
    assert.equal(namesDeadline(yes), true, yes);
  }
  for (const no of ['Lecture', 'Overdue fines talk', 'Encloses', 'Subdue', 'محاضرة', 'הרצאה', 'Quiz opens']) {
    assert.equal(namesDeadline(no), false, no);
  }
});

test('an opening in Arabic or Hebrew is not a deadline either', () => {
  const text = vcalendar(
    vevent('ar-open', 'يفتح الاختبار 2', '20261010T060000Z', '20261010T060000Z'),
    vevent('he-open', 'נפתח בוחן 2', '20261010T070000Z', '20261010T070000Z'),
  );
  const result = classifyIcs(text, { now: NOW, timeZone: ZONE });
  assert.equal(result.deadlines.length, 0);
  assert.equal(skipped(result).opens_not_due, 2);
});

/* ── Windows, caps, determinism, garbage ───────────────────────────── */

test('deadlines are capped at 100 and busy blocks at 500, earliest first, with the rest counted', () => {
  const lines: string[] = [];
  for (let i = 0; i < MAX_DEADLINES + 7; i += 1) {
    const due = new Date(NOW.getTime() + (i + 1) * 3_600_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    lines.push(vevent(`d${i}`, `Task ${i} due`, due, due));
  }
  for (let i = 0; i < MAX_BUSY + 3; i += 1) {
    const start = new Date(NOW.getTime() + i * 60_000);
    const fmt = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    lines.push(vevent(`b${i}`, 'Meeting', fmt(start), fmt(new Date(start.getTime() + 30_000))));
  }
  const result = classifyIcs(vcalendar(...lines), { now: NOW, timeZone: ZONE });
  assert.equal(result.deadlines.length, MAX_DEADLINES);
  assert.equal(result.deadlines[0]!.uid, 'd0');
  assert.equal(result.busy.length, MAX_BUSY);
  assert.equal(result.busy[0]!.uid, 'b0');
  assert.equal(skipped(result).over_cap, 10);
});

test('the window edges: due exactly now is kept, due a millisecond before is not, due at +120d is kept', () => {
  const text = vcalendar(
    vevent('at-now', 'A due', '20261005T080000Z', '20261005T080000Z'),
    vevent('before', 'B due', '20261005T075959Z', '20261005T075959Z'),
    vevent('at-end', 'C due', '20270202T080000Z', '20270202T080000Z'),
    vevent('after-end', 'D due', '20270202T080001Z', '20270202T080001Z'),
    vevent('busy-ends-now', 'Lecture', '20261005T070000Z', '20261005T080000Z'),
    vevent('busy-starts-at-end', 'Lecture', '20261102T080000Z', '20261102T090000Z'),
  );
  const result = classifyIcs(text, { now: NOW, timeZone: ZONE });
  assert.deepEqual(result.deadlines.map((d) => d.uid), ['at-now', 'at-end']);
  assert.deepEqual(result.busy.map((b) => b.uid), []);
  assert.equal(skipped(result).outside_window, 4);
});

test('the same input gives the same output, and no uid still yields a stable key', () => {
  const text = vcalendar(['BEGIN:VEVENT', 'SUMMARY:Essay due', 'DTSTART:20261010T100000Z', 'DTEND:20261010T100000Z', 'END:VEVENT'].join('\r\n'));
  const first = classifyIcs(text, { now: NOW, timeZone: ZONE });
  const second = classifyIcs(text, { now: NOW, timeZone: ZONE });
  assert.deepEqual(first, second);
  assert.match(first.deadlines[0]!.uid, /^no-uid:[0-9a-f]{64}$/);
});

test('what is not a calendar is refused, and an unknown user zone is read as UTC rather than thrown on', () => {
  assert.throws(() => classifyIcs('<html>nope</html>', { now: NOW, timeZone: ZONE }), IcsParseError);
  assert.throws(() => classifyIcs('BEGIN:VCARD\r\nEND:VCARD\r\n', { now: NOW, timeZone: ZONE }), IcsParseError);
  const result = classifyIcs(vcalendar(vevent('f', 'Seminar', '20261007T100000', '20261007T110000')), { now: NOW, timeZone: 'Not/AZone' });
  assert.equal(result.busy[0]?.startAt, '2026-10-07T10:00:00.000Z');
});
