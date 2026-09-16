/**
 * Deterministic memory growth: the rules themselves (UC-3.16, #202).
 *
 * Pure functions over what the user did, with no model, no titles and no
 * clock. Each case states its "now" and its zone, so nothing here depends on
 * the date the suite runs or the zone of the machine running it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  R1_FOCUS_WINDOW,
  R1_LOOKBACK_DAYS,
  focusWindowFingerprint,
  parseFocusWindowFingerprint,
  suggestFocusWindow,
  type CompletionObservation,
} from '../../lib/memoryGrowth/rules.ts';

const NOW = '2026-09-16T18:00:00.000Z';
const ZONE = 'Asia/Jerusalem'; // UTC+3 in September

/** A completion at a local wall-clock time, `daysAgo` days before NOW. */
function completionAt(id: string, daysAgo: number, localHHMM: string, zoneOffsetHours = 3): CompletionObservation {
  const [hour, minute] = localHHMM.split(':').map(Number);
  const day = new Date(Date.parse(NOW) - daysAgo * 86_400_000);
  const utc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour! - zoneOffsetHours, minute!);
  return { id, at: new Date(utc).toISOString(), commitmentId: `c_${id}` };
}

/** Ten completions: seven between 09:00 and 12:00, three in the evening. */
function tenWithSevenInTheMorning(): CompletionObservation[] {
  return [
    completionAt('e01', 1, '09:15'),
    completionAt('e02', 2, '09:40'),
    completionAt('e03', 3, '10:00'),
    completionAt('e04', 5, '10:30'),
    completionAt('e05', 6, '11:00'),
    completionAt('e06', 8, '11:20'),
    completionAt('e07', 9, '11:45'),
    completionAt('e08', 4, '19:00'),
    completionAt('e09', 7, '20:30'),
    completionAt('e10', 10, '21:10'),
  ];
}

test('ten completions with seven between 09:00 and 12:00 yield the R1 suggestion', () => {
  const suggestion = suggestFocusWindow(tenWithSevenInTheMorning(), ZONE, NOW);
  assert.ok(suggestion, 'the issue’s own fixture must produce a suggestion');
  assert.equal(suggestion.ruleId, R1_FOCUS_WINDOW);
  assert.deepEqual(suggestion.window, { start: '09:00', end: '12:00' });
  assert.equal(suggestion.fingerprint, 'R1_focus_window:09:00-12:00');
  assert.equal(suggestion.matchingCount, 7);
  assert.equal(suggestion.totalCount, 10);
  assert.equal(suggestion.confidence, 0.7);
  assert.deepEqual([...suggestion.evidenceIds].sort(), ['e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07']);
});

test('seven completions yield nothing, however concentrated they are', () => {
  const seven = tenWithSevenInTheMorning().slice(0, 7);
  assert.equal(suggestFocusWindow(seven, ZONE, NOW), null);
  // And the eighth, in the same window, is what crosses the threshold.
  const eight = [...seven, completionAt('e11', 11, '10:10')];
  assert.ok(suggestFocusWindow(eight, ZONE, NOW));
});

test('below sixty percent in any three-hour window yields nothing', () => {
  // Six of ten inside 09-12 is exactly 60% and counts; five of ten does not.
  const base = tenWithSevenInTheMorning();
  const sixOfTen = [...base.slice(0, 6), completionAt('x1', 12, '15:00'), ...base.slice(7)];
  assert.equal(suggestFocusWindow(sixOfTen, ZONE, NOW)?.confidence, 0.6);
  const fiveOfTen = [...base.slice(0, 5), completionAt('x1', 12, '15:00'), completionAt('x2', 13, '16:10'), ...base.slice(7)];
  assert.equal(suggestFocusWindow(fiveOfTen, ZONE, NOW), null);
});

test('only the last 28 days count', () => {
  const base = tenWithSevenInTheMorning();
  // Push three of the morning completions just past the lookback: 4 of 7 left.
  const aged = base.map((event, index) => (index < 3
    ? completionAt(event.id, R1_LOOKBACK_DAYS + 1, '10:00')
    : event));
  assert.equal(suggestFocusWindow(aged, ZONE, NOW), null);
  // A completion "in the future" relative to now is not an observation either.
  const future = [...base.slice(0, 7), completionAt('f1', -2, '10:00')];
  assert.equal(suggestFocusWindow(future, ZONE, NOW), null);
});

test('the window is read in the user’s own zone, not the server’s or UTC', () => {
  // The same instants, read in New York, fall at 02:15–04:45 — a different
  // window, and the fingerprint says so.
  const events = tenWithSevenInTheMorning();
  const jerusalem = suggestFocusWindow(events, 'Asia/Jerusalem', NOW);
  const newYork = suggestFocusWindow(events, 'America/New_York', NOW);
  assert.equal(jerusalem?.window.start, '09:00');
  assert.ok(newYork);
  assert.notEqual(newYork.fingerprint, jerusalem?.fingerprint);
  assert.deepEqual(newYork.window, { start: '02:00', end: '05:00' });
});

test('a daylight-saving change does not move a habit out of its window', () => {
  // New York leaves DST on 2026-11-01. 09:30 local is 13:30Z before and 14:30Z
  // after; reading every instant with one fixed offset would split the habit.
  const now = '2026-11-08T23:00:00.000Z';
  const before = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']
    .map((day, index) => ({ id: `b${index}`, at: `${day}T13:30:00.000Z`, commitmentId: `cb${index}` }));
  const after = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']
    .map((day, index) => ({ id: `a${index}`, at: `${day}T14:30:00.000Z`, commitmentId: `ca${index}` }));
  const suggestion = suggestFocusWindow([...before, ...after], 'America/New_York', now);
  assert.ok(suggestion);
  assert.equal(suggestion.matchingCount, 10);
  // All ten at 09:30: the window centred on them, not the earliest that holds them.
  assert.deepEqual(suggestion.window, { start: '08:00', end: '11:00' });
});

test('a commitment completed, reopened and completed again counts once', () => {
  const base = tenWithSevenInTheMorning().slice(0, 7);
  const repeats = [1, 2, 3].map((n) => ({ ...completionAt(`r${n}`, n, '10:05'), commitmentId: 'c_e01' }));
  // Seven distinct things finished, not ten.
  assert.equal(suggestFocusWindow([...base, ...repeats], ZONE, NOW), null);
});

test('the same input gives the same answer whatever order it arrives in', () => {
  const events = tenWithSevenInTheMorning();
  const forward = suggestFocusWindow(events, ZONE, NOW);
  const backward = suggestFocusWindow([...events].reverse(), ZONE, NOW);
  assert.deepEqual(backward, forward);
});

test('a window never wraps midnight, because a working window may not', () => {
  const late = Array.from({ length: 10 }, (_, index) => completionAt(`n${index}`, index + 1, index % 2 ? '23:30' : '00:30'));
  const suggestion = suggestFocusWindow(late, ZONE, NOW);
  // 23:30 and 00:30 are an hour apart on the clock and a day apart on the grid.
  assert.equal(suggestion, null);
});

test('the fingerprint round-trips and refuses anything it did not write', () => {
  assert.equal(focusWindowFingerprint({ start: '09:00', end: '12:00' }), 'R1_focus_window:09:00-12:00');
  assert.deepEqual(parseFocusWindowFingerprint('R1_focus_window:09:00-12:00'), { start: '09:00', end: '12:00' });
  for (const bad of [
    '', 'R1_focus_window:9:00-12:00', 'R1_focus_window:09:00-13:00', 'R1_focus_window:22:00-01:00',
    'R2_defer_default:09:00-12:00', 'R1_focus_window:09:30-12:30', 'R1_focus_window:٠٩:٠٠-١٢:٠٠', null, 42,
  ]) {
    assert.equal(parseFocusWindowFingerprint(bad), null, `accepted ${String(bad)}`);
  }
});

// ── Boundaries ───────────────────────────────────────────────────

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourcesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'memoryGrowth');

test('no rule reads a commitment title', () => {
  const files = sourcesUnder(GROWTH_DIR);
  assert.ok(files.length > 0, 'found no sources, so this check would be vacuous');
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /title/i, `${file} mentions a title`);
  }
});

test('the rules read no ambient clock and no random source', () => {
  const source = readFileSync(join(GROWTH_DIR, 'rules.ts'), 'utf8');
  assert.doesNotMatch(source, /Date\.now\s*\(/);
  assert.doesNotMatch(source, /new\s+Date\s*\(\s*\)/);
  assert.doesNotMatch(source, /Math\.random|randomUUID/);
  assert.doesNotMatch(source, /from '\.\.\/storage|getStorage/);
});
