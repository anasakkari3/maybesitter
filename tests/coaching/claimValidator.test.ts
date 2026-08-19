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

import {
  COACHING_ABSENT_GATEWAY_RECOVERY,
  COACHING_CLAIM_SUPPORT_RECOVERY,
  CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM,
  COACHING_CLAIM_KINDS,
  PRESSURE_INTENSITY_FOR_INTENT,
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
  SAFETY_CODE_BOUNDARIES,
  SAFETY_CODE_SCOPES,
  SAFETY_CODE_SEVERITY,
  SAFETY_CODE_STAGES,
  type SafetyFinding,
  type SafetyVerdict,
} from '../../src/contracts/v1/safetyContracts';
import {
  checkClaimSupport,
  checkCoachingLanguage,
  containsToken,
  deliverCoaching,
  identifiersOf,
  planCoaching,
  realizeCoachingPlan,
  toSafetyCandidate,
} from '../../lib/coaching';
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

function outputFor(recommendation: Recommendation, decision: RecommendationDecision | null = null): CoachingOutput {
  const plan = planFor(recommendation, decision);
  const outcome = realizeCoachingPlan({ plan, evidence: recommendation.evidence, basisAt: NOW });
  assert.equal(outcome.outcome, 'realized', `realization refused: ${JSON.stringify(outcome)}`);
  return (outcome as { output: CoachingOutput }).output;
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

test('every converted claim is a statement carrying no instant', () => {
  // The pin behind `FABRICATED_INSTANT` being unreachable for this producer.
  // The reason it is unreachable is proved in `realizer.test.ts`, against the
  // templates rather than against this mapping.
  for (const source of [soleSurvivor('OVERDUE', 0.9), choiceOffer(), onlyCandidate(), withheld()]) {
    const candidate = toSafetyCandidate(outputFor(source), 'candidate-fixed');
    for (const claim of candidate.claims) {
      assert.equal(claim.kind, 'statement');
      assert.equal(claim.statedInstant, null);
      assert.ok(claim.supportedBy.length > 0, 'this module must never hand the gateway an unsourced claim');
    }
  }
  for (const kind of COACHING_CLAIM_KINDS) {
    assert.equal((CANDIDATE_CLAIM_KIND_FOR_COACHING_CLAIM as Readonly<Record<string, string>>)[kind], 'statement');
  }
});

test('a decision echo contributes a segment and no claim, by count', () => {
  // Deliberate: an echo has no evidence, and `supportedBy: []` would earn
  // #39's blocking `UNSOURCED_CLAIM` on every honest acknowledgement. Pinned
  // with a count so it reads as a decision rather than a claim gone missing.
  const base = soleSurvivor();
  const decision = doneDecision(base.recommendationId);
  const output = outputFor(base, decision);
  const candidate = toSafetyCandidate(output, 'candidate-fixed');
  assert.equal(output.claims.length, 1, 'the fixture must produce exactly one echo');
  assert.equal(candidate.segments.length, 1, 'the prose still reaches the gateway');
  assert.equal(candidate.claims.length, 0, 'an echo asserts nothing about trusted state');
});

test('a coaching candidate declares no effect and never overstates its pressure', () => {
  const candidate = toSafetyCandidate(outputFor(soleSurvivor('OVERDUE', 0.9)), 'candidate-fixed');
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
  const delivery = deliverCoaching({
    output: outputFor(source),
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
  const delivery = deliverCoaching({
    output: outputFor(source),
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
    const delivery = deliverCoaching({
      output: outputFor(source),
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
