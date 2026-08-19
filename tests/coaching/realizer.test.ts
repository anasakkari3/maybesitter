/**
 * The coaching realizer and its template table (Sprint 09, issue #38).
 *
 * The load-bearing tests here scan **the template table itself**, in all three
 * locales, rather than the mapping this track decided. The distinction is
 * Sprint 08's: a guard that checks the thing you already decided is not
 * checking the thing that can change.
 *
 * Concretely — `CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM` maps every claim kind
 * to `'statement'`, so every candidate this module hands #39 carries
 * `statedInstant: null` and `FABRICATED_INSTANT` cannot fire. That guarantee
 * does not rest on the mapping. It rests on the templates containing no time
 * and no interpolation point, and *that* is what is asserted below. The day a
 * template grows an interpolated time, these fail rather than the gateway
 * silently starting to matter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COACHING_LOCALES,
  COACHING_REALIZATION_MODES,
  COACHING_REALIZATION_POLICY,
  COACHING_SENTENCE_POLICY,
  checkCoachingOutput,
  type CoachingLocale,
  type CoachingPlan,
} from '../../src/contracts/v1/coachingContracts';
import {
  RECOMMENDATION_CONTRACT_VERSION,
  RECOMMENDATION_DECISION_VERDICTS,
  SUPPORT_REASON_CODES,
  type Recommendation,
  type RecommendationDecision,
  type RecommendationDecisionVerdict,
} from '../../src/contracts/v1/recommendationContracts';
import {
  COACHING_MODEL_ADAPTER,
  COACHING_TEMPLATES,
  COACHING_TEMPLATE_IDS,
  planCoaching,
  realizeCoachingPlan,
  templateIdFor,
  templateText,
} from '../../lib/coaching';
import { NOW, choiceOffer, fingerprintsFor, onlyCandidate, soleSurvivor, withheld } from './fixtures';

function planFor(recommendation: Recommendation, locale: CoachingLocale = 'en', decision: RecommendationDecision | null = null): CoachingPlan {
  const outcome = planCoaching({
    recommendation,
    decision,
    locale,
    now: NOW,
    currentFingerprints: fingerprintsFor(recommendation),
  });
  assert.equal(outcome.outcome, 'planned', `planning refused: ${JSON.stringify(outcome)}`);
  return (outcome as { plan: CoachingPlan }).plan;
}

function decisionOf(verdict: RecommendationDecisionVerdict, recommendationId: string): RecommendationDecision {
  return {
    version: RECOMMENDATION_CONTRACT_VERSION,
    recommendationId,
    optionIndex: verdict === 'dismiss' ? null : 0,
    verdict,
    ...(verdict === 'edit' ? { editedTitle: 'a replacement the user wrote' } : {}),
    decidedAt: NOW,
  };
}

function everyTemplateString(): ReadonlyArray<readonly [string, string, string]> {
  const rows: Array<readonly [string, string, string]> = [];
  for (const locale of COACHING_LOCALES) {
    for (const id of COACHING_TEMPLATE_IDS) {
      rows.push([locale, id, COACHING_TEMPLATES[locale][id]]);
    }
  }
  return rows;
}

/* ── The table is complete and never vacuous ─────────────────────── */

test('every template id has non-blank copy in every locale', () => {
  assert.ok(COACHING_TEMPLATE_IDS.length > 0, 'the template list is empty; every scan below would pass by finding nothing');
  for (const [locale, id, text] of everyTemplateString()) {
    assert.equal(typeof text, 'string', `${locale}/${id} has no copy`);
    assert.ok(text.trim().length > 0, `${locale}/${id} is blank`);
  }
  assert.equal(everyTemplateString().length, COACHING_LOCALES.length * COACHING_TEMPLATE_IDS.length);
});

test('a missing translation is reported as null, never served in English', () => {
  // An English fallback is a defect that reads as a feature to everyone who
  // reviews it, which is the asymmetry that let the pilot's four
  // `localeCompare` sites survive review.
  assert.equal(templateText('klingon' as CoachingLocale, 'lead.timing'), null);
  assert.equal(templateText('ar', 'no.such.template' as never), null);
  assert.equal(templateText('ar', 'lead.timing'), COACHING_TEMPLATES.ar['lead.timing']);
});

/* ── The templates state no time and interpolate nothing ─────────── */

test('no template in any locale contains a digit, so no time can be stated', () => {
  // This is the assertion behind `statedInstant: null` on every converted
  // claim, and it is deliberately over-strict: a digit is not a time, but a
  // template with no digits cannot carry one, and the rule is cheap to keep.
  for (const [locale, id, text] of everyTemplateString()) {
    assert.equal(/[0-9٠-٩۰-۹]/.test(text), false, `${locale}/${id} contains a digit; #39's FABRICATED_INSTANT becomes reachable`);
  }
});

test('no template in any locale contains an interpolation point', () => {
  // Sprint 07's recorded leak was a detail string reading
  // `working window call-dr.cohen-about-the-biopsy`. A table with no
  // interpolation at all cannot produce that line; these are the shapes that
  // would reintroduce one.
  const shapes: ReadonlyArray<readonly [RegExp, string]> = [
    [/\$\{/, 'a template literal placeholder'],
    [/\{\{/, 'a moustache placeholder'],
    [/%[sd]/, 'a printf placeholder'],
    [/\{\d+\}/, 'a positional placeholder'],
    [/<[^>]+>/, 'an angle-bracket placeholder'],
  ];
  for (const [locale, id, text] of everyTemplateString()) {
    for (const [pattern, what] of shapes) {
      assert.equal(pattern.test(text), false, `${locale}/${id} contains ${what}`);
    }
  }
});

test('the interpolation scan still recognises a real placeholder', () => {
  // A negative-only assertion passes just as well against a regex that matches
  // nothing. Both halves are pinned, which is the check Sprint 08 recorded a
  // mutation harness silently failing without.
  assert.equal(/\$\{/.test('This is ${title}.'), true);
  assert.equal(/\{\{/.test('This is {{title}}.'), true);
  assert.equal(/[0-9]/.test('Due at 9.'), true);
  assert.equal(/[0-9]/.test('This one is short.'), false);
});

test('every template is exactly one sentence and carries no semicolon', () => {
  for (const [locale, id, text] of everyTemplateString()) {
    const marks = text.match(/[.?!](?:\s|$)/g);
    assert.equal(marks === null ? 0 : marks.length, 1, `${locale}/${id} is not exactly one sentence`);
    assert.equal(text.includes(';'), false, `${locale}/${id} contains a semicolon`);
  }
});

/* ── Every template is reachable ─────────────────────────────────── */

test('every template id is selected by some real plan, in every locale', () => {
  const reached = new Set<string>();
  for (const locale of COACHING_LOCALES) {
    const plans: CoachingPlan[] = [
      planFor(choiceOffer(), locale),
      planFor(onlyCandidate(), locale),
      planFor(withheld(), locale),
    ];
    for (const code of SUPPORT_REASON_CODES) {
      plans.push(planFor(soleSurvivor(code, 0.9), locale));
      plans.push(planFor(soleSurvivor(code, 0.3), locale));
    }
    const base = soleSurvivor();
    for (const verdict of RECOMMENDATION_DECISION_VERDICTS) {
      plans.push(planFor(base, locale, decisionOf(verdict, base.recommendationId)));
    }
    for (const plan of plans) {
      for (let index = 0; index < plan.claims.length; index += 1) {
        const id = templateIdFor(plan, plan.claims[index], index);
        assert.ok(id !== null, `no template covers claim ${index} of a ${plan.intent}/${plan.strategy} plan`);
        reached.add(id as string);
      }
    }
  }
  for (const id of COACHING_TEMPLATE_IDS) {
    assert.ok(reached.has(id), `template ${id} is never selected; unreachable copy is copy nobody reviews`);
  }
});

/* ── Realization ─────────────────────────────────────────────────── */

test('realizing a plan produces an output its own checker accepts, in every locale', () => {
  for (const locale of COACHING_LOCALES) {
    for (const source of [soleSurvivor('OVERDUE', 0.9), soleSurvivor('QUICK_WIN', 0.3), choiceOffer(), onlyCandidate(), withheld()]) {
      const plan = planFor(source, locale);
      const outcome = realizeCoachingPlan({ plan, evidence: source.evidence, basisAt: NOW });
      assert.equal(outcome.outcome, 'realized', `realization refused: ${JSON.stringify(outcome)}`);
      const output = (outcome as { output: ReturnType<typeof Object> }).output as never;
      assert.deepEqual(checkCoachingOutput(output, plan), [], 'the realizer produced an output its own checker rejects');
    }
  }
});

test('every planned claim is realized by exactly one sentence', () => {
  // `PLANNED_CLAIM_NOT_REALIZED` exists because a dropped claim leaves a turn
  // that still validates while the sentence a user reads rests on the
  // remainder — the silent direction.
  const plan = planFor(soleSurvivor('OVERDUE', 0.9));
  const outcome = realizeCoachingPlan({ plan, evidence: soleSurvivor('OVERDUE', 0.9).evidence, basisAt: NOW });
  assert.equal(outcome.outcome, 'realized');
  const output = (outcome as { output: { sentences: ReadonlyArray<{ claimIndices: readonly number[] }> } }).output;
  assert.equal(output.sentences.length, plan.claims.length);
  const cited = output.sentences.flatMap((sentence) => sentence.claimIndices);
  assert.deepEqual(cited.slice().sort(), plan.claims.map((_, index) => index));
});

test('realization is deterministic and uses no entropy', () => {
  // The shipped `realization.ts` defaults its tie-break to `Math.random`. This
  // module is replayable: an audit of what a user was told is worth nothing if
  // the module cannot reproduce it.
  const source = choiceOffer();
  const plan = planFor(source);
  const first = realizeCoachingPlan({ plan, evidence: source.evidence, basisAt: NOW });
  const second = realizeCoachingPlan({ plan, evidence: source.evidence, basisAt: NOW });
  assert.deepEqual(first, second);
});

test('the three locales produce different prose from one plan shape', () => {
  // A locale parameter that changed nothing would pass every other test here.
  const source = soleSurvivor('OVERDUE', 0.9);
  const texts = COACHING_LOCALES.map((locale) => {
    const outcome = realizeCoachingPlan({ plan: planFor(source, locale), evidence: source.evidence, basisAt: NOW });
    assert.equal(outcome.outcome, 'realized');
    return (outcome as { output: { sentences: ReadonlyArray<{ text: string }> } }).output.sentences[0].text;
  });
  assert.equal(new Set(texts).size, COACHING_LOCALES.length, 'two locales rendered identical prose');
});

/* ── Rules-only is the only path, and the exclusion is named ─────── */

test('every realization mode is either producible or a named exclusion', () => {
  // Sprint 08's rule about declared-but-unreachable members: a fifth mode is
  // not silently exempt, it has to be added to one list or the other.
  const producible = new Set<string>();
  const source = soleSurvivor('OVERDUE', 0.9);
  const plan = planFor(source);
  for (const mode of COACHING_REALIZATION_MODES) {
    const outcome = realizeCoachingPlan({ plan, evidence: source.evidence, basisAt: NOW, mode });
    if (outcome.outcome === 'realized') producible.add(mode);
  }
  for (const mode of COACHING_REALIZATION_MODES) {
    const excluded = (COACHING_REALIZATION_POLICY.excludedModes as readonly string[]).includes(mode);
    assert.notEqual(producible.has(mode), excluded, `mode ${mode} is neither producible nor a named exclusion`);
  }
  assert.deepEqual(
    [...(COACHING_REALIZATION_POLICY.enabledModes as readonly string[])].sort().concat(
      [...(COACHING_REALIZATION_POLICY.excludedModes as readonly string[])].sort(),
    ).sort(),
    [...COACHING_REALIZATION_MODES].sort(),
    'the enabled and excluded lists must partition the modes exactly',
  );
});

test('the model path is declared and not wired', () => {
  assert.equal(COACHING_MODEL_ADAPTER, null, 'v1 wires no model adapter');
  const source = soleSurvivor('OVERDUE', 0.9);
  const outcome = realizeCoachingPlan({ plan: planFor(source), evidence: source.evidence, basisAt: NOW, mode: 'model' });
  assert.equal(outcome.outcome, 'refused');
  assert.ok(outcome.defects.some((one) => one.code === 'MODEL_REALIZATION_NOT_ENABLED'));
});

test('rules-only realization is the default and needs no configuration', () => {
  const source = withheld();
  const outcome = realizeCoachingPlan({ plan: planFor(source), evidence: source.evidence, basisAt: NOW });
  assert.equal(outcome.outcome, 'realized');
  assert.equal((outcome as { output: { realization: string } }).output.realization, 'template');
  assert.equal(COACHING_REALIZATION_POLICY.defaultMode, 'template');
});

/* ── Report, do not throw ────────────────────────────────────────── */

test('the realizer refuses rather than throwing, for every malformed input', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const plan = planFor(source);
  const malformed: readonly unknown[] = [
    null,
    undefined,
    {},
    { plan: null, evidence: source.evidence, basisAt: NOW },
    { plan, evidence: source.evidence, basisAt: 'not-an-instant' },
    { plan, evidence: source.evidence, basisAt: '2026-08-20T09:15:00' },
    { plan: { ...plan, claims: [] }, evidence: source.evidence, basisAt: NOW },
    { plan: { ...plan, locale: 'klingon' }, evidence: source.evidence, basisAt: NOW },
    { plan: { ...plan, strategy: 'confirm_and_stop' }, evidence: source.evidence, basisAt: NOW },
    { plan: { ...plan, claims: [{ ...plan.claims[0], kind: 'unheard_of' }] }, evidence: source.evidence, basisAt: NOW },
  ];
  for (const input of malformed) {
    const outcome = realizeCoachingPlan(input as never);
    assert.equal(outcome.outcome, 'refused', `expected a refusal for ${JSON.stringify(input)?.slice(0, 90)}`);
    assert.ok(outcome.defects.length > 0, 'a refusal must say why');
  }
});

test('a plan carrying more claims than sentences is refused rather than truncated', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const plan = planFor(source);
  const overfull = {
    ...plan,
    claims: [plan.claims[0], plan.claims[1], { ...plan.claims[0], claimIndex: 2 }],
  } as CoachingPlan;
  const outcome = realizeCoachingPlan({ plan: overfull, evidence: source.evidence, basisAt: NOW });
  assert.equal(outcome.outcome, 'refused');
  assert.ok(outcome.defects.some((one) => one.code === 'SENTENCE_LIMIT_EXCEEDED'));
  assert.equal(COACHING_SENTENCE_POLICY.maxClaimsPerPlan, 2);
});
