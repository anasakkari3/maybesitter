/**
 * The personalization evaluation protocol, the report, and the release gate.
 *
 * Run against #41's real deriver where it exists on this branch, and against a
 * scripted deriver where the point is to make a metric move — a metric that
 * cannot be made to move by any input is not measuring anything, and the only
 * way to find that out is to build the input that should move it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONALIZATION_INVARIANTS,
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LEVEL_VOCABULARY,
  PRODUCT_BASELINE_LEVELS,
  isEscalation,
  type PersonalizationDeriver,
  type PersonalizationProfile,
  type PreferenceReading,
} from '../../src/contracts/v1/personalizationContracts.ts';
import {
  buildSyntheticCohort,
  DEFAULT_COHORT_SEED,
  SYNTHETIC_ACTIVITY_BANDS,
  SYNTHETIC_ARCHETYPES,
  COHORT_LOCALES,
} from '../../lib/evaluation/personalization/syntheticCohort.ts';
import {
  EVALUATION_METRICS,
  MIN_MEMBER_EVENTS,
  MIN_SLICE_MEMBERS,
  PRESSURE_BEARING_DIMENSIONS,
  SLICE_AXES,
  scoreSlice,
  sliceCohort,
  sliceKeyOf,
} from '../../lib/evaluation/personalization/protocol.ts';
import {
  GATE_ENFORCED_INVARIANTS,
  HARM_SIGNALS,
  RELEASE_GATE_SIGNALS,
  buildEvaluationReport,
  evaluateRollbackGate,
} from '../../lib/evaluation/personalization/report.ts';

const NOW = '2026-08-20T09:00:00.000Z';

function scripted(readings: Partial<Record<string, PreferenceReading>>): PersonalizationDeriver {
  return (input) => {
    const full = Object.fromEntries(
      PREFERENCE_DIMENSIONS.map((dimension) => [
        dimension,
        readings[dimension] ?? {
          status: 'inconclusive',
          dimension,
          reason: 'insufficient_sample',
          level: null,
          confidence: null,
          sampleEventCount: 0,
          evidence: [],
        },
      ]),
    );
    return {
      version: 'personalization-v1',
      schemaVersion: 'personalization-v1',
      scopeId: input.scopeId,
      consent: 'enabled',
      derivedAt: input.now,
      readings: full,
      basis: {
        rungs: PERSONALIZATION_WINDOW_LADDER_DAYS.map((windowDays) => ({
          windowDays, windowStart: input.now, inputDigest: 'digest', revokedCount: 0,
        })),
        totalEventCount: 0,
      },
    } as unknown as PersonalizationProfile;
  };
}

const inertDeriver = scripted({});

/* ── The cohort is what it claims to be ──────────────────────────── */

test('the generator’s distribution is asserted, not trusted', () => {
  // A seeded generator that quietly produced 36 copies of one archetype would
  // make every metric below look stable. The cross-product is the claim, so it
  // is the thing measured.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  assert.equal(cohort.provenance, 'synthetic');
  assert.equal(
    cohort.members.length,
    SYNTHETIC_ARCHETYPES.length * COHORT_LOCALES.length * SYNTHETIC_ACTIVITY_BANDS.length,
  );
  for (const archetype of SYNTHETIC_ARCHETYPES) {
    const count = cohort.members.filter((member) => member.archetype === archetype).length;
    assert.equal(count, COHORT_LOCALES.length * SYNTHETIC_ACTIVITY_BANDS.length, `archetype ${archetype}`);
  }
  for (const locale of COHORT_LOCALES) {
    const count = cohort.members.filter((member) => member.locale === locale).length;
    assert.equal(count, SYNTHETIC_ARCHETYPES.length * SYNTHETIC_ACTIVITY_BANDS.length, `locale ${locale}`);
  }
  // And the streams are not all the same stream.
  const shapes = new Set(cohort.members.map((member) => `${member.events.length}`));
  assert.ok(shapes.size > 1, 'every member has an identically-sized stream, so activity is not varying');
});

test('the same seed rebuilds byte-identically, and a different seed does not', () => {
  const a = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const b = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = buildSyntheticCohort('a-different-seed', NOW);
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

/* ── Slicing is measured, not declared ───────────────────────────── */

test('slice keys are measured from events, never read from the generator’s label', () => {
  // A report sliced by the label the generator wrote is a report about the
  // generator. This compares the measured activity key against the declared
  // band and requires them to agree — which they can only do if the measurement
  // is real.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  for (const member of cohort.members) {
    const measured = sliceKeyOf(member, 'activity');
    if (member.events.length === 0) assert.equal(measured, 'activity:none');
    else if (member.events.length < MIN_MEMBER_EVENTS) assert.equal(measured, 'activity:light');
    else assert.equal(measured, 'activity:active');
  }
});

test('every axis partitions the whole cohort, losing and duplicating nobody', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  for (const axis of SLICE_AXES) {
    const slices = Array.from(sliceCohort(cohort, axis));
    const total = slices.reduce((sum, [, members]) => sum + members.length, 0);
    assert.equal(total, cohort.members.length, `axis ${axis} lost or duplicated members`);
    const seen = new Set(slices.flatMap(([, members]) => members.map((m) => m.scopeId)));
    assert.equal(seen.size, cohort.members.length, `axis ${axis} put a member in two slices`);
  }
});

/* ── Small samples ───────────────────────────────────────────────── */

test('a slice one member below the floor is inconclusive on every metric', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const thin = cohort.members.slice(0, MIN_SLICE_MEMBERS - 1);
  const score = scoreSlice('thin', thin, inertDeriver, NOW);
  assert.equal(score.readings.length, EVALUATION_METRICS.length);
  for (const reading of score.readings) {
    assert.equal(reading.kind, 'inconclusive', `${reading.metric} reported a value on a thin slice`);
    assert.equal(reading.kind === 'inconclusive' && reading.reason, 'slice_below_member_floor');
  }
});

test('a slice exactly at the floor reports values: the threshold is load-bearing on both sides', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const atFloor = cohort.members.slice(0, MIN_SLICE_MEMBERS);
  const score = scoreSlice('at-floor', atFloor, inertDeriver, NOW);
  assert.ok(
    score.readings.some((reading) => reading.kind === 'measured'),
    'a slice at the floor reported nothing, so the floor is off by one',
  );
});

test('an inconclusive reading carries no value at all, so nothing downstream can average it', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const score = scoreSlice('thin', cohort.members.slice(0, 2), inertDeriver, NOW);
  for (const reading of score.readings) {
    assert.equal((reading as Record<string, unknown>).personalized, undefined);
    assert.equal((reading as Record<string, unknown>).baseline, undefined);
    assert.equal((reading as Record<string, unknown>).delta, undefined);
  }
});

/* ── Baseline comparison is not optional ─────────────────────────── */

test('every measured reading carries its baseline and a delta that is their difference', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const report = buildEvaluationReport(cohort, inertDeriver, NOW);
  let measured = 0;
  for (const score of [report.overall, ...report.slices]) {
    for (const reading of score.readings) {
      if (reading.kind !== 'measured') continue;
      measured += 1;
      assert.equal(typeof reading.baseline, 'number', `${score.sliceId}/${reading.metric} has no baseline`);
      assert.equal(reading.delta, reading.personalized - reading.baseline);
    }
  }
  assert.ok(measured > 0, 'no reading was measured, so this test asserted nothing');
});

/* ── The #107 metric ─────────────────────────────────────────────── */

test('unfair pressure is zero across the whole cohort, and the metric can still move', () => {
  // Zero by construction — but a property holds only while its construction
  // does, and this one is a contract edit away from the failure #107 documents
  // in the shipped adaptiveService. So: assert the zero, then prove the meter
  // is not simply stuck at zero.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const report = buildEvaluationReport(cohort, inertDeriver, NOW);
  for (const score of [report.overall, ...report.slices]) {
    const reading = score.readings.find((entry) => entry.metric === 'unfair_pressure');
    if (reading?.kind !== 'measured') continue;
    assert.equal(reading.personalized, 0, `unfair pressure on ${score.sliceId}`);
  }

  // A deriver that escalates a pressure-bearing dimension on purely behavioural
  // evidence — the thing the contract forbids and adaptiveService does.
  // The level is chosen from the dimension's own vocabulary and checked to be
  // an escalation before it is used. A hard-coded literal that is not in the
  // vocabulary makes `isEscalation` return null, the metric skips the reading,
  // and the test passes while proving nothing — which is exactly what the first
  // draft of this did with `'insistent'`.
  const dimension = PRESSURE_BEARING_DIMENSIONS[0];
  const escalatedLevel = (PREFERENCE_LEVEL_VOCABULARY[dimension] as readonly string[]).find(
    (level) => isEscalation(dimension, level) === true,
  );
  assert.ok(escalatedLevel, `${dimension} declares no level above its baseline`);
  const escalating = scripted({
    [dimension]: {
      status: 'operative',
      dimension,
      reason: null,
      level: escalatedLevel,
      confidence: 0.9,
      sampleEventCount: 10,
      evidence: [{ rungIndex: 0, outcome: 'ignore', count: 10 }],
    } as PreferenceReading,
  });
  const harmed = buildEvaluationReport(cohort, escalating, NOW);
  const overall = harmed.overall.readings.find((entry) => entry.metric === 'unfair_pressure');
  assert.equal(overall?.kind, 'measured');
  assert.ok(
    overall?.kind === 'measured' && overall.personalized > 0,
    'the unfair-pressure meter did not move on a deriver that escalates from ignores',
  );
});

test('cold start invents nothing: a member with no events gets no operative reading', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const empty = cohort.members.filter((member) => member.events.length === 0);
  assert.ok(empty.length >= MIN_SLICE_MEMBERS, 'the cohort has too few empty members to measure cold start');
  const score = scoreSlice('cold', empty, inertDeriver, NOW);
  const reading = score.readings.find((entry) => entry.metric === 'cold_start_invention');
  assert.equal(reading?.kind, 'measured');
  assert.equal(reading?.kind === 'measured' && reading.personalized, 0);
});

/* ── The gate ────────────────────────────────────────────────────── */

test('the gate reads only its declared signals, and the harm set is a non-empty subset', () => {
  const declared = Object.keys(RELEASE_GATE_SIGNALS);
  assert.deepEqual([...declared].sort(), [...EVALUATION_METRICS].sort());
  assert.ok(HARM_SIGNALS.length > 0, 'no harm signal: every rollback path would be unreachable');
  for (const metric of HARM_SIGNALS) {
    assert.equal(RELEASE_GATE_SIGNALS[metric].direction, 'harm');
  }
  // NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE, enumerated against the contract rather
  // than asserted in prose.
  assert.ok((PERSONALIZATION_INVARIANTS as readonly string[]).includes('NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE'));
  assert.deepEqual([...GATE_ENFORCED_INVARIANTS], ['NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE']);
});

test('a synthetic report can refuse a release but can never authorise one', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const decision = evaluateRollbackGate(buildEvaluationReport(cohort, inertDeriver, NOW));
  assert.notEqual(decision.verdict, 'keep');
  assert.equal(decision.verdict, 'inconclusive');
  assert.ok(decision.notes.some((note) => /logged user data/.test(note)));
});

test('a harm on one slice rolls back even when the overall average is clean', () => {
  // The reason the report is sliced at all. A harm concentrated in one locale
  // disappears into a mean, and a gate reading only the overall score ships it.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const clean = buildEvaluationReport(cohort, inertDeriver, NOW);
  assert.equal(evaluateRollbackGate(clean).verdict, 'inconclusive');

  const poisoned = {
    ...clean,
    provenance: 'real_logged' as const,
    slices: clean.slices.map((slice, index) =>
      index === 0
        ? {
            ...slice,
            readings: slice.readings.map((reading) =>
              reading.metric === 'unfair_pressure' && reading.kind === 'measured'
                ? { ...reading, personalized: 0.5, delta: 0.5 }
                : reading,
            ),
          }
        : slice,
    ),
  };
  const decision = evaluateRollbackGate(poisoned);
  assert.equal(decision.verdict, 'rollback');
  assert.equal(decision.reasons.length, 1);
  assert.equal(decision.reasons[0].metric, 'unfair_pressure');
});

test('a harm cannot be outvoted by a benefit, however large', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const base = buildEvaluationReport(cohort, inertDeriver, NOW);
  const both = {
    ...base,
    provenance: 'real_logged' as const,
    overall: {
      ...base.overall,
      readings: base.overall.readings.map((reading) => {
        if (reading.kind !== 'measured') return reading;
        if (reading.metric === 'usefulness' || reading.metric === 'stability') {
          return { ...reading, personalized: 1, delta: 1 - reading.baseline };
        }
        if (reading.metric === 'cold_start_invention') return { ...reading, personalized: 1, delta: 1 };
        return reading;
      }),
    },
  };
  assert.equal(evaluateRollbackGate(both).verdict, 'rollback');
});

test('every harm threshold is load-bearing: one step over it flips the verdict', () => {
  // Per-signal, one at a time. Moving all of them together would prove only
  // that *some* threshold is wired.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const base = { ...buildEvaluationReport(cohort, inertDeriver, NOW), provenance: 'real_logged' as const };
  for (const metric of HARM_SIGNALS) {
    const over = {
      ...base,
      overall: {
        ...base.overall,
        readings: base.overall.readings.map((reading) =>
          reading.metric === metric && reading.kind === 'measured'
            ? { ...reading, personalized: RELEASE_GATE_SIGNALS[metric].threshold + 0.01 }
            : reading,
        ),
      },
    };
    const decision = evaluateRollbackGate(over);
    assert.equal(decision.verdict, 'rollback', `${metric} above its ceiling did not roll back`);
    assert.ok(decision.reasons.some((reason) => reason.metric === metric), `${metric} was not named as the reason`);
  }
});

test('the report carries its provenance and seed, so a number cannot be quoted without them', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const report = buildEvaluationReport(cohort, inertDeriver, NOW);
  assert.equal(report.provenance, 'synthetic');
  assert.equal(report.syntheticSeed, DEFAULT_COHORT_SEED);
  assert.equal(report.generatedAt, NOW);
  assert.equal(report.memberCount, cohort.members.length);
});

test('the report reads no clock: same cohort and instant, byte-identical report', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  assert.equal(
    JSON.stringify(buildEvaluationReport(cohort, inertDeriver, NOW)),
    JSON.stringify(buildEvaluationReport(cohort, inertDeriver, NOW)),
  );
});
