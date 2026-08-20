/**
 * The cohort's own suite — the file `syntheticCohort.ts`'s header has been
 * citing since it was written, and which did not exist until integration.
 *
 * That is worth stating plainly: the header claimed a Sprint 08 failure
 * "cannot recur here" and named this file as the reason. The claim was checked
 * by nothing, and the failure had in fact recurred — one activity band cleared
 * the protocol's member floor, so every archetype had three scoreable members
 * against a slice floor of six and no archetype-homogeneous slice could ever be
 * reported. A comment naming a test is not a test.
 *
 * `UNDERIVABLE_LEVELS` gets its sweep here for the same reason: it was written
 * so "a reachability sweep needs the exclusion named", and no sweep existed, so
 * the whole constant could be deleted with the suite green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEEDBACK_OUTCOME_CLASSES,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LEVEL_VOCABULARY,
  isEscalation,
  operativeReadings,
  type PersonalizationConsent,
} from '../../src/contracts/v1/personalizationContracts.ts';
import {
  ACTIVITY_BAND_EVENT_BOUNDS,
  ARCHETYPE_OUTCOME_CYCLES,
  COHORT_LOCALES,
  DEFAULT_COHORT_SEED,
  SYNTHETIC_ACTIVITY_BANDS,
  SYNTHETIC_ARCHETYPES,
  buildSyntheticCohort,
} from '../../lib/evaluation/personalization/syntheticCohort.ts';
import { MIN_MEMBER_EVENTS, MIN_SLICE_MEMBERS } from '../../lib/evaluation/personalization/protocol.ts';
import { UNDERIVABLE_LEVELS } from '../../lib/personalization/derive.ts';
import { rebuildPersonalizationProfile } from '../../lib/personalization/rebuild.ts';

const NOW = '2026-08-20T09:00:00.000Z';
const ENABLED: PersonalizationConsent = Object.freeze({ state: 'enabled', changedAt: NOW });

/* ── The distribution, measured as sets ──────────────────────────── */

test('the produced archetypes, locales and bands each equal the declared vocabulary as a set', () => {
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const setOf = <T>(values: readonly T[]) => Array.from(new Set(values)).sort();
  assert.deepEqual(setOf(cohort.members.map((m) => m.archetype)), setOf([...SYNTHETIC_ARCHETYPES]));
  assert.deepEqual(setOf(cohort.members.map((m) => m.locale)), setOf([...COHORT_LOCALES]));
  assert.deepEqual(setOf(cohort.members.map((m) => m.declaredActivityBand)), setOf([...SYNTHETIC_ACTIVITY_BANDS]));
});

test('every band produces event counts inside its declared bounds', () => {
  // Bounds derived from the contract's floors; a member outside them means the
  // stream builder and the band table disagree, and the band names then mean
  // nothing.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  for (const member of cohort.members) {
    const bounds = ACTIVITY_BAND_EVENT_BOUNDS[member.declaredActivityBand];
    assert.ok(
      member.events.length >= bounds.min && member.events.length <= bounds.max,
      `${member.scopeId}: ${member.events.length} events outside ${JSON.stringify(bounds)}`,
    );
  }
});

test('each archetype has at least a full slice of members the behavioural metrics can score', () => {
  // The check that was missing. With one qualifying band there were three per
  // archetype against a floor of six, so an archetype slice was permanently
  // inconclusive — a generator structurally incapable of the case that matters,
  // behind a healthy total member count.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  for (const archetype of SYNTHETIC_ARCHETYPES) {
    const scoreable = cohort.members.filter(
      (member) => member.archetype === archetype && member.events.length >= MIN_MEMBER_EVENTS,
    );
    assert.ok(
      scoreable.length >= MIN_SLICE_MEMBERS,
      `${archetype} has ${scoreable.length} scoreable members, below the slice floor of ${MIN_SLICE_MEMBERS}`,
    );
  }
});

test('the light band exists below the member floor, so the small-sample path is reachable', () => {
  // The other half: a band that clears the floor cannot exercise the
  // inconclusive path it was built for.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  const light = cohort.members.filter((member) => member.declaredActivityBand === 'light');
  assert.ok(light.length > 0);
  for (const member of light) {
    assert.ok(member.events.length > 0, `${member.scopeId} is light but empty`);
    assert.ok(member.events.length < MIN_MEMBER_EVENTS, `${member.scopeId} is light but clears the floor`);
  }
});

test('the outcome cycles’ explicit/behavioural composition is measured, not described', () => {
  // The header describes each archetype's regime in prose. This is that prose
  // checked against `FEEDBACK_OUTCOME_CLASSES`.
  const classOf = (outcome: string) => FEEDBACK_OUTCOME_CLASSES[outcome as keyof typeof FEEDBACK_OUTCOME_CLASSES];
  const share = (archetype: keyof typeof ARCHETYPE_OUTCOME_CYCLES) => {
    const cycle = ARCHETYPE_OUTCOME_CYCLES[archetype];
    return cycle.filter((outcome) => classOf(outcome) === 'explicit_judgement').length / cycle.length;
  };
  assert.ok(share('quiet_seeker') > 0.5, 'quiet_seeker is described as explicit-heavy');
  assert.equal(share('passive_ignorer'), 0, 'passive_ignorer is described as behavioural only');
  assert.ok(share('content_accepter') > 0 && share('content_accepter') < 1, 'content_accepter is described as mixed');
  assert.ok(share('conflicted') > 0.5, 'conflicted is described as explicit judgements pulling both ways');
});

/* ── UNDERIVABLE_LEVELS, swept ───────────────────────────────────── */

test('every level the deriver declares underivable is in its dimension’s vocabulary', () => {
  // A typo here would exclude nothing and read as an exclusion.
  for (const dimension of PREFERENCE_DIMENSIONS) {
    for (const level of UNDERIVABLE_LEVELS[dimension]) {
      assert.ok(
        (PREFERENCE_LEVEL_VOCABULARY[dimension] as readonly string[]).includes(level),
        `${dimension} declares ${level} underivable, which is not one of its levels`,
      );
    }
  }
});

test('no underivable level is ever produced, and the derivable ones are not all excluded', () => {
  // The sweep the constant was written for. Both directions: nothing excluded
  // appears anywhere in the cohort, and the exclusion list is not simply the
  // whole vocabulary — which would make the first half vacuous.
  const cohort = buildSyntheticCohort(DEFAULT_COHORT_SEED, NOW);
  let observed = 0;
  for (const member of cohort.members) {
    const profile = rebuildPersonalizationProfile({
      scopeId: member.scopeId, now: NOW, consent: ENABLED, events: member.events, baseline: null,
    });
    for (const reading of operativeReadings(profile)) {
      observed += 1;
      assert.ok(
        !UNDERIVABLE_LEVELS[reading.dimension].includes(reading.level as string),
        `${member.scopeId} derived ${reading.dimension}=${reading.level}, declared underivable`,
      );
    }
  }
  assert.ok(observed > 0, 'no operative reading in the whole cohort, so nothing was swept');

  const fullyExcluded = PREFERENCE_DIMENSIONS.filter(
    (dimension) => UNDERIVABLE_LEVELS[dimension].length >= PREFERENCE_LEVEL_VOCABULARY[dimension].length,
  );
  assert.deepEqual(
    fullyExcluded,
    ['pressure_tone'],
    'a dimension excludes its whole vocabulary; only pressure_tone is deliberately never derived',
  );
});

test('every escalation the product can express is named underivable, except the one that is not', () => {
  // `suggestion_directness=supportive` is the single escalation v1 can derive,
  // and only on an explicit edit majority. Everything else above baseline must
  // be on the exclusion list — otherwise a level could escalate with no rule
  // forbidding it and no test noticing.
  const escalations: string[] = [];
  for (const dimension of PREFERENCE_DIMENSIONS) {
    for (const level of PREFERENCE_LEVEL_VOCABULARY[dimension] as readonly string[]) {
      if (isEscalation(dimension, level) !== true) continue;
      if (!UNDERIVABLE_LEVELS[dimension].includes(level)) escalations.push(`${dimension}=${level}`);
    }
  }
  assert.deepEqual(
    escalations,
    ['suggestion_directness=supportive'],
    'the set of derivable escalations changed; that is a product decision about pressure',
  );
});
