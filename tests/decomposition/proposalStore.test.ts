/**
 * The proposal store and its confirmation path (Sprint 06, issue #25).
 *
 * The store is where the two structural guarantees become observable:
 *
 *  - **Nothing reaches the persistence port except a completed confirmation.**
 *    The port here is a recording double, so "was not called" is an assertion
 *    rather than an absence of evidence — admission, a malformed request, an
 *    all-rejected confirmation and a replay must all leave it untouched.
 *  - **The original commitment stays canonical.** The proposal the store holds
 *    is deep-compared before and after a confirmation that edited a step, so a
 *    write-back into the proposal (the shape a "just update the title in place"
 *    refactor takes) fails the suite.
 *
 * Idempotency follows Capture's: a replayed identical confirmation returns
 * `replayed: true` and does not apply twice. The store additionally refuses a
 * *different* confirmation of an already-confirmed proposal, which Capture's
 * `invalid_selection` covered and this contract has no code for — see the
 * BLOCKER note in docs/architecture/decomposition-boundary.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECOMPOSITION_CONTRACT_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  type AtomicProposal,
  type DecomposedProposal,
  type DecompositionConfirmationRequest,
  type DecompositionProposal,
  type DecompositionStepProposal,
  type RejectedProposal,
  type StepDecision,
} from '../../src/contracts/v1/decompositionContracts.ts';
import { goldenById } from '../fixtures/decompositionGolden.ts';
import type { ConfirmedStepBatch } from '../../lib/decomposition/proposal/persistencePort.ts';
import { createInMemoryProposalStore } from '../../lib/decomposition/proposal/proposalStore.ts';

const SCOPE = 'scope-1';

function proposalFrom(exampleId: string, proposalId = 'p1'): DecomposedProposal {
  const example = goldenById(exampleId);
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    proposalId,
    commitmentId: 'c1',
    sourceText: example.sourceText,
    provenance: { requestedEngine: 'rules', executedEngine: 'rules', fallbackUsed: false },
    outcome: 'decomposed',
    steps: example.expectedSteps as unknown as DecomposedProposal['steps'],
  };
}

function atomicProposal(): AtomicProposal {
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    proposalId: 'p-atomic',
    commitmentId: 'c1',
    sourceText: 'Call the dentist.',
    provenance: { requestedEngine: 'rules', executedEngine: 'rules', fallbackUsed: false },
    outcome: 'atomic',
    reason: 'not_decomposable',
  };
}

function rejectedProposal(): RejectedProposal {
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    proposalId: 'p-rejected',
    commitmentId: 'c1',
    sourceText: 'Review the terms and conditions before Friday.',
    provenance: { requestedEngine: 'rules', executedEngine: 'rules', fallbackUsed: false },
    outcome: 'rejected',
    violations: [{ code: 'SPLIT_ATOMIC', stepId: null, detail: 'do-not-split commitment was split' }],
  };
}

/** A persistence port that records rather than persists. */
function recordingPort() {
  const batches: ConfirmedStepBatch[] = [];
  let failNext = false;
  return {
    batches,
    failWith(shouldFail: boolean): void {
      failNext = shouldFail;
    },
    port: {
      async persistConfirmedSteps(batch: ConfirmedStepBatch): Promise<void> {
        if (failNext) throw new Error('adapter unavailable');
        batches.push(batch);
      },
    },
  };
}

function request(overrides: Partial<DecompositionConfirmationRequest> = {}): DecompositionConfirmationRequest {
  return {
    proposalId: 'p1',
    scopeId: SCOPE,
    decisions: [
      { stepId: 's1', verdict: 'accept' },
      { stepId: 's2', verdict: 'accept' },
      { stepId: 's3', verdict: 'accept' },
    ],
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

function setup(proposal: DecompositionProposal = proposalFrom('en-multi-wedding')) {
  const recorder = recordingPort();
  const store = createInMemoryProposalStore({ persistence: recorder.port });
  const admission = store.admit({ proposal, scopeId: SCOPE });
  return { recorder, store, admission, proposal };
}

/* ── Admission ────────────────────────────────────────────────────── */

test('a valid decomposed proposal is admitted and retrievable', () => {
  const { store, admission, proposal } = setup();

  assert.equal(admission.admitted, true);
  assert.deepEqual(store.get('p1')?.proposal, proposal);
  assert.equal(store.get('p1')?.scopeId, SCOPE);
});

test('admission alone never reaches the persistence port', () => {
  const { recorder } = setup();
  assert.deepEqual(recorder.batches, []);
});

test('a proposal that fails entry validation is refused and not stored', () => {
  const blank: DecompositionStepProposal = {
    stepId: 's1',
    title: '   ',
    sourceSpans: [],
    inferred: true,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
  };
  const proposal: DecomposedProposal = {
    ...proposalFrom('en-multi-wedding'),
    steps: [blank, { ...blank, stepId: 's2', title: 'and' }],
  };
  const { store, admission } = setup(proposal);

  assert.equal(admission.admitted, false);
  assert.deepEqual(
    admission.admitted === false ? admission.violations.map((violation) => violation.code) : null,
    ['EMPTY_STEP', 'CONJUNCTION_ONLY'],
  );
  assert.equal(store.get('p1'), undefined, 'an inadmissible proposal must not be offerable');
});

test('a rejected proposal is refused admission carrying its own violations', () => {
  const { store, admission } = setup(rejectedProposal());

  assert.equal(admission.admitted, false);
  assert.deepEqual(
    admission.admitted === false ? admission.violations.map((violation) => violation.code) : null,
    ['SPLIT_ATOMIC'],
  );
  assert.equal(store.get('p-rejected'), undefined);
});

test('an atomic proposal is admitted but cannot be confirmed', async () => {
  const { store, admission, recorder } = setup(atomicProposal());
  assert.equal(admission.admitted, true, 'an honest refusal to decompose is still a valid proposal to show');

  const result = await store.confirm(request({ proposalId: 'p-atomic', decisions: [] }));

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_not_decomposed');
  assert.deepEqual(recorder.batches, []);
});

/* ── Lookup and scope ─────────────────────────────────────────────── */

test('confirming an unknown proposal fails without touching the port', async () => {
  const { store, recorder } = setup();
  const result = await store.confirm(request({ proposalId: 'nope' }));

  assert.equal(result.failureCode, 'proposal_not_found');
  assert.equal(result.version, DECOMPOSITION_CONTRACT_VERSION);
  assert.deepEqual(recorder.batches, []);
});

test('a confirmation from another scope cannot reach a proposal', async () => {
  const { store, recorder } = setup();
  const result = await store.confirm(request({ scopeId: 'someone-else' }));

  assert.equal(result.failureCode, 'proposal_not_found');
  assert.deepEqual(recorder.batches, []);
});

/* ── The happy path ───────────────────────────────────────────────── */

test('a complete confirmation persists exactly the accepted and edited steps', async () => {
  const { store, recorder } = setup();
  const result = await store.confirm(
    request({
      decisions: [
        { stepId: 's1', verdict: 'accept' },
        { stepId: 's2', verdict: 'edit', editedTitle: 'Post the invitations' },
        { stepId: 's3', verdict: 'reject' },
      ],
    }),
  );

  assert.equal(result.success, true);
  assert.equal(result.replayed, false);
  assert.deepEqual(result.persistedStepIds, ['s1', 's2']);
  assert.deepEqual(result.rejectedStepIds, ['s3']);

  assert.equal(recorder.batches.length, 1);
  const batch = recorder.batches[0];
  assert.equal(batch.commitmentId, 'c1');
  assert.equal(batch.proposalId, 'p1');
  assert.equal(batch.scopeId, SCOPE);
  assert.deepEqual(
    batch.steps.map((entry) => [entry.step.stepId, entry.disposition, entry.step.title, entry.proposedTitle]),
    [
      ['s1', 'accepted', 'Book the venue', 'Book the venue'],
      ['s2', 'edited', 'Post the invitations', 'send the invitations'],
    ],
  );
});

test('the batch carries the spans the proposal was offered with, unedited', async () => {
  const proposal = proposalFrom('ar-multi-wedding');
  const { store, recorder } = setup(proposal);
  await store.confirm(
    request({
      decisions: [
        { stepId: 's1', verdict: 'accept' },
        { stepId: 's2', verdict: 'edit', editedTitle: 'ابعت الدعوات' },
        { stepId: 's3', verdict: 'accept' },
      ],
    }),
  );

  for (const entry of recorder.batches[0].steps) {
    const original = proposal.steps.find((step) => step.stepId === entry.step.stepId);
    assert.ok(original);
    assert.deepEqual(entry.step.sourceSpans, original.sourceSpans);
    for (const span of entry.step.sourceSpans) {
      assert.equal(proposal.sourceText.slice(span.start, span.end), span.text);
    }
  }
});

test('rejecting every step succeeds and persists nothing at all', async () => {
  const { store, recorder } = setup();
  const result = await store.confirm(
    request({
      decisions: [
        { stepId: 's1', verdict: 'reject' },
        { stepId: 's2', verdict: 'reject' },
        { stepId: 's3', verdict: 'reject' },
      ],
    }),
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.persistedStepIds, []);
  assert.deepEqual(result.rejectedStepIds, ['s1', 's2', 's3']);
  assert.deepEqual(recorder.batches, [], 'an empty batch is not a write with nothing in it; it is no write');
});

test('confirmation leaves the stored proposal byte-identical', async () => {
  // "The original commitment remains canonical" at the store level: an edit
  // rewrites what is confirmed, never what was proposed.
  const { store, proposal } = setup();
  const before = JSON.parse(JSON.stringify(store.get('p1')?.proposal)) as unknown;

  await store.confirm(
    request({
      decisions: [
        { stepId: 's1', verdict: 'edit', editedTitle: 'Reserve the venue' },
        { stepId: 's2', verdict: 'accept' },
        { stepId: 's3', verdict: 'reject' },
      ],
    }),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(store.get('p1')?.proposal)) as unknown, before);
  assert.deepEqual(store.get('p1')?.proposal, proposal);
});

/* ── Idempotency ──────────────────────────────────────────────────── */

test('a replayed identical confirmation returns replayed and does not apply twice', async () => {
  const { store, recorder } = setup();
  const first = await store.confirm(request());
  const second = await store.confirm(request());

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.success, true);
  assert.deepEqual(second.persistedStepIds, first.persistedStepIds);
  assert.deepEqual(second.rejectedStepIds, first.rejectedStepIds);
  assert.equal(recorder.batches.length, 1, 'the port must be reached exactly once');
});

test('the same idempotency key with different decisions is refused, not replayed', async () => {
  // Returning the first result here would tell the caller its new decisions
  // were applied when they were discarded.
  const { store, recorder } = setup();
  await store.confirm(request());
  const second = await store.confirm(
    request({
      decisions: [
        { stepId: 's1', verdict: 'reject' },
        { stepId: 's2', verdict: 'reject' },
        { stepId: 's3', verdict: 'reject' },
      ],
    }),
  );

  assert.equal(second.success, false);
  assert.equal(second.replayed, false);
  assert.equal(recorder.batches.length, 1);
});

test('a second confirmation under a new key cannot re-apply an applied proposal', async () => {
  const { store, recorder } = setup();
  await store.confirm(request());
  const second = await store.confirm(request({ idempotencyKey: 'key-2' }));

  assert.equal(second.success, false);
  assert.equal(recorder.batches.length, 1);
});

/* ── Failure paths ────────────────────────────────────────────────── */

test('every reducer failure surfaces as its contract code and reaches no port', async () => {
  const cases: readonly (readonly [string, readonly StepDecision[]])[] = [
    ['incomplete_decisions', [{ stepId: 's1', verdict: 'accept' }]],
    [
      'unknown_step',
      [
        { stepId: 's1', verdict: 'accept' },
        { stepId: 's2', verdict: 'accept' },
        { stepId: 's3', verdict: 'accept' },
        { stepId: 's9', verdict: 'accept' },
      ],
    ],
    [
      'duplicate_decision',
      [
        { stepId: 's1', verdict: 'accept' },
        { stepId: 's1', verdict: 'reject' },
        { stepId: 's2', verdict: 'accept' },
        { stepId: 's3', verdict: 'accept' },
      ],
    ],
    [
      'invalid_edit',
      [
        { stepId: 's1', verdict: 'edit', editedTitle: '   ' },
        { stepId: 's2', verdict: 'accept' },
        { stepId: 's3', verdict: 'accept' },
      ],
    ],
  ];

  for (const [expected, decisions] of cases) {
    const { store, recorder } = setup();
    const result = await store.confirm(request({ decisions }));

    assert.equal(result.success, false, expected);
    assert.equal(result.failureCode, expected);
    assert.deepEqual(result.persistedStepIds, []);
    assert.deepEqual(result.rejectedStepIds, []);
    assert.deepEqual(recorder.batches, [], `${expected} must not reach the port`);
  }
});

test('a failing port reports persistence_failed and leaves the proposal confirmable', async () => {
  const { store, recorder } = setup();
  recorder.failWith(true);
  const failed = await store.confirm(request());

  assert.equal(failed.success, false);
  assert.equal(failed.failureCode, 'persistence_failed');
  assert.deepEqual(recorder.batches, []);

  // A retry must work: recording the confirmation before the port succeeded
  // would strand the user with steps that were never written and a proposal
  // that believes they were.
  recorder.failWith(false);
  const retried = await store.confirm(request());
  assert.equal(retried.success, true);
  assert.equal(retried.replayed, false);
  assert.equal(recorder.batches.length, 1);
});
