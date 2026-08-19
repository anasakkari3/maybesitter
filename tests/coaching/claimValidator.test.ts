/**
 * The claim-to-evidence validator and the delivery path (Sprint 09, #38).
 *
 * The load-bearing test in this file is `a claim citing a valid node its reason
 * never cited is caught here and nowhere else`. It constructs a recommendation
 * that **Sprint 08's own checker reports as defect-free**, an evidence graph
 * that `checkEvidenceGraph` reports as sound, and a coaching claim whose every
 * evidence id resolves to a real observation — and the claim still asserts
 * something the recommendation did not.
 *
 * That is the whole justification for this module existing beside Sprint 08's
 * rather than duplicating it. `checkRecommendation` validates a recommendation
 * **against itself**; this validates a **derived artefact against the
 * recommendation it came from**, and the second question is unaskable from
 * inside the first. The test asserts both halves: that this validator finds it,
 * and that Sprint 08's does not — because a claim that "we added something new"
 * is only worth having if the thing it adds is demonstrably absent elsewhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COACHING_ABSENT_GATEWAY_RECOVERY,
  COACHING_CLAIM_SUPPORT_RECOVERY,
  CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM,
  COACHING_CLAIM_KINDS,
  COACHING_SENTENCE_POLICY,
  DECISION_ECHO_CLAIM_KINDS,
  ENGINE_LEXICON_PARITY,
  checkCoachingOutput,
  checkCoachingPlan,
  isDecisionEchoClaim,
  isEvidenceBackedClaim,
  EVIDENCE_BACKED_CLAIM_KINDS,
  PRESSURE_INTENSITY_FOR_INTENT,
  UNKNOWN_COACHING_CLAIM_CANDIDATE_KIND,
  UNKNOWN_INTENT_PRESSURE_INTENSITY,
  type CoachingOutput,
  type CoachingPlan,
} from '../../src/contracts/v1/coachingContracts';
import {
  RECOMMENDATION_CONTRACT_VERSION,
  checkEvidenceGraph,
  checkRecommendation,
  type EvidenceNode,
  type Recommendation,
  type RecommendationDecision,
} from '../../src/contracts/v1/recommendationContracts';
import {
  CANDIDATE_CLAIM_KINDS,
  SAFETY_CODE_BOUNDARIES,
  SAFETY_CODE_SCOPES,
  SAFETY_CODE_SEVERITY,
  SAFETY_CODE_STAGES,
  type SafetyFinding,
  type SafetyRequest,
  type SafetyVerdict,
} from '../../src/contracts/v1/safetyContracts';
import { evaluateSafetyGate } from '../../lib/safety';
import {
  DEFAULT_COACHING_LEXICONS,
  checkClaimSupport,
  checkCoachingLanguage,
  containsToken,
  matchesPattern,
  deliverCoaching,
  identifiersOf,
  planCoaching,
  realizeCoachingPlan,
  toSafetyCandidate,
} from '../../lib/coaching';
import { realizeCoachingPlan as _realize } from '../../lib/coaching';
void _realize;
import { NOW, choiceOffer, fingerprintsFor, observed, onlyCandidate, soleSurvivor, withheld } from './fixtures';

function planFor(recommendation: Recommendation, decision: RecommendationDecision | null = null): CoachingPlan {
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

const PLAN_OF = new WeakMap<CoachingOutput, CoachingPlan>();

function outputFor(recommendation: Recommendation, decision: RecommendationDecision | null = null): CoachingOutput {
  const plan = planFor(recommendation, decision);
  const outcome = realizeCoachingPlan({ plan, evidence: recommendation.evidence, basisAt: NOW });
  assert.equal(outcome.outcome, 'realized', `realization refused: ${JSON.stringify(outcome)}`);
  const output = (outcome as { output: CoachingOutput }).output;
  PLAN_OF.set(output, plan);
  return output;
}

/** The plan an output was realized from, for the delivery gate's structural pass. */
function planOf(output: CoachingOutput): CoachingPlan {
  const plan = PLAN_OF.get(output);
  assert.ok(plan !== undefined, 'no plan was recorded for this output');
  return plan as CoachingPlan;
}

function doneDecision(recommendationId: string): RecommendationDecision {
  return { version: RECOMMENDATION_CONTRACT_VERSION, recommendationId, optionIndex: 0, verdict: 'done', decidedAt: NOW };
}

function codesOf(defects: ReadonlyArray<{ code: string }>): readonly string[] {
  return defects.map((one) => one.code);
}

/** A finding built from #39's own tables, so no field is invented here. */
function finding(code: SafetyFinding['code']): SafetyFinding {
  return {
    code,
    stage: SAFETY_CODE_STAGES[code],
    boundary: SAFETY_CODE_BOUNDARIES[code],
    scope: SAFETY_CODE_SCOPES[code],
    severity: SAFETY_CODE_SEVERITY[code],
    inputIndex: null,
    segmentIndex: 0,
    claimIndex: null,
    nodeIndex: null,
    effectIndex: null,
    limitName: null,
    detail: 'a finding constructed by the coaching suite',
  };
}

/* ── The honest path ─────────────────────────────────────────────── */

test('an honestly planned and realized output has no claim-support defect', () => {
  for (const source of [soleSurvivor('OVERDUE', 0.9), soleSurvivor('QUICK_WIN', 0.3), choiceOffer(), onlyCandidate(), withheld()]) {
    const output = outputFor(source);
    assert.deepEqual(checkClaimSupport({ output, recommendation: source }), [], `an honest ${output.intent} turn was rejected`);
  }
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  assert.deepEqual(checkClaimSupport({ output: outputFor(base, decision), recommendation: base, decision }), []);
});

test('an honestly realized output has no language defect, in every locale', () => {
  for (const source of [soleSurvivor('OVERDUE', 0.9), choiceOffer(), onlyCandidate(), withheld()]) {
    const output = outputFor(source);
    assert.deepEqual(checkCoachingLanguage(output, identifiersOf(source)), [], `an honest ${output.intent} turn carries forbidden language`);
  }
});

/* ── THE load-bearing test ───────────────────────────────────────── */

test('a claim citing a valid node its reason never cited is caught here and nowhere else', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);

  // `n-basis` is a real observed node, cited by the lead option's confidence,
  // reachable, fingerprinted and structurally perfect. The lead option's
  // *support reason* cites `n-reason` and nothing else.
  const reasonClaim = output.claims.find((claim) => 'source' in claim && claim.source.kind === 'support_reason');
  assert.ok(reasonClaim !== undefined, 'the fixture must produce a support-reason claim for this test to mean anything');

  const smuggled = {
    ...output,
    claims: output.claims.map((claim) =>
      claim === reasonClaim ? { ...claim, supportedBy: ['n-reason', 'n-basis'] } : claim,
    ),
  } as unknown as CoachingOutput;

  // Half one: Sprint 08's checkers are blind to it, by construction.
  assert.deepEqual(checkRecommendation(source), [], 'the recommendation itself is defect-free');
  assert.deepEqual(checkEvidenceGraph(source.evidence), [], 'the evidence graph itself is sound');

  // Half two: this validator sees it.
  const defects = checkClaimSupport({ output: smuggled, recommendation: source });
  assert.ok(
    codesOf(defects).includes('CLAIM_EVIDENCE_NOT_IN_REASON'),
    `expected CLAIM_EVIDENCE_NOT_IN_REASON, got ${JSON.stringify(codesOf(defects))}`,
  );
});

test('the subset rule is by id, not by resolved roots', () => {
  // The rejected weaker rule: if a claim's evidence resolves to the same
  // observations as its reason's, a root-set comparison passes it. Here both
  // nodes are observations, so `roots(n-basis) = {n-basis}` and
  // `roots(n-reason) = {n-reason}` differ — but the shape the rule guards
  // against is the derived one, so build it explicitly.
  const nodes: EvidenceNode[] = [
    observed('n-root', 'fp-root'),
    { kind: 'derived', nodeId: 'n-reason', rule: 'OVERDUE_FROM_DUE_AT', claim: { kind: 'flag', value: true }, derivedFrom: ['n-root'] },
    { kind: 'derived', nodeId: 'n-sibling', rule: 'CAPACITY_FROM_LOAD', claim: { kind: 'flag', value: false }, derivedFrom: ['n-root'] },
    observed('n-basis', 'fp-basis'),
  ];
  const source = { ...soleSurvivor('OVERDUE', 0.9), evidence: { nodes } } as Recommendation;
  assert.deepEqual(checkEvidenceGraph(source.evidence), [], 'the sibling graph must be sound for the point to land');

  const output = outputFor(source);
  const reasonClaim = output.claims.find((claim) => 'source' in claim && claim.source.kind === 'support_reason');
  assert.ok(reasonClaim !== undefined);
  const sibling = {
    ...output,
    claims: output.claims.map((claim) => (claim === reasonClaim ? { ...claim, supportedBy: ['n-sibling'] } : claim)),
  } as unknown as CoachingOutput;

  // `n-sibling` resolves to exactly the roots `n-reason` resolves to, so a
  // root-set rule would accept it. It says something else entirely.
  const defects = checkClaimSupport({ output: sibling, recommendation: source });
  assert.ok(codesOf(defects).includes('CLAIM_EVIDENCE_NOT_IN_REASON'), 'a root-set rule would have let this through');
});

/* ── The rest of the faithfulness taxonomy ───────────────────────── */

test('a claim asserting a kind its source reason does not license is rejected', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const mutated = {
    ...output,
    claims: output.claims.map((claim) =>
      'source' in claim && claim.source.kind === 'support_reason' ? { ...claim, kind: 'importance' } : claim,
    ),
  } as unknown as CoachingOutput;
  // Fully sourced, every id resolves, and still says something the
  // recommendation did not.
  assert.ok(codesOf(checkClaimSupport({ output: mutated, recommendation: source })).includes('CLAIM_KIND_NOT_DERIVABLE'));
});

test('a claim naming a source position the recommendation does not have is rejected', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const cases: ReadonlyArray<Record<string, unknown>> = [
    { kind: 'support_reason', optionIndex: 7, reasonIndex: 0 },
    { kind: 'support_reason', optionIndex: 0, reasonIndex: 7 },
    { kind: 'option_confidence', optionIndex: 7 },
    { kind: 'withholding_reason', reasonIndex: 0 },
    { kind: 'only_candidate_attestation' },
    { kind: 'not_a_source_kind' },
  ];
  for (const source_ of cases) {
    const mutated = {
      ...output,
      claims: output.claims.map((claim, index) => (index === 0 ? { ...claim, source: source_ } : claim)),
    } as unknown as CoachingOutput;
    assert.ok(
      codesOf(checkClaimSupport({ output: mutated, recommendation: source })).includes('UNKNOWN_SOURCE_REASON'),
      `expected UNKNOWN_SOURCE_REASON for ${JSON.stringify(source_)}`,
    );
  }
});

test('evidence that reaches no observation is reported, using Sprint 08 own resolver', () => {
  const nodes: EvidenceNode[] = [
    { kind: 'derived', nodeId: 'n-reason', rule: 'OVERDUE_FROM_DUE_AT', claim: { kind: 'flag', value: true }, derivedFrom: ['n-loop'] },
    { kind: 'derived', nodeId: 'n-loop', rule: 'CAPACITY_FROM_LOAD', claim: { kind: 'flag', value: true }, derivedFrom: ['n-reason'] },
    observed('n-basis', 'fp-basis'),
  ];
  const source = { ...soleSurvivor('OVERDUE', 0.9), evidence: { nodes } } as Recommendation;
  const output = {
    ...outputFor({ ...source, evidence: soleSurvivor().evidence } as Recommendation),
    evidence: { nodes },
  } as unknown as CoachingOutput;
  const codes = codesOf(checkClaimSupport({ output, recommendation: source }));
  // Both fire, and neither suppresses the other: they borrow nothing from each
  // other, and suppressing the second would hide a claim-level finding behind a
  // structural one from a different producer.
  assert.ok(codes.includes('RECOMMENDATION_EVIDENCE_MALFORMED'), `expected a graph finding, got ${JSON.stringify(codes)}`);
  assert.ok(codes.includes('UNRESOLVABLE_EVIDENCE'), `expected an unresolvable finding, got ${JSON.stringify(codes)}`);
});

test('an output naming a different recommendation is rejected', () => {
  const source = soleSurvivor();
  const output = { ...outputFor(source), recommendationId: 'a-different-recommendation' } as unknown as CoachingOutput;
  assert.ok(codesOf(checkClaimSupport({ output, recommendation: source })).includes('RECOMMENDATION_MISMATCH'));
});

/* ── The decision-echo exception is bounded ──────────────────────── */

test('a decision echo with no decision supplied is rejected', () => {
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  assert.ok(
    codesOf(checkClaimSupport({ output, recommendation: base })).includes('DECISION_CLAIM_WITHOUT_DECISION'),
    'an echo of a decision nobody made is the worst output this module could produce',
  );
});

test('a decision echo of a verdict the user did not give is rejected', () => {
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  const other: RecommendationDecision = { ...decision, verdict: 'dismiss', optionIndex: null };
  const codes = codesOf(checkClaimSupport({ output, recommendation: base, decision: other }));
  assert.ok(codes.includes('DECISION_CLAIM_VERDICT_MISMATCH'), `got ${JSON.stringify(codes)}`);
  // A fabricated completion is one field away from a correct acknowledgement.
  assert.ok(codes.includes('CLAIM_KIND_NOT_DERIVABLE'));
});

/* ── Language: the acceptance criterion, both directions ─────────── */

test('a completion described as tracking is caught, and gets its own code', () => {
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  for (const text of [
    'You closed that one out, and I am tracking the rest.',
    'You closed that one out. I saved it.',
    'You closed that one out, and I will keep an eye on it while monitoring the others.',
    'You closed that one out, so I am logging it.',
  ]) {
    const mutated = { ...output, sentences: [{ ...output.sentences[0], text }] } as unknown as CoachingOutput;
    const codes = codesOf(checkCoachingLanguage(mutated, identifiersOf(base)));
    assert.ok(codes.includes('COMPLETION_DESCRIBED_AS_TRACKING'), `not caught: ${text} -> ${JSON.stringify(codes)}`);
  }
});

test('the same verb outside a completion is forbidden too, under the other code', () => {
  // The engine forbids these only when `stateChange === 'completed'`, because
  // the engine genuinely creates reminders. This module writes nothing, so the
  // verb is a false claim whatever the intent — but the code says which lie it
  // is, because the two are told by different templates.
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const mutated = { ...output, sentences: [{ ...output.sentences[0], text: 'I saved that for you.' }, output.sentences[1]] } as unknown as CoachingOutput;
  const codes = codesOf(checkCoachingLanguage(mutated, identifiersOf(source)));
  assert.ok(codes.includes('FORBIDDEN_LANGUAGE'));
  assert.equal(codes.includes('COMPLETION_DESCRIBED_AS_TRACKING'), false, 'this turn acknowledges no completion');
});

test('shame language is caught, and the lexicon matches the shipped engine word for word', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  for (const text of [
    'You have been inconsistent about this one.',
    'That is your fault.',
    'You failed to get to it.',
    'I am disappointed by that.',
    'You are being avoidant.',
  ]) {
    const mutated = { ...output, sentences: [{ ...output.sentences[0], text }, output.sentences[1]] } as unknown as CoachingOutput;
    assert.ok(codesOf(checkCoachingLanguage(mutated, identifiersOf(source))).includes('FORBIDDEN_LANGUAGE'), `not caught: ${text}`);
  }
});

test('the token matcher is prefix-anchored and Unicode-aware, proved both ways', () => {
  // A negative-only assertion passes against a matcher that matches nothing.
  assert.equal(containsToken('I am tracking that.', 'tracking'), true);
  assert.equal(containsToken('A reminder about it.', 'remind'), true, 'prefix-anchored: remind must catch reminder');
  assert.equal(containsToken('هذه tracking للمهام.', 'tracking'), true, 'an English word inside Arabic text must still match');
  assert.equal(containsToken('There is nothing here.', 'noting'), false, 'nothing must not read as noting');
  assert.equal(containsToken('This is retracking.', 'tracking'), false, 'the left boundary must hold');
  assert.equal(containsToken('anything', ''), false);
});

test('an identifier reaching prose is caught, and the real templates never do', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  // Sprint 07's recorded leak was `working window call-dr.cohen-about-the-biopsy`
  // passing a test that only checked the title was absent.
  const leaked = {
    ...output,
    sentences: [{ ...output.sentences[0], text: 'The next step is commitment-alpha.' }, output.sentences[1]],
  } as unknown as CoachingOutput;
  const defects = checkCoachingLanguage(leaked, identifiersOf(source));
  assert.ok(codesOf(defects).includes('IDENTIFIER_IN_PROSE'));
  for (const one of defects) {
    assert.equal(one.detail.includes('commitment-alpha'), false, 'the defect detail quoted the identifier it was reporting');
  }
  assert.deepEqual(checkCoachingLanguage(output, identifiersOf(source)), [], 'the real templates leak nothing');
});

test('identifiersOf collects every free string the recommendation carries', () => {
  const found = identifiersOf(soleSurvivor());
  for (const expected of ['rec-fixture-one', 'scope-fixture-one', 'commitment-alpha', 'commitment-beta', 'n-reason', 'n-basis']) {
    assert.ok(found.includes(expected), `identifiersOf missed ${expected}`);
  }
});

/* ── The conversion to #39 candidate ─────────────────────────────── */

test('every evidence-backed claim converts to a statement carrying no instant', () => {
  // The pin behind `FABRICATED_INSTANT` being unreachable for this producer.
  // The reason it is unreachable is proved in `realizer.test.ts`, against the
  // templates rather than against this mapping.
  for (const source of [soleSurvivor('OVERDUE', 0.9), choiceOffer(), onlyCandidate(), withheld()]) {
    const candidate = toSafetyCandidate(outputFor(source), 'candidate-fixed', []);
    for (const claim of candidate.claims) {
      assert.equal(claim.kind, 'statement');
      assert.equal(claim.statedInstant, null);
      assert.equal(claim.decisionIndex, null, 'only a decision echo names an attested decision');
      assert.equal(claim.echoedVerdict, null, 'only a decision echo attributes an act to the user');
      assert.ok(claim.supportedBy.length > 0, 'this module must never hand the gateway an unsourced claim');
    }
  }
  for (const kind of EVIDENCE_BACKED_CLAIM_KINDS) {
    assert.equal((CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM as Readonly<Record<string, string>>)[kind], 'statement');
  }
  for (const kind of COACHING_CLAIM_KINDS) {
    const mapped = (CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM as Readonly<Record<string, string>>)[kind];
    assert.ok(mapped !== undefined, `no candidate kind is mapped for coaching claim kind ${kind}`);
    assert.ok((CANDIDATE_CLAIM_KINDS as readonly string[]).includes(mapped), `${kind} maps outside #39's frozen list`);
  }
});

/* ── The decision-echo ruling (#39) ──────────────────────────────── */

test('a decision echo is emitted, not dropped, and names its attested record', () => {
  // #39 ruled against the earlier exclusion: the class only looked uncheckable
  // because `SafetyRequest` did not carry the record. Dropping echoes would
  // have left a fabricated completion — the worst output this module can
  // produce — checked by this module alone.
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  const candidate = toSafetyCandidate(output, 'candidate-fixed', [decision]);

  assert.equal(output.claims.length, 1, 'the fixture must produce exactly one echo');
  assert.equal(candidate.segments.length, 1, 'the prose reaches the gateway');
  assert.equal(candidate.claims.length, 1, 'the echo reaches the gateway too, and is no longer dropped');

  const echo = candidate.claims[0];
  assert.equal(echo.kind, 'decision_echo');
  assert.equal(echo.decisionIndex, 0, 'the index must name the attested record, by position');
  assert.equal(echo.echoedVerdict, 'done');
  assert.deepEqual(echo.supportedBy, [], "empty is correct here; #39's exemption is explicit");
  assert.equal(echo.statedInstant, null);
  for (const kind of DECISION_ECHO_CLAIM_KINDS) {
    assert.equal((CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM as Readonly<Record<string, string>>)[kind], 'decision_echo');
  }
});

test('an unattested decision converts to a null index, which is what #39 blocks', () => {
  // Attestation is the gateway's judgement, not this module's. Re-deriving it
  // here would be the second *copy of data* Sprint 06 forbids, as opposed to
  // the second *judgement* it endorses — which this module already makes, in
  // `DECISION_CLAIM_WITHOUT_DECISION` and `DECISION_CLAIM_VERDICT_MISMATCH`.
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);

  const cases: ReadonlyArray<readonly [string, readonly RecommendationDecision[]]> = [
    ['nothing attested at all', []],
    ['a record for a different recommendation', [{ ...decision, recommendationId: 'some-other-recommendation' }]],
    ['a record targeting a different option', [{ ...decision, optionIndex: 3 }]],
    ['a whole-offer dismissal where the echo names an option', [{ ...decision, optionIndex: null }]],
  ];
  for (const [why, attested] of cases) {
    const candidate = toSafetyCandidate(output, 'candidate-fixed', attested);
    assert.equal(candidate.claims[0].decisionIndex, null, `expected a null index when ${why}`);
    assert.equal(candidate.claims[0].echoedVerdict, 'done', 'the echo still says what the prose attributes');
  }
  // Defaulting the argument away is the same fail-closed direction.
  assert.equal(toSafetyCandidate(output, 'candidate-fixed').claims[0].decisionIndex, null);
});

test('the attestation match is on recommendation and option, never on the verdict', () => {
  // Matching on the verdict is the shortcut that destroys the check: a
  // fabricated `done` would find whichever record happens to say `done`, so
  // `DECISION_ECHO_MISMATCHED` could never fire. The index must name the record
  // the echo is *about*, so the gateway can compare the two.
  const base = soleSurvivor();
  const done = doneDecision(base.recommendationId);
  const output = outputFor(base, done);
  const deferred: RecommendationDecision = { ...done, verdict: 'defer' };

  const candidate = toSafetyCandidate(output, 'candidate-fixed', [deferred]);
  assert.equal(candidate.claims[0].decisionIndex, 0, 'the record about this option must still be located');
  assert.equal(candidate.claims[0].echoedVerdict, 'done', 'and the echo must still say what the prose says');
  assert.notEqual(
    candidate.claims[0].echoedVerdict,
    deferred.verdict,
    "the disagreement must survive into the candidate for #39's DECISION_ECHO_MISMATCHED to see it",
  );
});

test('every decision verdict produces an echo the gateway can locate', () => {
  const base = soleSurvivor();
  for (const verdict of ['accept', 'edit', 'done', 'dismiss', 'defer'] as const) {
    const decision: RecommendationDecision = {
      version: RECOMMENDATION_CONTRACT_VERSION,
      recommendationId: base.recommendationId,
      optionIndex: verdict === 'dismiss' ? null : 0,
      verdict,
      ...(verdict === 'edit' ? { editedTitle: 'a replacement the user wrote' } : {}),
      decidedAt: NOW,
    };
    const candidate = toSafetyCandidate(outputFor(base, decision), 'candidate-fixed', [decision]);
    assert.equal(candidate.claims.length, 1, `no echo emitted for ${verdict}`);
    assert.equal(candidate.claims[0].kind, 'decision_echo');
    assert.equal(candidate.claims[0].decisionIndex, 0, `${verdict} echo did not locate its record`);
    assert.equal(candidate.claims[0].echoedVerdict, verdict);
  }
});

/* ── Both fallbacks fail closed ──────────────────────────────────── */

test('an unrecognised claim kind converts to a blocking kind, never to a statement', () => {
  // #39 recorded that `postValidator.ts` held private copies of
  // `CANDIDATE_CLAIM_KINDS` and `PROPOSED_EFFECT_KINDS` that had already
  // diverged once. A quiet `?? 'statement'` default is the same shape: a local
  // opinion about a contract-owned vocabulary, substituting its most permissive
  // member.
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const mutated = {
    ...output,
    claims: output.claims.map((claim, index) => (index === 0 ? { ...claim, kind: 'motivational' } : claim)),
  } as unknown as CoachingOutput;
  const candidate = toSafetyCandidate(mutated, 'candidate-fixed', []);
  assert.equal(candidate.claims[0].kind, UNKNOWN_COACHING_CLAIM_CANDIDATE_KIND);
  assert.equal(candidate.claims[0].kind, 'decision_echo');
  assert.equal(candidate.claims[0].decisionIndex, null, 'so #39 blocks it with DECISION_ECHO_UNATTESTED');
  assert.notEqual(candidate.claims[0].kind, 'statement', 'a statement default would slip through as ordinary prose');
});

test('an unrecognised intent overstates its pressure rather than declaring none', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const mutated = { ...outputFor(source), intent: 'unheard_of' } as unknown as CoachingOutput;
  const candidate = toSafetyCandidate(mutated, 'candidate-fixed', []);
  assert.equal(candidate.pressure, UNKNOWN_INTENT_PRESSURE_INTENSITY);
  assert.notEqual(candidate.pressure, 'none', 'a none default is how an unknown intent slips under the budget');
  assert.notEqual(candidate.pressure, 'high', 'and no coaching intent may claim the engine escalation band');
});

test('a coaching candidate declares no effect and never overstates its pressure', () => {
  const candidate = toSafetyCandidate(outputFor(soleSurvivor('OVERDUE', 0.9)), 'candidate-fixed', []);
  assert.equal(candidate.surface, 'coaching_message');
  assert.deepEqual(candidate.effects.map((effect) => effect.kind), ['none']);
  for (const level of Object.values(PRESSURE_INTENSITY_FOR_INTENT)) {
    assert.notEqual(level, 'high', 'no coaching intent may claim the engine escalation band');
  }
});

/* ── Delivery: unsupported claims block ──────────────────────────── */

test('an unsupported claim blocks delivery, and the gateway is not consulted', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const smuggled = {
    ...output,
    claims: output.claims.map((claim) =>
      'source' in claim && claim.source.kind === 'support_reason' ? { ...claim, supportedBy: ['n-basis'] } : claim,
    ),
  } as unknown as CoachingOutput;
  let consulted = 0;
  const delivery = deliverCoaching({
    output: smuggled,
    plan: planOf(output),
    recommendation: source,
    candidateId: 'candidate-fixed',
    gate: () => {
      consulted += 1;
      return { disposition: 'allow', findings: [] };
    },
  });
  assert.equal(delivery.disposition, 'withheld');
  assert.deepEqual(delivery.blockedBy, ['claim_support']);
  assert.ok(delivery.defects.some((one) => one.code === 'CLAIM_EVIDENCE_NOT_IN_REASON'));
  assert.deepEqual(delivery.recovery, COACHING_CLAIM_SUPPORT_RECOVERY);
  assert.equal(consulted, 0, 'a permissive gateway must not be able to overrule this module own gate');
});

test('an absent gateway blocks delivery; it is refusal, never permission', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const delivery = deliverCoaching({
    output,
    plan: planOf(output),
    recommendation: source,
    candidateId: 'candidate-fixed',
    gate: null,
  });
  assert.equal(delivery.disposition, 'withheld');
  assert.deepEqual(delivery.blockedBy, ['safety_gateway']);
  assert.deepEqual(delivery.recovery, COACHING_ABSENT_GATEWAY_RECOVERY);
  assert.equal(delivery.verdict, null);
});

test('a gateway allow delivers, and a gateway block withholds with its own recovery', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const allowed = deliverCoaching({
    output,
    plan: planOf(output),
    recommendation: source,
    candidateId: 'candidate-fixed',
    gate: () => ({ disposition: 'allow', findings: [] }),
  });
  assert.equal(allowed.disposition, 'delivered');
  assert.deepEqual(allowed.output, output);

  const blockVerdict: SafetyVerdict = {
    disposition: 'block',
    findings: [finding('SHAMING_LANGUAGE')],
    recovery: { kind: 'offer_neutral_acknowledgement', retryAdmissible: true, retryAfter: null },
  };
  const blocked = deliverCoaching({
    output,
    plan: planOf(output),
    recommendation: source,
    candidateId: 'candidate-fixed',
    gate: () => blockVerdict,
  });
  assert.equal(blocked.disposition, 'withheld');
  assert.deepEqual(blocked.blockedBy, ['safety_gateway']);
  assert.deepEqual(blocked.verdict, blockVerdict, "#39's verdict travels verbatim; this module keeps no second copy");
  assert.deepEqual(blocked.recovery, blockVerdict.recovery);
});

test('allow_with_redaction withholds in v1, and still carries a way out', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const redaction: SafetyVerdict = {
    disposition: 'allow_with_redaction',
    findings: [finding('RAW_IDENTIFIER_DISCLOSED')],
    redactedSegmentIndices: [1],
    recovery: { kind: 'offer_neutral_acknowledgement', retryAdmissible: true, retryAfter: null },
  };
  const redactedOutput = outputFor(source);
  const delivery = deliverCoaching({
    output: redactedOutput,
    plan: planOf(redactedOutput),
    recommendation: source,
    candidateId: 'candidate-fixed',
    gate: () => redaction,
  });
  // A fragment of a coaching sentence is not a shorter coaching sentence:
  // dropping one leaves the rest resting on a claim nothing realizes.
  assert.equal(delivery.disposition, 'withheld');
  assert.deepEqual(delivery.recovery, redaction.recovery);
});

test('a verdict this version does not recognise is a refusal, not a pass', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  for (const bad of [null, undefined, {}, { disposition: 'probably_fine' }, 'allow']) {
    const badOutput = outputFor(source);
    const delivery = deliverCoaching({
      output: badOutput,
      plan: planOf(badOutput),
      recommendation: source,
      candidateId: 'candidate-fixed',
      gate: (() => bad) as never,
    });
    assert.equal(delivery.disposition, 'withheld', `an unrecognised verdict must not deliver: ${JSON.stringify(bad)}`);
  }
});

/* ── Report, do not throw ────────────────────────────────────────── */

test('the validator refuses rather than throwing, for every malformed input', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const malformed: readonly unknown[] = [
    null,
    undefined,
    {},
    { output, recommendation: null },
    { output: null, recommendation: source },
    { output: { ...output, claims: null }, recommendation: source },
    { output: { ...output, claims: [null, 42, 'claim'] }, recommendation: source },
    { output: { ...output, evidence: null }, recommendation: source },
    { output: { ...output, evidence: { nodes: 'not-an-array' } }, recommendation: source },
    { output, recommendation: { outcome: 'unheard-of', recommendationId: source.recommendationId } },
  ];
  for (const input of malformed) {
    const defects = checkClaimSupport(input as never);
    assert.ok(Array.isArray(defects), `checkClaimSupport did not return a list for ${JSON.stringify(input)?.slice(0, 80)}`);
  }
  for (const input of [null, undefined, {}, { sentences: null }, { sentences: [null, { text: 42 }] }]) {
    assert.ok(Array.isArray(checkCoachingLanguage(input as never, [])), 'checkCoachingLanguage did not return a list');
  }
  assert.ok(Array.isArray(identifiersOf(null as never)));
});

test('no defect detail from any pass quotes an identifier', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const broken = {
    ...output,
    recommendationId: 'a-different-recommendation',
    claims: output.claims.map((claim) => ({ ...claim, supportedBy: ['n-basis', 'no-such-node'] })),
  } as unknown as CoachingOutput;
  const defects = [
    ...checkClaimSupport({ output: broken, recommendation: source }),
    ...checkCoachingLanguage(broken, identifiersOf(source)),
  ];
  assert.ok(defects.length > 0, 'this guard would be vacuous with no findings');
  for (const one of defects) {
    for (const identifier of identifiersOf(source).concat(['a-different-recommendation', 'no-such-node'])) {
      assert.equal(one.detail.includes(identifier), false, `a defect detail quoted ${identifier}`);
    }
  }
});

/* ── End to end against #39's real gateway ───────────────────────── */

/**
 * The conformance proof.
 *
 * Everything above checks the *conversion* against what #39's contract says.
 * These run the conversion's output through `evaluateSafetyGate` itself, which
 * is the only thing that proves the two tracks agree rather than that this
 * track read the contract carefully. Sprint 07's recorded lesson is that a
 * cross-track claim is only as strong as the granularity it is checked at, and
 * "the shapes typecheck" is the weakest granularity available.
 *
 * The import runs test → `lib/safety`, which is a direction
 * `coachingBoundaries.test.ts` permits: it forbids `lib/coaching/**` reaching
 * `lib/safety/**` at runtime and the reverse, and a test that exercises both is
 * neither.
 */

function safetyRequestFor(attested: readonly RecommendationDecision[]): SafetyRequest {
  return {
    requestId: 'request-fixed',
    surface: 'coaching_message',
    now: NOW,
    inputs: [],
    permittedSensitivity: 'personal',
    pressureBudget: {
      maxIntensity: 'medium',
      minIntervalMinutes: 0,
      lastPressuredAt: null,
      consecutiveUnansweredCount: 0,
      maxConsecutiveUnanswered: 3,
    },
    attestedDecisions: attested,
  };
}

test('an honest coaching turn is allowed by the real gateway, in every locale', () => {
  for (const source of [soleSurvivor('OVERDUE', 0.9), choiceOffer(), onlyCandidate(), withheld()]) {
    const candidate = toSafetyCandidate(outputFor(source), 'candidate-fixed', []);
    const result = evaluateSafetyGate({ request: safetyRequestFor([]), candidate, auditId: 'audit-fixed' });
    assert.equal(
      result.verdict.disposition,
      'allow',
      `an honest ${candidate.surface} turn was refused: ${JSON.stringify(result.verdict.findings.map((one) => one.code))}`,
    );
  }
});

test('an honest completion acknowledgement is allowed once its decision is attested', () => {
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const candidate = toSafetyCandidate(outputFor(base, decision), 'candidate-fixed', [decision]);
  const result = evaluateSafetyGate({ request: safetyRequestFor([decision]), candidate, auditId: 'audit-fixed' });
  assert.equal(
    result.verdict.disposition,
    'allow',
    `refused: ${JSON.stringify(result.verdict.findings.map((one) => one.code))}`,
  );
});

test('the real gateway blocks a completion echo nothing attests', () => {
  // The class #39 ruled back into scope. Under the earlier dropping conversion
  // this candidate carried no claim at all, so the gateway had nothing to
  // check and would have allowed it.
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const candidate = toSafetyCandidate(outputFor(base, decision), 'candidate-fixed', []);
  const result = evaluateSafetyGate({ request: safetyRequestFor([]), candidate, auditId: 'audit-fixed' });
  assert.equal(result.verdict.disposition, 'block');
  const codes = result.verdict.findings.map((one) => one.code);
  assert.ok(codes.includes('DECISION_ECHO_UNATTESTED'), `expected DECISION_ECHO_UNATTESTED, got ${JSON.stringify(codes)}`);
});

test('the real gateway blocks a completion echo the record contradicts', () => {
  // A fabrication by the realizer: the store recorded `defer`, the prose says
  // the user closed it out. This is what the attestation match on
  // (recommendation, option) rather than on verdict exists to make visible.
  const base = soleSurvivor();
  const done = doneDecision(base.recommendationId);
  const deferred: RecommendationDecision = { ...done, verdict: 'defer' };
  const candidate = toSafetyCandidate(outputFor(base, done), 'candidate-fixed', [deferred]);
  const result = evaluateSafetyGate({ request: safetyRequestFor([deferred]), candidate, auditId: 'audit-fixed' });
  assert.equal(result.verdict.disposition, 'block');
  const codes = result.verdict.findings.map((one) => one.code);
  assert.ok(codes.includes('DECISION_ECHO_MISMATCHED'), `expected DECISION_ECHO_MISMATCHED, got ${JSON.stringify(codes)}`);
});

test('the full delivery path allows an honest turn and withholds a fabricated one', () => {
  const base = soleSurvivor();
  const done = doneDecision(base.recommendationId);
  const deferred: RecommendationDecision = { ...done, verdict: 'defer' };
  const output = outputFor(base, done);
  const gate = (attested: readonly RecommendationDecision[]) => (candidate: Parameters<typeof evaluateSafetyGate>[0]['candidate']) =>
    evaluateSafetyGate({ request: safetyRequestFor(attested), candidate, auditId: 'audit-fixed' }).verdict;

  const honest = deliverCoaching({
    output,
    plan: planOf(output),
    recommendation: base,
    decision: done,
    candidateId: 'candidate-fixed',
    attestedDecisions: [done],
    gate: gate([done]),
  });
  assert.equal(honest.disposition, 'delivered');

  const fabricated = deliverCoaching({
    output,
    plan: planOf(output),
    recommendation: base,
    decision: done,
    candidateId: 'candidate-fixed',
    attestedDecisions: [deferred],
    gate: gate([deferred]),
  });
  assert.equal(fabricated.disposition, 'withheld');
  assert.deepEqual(fabricated.blockedBy, ['safety_gateway'], 'this module own gate cannot see an attestation mismatch');
  assert.equal(fabricated.recovery.kind, 'show_evidence_only', "#39's recovery for DECISION_ECHO_MISMATCHED, carried verbatim");
});

/* ── Review findings: regressions, one per defect ────────────────── */

/**
 * The blocker, as a single reproduced input.
 *
 * `deliverCoaching` ran only the claim-support and language passes, so every
 * structural code was unenforced at the one place both this file and `index.ts`
 * document as the gate. The compounding half is what made it deliverable:
 * `checkClaimSupport` iterates `output.claims`, so **zero claims produced zero
 * findings**, and the candidate handed to the gateway declared no claims either
 * — so #39 found nothing too. One empty field silenced two independent gates.
 */
test('the delivery gate runs the structural pass, and the reviewer exploit is refused', () => {
  // The recommendation actually carries the leaked identifier, on a
  // `TrustedSource` — which is the shape `identifiersOf` used to walk past.
  const source = {
    ...soleSurvivor('OVERDUE', 0.9),
    evidence: {
      nodes: [
        {
          ...observed('n-reason', 'fp-reason'),
          source: { kind: 'plan_slot', itemId: 'call-dr-cohen-about-the-biopsy', planDigest: 'digest-secret-value' },
        },
        observed('n-basis', 'fp-basis'),
      ],
    },
  } as unknown as Recommendation;
  const honest = outputFor(source);
  const exploit = {
    ...honest,
    realization: 'model',
    claims: [],
    sentences: [
      { sentenceIndex: 0, text: 'Your call-dr-cohen-about-the-biopsy is due 2026-08-21 at 16:00.', templateId: 'x', claimIndices: [7] },
      { sentenceIndex: 1, text: 'I have put it on your list and I will keep an eye on it.', templateId: 'y', claimIndices: [9] },
    ],
  } as unknown as CoachingOutput;

  let consulted = 0;
  const delivery = deliverCoaching({
    output: exploit,
    plan: planOf(honest),
    recommendation: source,
    candidateId: 'candidate-fixed',
    gate: () => {
      consulted += 1;
      return { disposition: 'allow', findings: [] };
    },
  });

  assert.equal(delivery.disposition, 'withheld', 'the reviewer exploit was delivered');
  assert.equal(consulted, 0, 'a permissive gateway must not be reached once this module own gate refuses');
  const codes = codesOf(delivery.defects);
  // Each of the five things wrong with that one output earns its own code.
  for (const expected of [
    'MODEL_REALIZATION_NOT_ENABLED',
    'EMPTY_CLAIM_LIST',
    'UNKNOWN_CLAIM_REFERENCE',
    'IDENTIFIER_IN_PROSE',
  ]) {
    assert.ok(codes.includes(expected), `expected ${expected}; got ${JSON.stringify(codes)}`);
  }
  assert.ok(
    codes.includes('COMPLETION_DESCRIBED_AS_TRACKING') || codes.includes('FORBIDDEN_LANGUAGE'),
    `the persistence claim and the machine time must both be caught; got ${JSON.stringify(codes)}`,
  );
});

test('the delivery gate refuses an output that disagrees with its plan', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const delivery = deliverCoaching({
    output: { ...output, intent: 'explain_withholding' } as unknown as CoachingOutput,
    plan: planOf(output),
    recommendation: source,
    candidateId: 'candidate-fixed',
    gate: () => ({ disposition: 'allow', findings: [] }),
  });
  assert.equal(delivery.disposition, 'withheld');
  assert.ok(codesOf(delivery.defects).includes('PLAN_OUTPUT_MISMATCH'));
});

/**
 * The superset claim, **checked against the shipped file rather than read**.
 *
 * The claim "everything the engine forbids, this module forbids" was written
 * from a reading of `validation.ts` and was false in six places. A reading is
 * not a check, and it stops being true silently the day the engine's list
 * grows. So this reads the engine's source from disk, pins that the recorded
 * patterns still match it, and then runs a corpus through both.
 */
function engineSource(): string {
  return readFileSync(join(repoRootFromTest(), 'lib', 'services', 'responseEngine', 'validation.ts'), 'utf8');
}

function repoRootFromTest(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

test("the engine's patterns have not drifted from the copies recorded in the contract", () => {
  const source = engineSource();
  assert.ok(
    source.includes(ENGINE_LEXICON_PARITY.creationOrTracking),
    'the engine CREATION_OR_TRACKING_CLAIM no longer matches the recorded source; the superset claim must be re-derived',
  );
  for (const pattern of ENGINE_LEXICON_PARITY.machineTime) {
    assert.ok(source.includes(pattern), `the engine no longer carries the recorded machine-time pattern ${pattern}`);
  }
  for (const word of ENGINE_LEXICON_PARITY.shame) {
    assert.ok(source.includes(word), `the engine SHAME_PATTERNS no longer carries ${word}`);
  }
});

test('everything the engine forbids, this module forbids — over a real corpus', () => {
  const engine = new RegExp(ENGINE_LEXICON_PARITY.creationOrTracking, 'i');
  const engineTime = ENGINE_LEXICON_PARITY.machineTime.map((pattern) => new RegExp(pattern, 'i'));
  const engineShame = ENGINE_LEXICON_PARITY.shame.map((word) => new RegExp(`\\b${word}\\b`, 'i'));
  const mine = (text: string) =>
    DEFAULT_COACHING_LEXICONS.trackingVerbs.some((word) => containsToken(text, word)) ||
    DEFAULT_COACHING_LEXICONS.scaffold.some((word) => containsToken(text, word)) ||
    DEFAULT_COACHING_LEXICONS.shame.some((word) => containsToken(text, word)) ||
    DEFAULT_COACHING_LEXICONS.machineTimePatterns.some((pattern) => matchesPattern(text, pattern));

  const corpus = [
    // The three bare stems the inflected list missed entirely.
    'I will save that for you.',
    'I will create that.',
    'I will schedule that.',
    'I save it.',
    'Creating that now.',
    'A reminder is set.',
    'I remind you later.',
    'It is tracked.',
    'I am tracking it.',
    // The machine-time forms, which a word list cannot express.
    'It is due 2026-08-21.',
    'It is due 2026-08-21 at 16:00.',
    'It is due 2026-08-21T16:00:00Z.',
    // Shame, which must remain word-for-word identical.
    'You have been inconsistent.',
    'That is your fault.',
    'You failed to get to it.',
    'You are avoidant.',
    'I am disappointed.',
    'That was lazy.',
    'There is no shame in it.',
    'No guilt here.',
  ];
  for (const text of corpus) {
    const engineSays = engine.test(text) || engineTime.some((p) => p.test(text)) || engineShame.some((p) => p.test(text));
    if (!engineSays) continue;
    assert.ok(mine(text), `the engine forbids this and this module does not: ${text}`);
  }
});

test('the surveillance sentences a template author actually writes are caught', () => {
  // The list previously spelled `watching`, `monitoring`, `noting` and
  // `keeping track` — none of which is what anyone writes. The engine misses
  // most of these too; that is why the superset exists, and why missing them
  // was worse than a parity gap.
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  for (const text of [
    'You closed that one out. I will keep an eye on it.',
    'You closed that one out. I will track it from here.',
    'You closed that one out. I have noted it.',
    'You closed that one out. I will watch the rest.',
    'You closed that one out. I put it on your list.',
    'You closed that one out. I recorded it.',
    'You closed that one out. It is stored now.',
    'You closed that one out. I am monitoring the others.',
    'You closed that one out. I will log it.',
  ]) {
    const mutated = { ...output, sentences: [{ ...output.sentences[0], text }] } as unknown as CoachingOutput;
    assert.ok(
      codesOf(checkCoachingLanguage(mutated, identifiersOf(base))).includes('COMPLETION_DESCRIBED_AS_TRACKING'),
      `a completion described as tracking was not caught: ${text}`,
    );
  }
});

test('a machine-formatted time in prose is caught', () => {
  // The whole argument that `FABRICATED_INSTANT` is unreachable for this
  // producer rests on no time reaching the text.
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  for (const text of ['It is due 2026-08-21.', 'It is due 2026-08-21 at 16:00.', 'Try again at 16:00.']) {
    const mutated = { ...output, sentences: [{ ...output.sentences[0], text }, output.sentences[1]] } as unknown as CoachingOutput;
    assert.ok(
      codesOf(checkCoachingLanguage(mutated, identifiersOf(source))).length > 0,
      `a machine-formatted time was not caught: ${text}`,
    );
  }
});

/**
 * Every word in every lexicon is exercised.
 *
 * 25 of 34 words could be deleted with the suite still green, and all nine
 * `scaffold` entries were exercised by nothing at all. A lexicon nothing probes
 * is a lexicon that can be silently emptied — and the test that *looked* like
 * it pinned `keep an eye on` was in fact being caught by `monitoring` in the
 * same sentence.
 */
test('deleting any single word from any lexicon is detectable', () => {
  for (const key of ['shame', 'scaffold', 'trackingVerbs'] as const) {
    const words = DEFAULT_COACHING_LEXICONS[key];
    assert.ok(words.length > 0, `${key} is empty`);
    for (const word of words) {
      const text = `A sentence carrying ${word} alone.`;
      const withAll = containsToken(text, word);
      assert.ok(withAll, `${key}/${word} does not match its own probe`);
      // The probe must be caught by *this* word and by no other in the list,
      // or its deletion would be masked by a neighbour.
      const others = words.filter((other) => other !== word).filter((other) => containsToken(text, other));
      assert.deepEqual(others, [], `${key}/${word} is masked by ${JSON.stringify(others)}; deleting it would not turn the suite red`);
    }
  }
  for (const pattern of DEFAULT_COACHING_LEXICONS.machineTimePatterns) {
    assert.ok(pattern.length > 0, 'an empty time pattern matches nothing and would pass silently');
  }
});

test('every lexicon word is refused in a real coaching sentence, one at a time', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  for (const key of ['shame', 'scaffold', 'trackingVerbs'] as const) {
    for (const word of DEFAULT_COACHING_LEXICONS[key]) {
      const mutated = {
        ...output,
        sentences: [{ ...output.sentences[0], text: `A sentence carrying ${word} alone.` }, output.sentences[1]],
      } as unknown as CoachingOutput;
      const codes = codesOf(checkCoachingLanguage(mutated, identifiersOf(source)));
      assert.ok(
        codes.includes('FORBIDDEN_LANGUAGE') || codes.includes('COMPLETION_DESCRIBED_AS_TRACKING'),
        `${key}/${word} is in the lexicon and nothing rejects a sentence containing it`,
      );
    }
  }
});

/**
 * Sprint 07's recorded leak, reproduced by the check written to prevent it.
 *
 * `identifiersOf` walked `nodeId` and the actions but never
 * `ObservedEvidence.source`, so a `plan_slot.itemId` reached prose unreported —
 * against a recommendation `checkRecommendation` calls defect-free. The
 * previous fixture passed by coincidence: its node source happened to reuse the
 * same `commitmentId` the action walk already collected.
 */
test('an identifier on a TrustedSource is collected, and reaching prose is caught', () => {
  const leaky = {
    ...soleSurvivor('OVERDUE', 0.9),
    evidence: {
      nodes: [
        {
          ...observed('n-reason', 'fp-reason'),
          source: { kind: 'plan_slot', itemId: 'call-dr-cohen-about-the-biopsy', planDigest: 'digest-secret-value' },
        },
        {
          ...observed('n-basis', 'fp-basis'),
          source: { kind: 'priority_score', commitmentId: 'commitment-gamma', policyVersion: 'policy-secret-version' },
        },
      ],
    },
  } as unknown as Recommendation;
  assert.deepEqual(checkRecommendation(leaky), [], 'the leaky fixture must itself be a valid recommendation');

  const found = identifiersOf(leaky);
  for (const expected of [
    'call-dr-cohen-about-the-biopsy',
    'digest-secret-value',
    'commitment-gamma',
    'policy-secret-version',
    'digest-fixture-one',
  ]) {
    assert.ok(found.includes(expected), `identifiersOf missed ${expected}`);
  }
  // `kind` is deliberately not collected: scanning for it would make the word
  // "commitment" a forbidden substring of ordinary prose.
  assert.equal(found.includes('plan_slot'), false);

  const output = outputFor(soleSurvivor('OVERDUE', 0.9));
  const leaked = {
    ...output,
    sentences: [
      { ...output.sentences[0], text: 'Your call-dr-cohen-about-the-biopsy is the next one.' },
      output.sentences[1],
    ],
  } as unknown as CoachingOutput;
  assert.ok(codesOf(checkCoachingLanguage(leaked, found)).includes('IDENTIFIER_IN_PROSE'));
});

/**
 * The three-case claim shape.
 *
 * `isEvidenceBackedClaim` returns false for a claim with no `source` at all —
 * correctly — and four call sites read `claim.source.verdict` on the `else`
 * branch, raising a `TypeError` out of functions documented never to throw.
 * Neither predicate is a partition; there is a third case.
 */
test('a claim carrying no source is reported, never routed down the echo branch', () => {
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  const noSource = { claimIndex: 0, kind: 'user_completed' } as unknown as CoachingOutput['claims'][number];
  const broken = { ...output, claims: [noSource] } as unknown as CoachingOutput;

  assert.equal(isEvidenceBackedClaim(noSource), false);
  assert.equal(isDecisionEchoClaim(noSource), false, 'the third case must be neither, not silently an echo');

  const defects = checkClaimSupport({ output: broken, recommendation: base, decision });
  assert.ok(codesOf(defects).includes('UNKNOWN_SOURCE_REASON'), `got ${JSON.stringify(codesOf(defects))}`);

  const candidate = toSafetyCandidate(broken, 'candidate-fixed', [decision]);
  assert.equal(candidate.claims[0].kind, 'decision_echo', 'it converts to the blocking kind');
  assert.equal(candidate.claims[0].decisionIndex, null, 'with no attestation, so #39 refuses it');
  assert.equal(candidate.claims[0].echoedVerdict, null, 'and it attributes no act to the user');
});

test('the delivery gate survives a claim carrying no source', () => {
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  const broken = { ...output, claims: [{ claimIndex: 0, kind: 'user_completed' }] } as unknown as CoachingOutput;
  const delivery = deliverCoaching({
    output: broken,
    plan: planOf(output),
    recommendation: base,
    decision,
    candidateId: 'candidate-fixed',
    gate: () => ({ disposition: 'allow', findings: [] }),
  });
  assert.equal(delivery.disposition, 'withheld');
});

/* ── The two MEDIUMs ─────────────────────────────────────────────── */

test('the sentence limit is clamped by the policy, not taken from the plan', () => {
  const source = soleSurvivor('OVERDUE', 0.9);
  const output = outputFor(source);
  const forty = Array.from({ length: 40 }, (_, index) => ({
    sentenceIndex: index,
    text: 'This one is short.',
    templateId: 'lead.effort',
    claimIndices: [index % 2],
  }));
  const defects = checkCoachingOutput(
    { ...output, sentences: forty } as unknown as CoachingOutput,
    { ...planOf(output), maxSentences: 500 } as unknown as CoachingPlan,
  );
  assert.ok(
    codesOf(defects).includes('SENTENCE_LIMIT_EXCEEDED'),
    `a plan claiming maxSentences 500 must not license 40 sentences; got ${JSON.stringify(codesOf(defects))}`,
  );
  assert.equal(COACHING_SENTENCE_POLICY.maxSentences, 2);
});

test('attestation picks the latest matching record, not the first, and refuses a tie', () => {
  // Taking the first made the verdict depend on the order of an array this
  // module does not own: `[accept@0, done@0]` blocked an honest completion and
  // the same two reversed allowed it.
  const base = soleSurvivor();
  const at = (verdict: RecommendationDecision['verdict'], decidedAt: string): RecommendationDecision => ({
    version: RECOMMENDATION_CONTRACT_VERSION,
    recommendationId: base.recommendationId,
    optionIndex: 0,
    verdict,
    decidedAt: decidedAt as RecommendationDecision['decidedAt'],
  });
  const accepted = at('accept', '2026-08-20T09:00:00Z');
  const completed = at('done', '2026-08-20T09:10:00Z');
  const output = outputFor(base, completed);

  for (const order of [[accepted, completed], [completed, accepted]]) {
    const candidate = toSafetyCandidate(output, 'candidate-fixed', order);
    const chosen = order[candidate.claims[0].decisionIndex as number];
    assert.equal(chosen.verdict, 'done', 'the latest act on the option must be the one located, whatever the array order');
  }

  // Two records claiming the same instant for the same option is an ambiguity
  // this module must not resolve by guessing.
  const tied = toSafetyCandidate(output, 'candidate-fixed', [at('accept', '2026-08-20T09:00:00Z'), at('done', '2026-08-20T09:00:00Z')]);
  assert.equal(tied.claims[0].decisionIndex, null);

  // An unparseable timestamp fails closed rather than being ordered arbitrarily.
  const unparseable = toSafetyCandidate(output, 'candidate-fixed', [at('done', 'not-an-instant')]);
  assert.equal(unparseable.claims[0].decisionIndex, null);
});

test('the real gateway still allows the honest turn under the latest-record rule', () => {
  const base = soleSurvivor();
  const accepted: RecommendationDecision = {
    version: RECOMMENDATION_CONTRACT_VERSION,
    recommendationId: base.recommendationId,
    optionIndex: 0,
    verdict: 'accept',
    decidedAt: '2026-08-20T09:00:00Z' as RecommendationDecision['decidedAt'],
  };
  const completed: RecommendationDecision = { ...accepted, verdict: 'done', decidedAt: '2026-08-20T09:10:00Z' as RecommendationDecision['decidedAt'] };
  const output = outputFor(base, completed);
  for (const order of [[accepted, completed], [completed, accepted]]) {
    const candidate = toSafetyCandidate(output, 'candidate-fixed', order);
    const result = evaluateSafetyGate({ request: safetyRequestFor(order), candidate, auditId: 'audit-fixed' });
    assert.equal(
      result.verdict.disposition,
      'allow',
      `array order changed the verdict: ${JSON.stringify(result.verdict.findings.map((one) => one.code))}`,
    );
  }
});

/* ── Robustness: systematic, not hand-picked ─────────────────────── */

/**
 * Every field of a real input, deleted one at a time.
 *
 * The first version of this guard lived in `coachingBoundaries.test.ts` and was
 * a cartesian sweep of shapeless values over every export. It passed — and then
 * passed again with one of the five real defects deliberately reverted, because
 * none of its hand-picked shapes produced the combination that triggers it: a
 * *valid* recommendation beside an output whose claim is an object missing
 * exactly one field. A robustness harness that cannot reproduce the defects it
 * was written for is a harness reporting a strength it does not have, which is
 * the instrument Sprint 08 recorded two tracks catching in the act.
 *
 * So the corpus is generated from the real fixtures rather than imagined:
 * every path in the object tree, each in turn deleted, set to null, and set to
 * a primitive. That is the untyped boundary as it actually arrives — JSON with
 * a field missing — and it is what the five `TypeError`s all were.
 */
function paths(value: unknown, prefix: readonly string[] = [], depth = 0): ReadonlyArray<readonly string[]> {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  const found: Array<readonly string[]> = [];
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const here = [...prefix, key];
    found.push(here);
    found.push(...paths((value as Record<string, unknown>)[key], here, depth + 1));
  }
  return found;
}

function withMutation(root: unknown, path: readonly string[], mode: 'delete' | 'null' | 'primitive'): unknown {
  const copy = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  let cursor: Record<string, unknown> = copy;
  for (let index = 0; index < path.length - 1; index += 1) {
    const next = cursor[path[index]];
    if (next === null || typeof next !== 'object') return copy;
    cursor = next as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (mode === 'delete') delete cursor[leaf];
  else if (mode === 'null') cursor[leaf] = null;
  else cursor[leaf] = 7;
  return copy;
}

test('no entry point throws when any single field of a real input is missing, null, or wrong', () => {
  const base = soleSurvivor('OVERDUE', 0.9);
  const decision = doneDecision(base.recommendationId);
  const echoOutput = outputFor(base, decision);
  const echoPlan = planOf(echoOutput);
  const plainOutput = outputFor(base);
  const plainPlan = planOf(plainOutput);

  const subjects: ReadonlyArray<readonly [string, unknown, (mutated: unknown) => void]> = [
    ['output', plainOutput, (m) => {
      checkClaimSupport({ output: m as CoachingOutput, recommendation: base });
      checkCoachingLanguage(m as CoachingOutput, identifiersOf(base));
      toSafetyCandidate(m as CoachingOutput, 'c', [decision]);
      checkCoachingOutput(m as CoachingOutput, plainPlan);
      deliverCoaching({ output: m as CoachingOutput, plan: plainPlan, recommendation: base, candidateId: 'c', gate: null });
    }],
    ['echo output', echoOutput, (m) => {
      checkClaimSupport({ output: m as CoachingOutput, recommendation: base, decision });
      checkCoachingLanguage(m as CoachingOutput, identifiersOf(base));
      toSafetyCandidate(m as CoachingOutput, 'c', [decision]);
      checkCoachingOutput(m as CoachingOutput, echoPlan);
      deliverCoaching({ output: m as CoachingOutput, plan: echoPlan, recommendation: base, decision, candidateId: 'c', gate: null });
    }],
    ['plan', plainPlan, (m) => {
      checkCoachingPlan(m as CoachingPlan);
      realizeCoachingPlan({ plan: m as CoachingPlan, evidence: base.evidence, basisAt: NOW });
      checkCoachingOutput(plainOutput, m as CoachingPlan);
    }],
    ['recommendation', base, (m) => {
      identifiersOf(m as Recommendation);
      checkClaimSupport({ output: plainOutput, recommendation: m as Recommendation });
      planCoaching({ recommendation: m as Recommendation, locale: 'en', now: NOW, currentFingerprints: {} });
    }],
    ['decision', decision, (m) => {
      checkClaimSupport({ output: echoOutput, recommendation: base, decision: m as RecommendationDecision });
      toSafetyCandidate(echoOutput, 'c', [m as RecommendationDecision]);
      planCoaching({ recommendation: base, decision: m as RecommendationDecision, locale: 'en', now: NOW, currentFingerprints: {} });
    }],
  ];

  const failures: string[] = [];
  let probes = 0;
  for (const [name, root, run] of subjects) {
    for (const path of paths(root)) {
      for (const mode of ['delete', 'null', 'primitive'] as const) {
        probes += 1;
        try {
          run(withMutation(root, path, mode));
        } catch (error) {
          failures.push(`${name}: ${mode} ${path.join('.')} -> ${(error as Error).constructor.name}: ${(error as Error).message.slice(0, 60)}`);
        }
      }
    }
  }
  assert.ok(probes > 400, `the fuzz must actually run; only ${probes} probes`);
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} entry points raised instead of reporting`);
});
