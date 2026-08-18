/**
 * Priority scorer specs (Sprint 04, #18).
 *
 * The defining criterion is that the explanation reconciles with the number it
 * explains, so the invariant `sum(components[].points) === total` is asserted
 * on every case built here, not only in the test named after it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankPriorities, scorePriority } from '../../lib/priority/priorityScorer.ts';
import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import type {
  PriorityPolicy,
  PriorityReason,
  PriorityScore,
  ScoreComponentCode,
} from '../../src/contracts/v1/priorityContracts.ts';
import { MAXIMAL_FEATURES, makeFeatures, type FeatureOverrides } from './priorityScorerFixtures.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function score(
  reason: PriorityReason,
  overrides: FeatureOverrides = {},
  policy: PriorityPolicy = DEFAULT_PRIORITY_POLICY,
): PriorityScore {
  const result = scorePriority({ features: makeFeatures(overrides), reason, policy });
  // The invariant is cheap, so it is checked on every score any test produces.
  assert.equal(
    result.components.reduce((sum, component) => sum + component.points, 0),
    result.total,
    `components must sum to total for ${reason}`,
  );
  return result;
}

function pointsFor(result: PriorityScore, code: ScoreComponentCode): number | null {
  const component = result.components.find((candidate) => candidate.code === code);
  return component === undefined ? null : component.points;
}

function codes(result: PriorityScore): readonly ScoreComponentCode[] {
  return result.components.map((component) => component.code);
}

test('priorityScorer: total is the sum of the emitted components across a spread of inputs', () => {
  const cases: ReadonlyArray<readonly [PriorityReason, FeatureOverrides]> = [
    ['overdue', {}],
    ['overdue', MAXIMAL_FEATURES],
    ['due_soon', { urgency: { hoursOverdue: 0, dueSoonCloseness: 0.5 }, importance: { level: 'low', userSet: false } }],
    ['active', { lateness: { snoozedCount: 1, postponed: false, deferred: false } }],
    ['pending', { userPressure: { ignoredCount: 1, ignoredRecently: false } }],
  ];

  for (const [reason, overrides] of cases) {
    const result = score(reason, overrides);
    const summed = result.components.reduce((sum, component) => sum + component.points, 0);
    assert.equal(summed, result.total);
  }
});

test('priorityScorer: the band clamp is emitted as a negative component when the cap binds', () => {
  const result = score('overdue', MAXIMAL_FEATURES);

  assert.equal(pointsFor(result, 'urgency'), 420);
  assert.equal(pointsFor(result, 'importance'), 180);
  assert.equal(pointsFor(result, 'lateness'), 510);
  assert.equal(pointsFor(result, 'user_pressure'), 240);
  // 1350 raw band against a 999 cap: the clamp must absorb exactly 351 points.
  assert.equal(pointsFor(result, 'band_clamp'), -351);
  assert.equal(result.total, 7_999);
  assert.ok(result.reasonCodes.includes('BAND_CAPPED'));
});

test('priorityScorer: the band clamp is emitted as zero, not omitted, when the cap does not bind', () => {
  const result = score('pending', { importance: { level: 'normal', userSet: false } });

  assert.equal(pointsFor(result, 'band_clamp'), 0);
  assert.equal(pointsFor(result, 'total_clamp'), 0);
  assert.equal(result.total, 1_080);
  assert.equal(result.reasonCodes.includes('BAND_CAPPED'), false);
});

test('priorityScorer: components are emitted in a fixed order', () => {
  const result = score('overdue', MAXIMAL_FEATURES);

  assert.deepEqual(codes(result), [
    'reason_base',
    'urgency',
    'importance',
    'lateness',
    'user_pressure',
    'band_clamp',
    'total_clamp',
  ]);
});

test('priorityScorer: the band cap starts binding at exactly one point over the cap', () => {
  const shared = {
    importance: { level: 'high', userSet: false } as const,
    lateness: { snoozedCount: 0, postponed: true, deferred: false } as const,
    userPressure: { ignoredCount: 1, ignoredRecently: true } as const,
  };
  // 180 + 160 + 240 = 580, so urgency of 419 lands the raw band on the cap.
  const atCap = score('overdue', { ...shared, urgency: { hoursOverdue: 419 / 6, dueSoonCloseness: 0 } });
  const overCap = score('overdue', { ...shared, urgency: { hoursOverdue: 420 / 6, dueSoonCloseness: 0 } });

  assert.equal(pointsFor(atCap, 'urgency'), 419);
  assert.equal(pointsFor(atCap, 'band_clamp'), 0);
  assert.equal(atCap.total, 7_999);
  assert.equal(atCap.reasonCodes.includes('BAND_CAPPED'), false);

  assert.equal(pointsFor(overCap, 'urgency'), 420);
  assert.equal(pointsFor(overCap, 'band_clamp'), -1);
  assert.equal(overCap.total, 7_999);
  assert.ok(overCap.reasonCodes.includes('BAND_CAPPED'));
});

test('priorityScorer: both clamps can bind at once and the components still sum to the total', () => {
  const cappedPolicy: PriorityPolicy = {
    ...DEFAULT_PRIORITY_POLICY,
    version: 'priority-policy-test-total-cap',
    reasonBase: { ...DEFAULT_PRIORITY_POLICY.reasonBase, overdue: 9_900 },
  };
  const result = score('overdue', MAXIMAL_FEATURES, cappedPolicy);

  assert.equal(pointsFor(result, 'band_clamp'), -351);
  assert.equal(pointsFor(result, 'total_clamp'), -900);
  assert.equal(result.total, 9_999);
  assert.equal(result.policyVersion, 'priority-policy-test-total-cap');
});

test('priorityScorer: an unknown feature contributes no component at all', () => {
  const result = score('active', {});

  assert.deepEqual(codes(result), ['reason_base', 'band_clamp', 'total_clamp']);
  assert.equal(pointsFor(result, 'urgency'), null);
  assert.equal(pointsFor(result, 'importance'), null);
  assert.equal(pointsFor(result, 'lateness'), null);
  assert.equal(pointsFor(result, 'user_pressure'), null);
  assert.equal(result.total, 3_000);
});

test('priorityScorer: dependency and effort never appear, since they are always unknown', () => {
  const result = score('overdue', MAXIMAL_FEATURES);
  const emitted = codes(result).join(',');

  assert.equal(emitted.includes('dependency'), false);
  assert.equal(emitted.includes('effort'), false);
});

test('priorityScorer: a known feature worth zero points still emits a component', () => {
  const result = score('pending', {
    importance: { level: 'low', userSet: false },
    lateness: { snoozedCount: 0, postponed: false, deferred: false },
    userPressure: { ignoredCount: 0, ignoredRecently: false },
  });

  // Known-and-zero is a measurement; omitting it would read as "not measured".
  assert.equal(pointsFor(result, 'importance'), 0);
  assert.equal(pointsFor(result, 'lateness'), 0);
  assert.equal(pointsFor(result, 'user_pressure'), 0);
  assert.equal(result.total, 1_000);
});

test('priorityScorer: a known feature carries its evidence onto the component it produced', () => {
  const result = score('overdue', { importance: { level: 'high', userSet: false } });
  const importance = result.components.find((component) => component.code === 'importance');
  const base = result.components.find((component) => component.code === 'reason_base');

  assert.equal(importance?.evidence, 'commitment.priority.level');
  // Structural terms are not features and must not claim an evidence source.
  assert.equal(base?.evidence, null);
});

test('priorityScorer: every reason band contributes its own base score', () => {
  assert.equal(score('overdue').total, 7_000);
  assert.equal(score('due_soon').total, 5_000);
  assert.equal(score('active').total, 3_000);
  assert.equal(score('pending').total, 1_000);
});

test('priorityScorer: urgency scores overdue hours and due-soon closeness on their own bands', () => {
  const overdue = score('overdue', { urgency: { hoursOverdue: 10, dueSoonCloseness: 0.9 } });
  const dueSoon = score('due_soon', { urgency: { hoursOverdue: 10, dueSoonCloseness: 0.5 } });

  assert.equal(pointsFor(overdue, 'urgency'), 60);
  assert.equal(pointsFor(dueSoon, 'urgency'), 210);
});

test('priorityScorer: a band that does not use time scores urgency at zero rather than dropping it', () => {
  const active = score('active', { urgency: { hoursOverdue: 40, dueSoonCloseness: 1 } });
  const pending = score('pending', { urgency: { hoursOverdue: 40, dueSoonCloseness: 1 } });

  assert.equal(pointsFor(active, 'urgency'), 0);
  assert.equal(pointsFor(pending, 'urgency'), 0);
});

test('priorityScorer: lateness caps its snooze term and adds postponement and deferral', () => {
  const result = score('active', { lateness: { snoozedCount: 9, postponed: true, deferred: true } });

  assert.equal(pointsFor(result, 'lateness'), 270 + 160 + 80);
  assert.ok(result.reasonCodes.includes('REPEATEDLY_DELAYED'));
});

test('priorityScorer: user pressure distinguishes a recent ignore from a stale one', () => {
  const recent = score('active', { userPressure: { ignoredCount: 1, ignoredRecently: true } });
  const stale = score('active', { userPressure: { ignoredCount: 1, ignoredRecently: false } });
  const none = score('active', { userPressure: { ignoredCount: 0, ignoredRecently: false } });

  assert.equal(pointsFor(recent, 'user_pressure'), 240);
  assert.equal(pointsFor(stale, 'user_pressure'), 120);
  assert.equal(pointsFor(none, 'user_pressure'), 0);
  assert.ok(recent.reasonCodes.includes('RECENTLY_IGNORED'));
  assert.equal(stale.reasonCodes.includes('RECENTLY_IGNORED'), false);
  assert.equal(none.reasonCodes.includes('RECENTLY_IGNORED'), false);
});

test('priorityScorer: reason codes are derivable from the components that were emitted', () => {
  const overdue = score('overdue', {
    importance: { level: 'high', userSet: false },
    lateness: { snoozedCount: 1, postponed: false, deferred: false },
    userPressure: { ignoredCount: 1, ignoredRecently: true },
  });
  assert.deepEqual(overdue.reasonCodes, [
    'OVERDUE',
    'HIGH_IMPORTANCE',
    'REPEATEDLY_DELAYED',
    'RECENTLY_IGNORED',
  ]);

  const dueSoon = score('due_soon', { importance: { level: 'normal', userSet: false } });
  assert.deepEqual(dueSoon.reasonCodes, ['DUE_SOON']);

  // Unknown importance must not be reported as low importance, or as high.
  const unknownImportance = score('active', {});
  assert.deepEqual(unknownImportance.reasonCodes, []);
});

test('priorityScorer: BAND_CAPPED is present exactly when the band clamp is non-zero', () => {
  const cases: ReadonlyArray<readonly [PriorityReason, FeatureOverrides]> = [
    ['overdue', {}],
    ['overdue', MAXIMAL_FEATURES],
    ['due_soon', MAXIMAL_FEATURES],
    ['active', MAXIMAL_FEATURES],
    ['pending', { importance: { level: 'normal', userSet: false } }],
  ];

  for (const [reason, overrides] of cases) {
    const result = score(reason, overrides);
    assert.equal(
      result.reasonCodes.includes('BAND_CAPPED'),
      pointsFor(result, 'band_clamp') !== 0,
      `BAND_CAPPED must track band_clamp for ${reason}`,
    );
  }
});

/* ── Hard constraints ────────────────────────────────────────────── */

test('priorityScorer: a user-pinned commitment records HARD_CONSTRAINT_APPLIED', () => {
  const pinned = score('pending', { importance: { level: 'high', userSet: true } });
  const inferred = score('pending', { importance: { level: 'high', userSet: false } });

  assert.ok(pinned.reasonCodes.includes('HARD_CONSTRAINT_APPLIED'));
  assert.equal(inferred.reasonCodes.includes('HARD_CONSTRAINT_APPLIED'), false);
});

test('priorityScorer: a hard constraint adds no points, so the score stays an honest soft measure', () => {
  const pinned = score('pending', { importance: { level: 'high', userSet: true } });
  const inferred = score('pending', { importance: { level: 'high', userSet: false } });

  assert.equal(pinned.total, inferred.total);
  assert.deepEqual(
    pinned.components.map((component) => component.points),
    inferred.components.map((component) => component.points),
  );
});

test('rankPriorities: a hard constraint outranks a higher soft total', () => {
  const pinned = score('pending', { commitmentId: 'pinned', importance: { level: 'high', userSet: true } });
  const overdue = score('overdue', { commitmentId: 'overdue', ...MAXIMAL_FEATURES });

  assert.ok(overdue.total > pinned.total);
  const ranked = rankPriorities({ scored: [overdue, pinned] });
  assert.deepEqual(ranked.map((entry) => entry.commitmentId), ['pinned', 'overdue']);
});

/* ── Ranking ─────────────────────────────────────────────────────── */

test('rankPriorities: orders by total, highest first', () => {
  const high = score('overdue', { commitmentId: 'c-high' });
  const mid = score('due_soon', { commitmentId: 'c-mid' });
  const low = score('pending', { commitmentId: 'c-low' });

  const ranked = rankPriorities({ scored: [mid, low, high] });
  assert.deepEqual(ranked.map((entry) => entry.commitmentId), ['c-high', 'c-mid', 'c-low']);
});

test('rankPriorities: identical state yields identical order regardless of input order', () => {
  const scored = [
    score('overdue', { commitmentId: 'c-1' }),
    score('overdue', { commitmentId: 'c-2' }),
    score('due_soon', { commitmentId: 'c-3' }),
    score('pending', { commitmentId: 'c-4' }),
    score('active', { commitmentId: 'c-5' }),
  ];

  const forward = rankPriorities({ scored }).map((entry) => entry.commitmentId);
  const reversed = rankPriorities({ scored: [...scored].reverse() }).map((entry) => entry.commitmentId);
  const rotated = rankPriorities({ scored: [scored[2], scored[4], scored[0], scored[3], scored[1]] }).map(
    (entry) => entry.commitmentId,
  );

  assert.deepEqual(reversed, forward);
  assert.deepEqual(rotated, forward);
});

test('rankPriorities: ties break on commitmentId by code-unit comparison, not locale', () => {
  const upper = score('active', { commitmentId: 'B-item' });
  const lower = score('active', { commitmentId: 'a-item' });

  assert.equal(upper.total, lower.total);
  // localeCompare puts 'a-item' first in an English locale; code-unit order does not.
  assert.ok('B-item'.localeCompare('a-item') > 0, 'fixture must actually discriminate the two orders');
  assert.deepEqual(
    rankPriorities({ scored: [lower, upper] }).map((entry) => entry.commitmentId),
    ['B-item', 'a-item'],
  );
  assert.deepEqual(
    rankPriorities({ scored: [upper, lower] }).map((entry) => entry.commitmentId),
    ['B-item', 'a-item'],
  );
});

test('rankPriorities: does not mutate the array it was given', () => {
  const scored = [
    score('pending', { commitmentId: 'c-1' }),
    score('overdue', { commitmentId: 'c-2' }),
  ];
  const before = scored.map((entry) => entry.commitmentId);

  rankPriorities({ scored });
  assert.deepEqual(scored.map((entry) => entry.commitmentId), before);
});

test('rankPriorities: returns an empty ranking for an empty input rather than throwing', () => {
  assert.deepEqual(rankPriorities({ scored: [] }), []);
});

/* ── Determinism guards ──────────────────────────────────────────── */

test('priorityScorer: the scorer and its policy read no clock and use no locale comparison', () => {
  for (const relative of ['lib/priority/priorityScorer.ts', 'lib/priority/priorityPolicy.ts']) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.equal(/Date\.now\(/.test(source), false, `${relative} must not read the clock`);
    assert.equal(/new Date\(/.test(source), false, `${relative} must not read the clock`);
    assert.equal(/localeCompare/.test(source), false, `${relative} must not compare by locale`);
  }
});

test('priorityScorer: scoring the same input twice produces an identical score', () => {
  const features = makeFeatures(MAXIMAL_FEATURES);
  const first = scorePriority({ features, reason: 'overdue', policy: DEFAULT_PRIORITY_POLICY });
  const second = scorePriority({ features, reason: 'overdue', policy: DEFAULT_PRIORITY_POLICY });

  assert.deepEqual(first, second);
});
