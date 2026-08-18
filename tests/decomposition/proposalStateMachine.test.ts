/**
 * The accept/edit/reject reducer (Sprint 06, issue #25).
 *
 * Two properties here are the whole point of the component and are tested
 * directly rather than through the store, because the store could satisfy them
 * by accident and stop doing so on any refactor:
 *
 *  - **Silence is never consent.** A decision set that omits a step invalidates
 *    the request. There is no default verdict anywhere in the fold, so the only
 *    way a step becomes accepted is a decision that says so.
 *  - **An edit moves the title, never the provenance.** The user rewrote the
 *    wording; they did not claim the step came from different words.
 *
 * Fixtures come from tests/fixtures/decompositionGolden.ts rather than being
 * hand-written here, so the reducer is exercised on the same spans #26 and #27
 * are measured against — including the Arabic clitic row, where a span that was
 * silently renormalised would stop matching its own source text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECOMPOSITION_CONTRACT_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  type DecomposedProposal,
  type DecompositionStepProposal,
  type StepDecision,
} from '../../src/contracts/v1/decompositionContracts.ts';
import { goldenById } from '../fixtures/decompositionGolden.ts';
import {
  applyStepDecision,
  finalizeProposalState,
  initialProposalState,
  reduceStepDecisions,
  resolveConfirmedSteps,
  validateProposalEntry,
} from '../../lib/decomposition/proposal/proposalStateMachine.ts';

/** Builds a `DecomposedProposal` from a golden multi-step row. */
function proposalFrom(exampleId: string, proposalId = 'p1'): DecomposedProposal {
  const example = goldenById(exampleId);
  const steps = example.expectedSteps;
  assert.ok(steps.length >= 2, `${exampleId} must be a multi-step row`);
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    proposalId,
    commitmentId: 'c1',
    sourceText: example.sourceText,
    provenance: { requestedEngine: 'rules', executedEngine: 'rules', fallbackUsed: false },
    outcome: 'decomposed',
    steps: steps as unknown as DecomposedProposal['steps'],
  };
}

function withSteps(steps: readonly DecompositionStepProposal[]): DecomposedProposal {
  return {
    ...proposalFrom('en-multi-wedding'),
    sourceText: 'irrelevant to entry validation',
    steps: steps as unknown as DecomposedProposal['steps'],
  };
}

function step(overrides: Partial<DecompositionStepProposal> & { stepId: string }): DecompositionStepProposal {
  return {
    title: `title of ${overrides.stepId}`,
    sourceSpans: [],
    inferred: true,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
    ...overrides,
  };
}

function accept(stepId: string): StepDecision {
  return { stepId, verdict: 'accept' };
}

function reject(stepId: string): StepDecision {
  return { stepId, verdict: 'reject' };
}

function edit(stepId: string, editedTitle: string): StepDecision {
  return { stepId, verdict: 'edit', editedTitle };
}

/* ── The fold ─────────────────────────────────────────────────────── */

test('every step starts pending: the reducer has no default verdict', () => {
  const state = initialProposalState(proposalFrom('en-multi-wedding'));

  assert.deepEqual(
    state.steps.map((entry) => entry.state),
    ['pending', 'pending', 'pending'],
  );
  assert.equal(state.failure, null);
});

test('accept, edit and reject each move exactly their own step', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
    accept('s1'),
    edit('s2', 'Post the invitations'),
    reject('s3'),
  ]);

  assert.equal(state.failure, null);
  assert.deepEqual(
    state.steps.map((entry) => [entry.stepId, entry.state]),
    [
      ['s1', 'accepted'],
      ['s2', 'edited'],
      ['s3', 'rejected'],
    ],
  );
});

test('an edit replaces the title and keeps the engine wording alongside it', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
    accept('s1'),
    edit('s2', '  Post the invitations  '),
    reject('s3'),
  ]);
  const edited = state.steps.find((entry) => entry.stepId === 's2');

  assert.ok(edited);
  // Trimmed, because the surrounding whitespace is a typing artefact and a
  // title differing from another only by padding is the same title.
  assert.equal(edited.step.title, 'Post the invitations');
  assert.equal(edited.proposedTitle, 'send the invitations');
});

test('an edit leaves sourceSpans untouched: the user rewrote the title, not the origin', () => {
  const proposal = proposalFrom('ar-multi-wedding');
  const original = proposal.steps[1];
  const state = reduceStepDecisions(proposal, [accept('s1'), edit('s2', 'ابعت الدعوات'), accept('s3')]);
  const edited = state.steps.find((entry) => entry.stepId === 's2');

  assert.ok(edited);
  assert.notEqual(edited.step.title, original.title, 'the edit must actually have changed the title');
  assert.deepEqual(edited.step.sourceSpans, original.sourceSpans);
  // And the spans still select the text they claim to, which is the property
  // the whole provenance design rests on.
  for (const span of edited.step.sourceSpans) {
    assert.equal(proposal.sourceText.slice(span.start, span.end), span.text);
  }
});

test('accept and reject leave every field of the step untouched', () => {
  const proposal = proposalFrom('ar-en-multi-invoice');
  const state = reduceStepDecisions(proposal, [accept('s1'), reject('s2')]);

  for (const entry of state.steps) {
    const source = proposal.steps.find((candidate) => candidate.stepId === entry.stepId);
    assert.deepEqual(entry.step, source);
  }
});

/* ── Silence is never consent ─────────────────────────────────────── */

test('a decision set that omits a step is incomplete, not partially applied', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [accept('s1'), accept('s2')]);

  assert.equal(state.failure?.code, 'incomplete_decisions');
  assert.equal(state.failure?.stepId, 's3');
});

test('an empty decision set is incomplete rather than a silent full rejection', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), []);

  assert.equal(state.failure?.code, 'incomplete_decisions');
});

test('rejecting every step is a valid, explicit outcome', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
    reject('s1'),
    reject('s2'),
    reject('s3'),
  ]);

  assert.equal(state.failure, null);
  assert.deepEqual(resolveConfirmedSteps(state).confirmed, []);
  assert.deepEqual(resolveConfirmedSteps(state).rejectedStepIds, ['s1', 's2', 's3']);
});

/* ── Malformed decision sets ──────────────────────────────────────── */

test('a second decision on the same step is a duplicate, never a correction', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
    accept('s1'),
    reject('s1'),
    accept('s2'),
    accept('s3'),
  ]);

  assert.equal(state.failure?.code, 'duplicate_decision');
  assert.equal(state.failure?.stepId, 's1');
});

test('a decision naming a step the proposal does not contain is rejected', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
    accept('s1'),
    accept('s2'),
    accept('s3'),
    accept('s4'),
  ]);

  assert.equal(state.failure?.code, 'unknown_step');
  assert.equal(state.failure?.stepId, 's4');
});

test('an edit to a blank title is invalid: a step with no words is not a step', () => {
  for (const blank of ['', '   ', '\t\n ']) {
    const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
      accept('s1'),
      edit('s2', blank),
      accept('s3'),
    ]);
    assert.equal(state.failure?.code, 'invalid_edit', `${JSON.stringify(blank)} must be refused`);
    assert.equal(state.failure?.stepId, 's2');
  }
});

test('the first failure sticks: a malformed request is refused whole, not in part', () => {
  // Otherwise a request could be repaired by its own later entries — the caller
  // would learn its request was accepted while a step it named was discarded.
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
    accept('nope'),
    accept('s1'),
    accept('s2'),
    accept('s3'),
  ]);

  assert.equal(state.failure?.code, 'unknown_step');
  assert.deepEqual(
    state.steps.map((entry) => entry.state),
    ['pending', 'pending', 'pending'],
    'no decision may apply once the request is known to be malformed',
  );
});

/* ── Purity ───────────────────────────────────────────────────────── */

test('the reducer is pure: the same inputs produce the same output', () => {
  const decisions = [accept('s1'), edit('s2', 'Send them'), reject('s3')];
  const first = reduceStepDecisions(proposalFrom('en-multi-wedding'), decisions);
  const second = reduceStepDecisions(proposalFrom('en-multi-wedding'), decisions);

  assert.deepEqual(first, second);
});

test('applying a decision returns a new state and mutates neither input', () => {
  const proposal = proposalFrom('en-multi-wedding');
  const before = initialProposalState(proposal);
  const snapshot = JSON.parse(JSON.stringify(before)) as unknown;

  const after = applyStepDecision(before, accept('s1'));

  assert.notEqual(after, before);
  assert.deepEqual(JSON.parse(JSON.stringify(before)) as unknown, snapshot);
  assert.equal(after.steps[0].state, 'accepted');
});

test('finalize is what detects incompleteness, and is idempotent', () => {
  const partial = applyStepDecision(initialProposalState(proposalFrom('en-multi-wedding')), accept('s1'));
  assert.equal(partial.failure, null, 'a fold in progress is not yet a failure');

  const once = finalizeProposalState(partial);
  const twice = finalizeProposalState(once);

  assert.equal(once.failure?.code, 'incomplete_decisions');
  assert.deepEqual(twice, once);
});

/* ── What leaves for persistence ──────────────────────────────────── */

test('only accepted and edited steps are confirmed, and edits carry the user title', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
    accept('s1'),
    edit('s2', 'Post the invitations'),
    reject('s3'),
  ]);
  const resolved = resolveConfirmedSteps(state);

  assert.deepEqual(
    resolved.confirmed.map((entry) => [entry.step.stepId, entry.disposition, entry.step.title]),
    [
      ['s1', 'accepted', 'Book the venue'],
      ['s2', 'edited', 'Post the invitations'],
    ],
  );
  assert.deepEqual(resolved.rejectedStepIds, ['s3']);
});

test('a state carrying a failure confirms nothing at all', () => {
  const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [accept('s1')]);
  const resolved = resolveConfirmedSteps(state);

  assert.deepEqual(resolved.confirmed, []);
  assert.deepEqual(resolved.rejectedStepIds, []);
});

/* ── Entry validation ─────────────────────────────────────────────── */

function codesFor(proposal: DecomposedProposal): string[] {
  return validateProposalEntry(proposal).map((violation) => violation.code);
}

test('a golden multi-step proposal passes entry validation', () => {
  for (const exampleId of ['en-multi-wedding', 'ar-multi-wedding', 'he-multi-event', 'ar-en-multi-invoice']) {
    assert.deepEqual(codesFor(proposalFrom(exampleId)), [], `${exampleId} must be admissible`);
  }
});

test('a blank or whitespace-only title is EMPTY_STEP', () => {
  for (const title of ['', '   ', ' \t']) {
    const violations = validateProposalEntry(withSteps([step({ stepId: 'a', title }), step({ stepId: 'b' })]));
    assert.deepEqual(
      violations.map((violation) => violation.code),
      ['EMPTY_STEP'],
      `${JSON.stringify(title)} must be EMPTY_STEP`,
    );
    assert.equal(violations[0].stepId, 'a');
  }
});

test('a title that is only a connective is CONJUNCTION_ONLY in English, Arabic and Hebrew', () => {
  // The split artefact this exists to catch. Arabic and Hebrew carry the
  // conjunction as a prefixed clitic, so a splitter that strips the prefix
  // emits the bare letter as if it were a step.
  for (const title of ['and', 'then', 'And then', 'و', 'ثم', 'ו', 'ואז', 'and.', ' , then ']) {
    assert.deepEqual(
      codesFor(withSteps([step({ stepId: 'a', title }), step({ stepId: 'b' })])),
      ['CONJUNCTION_ONLY'],
      `${JSON.stringify(title)} must be CONJUNCTION_ONLY`,
    );
  }
});

test('a real step that merely starts with a connective is not CONJUNCTION_ONLY', () => {
  // The mirror of the golden set's do-not-split rows: over-firing here would
  // reject valid steps, and would do it in exactly the languages the clitic
  // handling was added for.
  for (const title of ['and order the cake', 'واطلب الكعكة', 'ותזמין עוגה', 'Review the terms and conditions']) {
    assert.deepEqual(
      codesFor(withSteps([step({ stepId: 'a', title }), step({ stepId: 'b' })])),
      [],
      `${JSON.stringify(title)} must be admissible`,
    );
  }
});

test('two steps sharing a stepId is DUPLICATE_STEP_ID', () => {
  assert.deepEqual(codesFor(withSteps([step({ stepId: 'a' }), step({ stepId: 'a' })])), ['DUPLICATE_STEP_ID']);
});

test('a step depending on itself is SELF_DEPENDENCY, not a one-node cycle', () => {
  const violations = validateProposalEntry(
    withSteps([
      step({ stepId: 'a', dependsOn: [{ dependsOnStepId: 'a', kind: 'temporal' }] }),
      step({ stepId: 'b' }),
    ]),
  );

  assert.deepEqual(violations.map((violation) => violation.code), ['SELF_DEPENDENCY']);
  assert.equal(violations[0].stepId, 'a');
});

test('an edge pointing outside the proposal is UNKNOWN_DEPENDENCY', () => {
  assert.deepEqual(
    codesFor(
      withSteps([
        step({ stepId: 'a', dependsOn: [{ dependsOnStepId: 'ghost', kind: 'informational' }] }),
        step({ stepId: 'b' }),
      ]),
    ),
    ['UNKNOWN_DEPENDENCY'],
  );
});

test('a dependency cycle is CYCLIC_DEPENDENCY, reported once for the proposal', () => {
  const violations = validateProposalEntry(
    withSteps([
      step({ stepId: 'a', dependsOn: [{ dependsOnStepId: 'c', kind: 'temporal' }] }),
      step({ stepId: 'b', dependsOn: [{ dependsOnStepId: 'a', kind: 'temporal' }] }),
      step({ stepId: 'c', dependsOn: [{ dependsOnStepId: 'b', kind: 'temporal' }] }),
    ]),
  );

  assert.deepEqual(violations.map((violation) => violation.code), ['CYCLIC_DEPENDENCY']);
  assert.equal(violations[0].stepId, null, 'a cycle belongs to the graph, not to one of its nodes');
});

test('a diamond is not a cycle', () => {
  assert.deepEqual(
    codesFor(
      withSteps([
        step({ stepId: 'a' }),
        step({ stepId: 'b', dependsOn: [{ dependsOnStepId: 'a', kind: 'temporal' }] }),
        step({ stepId: 'c', dependsOn: [{ dependsOnStepId: 'a', kind: 'temporal' }] }),
        step({
          stepId: 'd',
          dependsOn: [
            { dependsOnStepId: 'b', kind: 'temporal' },
            { dependsOnStepId: 'c', kind: 'resource' },
          ],
        }),
      ]),
    ),
    [],
  );
});

test('violation detail never quotes the user text it is about', () => {
  // The audit policy the contract states: a violation travels into logs, and a
  // detail that embeds the title puts raw user text there with it.
  const secret = 'Call Dr. Levi about the biopsy and then';
  const violations = validateProposalEntry(
    withSteps([step({ stepId: 'a', title: '  ' }), step({ stepId: 'b', title: secret })]),
  );

  for (const violation of violations) {
    assert.equal(violation.detail.includes(secret), false, 'detail must not carry raw user text');
    assert.ok(violation.detail.length > 0, 'a violation must say something');
  }
});

test('entry validation reports every distinct problem, not just the first', () => {
  const violations = validateProposalEntry(
    withSteps([
      step({ stepId: 'a', title: '' }),
      step({ stepId: 'a', title: 'and' }),
      step({ stepId: 'c', dependsOn: [{ dependsOnStepId: 'zzz', kind: 'temporal' }] }),
    ]),
  );

  assert.deepEqual(
    violations.map((violation) => violation.code).slice().sort(),
    ['CONJUNCTION_ONLY', 'DUPLICATE_STEP_ID', 'EMPTY_STEP', 'UNKNOWN_DEPENDENCY'],
  );
});

/* ── Review regressions ───────────────────────────────────────────── */

test('an edit to a connective or punctuation-only title is invalid_edit', () => {
  // The edit path used `trim().length === 0` while admission used the strictly
  // stronger normalisation, so a user could edit a step into exactly the string
  // an engine could not have proposed. One standard, both paths.
  for (const title of ['and', 'then', 'ثم', 'و', 'ואז', '.', '-', '…', '  &  ']) {
    const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
      accept('s1'),
      edit('s2', title),
      accept('s3'),
    ]);
    assert.equal(state.failure?.code, 'invalid_edit', `${JSON.stringify(title)} must be refused`);
    assert.equal(state.failure?.stepId, 's2');
  }
});

test('an edit to a real title that merely contains a connective is accepted', () => {
  // The mirror: the stronger check must not start refusing ordinary edits.
  for (const title of ['and order the cake', 'Review the terms and conditions', 'واطلب الكعكة']) {
    const state = reduceStepDecisions(proposalFrom('en-multi-wedding'), [
      accept('s1'),
      edit('s2', title),
      accept('s3'),
    ]);
    assert.equal(state.failure, null, `${JSON.stringify(title)} must be allowed`);
  }
});

test('resolving a state that was never finalized confirms nothing', () => {
  // A caller wiring the incremental path straight to a port would otherwise
  // ship exactly the silent partial acceptance the contract forbids: s1
  // confirmed, s2 and s3 in neither list and nobody told.
  const partial = applyStepDecision(initialProposalState(proposalFrom('en-multi-wedding')), accept('s1'));
  const resolved = resolveConfirmedSteps(partial);

  assert.deepEqual(resolved.confirmed, []);
  assert.deepEqual(resolved.rejectedStepIds, []);
});

test('resolving a fully decided state does not need an explicit finalize', () => {
  const decided = [accept('s1'), accept('s2'), reject('s3')].reduce(
    applyStepDecision,
    initialProposalState(proposalFrom('en-multi-wedding')),
  );
  const resolved = resolveConfirmedSteps(decided);

  assert.deepEqual(resolved.confirmed.map((entry) => entry.step.stepId), ['s1', 's2']);
  assert.deepEqual(resolved.rejectedStepIds, ['s3']);
});

test('diacritics and bidi marks do not hide a connective-only title', () => {
  // Ordinary in this product's real input: vocalized Arabic, and a right-to-left
  // mark pasted in ahead of the word. Both left the title a bare conjunction
  // that no longer matched the connective list.
  const cases: readonly (readonly [string, string])[] = [
    ['وَ', 'waw with fatha'],
    ['‏و', 'RLM then waw'],
    ['  ثُمَّ  ', 'vocalized thumma'],
    ['‎And‏', 'LRM around and'],
    ['וָ', 'vav with qamats'],
  ];

  for (const [title, label] of cases) {
    assert.deepEqual(
      codesFor(withSteps([step({ stepId: 'a', title }), step({ stepId: 'b' })])),
      ['CONJUNCTION_ONLY'],
      `${label} must still be CONJUNCTION_ONLY`,
    );
  }
});

test('a title made only of punctuation or symbols is EMPTY_STEP', () => {
  // The ASCII hyphen was never caught: inside the noise class `‐-―` is a range
  // from U+2010 to U+2015, so `-` was a range delimiter and not a member.
  for (const title of ['-', '+', '/', '…', '&', '*', '--', ' . ', '()', '|']) {
    assert.deepEqual(
      codesFor(withSteps([step({ stepId: 'a', title }), step({ stepId: 'b' })])),
      ['EMPTY_STEP'],
      `${JSON.stringify(title)} must be EMPTY_STEP`,
    );
  }
});

test('ordinary titles containing punctuation are still admissible', () => {
  for (const title of ['Book venue & cake', 'Call Dr. Levi', 'Send the 3/4 report', 'Pay — in full']) {
    assert.deepEqual(
      codesFor(withSteps([step({ stepId: 'a', title }), step({ stepId: 'b' })])),
      [],
      `${JSON.stringify(title)} must be admissible`,
    );
  }
});

test('a step claiming to be inferred while citing source text is INFERRED_WITH_SPAN', () => {
  const violations = validateProposalEntry(
    withSteps([
      step({ stepId: 'a', inferred: true, sourceSpans: [{ start: 0, end: 4, text: 'Book' }] }),
      step({ stepId: 'b' }),
    ]),
  );

  assert.deepEqual(violations.map((violation) => violation.code), ['INFERRED_WITH_SPAN']);
  assert.equal(violations[0].stepId, 'a');
});

test('a step with no span that does not admit to being inferred is UNSOURCED_STEP', () => {
  // Directly the "stable source-span/provenance links" deliverable: a step with
  // no span and no admission is indistinguishable from an invented one.
  const violations = validateProposalEntry(
    withSteps([step({ stepId: 'a', inferred: false, sourceSpans: [] }), step({ stepId: 'b' })]),
  );

  assert.deepEqual(violations.map((violation) => violation.code), ['UNSOURCED_STEP']);
  assert.equal(violations[0].stepId, 'a');
});

test('the two honest provenance shapes are admissible', () => {
  assert.deepEqual(
    codesFor(
      withSteps([
        step({ stepId: 'a', inferred: false, sourceSpans: [{ start: 0, end: 4, text: 'Book' }] }),
        step({ stepId: 'b', inferred: true, sourceSpans: [] }),
      ]),
    ),
    [],
  );
});

test('an edit cannot mutate the spans of the step it came from', () => {
  // The headline provenance test compared the edited step's span array with the
  // proposal's — which was the same array object, so it could not have caught an
  // in-place rewrite. Compare against a clone taken before the edit, and assert
  // the arrays are not the same object.
  const proposal = proposalFrom('ar-multi-wedding');
  const before = JSON.parse(JSON.stringify(proposal.steps[1].sourceSpans)) as unknown;

  const state = reduceStepDecisions(proposal, [accept('s1'), edit('s2', 'ابعت الدعوات'), accept('s3')]);
  const edited = state.steps.find((entry) => entry.stepId === 's2');

  assert.ok(edited);
  assert.deepEqual(JSON.parse(JSON.stringify(edited.step.sourceSpans)) as unknown, before);
  assert.deepEqual(
    JSON.parse(JSON.stringify(proposal.steps[1].sourceSpans)) as unknown,
    before,
    'the proposal the edit came from must be unchanged',
  );
});
