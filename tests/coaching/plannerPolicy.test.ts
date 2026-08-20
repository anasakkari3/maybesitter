/**
 * The coaching planner's strategy and intent policy (Sprint 09, issue #38).
 *
 * The central assertions here are the **producibility sweeps**. Sprint 08
 * shipped two defects with one shape — a reachable code path whose *outcome*
 * was unreachable — and neither was visible to any assertion about the thing
 * itself: `decompose` could never be offered because a quota always suppressed
 * it, and `defer` could never be offered because it needs an input field the
 * selector does not carry. Every surface downstream read as though a user could
 * be shown one.
 *
 * Only an assertion that **enumerates the vocabulary and demands each member be
 * produced** can see that. There are three here, over `COACHING_INTENTS`,
 * `COACHING_STRATEGIES` and `COACHING_CLAIM_KINDS`, and each is driven by a
 * real `planCoaching` run rather than by a table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COACHING_CLAIM_KINDS,
  COACHING_INTENTS,
  COACHING_INTENT_STRATEGIES,
  COACHING_SENTENCE_POLICY,
  COACHING_STRATEGIES,
  CLAIM_KIND_FOR_SUPPORT_REASON,
  checkCoachingPlan,
  isEvidenceBackedClaim,
  type CoachingPlan,
} from '../../src/contracts/v1/coachingContracts';
import {
  RECOMMENDATION_DECISION_VERDICTS,
  RECOMMENDATION_CONTRACT_VERSION,
  SUPPORT_REASON_CODES,
  checkRecommendation,
  type Recommendation,
  type RecommendationDecision,
  type RecommendationDecisionVerdict,
} from '../../src/contracts/v1/recommendationContracts';
import { isPermittedPair, planCoaching } from '../../lib/coaching';
import { BASIS_AT, NOW, choiceOffer, fingerprintsFor, onlyCandidate, soleSurvivor, withheld } from './fixtures';

function plan(recommendation: Recommendation, decision: RecommendationDecision | null = null): CoachingPlan {
  const outcome = planCoaching({
    recommendation,
    decision,
    locale: 'en',
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

/* ── The fixtures are real, not decorative ──────────────────────── */

test('every fixture recommendation is defect-free by Sprint 08 own checker', () => {
  // Sprint 02's recorded failure was a fixture corpus that was data nothing
  // executed: 91 tests passed while three modules disagreed about what it
  // meant. Running the real checker over the builders' output is what stops
  // every assertion below from resting on a shape #34 would reject.
  const fixtures: ReadonlyArray<readonly [string, Recommendation]> = [
    ['soleSurvivor', soleSurvivor()],
    ['choiceOffer', choiceOffer()],
    ['onlyCandidate', onlyCandidate()],
    ['withheld', withheld()],
  ];
  for (const [name, recommendation] of fixtures) {
    assert.deepEqual(checkRecommendation(recommendation), [], `${name} is not a valid recommendation`);
  }
});

/* ── Producibility: every declared member is actually produced ──── */

test('every intent in COACHING_INTENTS is produced by a real planner run', () => {
  const produced = new Set<string>();
  produced.add(plan(choiceOffer()).intent);
  produced.add(plan(soleSurvivor()).intent);
  produced.add(plan(withheld()).intent);
  for (const verdict of RECOMMENDATION_DECISION_VERDICTS) {
    const base = soleSurvivor();
    produced.add(plan(base, decisionOf(verdict, base.recommendationId)).intent);
  }
  for (const intent of COACHING_INTENTS) {
    assert.ok(produced.has(intent), `no input produces intent ${intent}; a declared intent no run can reach is invisible`);
  }
  assert.equal(produced.size, COACHING_INTENTS.length, 'a run produced an intent outside the frozen list');
});

test('every strategy in COACHING_STRATEGIES is produced by a real planner run', () => {
  const produced = new Set<string>();
  produced.add(plan(choiceOffer()).strategy);
  // The confidence band is the only real choice the strategy policy makes:
  // high leads with the action, anything else earns it first.
  produced.add(plan(soleSurvivor('OVERDUE', 0.9)).strategy);
  produced.add(plan(soleSurvivor('OVERDUE', 0.4)).strategy);
  produced.add(plan(withheld()).strategy);
  const base = soleSurvivor();
  produced.add(plan(base, decisionOf('done', base.recommendationId)).strategy);
  for (const strategy of COACHING_STRATEGIES) {
    assert.ok(produced.has(strategy), `no input produces strategy ${strategy}`);
  }
  assert.equal(produced.size, COACHING_STRATEGIES.length, 'a run produced a strategy outside the frozen list');
});

test('every claim kind in COACHING_CLAIM_KINDS is produced by a real planner run', () => {
  const produced = new Set<string>();
  const collect = (built: CoachingPlan) => {
    for (const claim of built.claims) produced.add(claim.kind);
  };
  // One recommendation per support reason code, so each licensed claim kind is
  // reached through the reason that licenses it rather than asserted.
  for (const code of SUPPORT_REASON_CODES) collect(plan(soleSurvivor(code, 0.4)));
  collect(plan(choiceOffer()));
  collect(plan(onlyCandidate()));
  collect(plan(withheld()));
  for (const verdict of RECOMMENDATION_DECISION_VERDICTS) {
    const base = soleSurvivor();
    collect(plan(base, decisionOf(verdict, base.recommendationId)));
  }
  for (const kind of COACHING_CLAIM_KINDS) {
    assert.ok(produced.has(kind), `no input produces claim kind ${kind}`);
  }
  assert.equal(produced.size, COACHING_CLAIM_KINDS.length, 'a run produced a claim kind outside the frozen list');
});

test('every evidence claim source kind is produced by a real planner run', () => {
  const produced = new Set<string>();
  for (const built of [plan(soleSurvivor('OVERDUE', 0.4)), plan(choiceOffer()), plan(onlyCandidate()), plan(withheld())]) {
    for (const claim of built.claims) produced.add(claim.source.kind);
  }
  const base = soleSurvivor();
  for (const claim of plan(base, decisionOf('accept', base.recommendationId)).claims) produced.add(claim.source.kind);
  for (const expected of [
    'support_reason',
    'option_confidence',
    'withholding_reason',
    'only_candidate_attestation',
    'user_decision',
  ]) {
    assert.ok(produced.has(expected), `no input produces source kind ${expected}`);
  }
});

/* ── The tables are honest ───────────────────────────────────────── */

test('CLAIM_KIND_FOR_SUPPORT_REASON covers every support reason code the contract declares', () => {
  // The sweep Sprint 08 added after `NO_PLANNED_SLOT` and
  // `OUTSIDE_WORKING_WINDOW` sat structurally unemittable with nothing failing.
  for (const code of SUPPORT_REASON_CODES) {
    const mapped = (CLAIM_KIND_FOR_SUPPORT_REASON as Readonly<Record<string, string>>)[code];
    assert.ok(mapped !== undefined, `no coaching claim kind is licensed by support reason ${code}`);
    assert.ok((COACHING_CLAIM_KINDS as readonly string[]).includes(mapped), `${code} maps to a claim kind outside the frozen list`);
  }
});

test('COACHING_INTENT_STRATEGIES is total, non-empty, and reaches every strategy', () => {
  const reached = new Set<string>();
  for (const intent of COACHING_INTENTS) {
    const allowed = COACHING_INTENT_STRATEGIES[intent];
    assert.ok(Array.isArray(allowed) && allowed.length > 0, `intent ${intent} permits no strategy`);
    for (const strategy of allowed) reached.add(strategy);
  }
  for (const strategy of COACHING_STRATEGIES) {
    assert.ok(reached.has(strategy), `strategy ${strategy} appears in no intent's row; it can never be permitted`);
  }
});

test('every planned pair is one the contract table permits, and the plan is defect-free', () => {
  const built = [
    plan(choiceOffer()),
    plan(soleSurvivor('OVERDUE', 0.9)),
    plan(soleSurvivor('QUICK_WIN', 0.2)),
    plan(onlyCandidate()),
    plan(withheld()),
  ];
  const base = soleSurvivor();
  for (const verdict of RECOMMENDATION_DECISION_VERDICTS) built.push(plan(base, decisionOf(verdict, base.recommendationId)));
  for (const one of built) {
    assert.ok(isPermittedPair(one.intent, one.strategy), `${one.intent} produced a strategy its row forbids: ${one.strategy}`);
    assert.deepEqual(checkCoachingPlan(one), [], `planner produced a plan its own checker rejects: ${one.intent}`);
    assert.ok(one.claims.length <= COACHING_SENTENCE_POLICY.maxClaimsPerPlan, 'plan exceeds the claim cap');
    assert.ok(one.claims.length <= one.maxSentences, 'plan carries more claims than sentences to say them in');
  }
});

/* ── The strategy choice is the one it says it is ────────────────── */

test('a high-confidence sole option leads with the action and a lower one earns it first', () => {
  assert.equal(plan(soleSurvivor('OVERDUE', 0.9)).strategy, 'lead_with_action');
  assert.equal(plan(soleSurvivor('OVERDUE', 0.5)).strategy, 'lead_with_reason');
  assert.equal(plan(soleSurvivor('OVERDUE', 0.1)).strategy, 'lead_with_reason');
  // The two claims are the same either way; the order is the whole difference,
  // which is why the strategy is a field rather than something a reader infers.
  const confident = plan(soleSurvivor('OVERDUE', 0.9));
  const cautious = plan(soleSurvivor('OVERDUE', 0.5));
  assert.equal(confident.claims[0].kind, 'proposed_action');
  assert.equal(cautious.claims[0].kind, 'timing');
  assert.deepEqual(
    confident.claims.map((claim) => claim.kind).slice().sort(),
    cautious.claims.map((claim) => claim.kind).slice().sort(),
  );
});

test('a decision wins over the offer, whatever the offer was', () => {
  for (const source of [soleSurvivor(), choiceOffer(), onlyCandidate()]) {
    const built = plan(source, decisionOf('done', source.recommendationId));
    assert.equal(built.intent, 'acknowledge_completion');
    assert.equal(built.acknowledges, 'done');
    assert.equal(built.claims.length, 1);
    assert.equal(isEvidenceBackedClaim(built.claims[0]), false, 'a decision echo must not carry an evidence list');
  }
});

/* ── Report, do not throw ────────────────────────────────────────── */

test('the planner refuses rather than throwing, for every malformed input shape', () => {
  const malformed: readonly unknown[] = [
    null,
    undefined,
    {},
    { recommendation: null, locale: 'en', now: NOW },
    { recommendation: soleSurvivor(), locale: 'klingon', now: NOW },
    { recommendation: soleSurvivor(), locale: 'en', now: 'not-an-instant' },
    { recommendation: soleSurvivor(), locale: 'en', now: '2026-08-20T09:15:00' },
    { recommendation: { outcome: 'unheard-of' }, locale: 'en', now: NOW },
  ];
  for (const input of malformed) {
    const outcome = planCoaching(input as never);
    assert.equal(outcome.outcome, 'refused', `expected a refusal for ${JSON.stringify(input)}`);
    assert.ok(outcome.defects.length > 0, 'a refusal must say why');
  }
});

test('an unverifiable source is stale, so a caller supplying no fingerprints is refused', () => {
  // `RECOMMENDATION_INPUT_POLICY.unverifiableSourceIsStale`. The comfortable
  // direction — treat a missing fingerprint as unchanged — makes the check most
  // confident exactly when the caller has lost track of the most sources.
  const outcome = planCoaching({ recommendation: soleSurvivor(), locale: 'en', now: NOW });
  assert.equal(outcome.outcome, 'refused');
  assert.ok(
    outcome.defects.every((one) => one.code === 'SOURCE_RECOMMENDATION_STALE'),
    'an unverifiable source must be reported as staleness, not as something else',
  );
});

test('an expired recommendation is refused rather than coached about', () => {
  const source = soleSurvivor();
  const outcome = planCoaching({
    recommendation: source,
    locale: 'en',
    now: '2026-08-20T11:00:00Z' as never,
    currentFingerprints: fingerprintsFor(source),
  });
  assert.equal(outcome.outcome, 'refused');
  assert.ok(outcome.defects.some((one) => one.code === 'SOURCE_RECOMMENDATION_STALE'));
});

test('a decision naming a different recommendation is refused', () => {
  const source = soleSurvivor();
  const outcome = planCoaching({
    recommendation: source,
    decision: decisionOf('done', 'some-other-recommendation'),
    locale: 'en',
    now: NOW,
    currentFingerprints: fingerprintsFor(source),
  });
  assert.equal(outcome.outcome, 'refused');
  // The worst outcome available is a real user act recorded against an action
  // they never saw. It must not become prose about one either.
  assert.ok(outcome.defects.some((one) => one.code === 'UNKNOWN_SOURCE_REASON'));
});

/* ── No identifier travels in a defect detail ────────────────────── */

test('no defect detail quotes an identifier from the input', () => {
  const source = soleSurvivor();
  const outcome = planCoaching({
    recommendation: source,
    decision: decisionOf('done', 'leaky-identifier-value'),
    locale: 'en',
    now: NOW,
    currentFingerprints: fingerprintsFor(source),
  });
  assert.equal(outcome.outcome, 'refused');
  for (const one of outcome.defects) {
    for (const identifier of ['leaky-identifier-value', source.recommendationId, source.scopeId, 'commitment-alpha']) {
      assert.equal(one.detail.includes(identifier), false, `a defect detail quoted ${identifier}`);
    }
  }
});

test('planning is deterministic and does not mutate its input', () => {
  const source = soleSurvivor();
  const before = JSON.stringify(source);
  const first = plan(source);
  const second = plan(source);
  assert.deepEqual(first, second, 'two runs of one request must agree');
  assert.equal(JSON.stringify(source), before, 'the planner mutated its input');
  assert.equal(BASIS_AT, source.validity.basisAt, 'the fixture drifted from the contract it is built against');
});
