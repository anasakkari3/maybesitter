/**
 * The deriver: FeedbackAggregates + explicit now + consent -> profile.
 *
 * Fixtures run through the real Sprint 03 aggregation (`rungAggregatesFor`)
 * rather than hand-built aggregates, so window membership, nesting and digest
 * coherence are the real thing and cannot drift from a fixture's idea of them.
 * Every fixture's expected confidence is written as the exact ratio the rule
 * computes (`21/31`, not `0.677`), so a weight or threshold mutation moves the
 * number and fails the assertion — that is the per-site mutation cover.
 *
 * Every derived profile is also run through `checkPersonalizationProfile` and
 * must come back clean: the deriver may never produce what the contract's own
 * checker would reject.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackEvent,
  type FeedbackOutcome,
} from '../../src/contracts/v1/feedbackContracts.ts';
import {
  MIN_OPERATIVE_SAMPLE_EVENTS,
  MIN_SUGGESTION_SAMPLE_EVENTS,
  OPERATIVE_CONFIDENCE_FLOOR,
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LEVEL_INTRUSIVENESS,
  PRODUCT_BASELINE_LEVELS,
  checkPersonalizationProfile,
  inertPersonalizationProfile,
  type EnabledPersonalizationProfile,
  type PersonalizationConsent,
  type PersonalizationDerivationInput,
  type PersonalizationProfile,
  type PreferenceReading,
} from '../../src/contracts/v1/personalizationContracts.ts';
import {
  DERIVATION_SHARE_RULES,
  PROBATIVE_OUTCOMES,
  derivePersonalizationProfile,
} from '../../lib/personalization/derive.ts';
import { rungAggregatesFor } from '../../lib/personalization/rebuild.ts';

const NOW = '2026-08-20T09:00:00.000Z';
const SCOPE = 'alice';
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

const ENABLED: PersonalizationConsent = Object.freeze({ state: 'enabled', changedAt: NOW });
const DISABLED: PersonalizationConsent = Object.freeze({ state: 'disabled', changedAt: null });

let sequence = 0;

/** One event, `ageDays` before NOW. `new Date(millis)` reads no clock. */
function event(outcome: FeedbackOutcome, ageDays: number): FeedbackEvent {
  sequence += 1;
  const occurredAt = new Date(Date.parse(NOW) - ageDays * MS_PER_DAY).toISOString();
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    id: `evt-${sequence}`,
    scopeId: SCOPE,
    outcome,
    subjectId: 'subject-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt,
    recordedAt: occurredAt,
    idempotencyKey: `key-${sequence}`,
  };
}

function many(outcome: FeedbackOutcome, count: number, ageDays: number): FeedbackEvent[] {
  return Array.from({ length: count }, () => event(outcome, ageDays));
}

function derivationInput(
  events: readonly FeedbackEvent[],
  consent: PersonalizationConsent = ENABLED,
): PersonalizationDerivationInput {
  return {
    scopeId: SCOPE,
    now: NOW,
    consent,
    rungAggregates: rungAggregatesFor({ scopeId: SCOPE, now: NOW, events, baseline: null }),
  };
}

/** Derive and demand the contract checker agrees the result is well-formed. */
function deriveClean(input: PersonalizationDerivationInput): PersonalizationProfile {
  const profile = derivePersonalizationProfile(input);
  assert.deepEqual(
    checkPersonalizationProfile(profile),
    [],
    'the deriver produced a profile its own contract checker rejects',
  );
  return profile;
}

function enabledProfile(input: PersonalizationDerivationInput): EnabledPersonalizationProfile {
  const profile = deriveClean(input);
  assert.equal(profile.consent, 'enabled');
  return profile as EnabledPersonalizationProfile;
}

function reading(profile: EnabledPersonalizationProfile, dimension: (typeof PREFERENCE_DIMENSIONS)[number]): PreferenceReading {
  return profile.readings[dimension];
}

/* ── Consent gate ────────────────────────────────────────────────── */

test('disabled consent short-circuits to the inert profile, byte-identical to the factory', () => {
  const input = derivationInput(many('reject', 10, 1), DISABLED);
  const profile = deriveClean(input);
  assert.deepEqual(profile, inertPersonalizationProfile(SCOPE, NOW));
  assert.equal(JSON.stringify(profile), JSON.stringify(inertPersonalizationProfile(SCOPE, NOW)));
});

test('an unreadable consent state is disabled consent, per the input policy', () => {
  const withGarbageConsent = {
    ...derivationInput(many('accept', 5, 1)),
    consent: { state: 'paused', changedAt: null } as unknown as PersonalizationConsent,
  };
  assert.deepEqual(deriveClean(withGarbageConsent), inertPersonalizationProfile(SCOPE, NOW));
});

test('the consent gate precedes rung validation: a disabled call never depends on aggregates', () => {
  const input: PersonalizationDerivationInput = {
    scopeId: SCOPE,
    now: NOW,
    consent: DISABLED,
    rungAggregates: [],
  };
  assert.deepEqual(deriveClean(input), inertPersonalizationProfile(SCOPE, NOW));
});

/* ── Input validation: producer-style throws ─────────────────────── */

test('unusable scope, now, or mismatched rung aggregates are programming errors and throw', () => {
  const good = derivationInput(many('accept', 3, 1));
  assert.throws(() => derivePersonalizationProfile({ ...good, scopeId: '  ' }), TypeError);
  assert.throws(() => derivePersonalizationProfile({ ...good, now: 'yesterday' }), TypeError);
  assert.throws(
    () => derivePersonalizationProfile({ ...good, rungAggregates: good.rungAggregates.slice(0, 2) }),
    TypeError,
  );

  const wrongWindow = JSON.parse(JSON.stringify(good)) as PersonalizationDerivationInput;
  (wrongWindow.rungAggregates[1] as { windowDays: number }).windowDays = 15;
  assert.throws(() => derivePersonalizationProfile(wrongWindow), TypeError);

  const foreignScope = JSON.parse(JSON.stringify(good)) as PersonalizationDerivationInput;
  (foreignScope.rungAggregates[0] as { scopeId: string }).scopeId = 'bob';
  assert.throws(() => derivePersonalizationProfile(foreignScope), TypeError);

  const staleAggregate = JSON.parse(JSON.stringify(good)) as PersonalizationDerivationInput;
  (staleAggregate.rungAggregates[2] as { computedAt: string }).computedAt = '2026-08-19T09:00:00.000Z';
  assert.throws(() => derivePersonalizationProfile(staleAggregate), TypeError);
});

/* ── The empty log ───────────────────────────────────────────────── */

test('an empty log derives a total profile of insufficient-sample readings', () => {
  const profile = enabledProfile(derivationInput([]));
  for (const dimension of PREFERENCE_DIMENSIONS) {
    const entry = reading(profile, dimension);
    assert.equal(entry.status, 'inconclusive', dimension);
    assert.equal(entry.status === 'inconclusive' && entry.reason, 'insufficient_sample', dimension);
    assert.equal(entry.level, null, dimension);
    assert.equal(entry.confidence, null, dimension);
  }
  assert.equal(profile.basis.rungs.length, PERSONALIZATION_WINDOW_LADDER_DAYS.length);
  for (const rung of profile.basis.rungs) {
    assert.ok(rung.inputDigest.length > 0);
  }
});

/* ── The #107 shape: behaviour may quiet, never sharpen ──────────── */

test('a behaviour-only log derives quiet: density de-escalates, pressure dimensions stay inconclusive', () => {
  const profile = enabledProfile(derivationInput(many('ignore', 6, 1)));

  assert.deepEqual(reading(profile, 'reminder_density'), {
    status: 'operative',
    dimension: 'reminder_density',
    reason: null,
    level: 'lean',
    confidence: 1,
    sampleEventCount: 6,
    evidence: [
      { rungIndex: 0, outcome: 'ignore', count: 6 },
      { rungIndex: 1, outcome: 'ignore', count: 6 },
      { rungIndex: 2, outcome: 'ignore', count: 6 },
    ],
  });

  for (const dimension of ['pressure_ceiling', 'pressure_tone', 'suggestion_directness'] as const) {
    const entry = reading(profile, dimension);
    assert.equal(entry.status, 'inconclusive', dimension);
    assert.equal(entry.status === 'inconclusive' && entry.reason, 'no_admissible_evidence', dimension);
    assert.deepEqual(entry.evidence, [], dimension);
    assert.equal(entry.sampleEventCount, 0, dimension);
  }
});

test('no behaviour-only log can place any dimension above its product baseline', () => {
  const logs = [
    many('ignore', 40, 1),
    [...many('complete', 30, 1), ...many('defer', 10, 30)],
    [...many('ignore', 3, 1), ...many('complete', 3, 100), ...many('defer', 3, 30)],
  ];
  for (const log of logs) {
    const profile = enabledProfile(derivationInput(log));
    for (const dimension of PREFERENCE_DIMENSIONS) {
      const entry = reading(profile, dimension);
      if (entry.level === null) continue;
      const ranks = PREFERENCE_LEVEL_INTRUSIVENESS[dimension] as Readonly<Record<string, number>>;
      assert.ok(
        ranks[entry.level] <= ranks[PRODUCT_BASELINE_LEVELS[dimension]],
        `${dimension}: behavioural inference escalated to ${entry.level}`,
      );
    }
  }
});

test('pressure_tone is never derived in v1: outcome counts carry no tone signal', () => {
  const profile = enabledProfile(derivationInput([...many('accept', 8, 1), ...many('reject', 8, 1)]));
  assert.deepEqual(reading(profile, 'pressure_tone'), {
    status: 'inconclusive',
    dimension: 'pressure_tone',
    reason: 'no_admissible_evidence',
    level: null,
    confidence: null,
    sampleEventCount: 0,
    evidence: [],
  });
  assert.deepEqual(PROBATIVE_OUTCOMES.pressure_tone, []);
});

/* ── pressure_ceiling: the off switch ────────────────────────────── */

test('a weighted rejection majority at exactly the threshold turns pressure off', () => {
  // 5 rejects, 5 accepts, all recent: negative share exactly 0.5.
  const profile = enabledProfile(derivationInput([...many('reject', 5, 1), ...many('accept', 5, 1)]));
  const entry = reading(profile, 'pressure_ceiling');
  assert.equal(entry.status, 'suggestion');
  assert.equal(entry.level, 'none');
  assert.equal(entry.confidence, 5 / 10);
  assert.equal(entry.sampleEventCount, 10);
});

test('just below the threshold the ceiling stays at baseline', () => {
  const profile = enabledProfile(derivationInput([...many('reject', 4, 1), ...many('accept', 6, 1)]));
  const entry = reading(profile, 'pressure_ceiling');
  assert.equal(entry.level, 'low');
  assert.equal(entry.confidence, 6 / 10);
  assert.equal(entry.status, 'suggestion');
});

test('the confidence floor is inclusive: support at exactly 0.7 is operative, at 0.6 a suggestion', () => {
  const atFloor = enabledProfile(derivationInput([...many('reject', 7, 1), ...many('accept', 3, 1)]));
  const atFloorReading = reading(atFloor, 'pressure_ceiling');
  assert.equal(atFloorReading.status, 'operative');
  assert.equal(atFloorReading.level, 'none');
  assert.equal(atFloorReading.confidence, OPERATIVE_CONFIDENCE_FLOOR);

  const belowFloor = enabledProfile(derivationInput([...many('reject', 6, 1), ...many('accept', 4, 1)]));
  const belowFloorReading = reading(belowFloor, 'pressure_ceiling');
  assert.equal(belowFloorReading.status, 'suggestion');
  assert.equal(belowFloorReading.level, 'none');
  assert.equal(belowFloorReading.confidence, 6 / 10);

  const confirmedBaseline = enabledProfile(derivationInput([...many('reject', 3, 1), ...many('accept', 7, 1)]));
  const confirmedReading = reading(confirmedBaseline, 'pressure_ceiling');
  assert.equal(confirmedReading.status, 'operative');
  assert.equal(confirmedReading.level, 'low');
  assert.equal(confirmedReading.confidence, OPERATIVE_CONFIDENCE_FLOOR);
});

test('the sample floors are inclusive on both variants', () => {
  const operativeAtFloor = enabledProfile(derivationInput(many('reject', MIN_OPERATIVE_SAMPLE_EVENTS, 1)));
  assert.equal(reading(operativeAtFloor, 'pressure_ceiling').status, 'operative');

  const oneBelowOperative = enabledProfile(
    derivationInput(many('reject', MIN_OPERATIVE_SAMPLE_EVENTS - 1, 1)),
  );
  const belowReading = reading(oneBelowOperative, 'pressure_ceiling');
  assert.equal(belowReading.status, 'suggestion');
  assert.equal(belowReading.confidence, 1);

  const suggestionAtFloor = enabledProfile(
    derivationInput(many('reject', MIN_SUGGESTION_SAMPLE_EVENTS, 1)),
  );
  assert.equal(reading(suggestionAtFloor, 'pressure_ceiling').status, 'suggestion');

  const oneBelowSuggestion = enabledProfile(
    derivationInput(many('reject', MIN_SUGGESTION_SAMPLE_EVENTS - 1, 1)),
  );
  const inconclusive = reading(oneBelowSuggestion, 'pressure_ceiling');
  assert.equal(inconclusive.status, 'inconclusive');
  assert.equal(inconclusive.status === 'inconclusive' && inconclusive.reason, 'insufficient_sample');
});

/* ── suggestion_directness ───────────────────────────────────────── */

test('a weighted edit majority derives supportive — the one v1 escalation, explicit-backed', () => {
  const atThreshold = enabledProfile(derivationInput([...many('edit', 5, 1), ...many('accept', 5, 1)]));
  const atThresholdReading = reading(atThreshold, 'suggestion_directness');
  assert.equal(atThresholdReading.level, 'supportive');
  assert.equal(atThresholdReading.status, 'suggestion');
  assert.equal(atThresholdReading.confidence, 5 / 10);

  const strong = enabledProfile(derivationInput([...many('edit', 8, 1), ...many('accept', 2, 1)]));
  const strongReading = reading(strong, 'suggestion_directness');
  assert.equal(strongReading.status, 'operative');
  assert.equal(strongReading.level, 'supportive');
  assert.equal(strongReading.confidence, 8 / 10);

  const belowThreshold = enabledProfile(derivationInput([...many('edit', 4, 1), ...many('accept', 6, 1)]));
  const belowReading = reading(belowThreshold, 'suggestion_directness');
  assert.equal(belowReading.level, 'minimal');
  assert.equal(belowReading.confidence, 6 / 10);
});

test('explicit dissatisfaction with no direction for directness is conflicting, not a guess', () => {
  const profile = enabledProfile(derivationInput([...many('reject', 7, 1), ...many('accept', 3, 1)]));
  const entry = reading(profile, 'suggestion_directness');
  assert.equal(entry.status, 'inconclusive');
  assert.equal(entry.status === 'inconclusive' && entry.reason, 'conflicting_evidence');
  assert.equal(entry.level, null);
});

/* ── reminder_density ────────────────────────────────────────────── */

test('the lean threshold is inclusive and engagement confirms standard', () => {
  const leanAtThreshold = enabledProfile(
    derivationInput([...many('ignore', 3, 1), ...many('reject', 2, 1), ...many('accept', 5, 1)]),
  );
  const leanReading = reading(leanAtThreshold, 'reminder_density');
  assert.equal(leanReading.level, 'lean');
  assert.equal(leanReading.confidence, 5 / 10);
  assert.equal(leanReading.status, 'suggestion');

  const standard = enabledProfile(
    derivationInput([...many('accept', 6, 1), ...many('complete', 1, 1), ...many('ignore', 3, 1)]),
  );
  const standardReading = reading(standard, 'reminder_density');
  assert.equal(standardReading.status, 'operative');
  assert.equal(standardReading.level, 'standard');
  assert.equal(standardReading.confidence, 7 / 10);
});

test('defer dilutes both density baskets: a defer-heavy log is conflicting evidence', () => {
  const profile = enabledProfile(
    derivationInput([...many('defer', 6, 1), ...many('accept', 2, 1), ...many('ignore', 2, 1)]),
  );
  const entry = reading(profile, 'reminder_density');
  assert.equal(entry.status, 'inconclusive');
  assert.equal(entry.status === 'inconclusive' && entry.reason, 'conflicting_evidence');
  assert.equal(entry.sampleEventCount, 10);
});

/* ── Decay: the window ladder does the forgetting ────────────────── */

test('old rejections are outweighed by recent acceptance: the exact ladder arithmetic', () => {
  // 3 accepts at age 1 sit in all three rungs: weight 4+2+1 = 7 each -> 21.
  // 10 rejects at age 100 sit in the 224-day rung only: weight 1 each -> 10.
  const profile = enabledProfile(derivationInput([...many('accept', 3, 1), ...many('reject', 10, 100)]));
  assert.deepEqual(reading(profile, 'pressure_ceiling'), {
    status: 'suggestion',
    dimension: 'pressure_ceiling',
    reason: null,
    level: 'low',
    confidence: 21 / 31,
    sampleEventCount: 13,
    evidence: [
      { rungIndex: 0, outcome: 'accept', count: 3 },
      { rungIndex: 1, outcome: 'accept', count: 3 },
      { rungIndex: 2, outcome: 'accept', count: 3 },
      { rungIndex: 2, outcome: 'reject', count: 10 },
    ],
  });
});

test('evidence beyond the newest window still counts: the sample is the horizon, not the fortnight', () => {
  const profile = enabledProfile(derivationInput(many('reject', 6, 100)));
  const entry = reading(profile, 'pressure_ceiling');
  assert.equal(entry.status, 'operative');
  assert.equal(entry.level, 'none');
  assert.equal(entry.confidence, 1);
  assert.equal(entry.sampleEventCount, 6);
  assert.deepEqual(entry.evidence, [{ rungIndex: 2, outcome: 'reject', count: 6 }]);
});

test('a mid-ladder event carries the two outer weights: exact mixed-rung arithmetic', () => {
  // 4 rejects at age 30 (rungs 1 and 2): weight 2+1 = 3 each -> 12.
  // 4 accepts at age 1 (all rungs): weight 7 each -> 28. Support 28/40 = 0.7.
  const profile = enabledProfile(derivationInput([...many('reject', 4, 30), ...many('accept', 4, 1)]));
  const entry = reading(profile, 'pressure_ceiling');
  assert.equal(entry.status, 'operative');
  assert.equal(entry.level, 'low');
  assert.equal(entry.confidence, 28 / 40);
  assert.equal(entry.sampleEventCount, 8);
  assert.deepEqual(entry.evidence, [
    { rungIndex: 0, outcome: 'accept', count: 4 },
    { rungIndex: 1, outcome: 'accept', count: 4 },
    { rungIndex: 1, outcome: 'reject', count: 4 },
    { rungIndex: 2, outcome: 'accept', count: 4 },
    { rungIndex: 2, outcome: 'reject', count: 4 },
  ]);
});

/* ── Determinism and rule sanity ─────────────────────────────────── */

test('same input twice: byte-identical profiles', () => {
  const input = derivationInput([...many('accept', 4, 1), ...many('reject', 3, 30), ...many('ignore', 5, 100)]);
  const first = derivePersonalizationProfile(input);
  const second = derivePersonalizationProfile(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('every share rule is a genuine majority-or-better threshold', () => {
  for (const [name, share] of Object.entries(DERIVATION_SHARE_RULES)) {
    assert.ok(share >= 0.5 && share <= 1, `${name}: a level claim must rest on at least a weighted majority`);
  }
});
