/**
 * The three Sprint 06 tracks, joined and run against each other.
 *
 * #25 (proposal reducer), #26 (dataset and evaluator) and #27 (engine and
 * validator) were built in parallel against contracts written first, so each
 * was verified only against its own reading of them. Sprints 02-05 each showed
 * that is not enough, and this sprint had the sharper version of the problem:
 * #26 and #27 both decide what counts as a *violation*, from the same contract,
 * without ever importing each other. Two self-consistent readings would leave
 * both suites green and the disagreement invisible.
 *
 * So the checks here are deliberately not "does each track work". They are:
 * do the two independent implementations of the shared vocabulary return the
 * same answer on the same input, and does the path the sprint exists to build —
 * text becomes a proposal, a proposal is ruled on, a ruling becomes steps —
 * hold end to end. No single track can test either.
 *
 * This file is owned by the merge, not by a track, for the reason Sprint 05
 * gave the policy-freeze test to the merge: a check owned by the thing it
 * checks is not a check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DECOMPOSITION_GOLDEN, goldenById } from '../fixtures/decompositionGolden.ts';
import { validateDecomposition } from '../../lib/decomposition/engine/validator.ts';
import { proposeDecomposition } from '../../lib/decomposition/engine/index.ts';
import { validateDecompositionExample } from '../../lib/decomposition/evaluation/example.ts';
import { reduceStepDecisions, finalizeProposalState, resolveConfirmedSteps } from '../../lib/decomposition/proposal/proposalStateMachine.ts';
import { INTELLIGENCE_MODULES, INTELLIGENCE_MODULE_CONTRACTS } from '../../src/contracts/v1/moduleContracts.ts';
import { DECOMPOSITION_SCHEMA_VERSION } from '../../src/contracts/v1/decompositionContracts.ts';
import type {
  DecompositionExample,
  DecompositionStepProposal,
  DecompositionViolationCode,
} from '../../src/contracts/v1/decompositionContracts.ts';

/** Codes decidable from a step list alone — the surface both tracks implement. */
const SHARED_STRUCTURAL_CODES: readonly DecompositionViolationCode[] = [
  'EMPTY_STEP',
  'CONJUNCTION_ONLY',
  'SPAN_MISMATCH',
  'SPAN_OUT_OF_RANGE',
  'SPAN_OVERLAP',
  'INVENTED_TIMING',
  'INVENTED_OWNER',
  'INFERRED_WITH_SPAN',
  'UNSOURCED_STEP',
  'DUPLICATE_STEP_ID',
  'UNKNOWN_DEPENDENCY',
  'CYCLIC_DEPENDENCY',
  'SELF_DEPENDENCY',
];

function codesFromValidator(sourceText: string, steps: readonly DecompositionStepProposal[]): string[] {
  return validateDecomposition({ sourceText, steps })
    .map((violation) => violation.code)
    .filter((code) => SHARED_STRUCTURAL_CODES.includes(code))
    .sort();
}

function codesFromEvaluator(example: DecompositionExample): string[] {
  return validateDecompositionExample(example).violations
    .map((violation) => violation.code)
    .filter((code) => SHARED_STRUCTURAL_CODES.includes(code as DecompositionViolationCode))
    .sort();
}

/** An example carrying `steps` as its ground truth, for feeding the evaluator. */
function exampleWith(base: DecompositionExample, steps: readonly DecompositionStepProposal[]): DecompositionExample {
  return { ...base, label: 'multi_step', expectedSteps: steps };
}

const HOST = goldenById('en-multi-wedding');

function baseSteps(): DecompositionStepProposal[] {
  return HOST.expectedSteps.map((step) => ({ ...step }));
}

/* ── The vocabulary agreement ────────────────────────────────────── */

test('cross-track: validator and evaluator agree that the golden ground truth is clean', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    if (example.expectedSteps.length === 0) continue;
    const fromValidator = codesFromValidator(example.sourceText, example.expectedSteps);
    const fromEvaluator = codesFromEvaluator(example);
    assert.deepEqual(fromValidator, [], `${example.exampleId}: #27 validator found ${fromValidator.join(',')}`);
    assert.deepEqual(fromEvaluator, [], `${example.exampleId}: #26 evaluator found ${fromEvaluator.join(',')}`);
  }
});

/**
 * One malformed proposal per shared code, run through both implementations.
 *
 * This is the check the sprint was designed around. Each case is built once and
 * handed to both tracks; the assertion is not that a particular code appears
 * but that the two independently-written implementations return the *same set*.
 */
const DIVERGENCE_CASES: ReadonlyArray<{
  readonly name: string;
  readonly mutate: (steps: DecompositionStepProposal[]) => DecompositionStepProposal[];
}> = [
  {
    name: 'EMPTY_STEP — a whitespace title',
    mutate: (steps) => [{ ...steps[0], title: '   ' }, steps[1], steps[2]],
  },
  {
    name: 'CONJUNCTION_ONLY — a title that is only a connective',
    mutate: (steps) => [{ ...steps[0], title: 'and' }, steps[1], steps[2]],
  },
  {
    name: 'SPAN_MISMATCH — text that is not what the offsets select',
    mutate: (steps) => [
      { ...steps[0], sourceSpans: [{ start: 0, end: 14, text: 'Cancel the venue' }] },
      steps[1],
      steps[2],
    ],
  },
  {
    name: 'SPAN_OUT_OF_RANGE — a span past the end of the text',
    mutate: (steps) => [
      { ...steps[0], sourceSpans: [{ start: 0, end: 9999, text: 'Book the venue' }] },
      steps[1],
      steps[2],
    ],
  },
  {
    name: 'SPAN_OUT_OF_RANGE — a degenerate empty range',
    mutate: (steps) => [{ ...steps[0], sourceSpans: [{ start: 5, end: 5, text: '' }] }, steps[1], steps[2]],
  },
  {
    name: 'SPAN_OVERLAP — two steps claiming the same words',
    mutate: (steps) => [steps[0], { ...steps[1], sourceSpans: [{ ...steps[0].sourceSpans[0] }] }, steps[2]],
  },
  {
    name: 'SPAN_OVERLAP — one step claiming its own words twice',
    mutate: (steps) => [
      { ...steps[0], sourceSpans: [steps[0].sourceSpans[0], { start: 5, end: 14, text: 'the venue' }] },
      steps[1],
      steps[2],
    ],
  },
  {
    name: 'INVENTED_TIMING — a time the source never states',
    mutate: (steps) => [{ ...steps[0], statedTiming: 'next Tuesday' }, steps[1], steps[2]],
  },
  {
    name: 'INVENTED_OWNER — an owner the source never names',
    mutate: (steps) => [{ ...steps[0], statedOwner: 'Layla' }, steps[1], steps[2]],
  },
  {
    name: 'INFERRED_WITH_SPAN — claims to be inferred while citing text',
    mutate: (steps) => [{ ...steps[0], inferred: true }, steps[1], steps[2]],
  },
  {
    name: 'UNSOURCED_STEP — no span and no admission',
    mutate: (steps) => [{ ...steps[0], sourceSpans: [] }, steps[1], steps[2]],
  },
  {
    name: 'DUPLICATE_STEP_ID — two steps sharing an id',
    mutate: (steps) => [steps[0], { ...steps[1], stepId: steps[0].stepId }, steps[2]],
  },
  {
    name: 'UNKNOWN_DEPENDENCY — an edge to no step here',
    mutate: (steps) => [
      { ...steps[0], dependsOn: [{ dependsOnStepId: 'ghost', kind: 'temporal' as const }] },
      steps[1],
      steps[2],
    ],
  },
  {
    name: 'SELF_DEPENDENCY — a step depending on itself, and not also cyclic',
    mutate: (steps) => [
      { ...steps[0], dependsOn: [{ dependsOnStepId: steps[0].stepId, kind: 'temporal' as const }] },
      steps[1],
      steps[2],
    ],
  },
  {
    name: 'CYCLIC_DEPENDENCY — a two-step cycle',
    mutate: (steps) => [
      { ...steps[0], dependsOn: [{ dependsOnStepId: steps[1].stepId, kind: 'temporal' as const }] },
      { ...steps[1], dependsOn: [{ dependsOnStepId: steps[0].stepId, kind: 'temporal' as const }] },
      steps[2],
    ],
  },
];

for (const testCase of DIVERGENCE_CASES) {
  test(`cross-track: both tracks report the same codes for ${testCase.name}`, () => {
    const steps = testCase.mutate(baseSteps());
    const fromValidator = codesFromValidator(HOST.sourceText, steps);
    const fromEvaluator = codesFromEvaluator(exampleWith(HOST, steps));

    assert.deepEqual(
      fromEvaluator,
      fromValidator,
      `#26 evaluator said [${fromEvaluator.join(',')}], #27 validator said [${fromValidator.join(',')}]`,
    );
    assert.ok(fromValidator.length > 0, 'the case should be a violation at all');
  });
}

/**
 * Cardinality, not just membership.
 *
 * `codesFrom*` deliberately does not de-duplicate, so a track emitting one
 * violation per participating step rather than one per cycle shows up as a
 * longer list. That is how the divergence was found; asserting it here makes
 * the property deliberate rather than a side effect of how the helper is
 * written.
 */
test('cross-track: a three-step cycle is one defect in both tracks, not three', () => {
  const steps = baseSteps();
  const ring = [
    { ...steps[0], dependsOn: [{ dependsOnStepId: steps[1].stepId, kind: 'temporal' as const }] },
    { ...steps[1], dependsOn: [{ dependsOnStepId: steps[2].stepId, kind: 'temporal' as const }] },
    { ...steps[2], dependsOn: [{ dependsOnStepId: steps[0].stepId, kind: 'temporal' as const }] },
  ];
  assert.deepEqual(codesFromValidator(HOST.sourceText, ring), ['CYCLIC_DEPENDENCY']);
  assert.deepEqual(codesFromEvaluator(exampleWith(HOST, ring)), ['CYCLIC_DEPENDENCY']);

  const proposalLevel = validateDecomposition({ sourceText: HOST.sourceText, steps: ring })
    .filter((violation) => violation.code === 'CYCLIC_DEPENDENCY');
  assert.equal(proposalLevel.length, 1);
  assert.equal(proposalLevel[0].stepId, null, 'a cycle belongs to the proposal, not to one of its steps');
});

test('cross-track: a self-edge earns exactly one code, in both tracks', () => {
  const steps = baseSteps();
  const mutated = [
    { ...steps[0], dependsOn: [{ dependsOnStepId: steps[0].stepId, kind: 'temporal' as const }] },
    steps[1],
    steps[2],
  ];
  assert.deepEqual(codesFromValidator(HOST.sourceText, mutated), ['SELF_DEPENDENCY']);
  assert.deepEqual(codesFromEvaluator(exampleWith(HOST, mutated)), ['SELF_DEPENDENCY']);
});

/* ── The path the sprint exists to build ─────────────────────────── */

test('cross-track: engine output is accepted by the reducer and survives to confirmed steps', async () => {
  const source = goldenById('ar-multi-wedding').sourceText;
  const proposal = await proposeDecomposition({ proposalId: 'p-x', commitmentId: 'c-x', sourceText: source }, {});
  assert.equal(proposal.outcome, 'decomposed', 'the Arabic clitic row must still decompose');
  if (proposal.outcome !== 'decomposed') return;

  // #27's own validator finds nothing, and so does #26's, independently.
  assert.deepEqual(codesFromValidator(source, proposal.steps), []);
  assert.deepEqual(codesFromEvaluator(exampleWith(goldenById('ar-multi-wedding'), proposal.steps)), []);

  // #25's reducer accepts what #27 produced, with an explicit ruling per step.
  const decisions = proposal.steps.map((step, index) =>
    index === 1
      ? ({ stepId: step.stepId, verdict: 'reject' } as const)
      : ({ stepId: step.stepId, verdict: 'accept' } as const),
  );
  const state = finalizeProposalState(reduceStepDecisions(proposal, decisions));
  assert.equal(state.failure, null, 'the reducer rejected a proposal its own engine produced');
  const resolved = resolveConfirmedSteps(state);
  assert.equal(resolved.confirmed.length, 2);
  assert.equal(resolved.rejectedStepIds.length, 1);

  // Spans survive the round trip: what is confirmed still points at the words it came from.
  for (const step of resolved.confirmed) {
    for (const span of step.step.sourceSpans) {
      assert.equal(source.slice(span.start, span.end), span.text);
    }
  }
});

test('cross-track: a step the user never ruled on cannot become a confirmed step', async () => {
  const source = goldenById('en-multi-wedding').sourceText;
  const proposal = await proposeDecomposition({ proposalId: 'p-y', commitmentId: 'c-y', sourceText: source }, {});
  assert.equal(proposal.outcome, 'decomposed');
  if (proposal.outcome !== 'decomposed') return;

  const partial = proposal.steps
    .slice(0, proposal.steps.length - 1)
    .map((step) => ({ stepId: step.stepId, verdict: 'accept' } as const));
  const state = finalizeProposalState(reduceStepDecisions(proposal, partial));
  const resolved = resolveConfirmedSteps(state);

  assert.equal(state.failure?.code, 'incomplete_decisions');
  assert.equal(resolved.confirmed.length, 0, 'an omitted ruling let steps through');
});

test('cross-track: what the engine refuses to split, the corpus also calls unsplittable', async () => {
  for (const example of DECOMPOSITION_GOLDEN.filter((row) => row.label === 'do_not_split')) {
    const proposal = await proposeDecomposition(
      { proposalId: `p-${example.exampleId}`, commitmentId: 'c', sourceText: example.sourceText },
      {},
    );
    assert.notEqual(
      proposal.outcome,
      'decomposed',
      `${example.exampleId}: the engine split a row the corpus labels do_not_split`,
    );
  }
});

/* ── Module registration ─────────────────────────────────────────── */

test('cross-track: decomposition is a registered runtime module, not a borrowed one', () => {
  assert.ok(INTELLIGENCE_MODULES.includes('decomposition'));
  const descriptor = INTELLIGENCE_MODULE_CONTRACTS.decomposition;
  assert.equal(descriptor.module, 'decomposition');
  assert.equal(descriptor.allowsDirectStateWrites, false);
});

test('cross-track: the decomposition module descriptor matches the decomposition schema version', async () => {
  const result = await INTELLIGENCE_MODULE_CONTRACTS.decomposition.execute({
    provenance: { traceId: 't', producedAt: '2026-08-19T00:00:00.000Z', source: 'system', confidence: null },
    input: {},
  } as never);
  assert.equal(result.ok, true);
  const output = result.ok ? (result.output as { schemaVersion: string }) : { schemaVersion: '' };
  // `moduleContracts` spells this literal out to avoid an import cycle that
  // throws at runtime while typechecking clean; this is what keeps the two
  // spellings from drifting apart.
  assert.equal(output.schemaVersion, DECOMPOSITION_SCHEMA_VERSION);
});
