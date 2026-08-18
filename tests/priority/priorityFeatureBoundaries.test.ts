/**
 * Boundary, offset and DST tests for priority feature extraction (Sprint 04, #17).
 *
 * Separated from the behavioural suite because these are the cases that fail
 * silently. A review last sprint found a real defect where ISO timestamps
 * carrying different UTC offsets were ordered as text, which puts records in
 * the wrong window without any error surfacing — so the offset tests below are
 * built so a text comparison gives a *different* answer from an instant
 * comparison, rather than merely including an offset and hoping.
 *
 * The same reasoning drives the DST cases: across a spring-forward transition
 * the wall clock and the elapsed time disagree, so an implementation that
 * subtracts local hours instead of instants produces a plausible wrong number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPriorityFeatures } from '../../lib/priority/priorityFeatures.ts';
import { calculateAgendaUrgencyScore } from '../../lib/utils/agendaScoring.ts';
import type { FeatureValue, PriorityFeature } from '../../src/contracts/v1/priorityContracts.ts';
import { commitmentOf, reminderOf } from './priorityFeaturesFixtures.ts';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function knownValue<T>(field: PriorityFeature<T>): FeatureValue<T> {
  if (!field.known) {
    throw new assert.AssertionError({ message: `expected a known feature, got ${field.reason}` });
  }
  return field.value;
}

function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: expected ~${expected}, got ${actual}`);
}

function urgencyOf(dueAt: string | null, now: string, dueSoonWindowMs = DAY_MS) {
  return extractPriorityFeatures({
    commitment: commitmentOf({ timeSpec: { kind: 'due_by', dueAt, remindAt: null, timezone: 'UTC' } }),
    reminders: [],
    now,
    dueSoonWindowMs,
  }).urgency;
}

/* ── The exact boundary: due at the same instant as now ───────────── */

test('boundaries: a due time exactly equal to now is not overdue and is maximally close', () => {
  const now = '2026-08-18T12:00:00.000Z';
  const urgency = knownValue(urgencyOf(now, now));

  assert.equal(urgency.value.hoursOverdue, 0);
  assert.equal(urgency.value.dueSoonCloseness, 1);
});

test('boundaries: one millisecond past due flips the item into overdue', () => {
  const now = '2026-08-18T12:00:00.001Z';
  const urgency = knownValue(urgencyOf('2026-08-18T12:00:00.000Z', now));

  assertClose(urgency.value.hoursOverdue, 1 / (60 * 60 * 1_000), 'a millisecond of lateness is still lateness');
  assert.equal(urgency.value.dueSoonCloseness, 0);
});

test('boundaries: the exact instant boundary agrees with the live scorer for both reasons', () => {
  const now = '2026-08-18T12:00:00.000Z';
  const commitment = commitmentOf({ timeSpec: { kind: 'due_by', dueAt: now, remindAt: null, timezone: 'UTC' } });

  const overdue = calculateAgendaUrgencyScore({
    commitment, reminders: [], reason: 'overdue', now: new Date(now), relevantTimes: [now], dueSoonWindowMs: DAY_MS,
  });
  const dueSoon = calculateAgendaUrgencyScore({
    commitment, reminders: [], reason: 'due_soon', now: new Date(now), relevantTimes: [now], dueSoonWindowMs: DAY_MS,
  });

  // 7000 + importance(80) + nothing else; the due time is upcoming, not overdue.
  assert.equal(overdue, 7_000 + 80);
  // 5000 + closeness(1) * 420 + importance(80).
  assert.equal(dueSoon, 5_000 + 420 + 80);
});

test('boundaries: a due time exactly at the far edge of the window has zero closeness', () => {
  const now = '2026-08-18T12:00:00.000Z';
  const atEdge = knownValue(urgencyOf('2026-08-19T12:00:00.000Z', now));
  const justInside = knownValue(urgencyOf('2026-08-19T11:59:59.999Z', now));

  assert.equal(atEdge.value.dueSoonCloseness, 0);
  assert.ok(justInside.value.dueSoonCloseness > 0);
});

/* ── Non-UTC offsets: instants, never text ────────────────────────── */

test('offsets: the earliest overdue time is chosen by instant, not by the spelling of the string', () => {
  // '11:00:00Z' sorts before '12:00:00+02:00' as text, but names a later instant.
  const now = '2026-08-18T13:00:00.000Z';
  const features = extractPriorityFeatures({
    commitment: commitmentOf({
      timeSpec: { kind: 'due_by', dueAt: '2026-08-18T11:00:00.000Z', remindAt: '2026-08-18T12:00:00+02:00', timezone: 'Europe/Berlin' },
    }),
    reminders: [],
    now,
  });
  const urgency = knownValue(features.urgency);

  // 12:00+02:00 is 10:00Z — three hours before now, not two.
  assert.equal(urgency.value.hoursOverdue, 3);
  assert.deepEqual(
    urgency.evidence.map((item) => item.source),
    ['commitment.timeSpec.remindAt'],
  );
});

test('offsets: the next upcoming time is chosen by instant, not by the spelling of the string', () => {
  // '2026-08-18T20:00:00Z' sorts before '2026-08-18T22:00:00+05:00' (= 17:00Z) as text.
  const now = '2026-08-18T12:00:00.000Z';
  const features = extractPriorityFeatures({
    commitment: commitmentOf({
      timeSpec: { kind: 'due_by', dueAt: '2026-08-18T20:00:00.000Z', remindAt: '2026-08-18T22:00:00+05:00', timezone: 'Asia/Karachi' },
    }),
    reminders: [],
    now,
  });
  const urgency = knownValue(features.urgency);

  // 22:00+05:00 is 17:00Z — five hours out, not eight.
  assertClose(urgency.value.dueSoonCloseness, 1 - 5 / 24, 'closeness must measure the real remaining interval');
  assert.deepEqual(
    urgency.evidence.map((item) => item.source),
    ['commitment.timeSpec.remindAt'],
  );
});

test('offsets: two spellings of the same instant produce identical feature values', () => {
  const now = '2026-08-18T12:00:00.000Z';
  const asUtc = knownValue(urgencyOf('2026-08-18T09:00:00.000Z', now));
  const asOffset = knownValue(urgencyOf('2026-08-18T14:30:00+05:30', now));

  assert.deepEqual(asOffset.value, asUtc.value);
});

test('offsets: an ignore recorded with an offset is windowed by instant', () => {
  const now = '2026-08-18T12:00:00.000Z';
  // 2026-08-17T09:00:00-04:00 is 13:00Z on the 17th — 23 hours ago, inside the window,
  // even though its text is 'earlier' than the boundary spelling 2026-08-17T12:00:00Z.
  const features = extractPriorityFeatures({
    commitment: commitmentOf(),
    reminders: [reminderOf({ id: 'rem_1', status: 'ignored', updatedAt: '2026-08-17T09:00:00-04:00' })],
    now,
  });

  assert.deepEqual(knownValue(features.userPressure).value, { ignoredCount: 1, ignoredRecently: true });
});

/* ── DST ──────────────────────────────────────────────────────────── */

test('dst: overdue duration counts elapsed instants across a spring-forward transition', () => {
  // US spring forward 2026-03-08: 02:00 EST becomes 03:00 EDT.
  // 02:30-05:00 is 07:30Z; 03:00-04:00 is 07:00Z — the later wall clock is the
  // earlier instant, so a text ordering picks the wrong one.
  const now = '2026-03-08T09:00:00.000Z';
  const features = extractPriorityFeatures({
    commitment: commitmentOf({
      timeSpec: { kind: 'due_by', dueAt: '2026-03-08T02:30:00-05:00', remindAt: '2026-03-08T03:00:00-04:00', timezone: 'America/New_York' },
    }),
    reminders: [],
    now,
  });
  const urgency = knownValue(features.urgency);

  assert.equal(urgency.value.hoursOverdue, 2);
  assert.deepEqual(urgency.evidence.map((item) => item.source), ['commitment.timeSpec.remindAt']);
});

test('dst: a window spanning spring forward measures 23 wall-clock hours as 23 real hours', () => {
  // 2026-03-07T22:00:00-05:00 is 2026-03-08T03:00:00Z.
  // 2026-03-08T22:00:00-04:00 is 2026-03-09T02:00:00Z — 23 hours later, not 24.
  const now = '2026-03-07T22:00:00-05:00';
  const urgency = knownValue(urgencyOf('2026-03-08T22:00:00-04:00', now, DAY_MS));

  assertClose(urgency.value.dueSoonCloseness, 1 - 23 / 24, 'the lost hour must not be counted');
});

test('dst: a fall-back repeated wall time is disambiguated by its offset', () => {
  // US fall back 2026-11-01: 01:30-04:00 (05:30Z) and 01:30-05:00 (06:30Z) are
  // the same wall clock an hour apart.
  const now = '2026-11-01T07:30:00.000Z';
  const first = knownValue(urgencyOf('2026-11-01T01:30:00-04:00', now));
  const second = knownValue(urgencyOf('2026-11-01T01:30:00-05:00', now));

  assert.equal(first.value.hoursOverdue, 2);
  assert.equal(second.value.hoursOverdue, 1);
});

/* ── Malformed timestamps ─────────────────────────────────────────── */

test('malformed: an unparseable due date yields an unknown urgency, never a substituted now', () => {
  const field = urgencyOf('next tuesday-ish', '2026-08-18T12:00:00.000Z');

  assert.equal(field.known, false);
  if (field.known) return;
  assert.equal(field.reason, 'NO_DATA');
  assert.equal(Object.prototype.hasOwnProperty.call(field, 'value'), false);
  // Something was read and none of it contributed — distinct from having nothing to read.
  assert.equal(field.provenance.source, 'domain_state');
  assert.equal(field.provenance.derivedFrom, null);
});

test('malformed: a usable time alongside an unparseable one still yields a known urgency', () => {
  const now = '2026-08-18T12:00:00.000Z';
  const features = extractPriorityFeatures({
    commitment: commitmentOf({
      timeSpec: { kind: 'due_by', dueAt: 'ASAP', remindAt: '2026-08-18T10:00:00.000Z', timezone: 'UTC' },
    }),
    reminders: [],
    now,
  });

  assert.equal(knownValue(features.urgency).value.hoursOverdue, 2);
  assert.deepEqual(
    knownValue(features.urgency).evidence.map((item) => item.source),
    ['commitment.timeSpec.remindAt'],
  );
});

test('malformed: an unparseable commitment updatedAt leaves evidence undated rather than guessed', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({ updatedAt: 'unknown', currentAckState: 'seen' }),
    reminders: [],
    now: '2026-08-18T12:00:00.000Z',
  });

  for (const item of knownValue(features.importance).evidence) {
    assert.equal(item.observedAt, null);
  }
  assert.equal(features.importance.known && features.importance.provenance.derivedFrom, null);
});

test('malformed: an ack state of ignored with an undated commitment is unknown, not counted', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({ currentAckState: 'ignored', updatedAt: 'unknown' }),
    reminders: [],
    now: '2026-08-18T12:00:00.000Z',
  });

  assert.equal(features.userPressure.known, false);
  if (features.userPressure.known) return;
  assert.equal(features.userPressure.reason, 'NO_DATA');
});

/* ── No system clock ──────────────────────────────────────────────── */

test('purity: no module under lib/priority reads the system clock', () => {
  const priorityDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/priority');

  function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return filesUnder(full);
      return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
    });
  }

  const files = filesUnder(priorityDir);
  assert.ok(files.length > 0, 'expected at least one module under lib/priority');

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/\bDate\.now\s*\(/.test(source), false, `${file} must not call Date.now()`);
    assert.equal(/\bnew\s+Date\s*\(/.test(source), false, `${file} must not construct a Date`);
    assert.equal(/\bperformance\.now\s*\(/.test(source), false, `${file} must not call performance.now()`);
  }
});

test('purity: extraction reports the same features regardless of when it runs', () => {
  const commitment = commitmentOf({
    timeSpec: { kind: 'due_by', dueAt: '2026-08-18T06:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'ignored',
  });
  const reminders = [reminderOf({ id: 'rem_1', status: 'snoozed' })];

  const first = extractPriorityFeatures({ commitment, reminders, now: '2026-08-18T12:00:00.000Z' });
  const second = extractPriorityFeatures({ commitment, reminders, now: '2026-08-18T12:00:00.000Z' });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
