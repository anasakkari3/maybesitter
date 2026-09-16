/**
 * The wall clock around reading a calendar (review of #445, B1).
 *
 * `FREQ=DAILY;INTERVAL=7;BYDAY=MO;BYMONTHDAY=1` from a Thursday lands on a
 * Thursday every time and never on a Monday, so ical.js 2.2.1 never returns
 * from `next()` — and every BY-part in it is satisfiable, so the pre-check in
 * `classifyIcs` cannot see it. Only the worker's clock can stop it. Every test
 * here has its own timeout, so a regression fails rather than hanging the run.
 */
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IcsTooComplexError, classifyIcsBounded } from '../../lib/calendar/icsClassifyBounded.ts';
import { IcsParseError, classifyIcs } from '../../lib/calendar/icsImport.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-09-16T00:00:00Z');

function hanging(): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:never', 'SUMMARY:Lecture', 'DTSTAMP:20260915T000000Z',
    'DTSTART:20260917T000000Z', 'DTEND:20260917T010000Z', 'RRULE:FREQ=DAILY;INTERVAL=7;BYDAY=MO;BYMONTHDAY=1',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

test('a regression that reads the calendar on the calling thread fails here instead of hanging the suite', { timeout: 60_000 }, () => {
  // In a child process with a kill timer, because a test timeout cannot
  // interrupt a synchronous loop in its own process. If the bound is gone the
  // child is killed and this assertion fails; nothing hangs.
  const script = `
    const { classifyIcsBounded } = await import(${JSON.stringify(new URL('../../lib/calendar/icsClassifyBounded.ts', import.meta.url).href)});
    const text = ${JSON.stringify(hanging())};
    try { await classifyIcsBounded(text, { now: new Date(${NOW.getTime()}), timeZone: 'UTC' }, { timeoutMs: 1500 }); console.log('RESOLVED'); }
    catch (error) { console.log('REFUSED:' + error.name); }
    process.exit(0);`;
  const child = spawnSync(process.execPath, ['--no-warnings', '--loader', './scripts/ts-resolver.mjs', '--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL',
  });
  assert.equal(child.signal, null, 'the calendar was read without a bound: the child had to be killed');
  assert.match(child.stdout, /REFUSED:IcsTooComplexError/);
});

test('a rule that never yields is stopped by the clock and refused, and the caller gets its answer on time', { timeout: 20_000 }, async () => {
  const started = Date.now();
  await assert.rejects(classifyIcsBounded(hanging(), { now: NOW, timeZone: 'UTC' }, { timeoutMs: 1_500 }), IcsTooComplexError);
  assert.ok(Date.now() - started < 10_000, 'the refusal did not come from the clock');
});

test('the event loop stays free while a calendar is being read', { timeout: 20_000 }, async () => {
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 20);
  try {
    await assert.rejects(classifyIcsBounded(hanging(), { now: NOW, timeZone: 'UTC' }, { timeoutMs: 1_000 }), IcsTooComplexError);
  } finally {
    clearInterval(interval);
  }
  assert.ok(ticks >= 10, `the main thread was blocked (${ticks} ticks)`);
});

test('an ordinary calendar reads the same through the worker as in-thread', { timeout: 20_000 }, async () => {
  const text = readFileSync(path.join(here, '..', 'fixtures', 'ics', 'moodle.ics'), 'utf8');
  const options = { now: new Date('2026-10-05T08:00:00Z'), timeZone: 'Asia/Jerusalem' };
  assert.deepEqual(await classifyIcsBounded(text, options, { timeoutMs: 15_000 }), classifyIcs(text, options));
});

test('what is not a calendar is still a parse error, not a timeout', { timeout: 20_000 }, async () => {
  await assert.rejects(classifyIcsBounded('<html>', { now: NOW, timeZone: 'UTC' }, { timeoutMs: 15_000 }), IcsParseError);
});
