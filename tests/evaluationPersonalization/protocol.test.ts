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

test('the stability meter moves: a member whose behaviour shifts across the ladder', () => {
  // Replacing measureStability's body with a literal {1,1} passed the entire
  // suite. Every deriver the file passed was `scripted(...)`, which ignores
  // `input.now`, so stability was 1 by construction of the fixture rather than
  // of the code. A meter that no input can move is not measuring anything.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  // Members above the event floor: the four behavioural metrics average over
  // that pool, so a slice of six that includes quiet members reports
  // inconclusive and this test would assert nothing.
  const members = cohort.members
    .filter((member) => member.events.length >= MIN_MEMBER_EVENTS)
    .slice(0, MIN_SLICE_MEMBERS);
  assert.equal(members.length, MIN_SLICE_MEMBERS, 'not enough active members to measure stability');

  // A deriver that answers differently depending on the instant it is asked —
  // which is exactly what an unstable real deriver looks like from outside.
  const flapping: PersonalizationDeriver = (input) =>
    (Date.parse(input.now) > Date.parse(NOW)
      ? scripted({
          reminder_density: {
            status: 'operative', dimension: 'reminder_density', reason: null, level: 'lean',
            confidence: 0.9, sampleEventCount: 9, evidence: [{ rungIndex: 0, outcome: 'ignore', count: 9 }],
          } as PreferenceReading,
        })
      : inertDeriver)(input);

  const stable = scoreSlice('stable', members, inertDeriver, NOW)
    .readings.find((reading) => reading.metric === 'stability');
  const unstable = scoreSlice('unstable', members, flapping, NOW)
    .readings.find((reading) => reading.metric === 'stability');

  assert.equal(stable?.kind, 'measured');
  assert.equal(unstable?.kind, 'measured');
  assert.equal(stable?.kind === 'measured' && stable.personalized, 1);
  assert.ok(
    unstable?.kind === 'measured' && unstable.personalized < 1,
    'a deriver that changes its answer between two instants scored perfectly stable',
  );
});

test('the overfitting meter moves: a profile the held-out re-sample contradicts', () => {
  // Same shape as stability. `scripted(...)` returns the same readings for the
  // primary and the held-out stream, so overfitting was 0 by construction and
  // replacing the measure with a literal 0 passed everything.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const members = cohort.members
    .filter((member) => member.events.length >= MIN_MEMBER_EVENTS && member.resampleEvents !== null)
    .slice(0, MIN_SLICE_MEMBERS);
  assert.equal(members.length, MIN_SLICE_MEMBERS, 'not enough re-samplable members to measure overfitting');

  // Answers `lean` on the primary stream and `rich` on any other — a profile
  // the held-out data contradicts on every member.
  const contradicting: PersonalizationDeriver = (input) => {
    const total = input.rungAggregates[input.rungAggregates.length - 1]?.lifetime ?? {};
    void total;
    return scripted({
      reminder_density: {
        status: 'operative', dimension: 'reminder_density', reason: null,
        level: seenPrimary.has(input.scopeId) ? 'rich' : 'lean',
        confidence: 0.9, sampleEventCount: 9,
        evidence: [{ rungIndex: 0, outcome: 'ignore', count: 9 }],
      } as PreferenceReading,
    })(input);
  };
  const seenPrimary = new Set<string>();
  // The primary call for a member happens before its held-out call, so the
  // first answer per scope is the primary one and the second contradicts it.
  const wrapped: PersonalizationDeriver = (input) => {
    const answer = contradicting(input);
    seenPrimary.add(input.scopeId);
    return answer;
  };

  const reading = scoreSlice('overfit', members, wrapped, NOW)
    .readings.find((entry) => entry.metric === 'overfitting');
  assert.equal(reading?.kind, 'measured');
  assert.ok(
    reading?.kind === 'measured' && reading.personalized > 0,
    'a profile contradicted by its own held-out re-sample scored zero overfitting',
  );
});

test('the usefulness meter moves between a deriver that answers and one that does not', () => {
  // One archetype, not the first six active members.
  //
  // That distinction is a finding about the metric rather than a fixture
  // detail. Measured on the first six active members — three `quiet_seeker`
  // (explicitly negative, so quieter is what they asked for) and three
  // `content_accepter` (explicitly positive, so the default is) — the inert
  // deriver and a quieting one both score exactly 0.5. Every dimension the
  // quieting deriver wins from a seeker it loses from an accepter, and the mean
  // cancels to the digit.
  //
  // So usefulness averaged over a *balanced* slice is blind to whether the
  // deriver does anything at all. That is not a bug in the measure — a product
  // that helps half its users and hurts the other half has not helped — but it
  // does mean the overall number must never be read alone, which is what the
  // per-slice report is for. Here the slice is deliberately one-sided so the
  // meter has somewhere to move.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const members = cohort.members
    .filter((member) => member.archetype === 'quiet_seeker' && member.events.length >= MIN_MEMBER_EVENTS)
    .slice(0, MIN_SLICE_MEMBERS);
  assert.equal(members.length, MIN_SLICE_MEMBERS, 'not enough quiet_seeker members above the event floor');
  const quieting = scripted({
    reminder_density: {
      status: 'operative', dimension: 'reminder_density', reason: null, level: 'lean',
      confidence: 0.9, sampleEventCount: 9, evidence: [{ rungIndex: 0, outcome: 'reject', count: 9 }],
    } as PreferenceReading,
  });
  const flat = scoreSlice('flat', members, inertDeriver, NOW).readings.find((r) => r.metric === 'usefulness');
  const moved = scoreSlice('moved', members, quieting, NOW).readings.find((r) => r.metric === 'usefulness');
  assert.equal(flat?.kind, 'measured');
  assert.equal(moved?.kind, 'measured');
  assert.ok(
    flat?.kind === 'measured' && moved?.kind === 'measured' && moved.personalized > flat.personalized,
    'usefulness did not rise when the deriver gave a cohort of quiet-seekers a quieter product',
  );
});

test('usefulness cancels on a balanced slice, which is why the overall number is never read alone', () => {
  // The observation above, pinned. If this ever stops holding, the measure has
  // changed shape and the comment beside it is stale.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  // Balanced by construction, not by taking the first six and hoping. Three
  // members whose explicit judgements pull quieter and three whose pull the
  // other way.
  const half = MIN_SLICE_MEMBERS / 2;
  const pick = (archetype: string) =>
    cohort.members
      .filter((member) => member.archetype === archetype && member.events.length >= MIN_MEMBER_EVENTS)
      .slice(0, half);
  const balanced = [...pick('quiet_seeker'), ...pick('content_accepter')];
  assert.equal(balanced.length, MIN_SLICE_MEMBERS, 'could not build a balanced slice at the floor');
  const quieting = scripted({
    reminder_density: {
      status: 'operative', dimension: 'reminder_density', reason: null, level: 'lean',
      confidence: 0.9, sampleEventCount: 9, evidence: [{ rungIndex: 0, outcome: 'reject', count: 9 }],
    } as PreferenceReading,
  });
  const flat = scoreSlice('flat', balanced, inertDeriver, NOW).readings.find((r) => r.metric === 'usefulness');
  const moved = scoreSlice('moved', balanced, quieting, NOW).readings.find((r) => r.metric === 'usefulness');
  assert.ok(flat?.kind === 'measured' && moved?.kind === 'measured');
  assert.equal(
    flat?.kind === 'measured' && moved?.kind === 'measured' && moved.personalized,
    flat?.kind === 'measured' && flat.personalized,
    'the balanced slice no longer cancels; the usefulness measure has changed shape',
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

/* ── Floors pinned against a literal, not against themselves ─────── */

test('the slice and member floors are the numbers they are, not whatever they become', () => {
  // Every floor test above builds its fixture *from* the constant, so the
  // fixture moves with it and 6 -> 5 and 6 -> 7 both survived. A constant that
  // cannot be mutated is not pinned by anything; `OPERATIVE_CONFIDENCE_FLOOR`
  // was already pinned this way and these were not.
  //
  // Pinned against literals deliberately: changing one of these is a decision
  // about how much evidence a published number needs, and it should require
  // editing a test that says so.
  assert.equal(MIN_SLICE_MEMBERS, 6);
  assert.equal(MIN_MEMBER_EVENTS, 5);
});

test('a pool one below the floor is inconclusive and one at it is measured', () => {
  // Both sides, with the pool built to a literal size so the assertion does not
  // slide when the constant does.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const active = cohort.members.filter((member) => member.events.length >= MIN_MEMBER_EVENTS);
  assert.ok(active.length >= 6, 'not enough active members to probe the floor');

  const below = scoreSlice('five', active.slice(0, 5), inertDeriver, NOW)
    .readings.find((reading) => reading.metric === 'usefulness');
  assert.equal(below?.kind, 'inconclusive');

  const at = scoreSlice('six', active.slice(0, 6), inertDeriver, NOW)
    .readings.find((reading) => reading.metric === 'usefulness');
  assert.equal(at?.kind, 'measured');
});

test('a measured reading reports the size of the pool it averaged, not of the slice', () => {
  // The defect this replaced published `outcome_mix:behavioral_led` as a
  // measured value over three members against a floor of six, because the floor
  // guarded `members` and the mean was taken over `scored`.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const active = cohort.members.filter((member) => member.events.length >= MIN_MEMBER_EVENTS).slice(0, 6);
  const quiet = cohort.members.filter((member) => member.events.length === 0).slice(0, 6);
  const mixed = [...active.slice(0, 3), ...quiet];

  for (const reading of scoreSlice('mixed', mixed, inertDeriver, NOW).readings) {
    if (reading.metric === 'cold_start_invention') continue;
    assert.equal(
      reading.kind,
      'inconclusive',
      `${reading.metric} published a mean over 3 members against a floor of ${MIN_SLICE_MEMBERS}`,
    );
    assert.equal(reading.memberCount, 3, 'the reading reported the slice size rather than the averaged pool');
  }
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

test('the gate thresholds are the numbers they are', () => {
  // Every other gate test builds its fixture from the threshold it is probing
  // — `threshold + 0.01`, `threshold - 0.01` — so the fixture slides with the
  // constant and all five values could be moved to absurdity with the suite
  // green. The relational tests above are still the ones that prove the
  // comparators are wired; this is what makes the *values* a decision.
  //
  // Each of these is a policy: how much benefit is enough to ship, how much
  // harm is too much. Changing one should require editing a line that says so.
  assert.deepEqual(
    Object.fromEntries(
      EVALUATION_METRICS.map((metric) => [metric, RELEASE_GATE_SIGNALS[metric].threshold]),
    ),
    {
      usefulness: 0.25,
      stability: 0.75,
      overfitting: 0.25,
      unfair_pressure: 0,
      cold_start_invention: 0,
    },
    'a release-gate threshold moved; that is a decision about what ships, not a refactor',
  );
  assert.deepEqual(
    Object.fromEntries(
      EVALUATION_METRICS.map((metric) => [metric, RELEASE_GATE_SIGNALS[metric].direction]),
    ),
    {
      usefulness: 'benefit',
      stability: 'benefit',
      overfitting: 'harm',
      unfair_pressure: 'harm',
      cold_start_invention: 'harm',
    },
    'a signal changed side; a harm reclassified as a benefit can no longer roll anything back',
  );
  // The two zero ceilings are zero on purpose: unfair pressure and invented
  // cold-start preferences have no acceptable rate, not merely a low one.
  assert.equal(RELEASE_GATE_SIGNALS.unfair_pressure.threshold, 0);
  assert.equal(RELEASE_GATE_SIGNALS.cold_start_invention.threshold, 0);
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

  // Poison a slice that actually *has* a measured reading, rather than
  // whichever one is first. Indexing by position made this test depend on the
  // slice order and on which slices clear the member floor — it broke the
  // moment the floor moved to the averaged pool, which is the fix working.
  const target = clean.slices.find((slice) =>
    slice.readings.some((reading) => reading.metric === 'unfair_pressure' && reading.kind === 'measured'),
  );
  assert.ok(target, 'no slice has a measured unfair_pressure reading, so this test cannot poison one');

  const poisoned = {
    ...clean,
    provenance: 'real_logged' as const,
    slices: clean.slices.map((slice) =>
      slice.sliceId === target.sliceId
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

test('every benefit bar is load-bearing, one at a time, on a real_logged report', () => {
  // The benefit branch is only reachable with `provenance: 'real_logged'`, and
  // every test that built one mutated *harm* readings only — so all three
  // benefit thresholds could be moved to absurd values with the suite green.
  // Per-bar, one at a time: moving them together would prove only that some bar
  // is wired.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const base = buildEvaluationReport(cohort, inertDeriver, NOW);

  // A report that clears every bar and breaches no ceiling: the only shape that
  // can return `keep`, and the baseline this test perturbs from.
  const passing = {
    ...base,
    provenance: 'real_logged' as const,
    slices: [],
    overall: {
      ...base.overall,
      readings: base.overall.readings.map((reading) =>
        reading.kind === 'measured'
          ? {
              ...reading,
              personalized: RELEASE_GATE_SIGNALS[reading.metric].direction === 'benefit' ? 1 : 0,
            }
          : reading,
      ),
    },
  };
  assert.equal(evaluateRollbackGate(passing).verdict, 'keep', 'the passing fixture does not pass');

  for (const metric of EVALUATION_METRICS) {
    if (RELEASE_GATE_SIGNALS[metric].direction !== 'benefit') continue;
    const under = {
      ...passing,
      overall: {
        ...passing.overall,
        readings: passing.overall.readings.map((reading) =>
          reading.metric === metric && reading.kind === 'measured'
            ? { ...reading, personalized: RELEASE_GATE_SIGNALS[metric].threshold - 0.01 }
            : reading,
        ),
      },
    };
    const decision = evaluateRollbackGate(under);
    assert.equal(decision.verdict, 'inconclusive', `${metric} below its bar still authorised a release`);
    assert.ok(decision.notes.some((note) => note.includes(metric)), `${metric} was not named in the notes`);
  }
});

test('the benefit comparison is inclusive at the bar', () => {
  // `<` and `<=` differ only exactly on the threshold, which is the one input
  // that separates them.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const base = buildEvaluationReport(cohort, inertDeriver, NOW);
  const atBars = {
    ...base,
    provenance: 'real_logged' as const,
    slices: [],
    overall: {
      ...base.overall,
      readings: base.overall.readings.map((reading) =>
        reading.kind === 'measured'
          ? {
              ...reading,
              personalized:
                RELEASE_GATE_SIGNALS[reading.metric].direction === 'benefit'
                  ? RELEASE_GATE_SIGNALS[reading.metric].threshold
                  : 0,
            }
          : reading,
      ),
    },
  };
  assert.equal(evaluateRollbackGate(atBars).verdict, 'keep', 'a benefit exactly at its bar was treated as below it');
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
