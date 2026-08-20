/**
 * The personalization contract: vocabularies, floors, the #107 invariants,
 * and the two structural checkers.
 *
 * The tests here are about properties the *contract* claims. Following the
 * Sprint 08 lesson that a vocabulary is only as real as the assertion that
 * enumerates it, the closed sets are pinned with exact `deepEqual` — adding a
 * dimension, a level, an outcome class or an invariant is a decision this
 * suite forces into review rather than lets drift in. The floors and the one
 * limit are each reached from both sides, because a limit no test can name is
 * documentation of an intention.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BEHAVIORAL_INFERENCE_OUTCOMES,
  EXPLICIT_JUDGEMENT_OUTCOMES,
  FEEDBACK_OUTCOME_CLASSES,
  FORBIDDEN_DERIVATION_SIGNALS,
  INCONCLUSIVE_REASONS,
  MIN_OPERATIVE_SAMPLE_EVENTS,
  MIN_SUGGESTION_SAMPLE_EVENTS,
  OPERATIVE_CONFIDENCE_FLOOR,
  PERSONALIZATION_CONSENT_POLICY,
  PERSONALIZATION_CONSENT_STATES,
  PERSONALIZATION_CONTRACT_VERSION,
  PERSONALIZATION_DEFECT_PARTITIONS,
  PERSONALIZATION_EVIDENCE_HORIZON_DAYS,
  PERSONALIZATION_EVIDENCE_OUTCOMES,
  PERSONALIZATION_INPUT_POLICY,
  PERSONALIZATION_INVARIANTS,
  PERSONALIZATION_LIMITS,
  PERSONALIZATION_LIMIT_NAMES,
  PERSONALIZATION_PERSISTENCE_POLICY,
  PERSONALIZATION_PROFILE_DEFECT_CODES,
  PERSONALIZATION_RECEIPT_DEFECT_CODES,
  PERSONALIZATION_RUNG_WEIGHTS,
  PERSONALIZATION_SCHEMA_VERSION,
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_DIMENSION_CLASSES,
  PREFERENCE_LEVEL_INTRUSIVENESS,
  PREFERENCE_LEVEL_VOCABULARY,
  PREFERENCE_STATUSES,
  PRESSURE_INTENSITY_LEVELS,
  PRESSURE_INTENSITY_RANK,
  PRODUCT_BASELINE_LEVELS,
  admissibleOutcomesFor,
  checkPersonalizationDeletionReceipt,
  checkPersonalizationProfile,
  inertPersonalizationProfile,
  isEscalation,
  operativeReadings,
  type EnabledPersonalizationProfile,
  type InconclusiveReading,
  type OperativeReading,
  type PersonalizationDefect,
  type PersonalizationDeletionReceipt,
  type PersonalizationProfile,
  type PreferenceDimension,
  type PreferenceEvidence,
} from '../../src/contracts/v1/personalizationContracts.ts';
import { MODULE_CONTRACT_VERSION } from '../../src/contracts/v1/moduleContracts.ts';
import { DEFAULT_FEEDBACK_WINDOW_DAYS } from '../../src/contracts/v1/feedbackContracts.ts';

const DERIVED_AT = '2026-08-20T09:00:00Z';
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** A window start coherent with `DERIVED_AT`. `new Date(millis)` reads no clock. */
function windowStartFor(days: number): string {
  return new Date(Date.parse(DERIVED_AT) - days * MS_PER_DAY).toISOString();
}

/**
 * A fully valid enabled profile: one operative de-escalation, one
 * inconclusive dimension, one explicitly-evidenced escalated suggestion, one
 * behaviourally-evidenced de-escalated suggestion — every legal shape appears
 * once, so "valid means no findings" is checked over the whole vocabulary.
 * Fresh objects per call, so tampering in one test cannot leak into another.
 */
function validProfile(): EnabledPersonalizationProfile {
  return {
    version: PERSONALIZATION_CONTRACT_VERSION,
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    scopeId: 'scope-a',
    consent: 'enabled',
    derivedAt: DERIVED_AT,
    basis: {
      scopeId: 'scope-a',
      rungs: PERSONALIZATION_WINDOW_LADDER_DAYS.map((days, index) => ({
        windowDays: days,
        windowStart: windowStartFor(days),
        inputDigest: `sha256-fixture-rung-${index}`,
        revokedCount: 0,
      })),
    },
    readings: {
      pressure_ceiling: {
        status: 'operative',
        dimension: 'pressure_ceiling',
        reason: null,
        level: 'none',
        confidence: 0.8,
        sampleEventCount: 6,
        evidence: [
          { rungIndex: 0, outcome: 'reject', count: 4 },
          { rungIndex: 1, outcome: 'reject', count: 2 },
        ],
      },
      pressure_tone: {
        status: 'inconclusive',
        dimension: 'pressure_tone',
        reason: 'no_admissible_evidence',
        level: null,
        confidence: null,
        sampleEventCount: 0,
        evidence: [],
      },
      suggestion_directness: {
        status: 'suggestion',
        dimension: 'suggestion_directness',
        reason: null,
        level: 'supportive',
        confidence: 0.5,
        sampleEventCount: 3,
        evidence: [{ rungIndex: 0, outcome: 'edit', count: 3 }],
      },
      reminder_density: {
        status: 'suggestion',
        dimension: 'reminder_density',
        reason: null,
        level: 'lean',
        confidence: 0.4,
        sampleEventCount: 5,
        evidence: [{ rungIndex: 2, outcome: 'ignore', count: 5 }],
      },
    },
  };
}

/** The untyped boundary: what arrives from `JSON.parse`, tampered. */
function tampered(mutate: (profile: Record<string, unknown>) => void): PersonalizationProfile {
  const profile = JSON.parse(JSON.stringify(validProfile())) as Record<string, unknown>;
  mutate(profile);
  return profile as unknown as PersonalizationProfile;
}

function codesOf(defects: readonly PersonalizationDefect[]): readonly string[] {
  return defects.map((entry) => entry.code);
}

function validReceipt(): PersonalizationDeletionReceipt {
  return {
    version: PERSONALIZATION_CONTRACT_VERSION,
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    scopeId: 'scope-a',
    deletedAt: DERIVED_AT,
    remainingFeedbackEventCount: 0,
    remainingRuntimeMemoryRecordCount: 0,
    remainingPersistedProfileCount: 0,
    emptyStateDigest: 'sha256-fixture-empty-state',
  };
}

function tamperedReceipt(
  mutate: (receipt: Record<string, unknown>) => void,
): PersonalizationDeletionReceipt {
  const receipt = JSON.parse(JSON.stringify(validReceipt())) as Record<string, unknown>;
  mutate(receipt);
  return receipt as unknown as PersonalizationDeletionReceipt;
}

/* ── Versions ────────────────────────────────────────────────────── */

test('the schema version is spelled the way the module descriptor will pin it', () => {
  assert.equal(PERSONALIZATION_SCHEMA_VERSION, 'personalization-v1');
  assert.equal(PERSONALIZATION_CONTRACT_VERSION, MODULE_CONTRACT_VERSION);
});

/* ── Closed vocabularies, pinned exactly ─────────────────────────── */

test('the dimension vocabulary is exactly the four knobs consumers can honour', () => {
  assert.deepEqual(PREFERENCE_DIMENSIONS, [
    'pressure_ceiling',
    'pressure_tone',
    'suggestion_directness',
    'reminder_density',
  ]);
});

test('every dimension has a closed level set, and the ceiling shares the safety vocabulary', () => {
  assert.deepEqual(PREFERENCE_LEVEL_VOCABULARY, {
    pressure_ceiling: ['none', 'low', 'medium', 'high'],
    pressure_tone: ['soft', 'firm'],
    suggestion_directness: ['minimal', 'supportive', 'direct'],
    reminder_density: ['lean', 'standard', 'rich'],
  });
  // The same value, not a same-looking copy: one pressure vocabulary.
  assert.equal(PREFERENCE_LEVEL_VOCABULARY.pressure_ceiling, PRESSURE_INTENSITY_LEVELS);
  assert.equal(PREFERENCE_LEVEL_INTRUSIVENESS.pressure_ceiling, PRESSURE_INTENSITY_RANK);
});

test('dimension classes, baselines and intrusiveness ranks are total and coherent', () => {
  assert.deepEqual(PREFERENCE_DIMENSION_CLASSES, {
    pressure_ceiling: 'pressure_bearing',
    pressure_tone: 'pressure_bearing',
    suggestion_directness: 'pressure_bearing',
    reminder_density: 'presentation',
  });
  assert.deepEqual(PRODUCT_BASELINE_LEVELS, {
    pressure_ceiling: 'low',
    pressure_tone: 'soft',
    suggestion_directness: 'minimal',
    reminder_density: 'standard',
  });
  for (const dimension of PREFERENCE_DIMENSIONS) {
    const vocabulary = PREFERENCE_LEVEL_VOCABULARY[dimension] as readonly string[];
    const ranks = PREFERENCE_LEVEL_INTRUSIVENESS[dimension] as Readonly<Record<string, number>>;
    assert.ok(
      (vocabulary as readonly string[]).includes(PRODUCT_BASELINE_LEVELS[dimension]),
      `${dimension}: baseline must be a member of its own vocabulary`,
    );
    for (const level of vocabulary) {
      assert.equal(typeof ranks[level], 'number', `${dimension}/${level}: every level must be ranked`);
    }
  }
});

test('the outcome classification is exact, and it partitions the whole outcome vocabulary', () => {
  assert.deepEqual(FEEDBACK_OUTCOME_CLASSES, {
    accept: 'explicit_judgement',
    edit: 'explicit_judgement',
    reject: 'explicit_judgement',
    undo: 'explicit_judgement',
    defer: 'behavioral_inference',
    complete: 'behavioral_inference',
    ignore: 'behavioral_inference',
  });
  assert.deepEqual(EXPLICIT_JUDGEMENT_OUTCOMES, ['accept', 'edit', 'reject', 'undo']);
  assert.deepEqual(BEHAVIORAL_INFERENCE_OUTCOMES, ['defer', 'complete', 'ignore']);
  // Disjoint and jointly exhaustive over the enumerated vocabulary.
  assert.deepEqual(
    [...EXPLICIT_JUDGEMENT_OUTCOMES, ...BEHAVIORAL_INFERENCE_OUTCOMES].length,
    PERSONALIZATION_EVIDENCE_OUTCOMES.length,
  );
  for (const outcome of PERSONALIZATION_EVIDENCE_OUTCOMES) {
    assert.equal(
      EXPLICIT_JUDGEMENT_OUTCOMES.includes(outcome) !== BEHAVIORAL_INFERENCE_OUTCOMES.includes(outcome),
      true,
      `${outcome}: must sit in exactly one class`,
    );
  }
});

test('statuses, inconclusive reasons and consent states are the pinned sets', () => {
  assert.deepEqual(PREFERENCE_STATUSES, ['inconclusive', 'suggestion', 'operative']);
  assert.deepEqual(INCONCLUSIVE_REASONS, [
    'insufficient_sample',
    'conflicting_evidence',
    'no_admissible_evidence',
  ]);
  assert.deepEqual(PERSONALIZATION_CONSENT_STATES, ['enabled', 'disabled']);
});

test('the invariant list and the forbidden-signal list are pinned, and no forbidden signal is a dimension', () => {
  assert.deepEqual(PERSONALIZATION_INVARIANTS, [
    'NO_ENGAGEMENT_OPTIMIZATION',
    'NO_LATENCY_SIGNAL_IN_INPUT',
    'PRESSURE_DIMENSIONS_EXPLICIT_ONLY',
    'BEHAVIORAL_INFERENCE_NEVER_ESCALATES',
    'LOW_CONFIDENCE_NEVER_OPERATIVE',
    'SMALL_SAMPLE_IS_INCONCLUSIVE',
    'DISABLED_CONSENT_YIELDS_INERT_PROFILE',
    'PROFILE_REPRODUCIBLE_FROM_NON_REVOKED_EVENTS',
    'NO_RAW_TEXT_IN_PROFILE',
    'DELETION_IS_VERIFIABLE',
    'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE',
  ]);
  assert.deepEqual(FORBIDDEN_DERIVATION_SIGNALS, [
    'response_latency',
    'time_to_acknowledge',
    'compliance_rate',
    'engagement_frequency',
    'session_length',
    'notification_open_rate',
  ]);
  for (const signal of FORBIDDEN_DERIVATION_SIGNALS) {
    assert.equal(
      (PREFERENCE_DIMENSIONS as readonly string[]).includes(signal),
      false,
      `${signal}: a forbidden signal must never become a preference dimension`,
    );
  }
});

/* ── Decay policy ────────────────────────────────────────────────── */

test('the window ladder is the pinned decay policy, aligned with the feedback window', () => {
  assert.deepEqual(PERSONALIZATION_WINDOW_LADDER_DAYS, [14, 56, 224]);
  assert.deepEqual(PERSONALIZATION_RUNG_WEIGHTS, [4, 2, 1]);
  assert.equal(PERSONALIZATION_RUNG_WEIGHTS.length, PERSONALIZATION_WINDOW_LADDER_DAYS.length);
  // One number, not two that happen to match.
  assert.equal(PERSONALIZATION_WINDOW_LADDER_DAYS[0], DEFAULT_FEEDBACK_WINDOW_DAYS);
  // The horizon is the outermost rung, derived rather than restated.
  assert.equal(
    PERSONALIZATION_EVIDENCE_HORIZON_DAYS,
    PERSONALIZATION_WINDOW_LADDER_DAYS[PERSONALIZATION_WINDOW_LADDER_DAYS.length - 1],
  );
  // Windows widen and weights fall: the decay points backwards in time.
  for (let index = 1; index < PERSONALIZATION_WINDOW_LADDER_DAYS.length; index += 1) {
    assert.ok(PERSONALIZATION_WINDOW_LADDER_DAYS[index] > PERSONALIZATION_WINDOW_LADDER_DAYS[index - 1]);
    assert.ok(PERSONALIZATION_RUNG_WEIGHTS[index] < PERSONALIZATION_RUNG_WEIGHTS[index - 1]);
  }
});

/* ── Floors ──────────────────────────────────────────────────────── */

test('the floors are ordered the way the three-variant verdict requires', () => {
  assert.ok(OPERATIVE_CONFIDENCE_FLOOR > 0 && OPERATIVE_CONFIDENCE_FLOOR <= 1);
  assert.ok(MIN_SUGGESTION_SAMPLE_EVENTS >= 1);
  assert.ok(MIN_OPERATIVE_SAMPLE_EVENTS > MIN_SUGGESTION_SAMPLE_EVENTS);
});

/* ── Defect taxonomies ───────────────────────────────────────────── */

test('the defect partitions are pinned and disjoint', () => {
  assert.deepEqual(Object.keys(PERSONALIZATION_DEFECT_PARTITIONS), ['profile', 'receipt']);
  assert.equal(PERSONALIZATION_DEFECT_PARTITIONS.profile, PERSONALIZATION_PROFILE_DEFECT_CODES);
  assert.equal(PERSONALIZATION_DEFECT_PARTITIONS.receipt, PERSONALIZATION_RECEIPT_DEFECT_CODES);
  const receiptSet = new Set<string>(PERSONALIZATION_RECEIPT_DEFECT_CODES);
  for (const code of PERSONALIZATION_PROFILE_DEFECT_CODES) {
    assert.equal(receiptSet.has(code), false, `${code}: must belong to exactly one partition`);
  }
  assert.equal(PERSONALIZATION_PROFILE_DEFECT_CODES.length, 29);
  assert.equal(PERSONALIZATION_RECEIPT_DEFECT_CODES.length, 6);
});

/* ── Policies pinned ─────────────────────────────────────────────── */

test('the three policy objects are pinned, so flipping a flag is a reviewed decision', () => {
  assert.deepEqual(PERSONALIZATION_INPUT_POLICY, {
    reportWhatTheTaxonomyNames: true,
    noAmbientClock: true,
    derivationReadsCountsNeverEvents: true,
    digestsComeFromFeedbackAggregation: true,
    unreadableConsentIsDisabled: true,
  });
  assert.deepEqual(PERSONALIZATION_PERSISTENCE_POLICY, {
    profileCanPersist: false,
    profileRecomputedPerRead: true,
    deriverPerformsNoWrites: true,
    rawTextInProfile: false,
    profileNeverFineTuned: true,
    profileExportPolicy: 'personal_never_export',
  });
  assert.deepEqual(PERSONALIZATION_CONSENT_POLICY, {
    defaultState: 'disabled',
    disabledConsentYieldsInertProfile: true,
    profileMustNotOutliveConsentCheck: true,
    deletionProducesVerifiableReceipt: true,
  });
});

/* ── The confidence structure, at the type level ─────────────────── */

test('the type forbids the shapes the floor exists for', () => {
  const evidence: PreferenceEvidence = { rungIndex: 0, outcome: 'reject', count: 1 };

  const bareOperative: OperativeReading<'pressure_ceiling'> = {
    status: 'operative',
    dimension: 'pressure_ceiling',
    reason: null,
    level: 'none',
    confidence: 0.9,
    sampleEventCount: 6,
    // @ts-expect-error — an operative reading without evidence must not compile.
    evidence: [],
  };

  const numberlessOperative: OperativeReading<'pressure_ceiling'> = {
    status: 'operative',
    dimension: 'pressure_ceiling',
    reason: null,
    level: 'none',
    // @ts-expect-error — an operative reading cannot carry a null confidence.
    confidence: null,
    sampleEventCount: 6,
    evidence: [evidence],
  };

  const decidedInconclusive: InconclusiveReading<'pressure_ceiling'> = {
    status: 'inconclusive',
    dimension: 'pressure_ceiling',
    reason: 'insufficient_sample',
    // @ts-expect-error — an inconclusive reading cannot carry a level.
    level: 'high',
    confidence: null,
    sampleEventCount: 1,
    evidence: [],
  };

  const crossedLevels: OperativeReading<'pressure_tone'> = {
    status: 'operative',
    dimension: 'pressure_tone',
    reason: null,
    // @ts-expect-error — a level from another dimension's vocabulary must not compile.
    level: 'high',
    confidence: 0.9,
    sampleEventCount: 6,
    evidence: [evidence],
  };

  void bareOperative;
  void numberlessOperative;
  void decidedInconclusive;
  void crossedLevels;
  assert.ok(true);
});

/* ── The checker: valid shapes, determinism, garbage ─────────────── */

test('a fully valid profile produces no findings', () => {
  assert.deepEqual(checkPersonalizationProfile(validProfile()), []);
});

test('the checker and the inert factory are deterministic: same input, byte-identical output', () => {
  const profile = validProfile();
  const first = checkPersonalizationProfile(profile);
  const second = checkPersonalizationProfile(profile);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const inertA = inertPersonalizationProfile('scope-a', DERIVED_AT);
  const inertB = inertPersonalizationProfile('scope-a', DERIVED_AT);
  assert.deepEqual(inertA, inertB);
  assert.equal(JSON.stringify(inertA), JSON.stringify(inertB));
});

test('the checker reports and never throws, for any input', () => {
  for (const garbage of [null, undefined, 42, 'profile', [], {}]) {
    const defects = checkPersonalizationProfile(garbage as unknown as PersonalizationProfile);
    assert.ok(Array.isArray(defects));
  }
  assert.deepEqual(codesOf(checkPersonalizationProfile(null as unknown as PersonalizationProfile)), [
    'PROFILE_UNREADABLE',
  ]);
});

/* ── Consent: inert by shape, checked at the boundary ────────────── */

test('the inert profile is clean, and a disabled profile carrying readings is reported', () => {
  assert.deepEqual(checkPersonalizationProfile(inertPersonalizationProfile('scope-a', DERIVED_AT)), []);

  const notInert = tampered((profile) => {
    profile.consent = 'disabled';
    // readings and basis left in place: the tamper the code exists for.
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(notInert)), ['DISABLED_PROFILE_NOT_INERT']);
});

test('an unknown consent is reported alone: per-variant checks are suppressed after it', () => {
  const paused = tampered((profile) => {
    profile.consent = 'paused';
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(paused)), ['CONSENT_UNKNOWN']);
});

test('operativeReadings is the fail-closed read path', () => {
  const fromValid = operativeReadings(validProfile());
  assert.equal(fromValid.length, 1);
  assert.equal(fromValid[0].dimension, 'pressure_ceiling');

  assert.deepEqual(operativeReadings(inertPersonalizationProfile('scope-a', DERIVED_AT)), []);
  // A disabled profile that (illegally) still carries readings yields nothing:
  // the consent gate comes before the shape.
  const notInert = tampered((profile) => {
    profile.consent = 'disabled';
  });
  assert.deepEqual(operativeReadings(notInert), []);
  assert.deepEqual(operativeReadings(null as unknown as PersonalizationProfile), []);
});

/* ── The floors, reached from both sides ─────────────────────────── */

function withCeilingReading(overrides: Record<string, unknown>): PersonalizationProfile {
  return tampered((profile) => {
    const readings = profile.readings as Record<string, Record<string, unknown>>;
    readings.pressure_ceiling = { ...readings.pressure_ceiling, ...overrides };
  });
}

test('an operative reading below the confidence floor is reported; at the floor it is not', () => {
  const below = withCeilingReading({ confidence: 0.6 });
  assert.deepEqual(codesOf(checkPersonalizationProfile(below)), ['OPERATIVE_BELOW_CONFIDENCE_FLOOR']);

  const atFloor = withCeilingReading({ confidence: OPERATIVE_CONFIDENCE_FLOOR });
  assert.deepEqual(checkPersonalizationProfile(atFloor), []);
});

test('an unusable confidence is its own finding, and the floor comparison is suppressed', () => {
  const broken = withCeilingReading({ confidence: Number.NaN });
  // NaN does not survive JSON, so tamper after the round trip instead.
  const profile = broken as unknown as { readings: Record<string, Record<string, unknown>> };
  profile.readings.pressure_ceiling.confidence = Number.NaN;
  const codes = codesOf(checkPersonalizationProfile(broken));
  assert.deepEqual(codes, ['CONFIDENCE_OUT_OF_RANGE']);
});

test('the sample floors are reached on both variants, and an invalid count suppresses them', () => {
  const thinOperative = withCeilingReading({ sampleEventCount: MIN_OPERATIVE_SAMPLE_EVENTS - 1 });
  assert.deepEqual(codesOf(checkPersonalizationProfile(thinOperative)), ['OPERATIVE_BELOW_SAMPLE_FLOOR']);

  const atOperativeFloor = withCeilingReading({ sampleEventCount: MIN_OPERATIVE_SAMPLE_EVENTS });
  assert.deepEqual(checkPersonalizationProfile(atOperativeFloor), []);

  const thinSuggestion = tampered((profile) => {
    const readings = profile.readings as Record<string, Record<string, unknown>>;
    readings.suggestion_directness.sampleEventCount = MIN_SUGGESTION_SAMPLE_EVENTS - 1;
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(thinSuggestion)), ['SUGGESTION_BELOW_SAMPLE_FLOOR']);

  const invalidCount = withCeilingReading({ sampleEventCount: -1 });
  assert.deepEqual(codesOf(checkPersonalizationProfile(invalidCount)), ['SAMPLE_COUNT_INVALID']);
});

test('an operative reading stripped of evidence at the untyped boundary is reported', () => {
  const bare = withCeilingReading({ evidence: [] });
  assert.deepEqual(codesOf(checkPersonalizationProfile(bare)), ['OPERATIVE_WITHOUT_EVIDENCE']);
});

/* ── Limits, every one reachable ─────────────────────────────────── */

test('every declared limit is reachable by name', () => {
  for (const name of PERSONALIZATION_LIMIT_NAMES) {
    if (name === 'maxEvidencePerPreference') {
      const cap = PERSONALIZATION_LIMITS.maxEvidencePerPreference;
      const oversized = Array.from({ length: cap + 1 }, () => ({
        rungIndex: 0,
        outcome: 'edit',
        count: 1,
      }));
      const over = tampered((profile) => {
        const readings = profile.readings as Record<string, Record<string, unknown>>;
        readings.suggestion_directness.evidence = oversized;
      });
      const findings = checkPersonalizationProfile(over).filter(
        (entry) => entry.code === 'EVIDENCE_EXCEEDS_LIMIT',
      );
      assert.equal(findings.length, 1);
      assert.equal(findings[0].limitName, name);
      assert.equal(findings[0].dimension, 'suggestion_directness');
    } else {
      assert.fail(`no reachability test covers the limit ${name as string}`);
    }
  }
});

/* ── The #107 rules ──────────────────────────────────────────────── */

test('admissible evidence is derived from the two class tables', () => {
  assert.deepEqual(admissibleOutcomesFor('pressure_ceiling'), ['accept', 'edit', 'reject', 'undo']);
  assert.deepEqual(admissibleOutcomesFor('pressure_tone'), ['accept', 'edit', 'reject', 'undo']);
  assert.deepEqual(admissibleOutcomesFor('suggestion_directness'), ['accept', 'edit', 'reject', 'undo']);
  assert.deepEqual(admissibleOutcomesFor('reminder_density'), [
    'accept',
    'edit',
    'reject',
    'defer',
    'complete',
    'ignore',
    'undo',
  ]);
});

test('isEscalation ranks against the product baseline and refuses to guess', () => {
  assert.equal(isEscalation('pressure_ceiling', 'high'), true);
  assert.equal(isEscalation('pressure_ceiling', 'medium'), true);
  assert.equal(isEscalation('pressure_ceiling', 'low'), false);
  assert.equal(isEscalation('pressure_ceiling', 'none'), false);
  assert.equal(isEscalation('pressure_tone', 'firm'), true);
  assert.equal(isEscalation('suggestion_directness', 'direct'), true);
  assert.equal(isEscalation('suggestion_directness', 'minimal'), false);
  assert.equal(isEscalation('reminder_density', 'rich'), true);
  assert.equal(isEscalation('reminder_density', 'lean'), false);
  assert.equal(isEscalation('pressure_ceiling', 'loud'), null);
  assert.equal(isEscalation('cadence' as PreferenceDimension, 'high'), null);
});

test('a behavioural outcome cited on a pressure-bearing dimension is inadmissible', () => {
  const behaviouralCeiling = withCeilingReading({
    evidence: [
      { rungIndex: 0, outcome: 'ignore', count: 4 },
      { rungIndex: 1, outcome: 'reject', count: 2 },
    ],
  });
  const codes = codesOf(checkPersonalizationProfile(behaviouralCeiling));
  assert.deepEqual(codes, ['INADMISSIBLE_EVIDENCE_OUTCOME']);
});

test('the adaptiveService inversion is a reportable defect: avoidance may never raise pressure', () => {
  // The shipped #107 shape verbatim: ignored commitments driving the ceiling up.
  const escalatedByAvoidance = withCeilingReading({
    level: 'high',
    evidence: [
      { rungIndex: 0, outcome: 'ignore', count: 4 },
      { rungIndex: 1, outcome: 'complete', count: 3 },
    ],
  });
  const codes = codesOf(checkPersonalizationProfile(escalatedByAvoidance));
  assert.deepEqual(codes, [
    'INADMISSIBLE_EVIDENCE_OUTCOME',
    'INADMISSIBLE_EVIDENCE_OUTCOME',
    'ESCALATION_WITHOUT_EXPLICIT_EVIDENCE',
  ]);
});

test('escalation on a presentation dimension still demands an explicit judgement', () => {
  const richFromBehaviour = tampered((profile) => {
    const readings = profile.readings as Record<string, Record<string, unknown>>;
    readings.reminder_density.level = 'rich';
    // 'ignore' is admissible for a presentation dimension — but it cannot escalate.
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(richFromBehaviour)), [
    'ESCALATION_WITHOUT_EXPLICIT_EVIDENCE',
  ]);
});

test('de-escalation from behaviour alone is legal, and explicit escalation is legal', () => {
  // The valid fixture already contains both: reminder_density 'lean' resting on
  // 'ignore' counts, and suggestion_directness 'supportive' resting on 'edit'.
  assert.deepEqual(checkPersonalizationProfile(validProfile()), []);

  const explicitlyEscalated = withCeilingReading({ level: 'medium' });
  assert.deepEqual(checkPersonalizationProfile(explicitlyEscalated), []);
});

/* ── Basis and reproducibility ───────────────────────────────────── */

test('a basis over windows the schema does not define is reported', () => {
  const privateLadder = tampered((profile) => {
    const basis = profile.basis as { rungs: Record<string, unknown>[] };
    basis.rungs[2].windowDays = 999;
  });
  // The window arithmetic for the altered rung is also incoherent now, and it
  // is reported too: a bad ladder says nothing about whether the rung was
  // aggregated at this instant, so neither finding suppresses the other.
  assert.deepEqual(codesOf(checkPersonalizationProfile(privateLadder)), [
    'WINDOW_LADDER_MISMATCH',
    'RUNG_WINDOW_INCOHERENT',
  ]);

  const shortLadder = tampered((profile) => {
    const basis = profile.basis as { rungs: unknown[] };
    basis.rungs = basis.rungs.slice(0, 2);
    // The reminder_density evidence legitimately cites rung 2, which the
    // truncated basis no longer has — the range finding is the point, not noise.
  });
  const codes = codesOf(checkPersonalizationProfile(shortLadder));
  assert.deepEqual(codes, ['WINDOW_LADDER_MISMATCH', 'EVIDENCE_RUNG_OUT_OF_RANGE']);
});

test('a blank rung digest is reported at its position', () => {
  const blankDigest = tampered((profile) => {
    const basis = profile.basis as { rungs: Record<string, unknown>[] };
    basis.rungs[1].inputDigest = '   ';
  });
  const findings = checkPersonalizationProfile(blankDigest);
  assert.deepEqual(codesOf(findings), ['BASIS_DIGEST_MISSING']);
  assert.equal(findings[0].rungIndex, 1);
});

test('a basis naming another scope is reported', () => {
  const foreign = tampered((profile) => {
    (profile.basis as Record<string, unknown>).scopeId = 'scope-b';
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(foreign)), ['BASIS_SCOPE_MISMATCH']);
});

test('a rung not aggregated at the profile instant is incoherent, unless derivedAt is itself invalid', () => {
  const skewed = tampered((profile) => {
    const basis = profile.basis as { rungs: Record<string, unknown>[] };
    basis.rungs[0].windowStart = windowStartFor(15);
  });
  const findings = checkPersonalizationProfile(skewed);
  assert.deepEqual(codesOf(findings), ['RUNG_WINDOW_INCOHERENT']);
  assert.equal(findings[0].rungIndex, 0);

  // Suppression: the coherence check borrows its bound from derivedAt.
  const brokenInstant = tampered((profile) => {
    profile.derivedAt = 'not-a-time';
    const basis = profile.basis as { rungs: Record<string, unknown>[] };
    basis.rungs[0].windowStart = windowStartFor(15);
  });
  const codes = codesOf(checkPersonalizationProfile(brokenInstant));
  assert.ok(codes.includes('DERIVED_AT_INVALID'));
  assert.equal(codes.includes('RUNG_WINDOW_INCOHERENT'), false);
});

test('a missing basis suppresses rung-range checks and is reported itself', () => {
  const baseless = tampered((profile) => {
    profile.basis = null;
    const readings = profile.readings as Record<string, Record<string, unknown>>;
    readings.pressure_ceiling.evidence = [{ rungIndex: 99, outcome: 'reject', count: 1 }];
  });
  const codes = codesOf(checkPersonalizationProfile(baseless));
  assert.ok(codes.includes('ENABLED_PROFILE_NOT_DERIVED'));
  assert.equal(codes.includes('EVIDENCE_RUNG_OUT_OF_RANGE'), false);
});

/* ── Readings totality and shape ─────────────────────────────────── */

test('the readings must be total, carry no strangers, and agree with their keys', () => {
  const missing = tampered((profile) => {
    delete (profile.readings as Record<string, unknown>).pressure_tone;
  });
  const missingFindings = checkPersonalizationProfile(missing);
  assert.deepEqual(codesOf(missingFindings), ['MISSING_DIMENSION']);
  assert.equal(missingFindings[0].dimension, 'pressure_tone');

  const stranger = tampered((profile) => {
    (profile.readings as Record<string, unknown>).cadence = {
      status: 'suggestion',
      dimension: 'cadence',
    };
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(stranger)), ['UNKNOWN_DIMENSION']);

  const crossed = tampered((profile) => {
    const readings = profile.readings as Record<string, Record<string, unknown>>;
    readings.pressure_tone.dimension = 'reminder_density';
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(crossed)), ['READING_DIMENSION_MISMATCH']);
});

test('an unknown status is reported once and suppresses the per-status claims', () => {
  const unknownStatus = withCeilingReading({ status: 'tentative' });
  assert.deepEqual(codesOf(checkPersonalizationProfile(unknownStatus)), ['STATUS_UNKNOWN']);
});

test('an inconclusive reading that decided anyway is reported', () => {
  const decided = tampered((profile) => {
    const readings = profile.readings as Record<string, Record<string, unknown>>;
    readings.pressure_tone.level = 'firm';
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(decided)), ['INCONCLUSIVE_NOT_LEVEL_FREE']);

  const strangeReason = tampered((profile) => {
    const readings = profile.readings as Record<string, Record<string, unknown>>;
    readings.pressure_tone.reason = 'vibes';
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(strangeReason)), ['INCONCLUSIVE_REASON_UNKNOWN']);
});

test('levels outside the closed set and malformed evidence entries are reported at their positions', () => {
  const strangeLevel = withCeilingReading({ level: 'maximum' });
  assert.deepEqual(codesOf(checkPersonalizationProfile(strangeLevel)), ['LEVEL_NOT_IN_VOCABULARY']);

  const strangeOutcome = withCeilingReading({
    evidence: [{ rungIndex: 0, outcome: 'lingered', count: 2 }],
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(strangeOutcome)), ['UNKNOWN_EVIDENCE_OUTCOME']);

  const outOfRange = withCeilingReading({
    evidence: [{ rungIndex: 99, outcome: 'reject', count: 2 }],
  });
  const rangeFindings = checkPersonalizationProfile(outOfRange);
  assert.deepEqual(codesOf(rangeFindings), ['EVIDENCE_RUNG_OUT_OF_RANGE']);
  assert.equal(rangeFindings[0].evidenceIndex, 0);

  const zeroCount = withCeilingReading({
    evidence: [{ rungIndex: 0, outcome: 'reject', count: 0 }],
  });
  assert.deepEqual(codesOf(checkPersonalizationProfile(zeroCount)), ['EVIDENCE_COUNT_NOT_POSITIVE']);
});

/* ── The deletion receipt ────────────────────────────────────────── */

test('a valid receipt is clean, and the check is deterministic', () => {
  const receipt = validReceipt();
  const first = checkPersonalizationDeletionReceipt(receipt);
  const second = checkPersonalizationDeletionReceipt(receipt);
  assert.deepEqual(first, []);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('a non-zero remainder is reported per field, in fixed order', () => {
  const leaky = tamperedReceipt((receipt) => {
    receipt.remainingFeedbackEventCount = 3;
    receipt.remainingPersistedProfileCount = 1;
  });
  const findings = checkPersonalizationDeletionReceipt(leaky);
  assert.deepEqual(codesOf(findings), ['RECEIPT_REMAINDER_NOT_ZERO', 'RECEIPT_REMAINDER_NOT_ZERO']);
});

test('an unreadable remainder is not a passing remainder', () => {
  const unreadable = validReceipt() as unknown as Record<string, unknown>;
  unreadable.remainingRuntimeMemoryRecordCount = Number.NaN;
  const codes = codesOf(
    checkPersonalizationDeletionReceipt(unreadable as unknown as PersonalizationDeletionReceipt),
  );
  assert.deepEqual(codes, ['RECEIPT_REMAINDER_NOT_A_COUNT']);
});

test('a receipt with nothing to verify against is reported', () => {
  const blankDigest = tamperedReceipt((receipt) => {
    receipt.emptyStateDigest = '';
  });
  assert.deepEqual(codesOf(checkPersonalizationDeletionReceipt(blankDigest)), ['RECEIPT_DIGEST_MISSING']);

  const blankScope = tamperedReceipt((receipt) => {
    receipt.scopeId = ' ';
  });
  assert.deepEqual(codesOf(checkPersonalizationDeletionReceipt(blankScope)), ['RECEIPT_SCOPE_BLANK']);

  const badInstant = tamperedReceipt((receipt) => {
    receipt.deletedAt = '2026-02-30T00:00:00Z';
  });
  assert.deepEqual(codesOf(checkPersonalizationDeletionReceipt(badInstant)), ['RECEIPT_INSTANT_INVALID']);
});

test('the receipt checker reports and never throws, for any input', () => {
  for (const garbage of [null, undefined, 7, 'receipt', []]) {
    const defects = checkPersonalizationDeletionReceipt(
      garbage as unknown as PersonalizationDeletionReceipt,
    );
    assert.ok(Array.isArray(defects));
  }
  assert.deepEqual(
    codesOf(checkPersonalizationDeletionReceipt(null as unknown as PersonalizationDeletionReceipt)),
    ['RECEIPT_UNREADABLE'],
  );
});
