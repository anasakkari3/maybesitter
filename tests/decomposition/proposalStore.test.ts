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
  const proposal = proposalFrom('en-multi-wedding');
  const snapshot = JSON.parse(JSON.stringify(proposal)) as unknown;
  const { store, admission } = setup(proposal);

  assert.equal(admission.admitted, true);
  // Compared against a clone taken before admission, not against `proposal`
  // itself: the store used to hand back the caller's own object, so the old
  // assertion compared an object with itself and could not fail.
  assert.deepEqual(JSON.parse(JSON.stringify(store.get('p1')?.proposal)) as unknown, snapshot);
  assert.notEqual(store.get('p1')?.proposal, proposal, 'the store must not hand back the caller object');
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
  const { store } = setup();
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
  assert.equal(second.failureCode, 'already_confirmed');
  assert.equal(recorder.batches.length, 1);
});

test('a second confirmation under a new key cannot re-apply an applied proposal', async () => {
  const { store, recorder } = setup();
  await store.confirm(request());
  const second = await store.confirm(request({ idempotencyKey: 'key-2' }));

  assert.equal(second.success, false);
  assert.equal(second.failureCode, 'already_confirmed');
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

/* ── Review regressions ───────────────────────────────────────────── */

test('re-admitting a confirmed proposal cannot make it applicable twice', async () => {
  // `admit` used to overwrite the entry with `confirmed: null`, which reset the
  // already-confirmed guard and let the port be reached a second time. The
  // guard is only a guard if it survives a re-admission.
  const proposal = proposalFrom('en-multi-wedding');
  const { store, recorder } = setup(proposal);

  const first = await store.confirm(request());
  assert.equal(first.success, true);

  store.admit({ proposal, scopeId: SCOPE });

  // A fresh key is a second apply, which is the case the guard exists for.
  const reapply = await store.confirm(request({ idempotencyKey: 'key-2' }));
  assert.equal(reapply.success, false);
  assert.equal(reapply.failureCode, 'already_confirmed');

  // And the identical request is still a replay, not a second write.
  const replay = await store.confirm(request());
  assert.equal(replay.replayed, true);

  assert.equal(recorder.batches.length, 1, 'the port must still have been reached exactly once');
});

test('re-admitting under another scope does not hand that scope the proposal', async () => {
  // The same overwrite let a second admission move a live proposal into a
  // different scope, defeating the scope check outright.
  const proposal = proposalFrom('en-multi-wedding');
  const { store, recorder } = setup(proposal);

  store.admit({ proposal, scopeId: 'someone-else' });
  const foreign = await store.confirm(request({ scopeId: 'someone-else' }));

  assert.equal(foreign.success, false);
  assert.equal(foreign.failureCode, 'proposal_not_found');
  assert.deepEqual(recorder.batches, []);

  // And the original scope still owns it.
  const owner = await store.confirm(request());
  assert.equal(owner.success, true);
  assert.equal(recorder.batches.length, 1);
});

test('a re-admission of an open proposal is refused rather than silently applied', () => {
  const { store } = setup();
  const again = store.admit({ proposal: proposalFrom('en-multi-wedding'), scopeId: SCOPE });

  assert.equal(again.admitted, false);
  assert.equal(again.admitted === false ? again.reason : null, 'already_admitted');
});

test('concurrent confirmations with one key reach the port once', async () => {
  // `confirm` read the stored entry, awaited the port, and only then recorded
  // the confirmation — so two callers interleaving on that await both saw an
  // unconfirmed proposal and both applied it.
  const batches: ConfirmedStepBatch[] = [];
  const slowPort = {
    async persistConfirmedSteps(batch: ConfirmedStepBatch): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 5));
      batches.push(batch);
    },
  };
  const store = createInMemoryProposalStore({ persistence: slowPort });
  store.admit({ proposal: proposalFrom('en-multi-wedding'), scopeId: SCOPE });

  const results = await Promise.all([store.confirm(request()), store.confirm(request())]);

  assert.equal(batches.length, 1, 'the port must be reached exactly once');
  assert.equal(results.filter((result) => result.success && !result.replayed).length, 1);
  assert.equal(results.filter((result) => result.replayed).length, 1);
});

test('concurrent confirmations with different keys apply only one', async () => {
  const batches: ConfirmedStepBatch[] = [];
  const slowPort = {
    async persistConfirmedSteps(batch: ConfirmedStepBatch): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 5));
      batches.push(batch);
    },
  };
  const store = createInMemoryProposalStore({ persistence: slowPort });
  store.admit({ proposal: proposalFrom('en-multi-wedding'), scopeId: SCOPE });

  const results = await Promise.all([
    store.confirm(request()),
    store.confirm(request({ idempotencyKey: 'key-2' })),
  ]);

  assert.equal(batches.length, 1);
  assert.equal(results.filter((result) => result.success).length, 1);
  assert.equal(
    results.filter((result) => result.failureCode === 'already_confirmed').length,
    1,
    'the loser must be told someone already decided, not that nothing exists',
  );
});

test('the store hands out no reference a caller can corrupt', async () => {
  const proposal = proposalFrom('en-multi-wedding');
  const { store, recorder } = setup(proposal);
  const stored = store.get('p1');

  assert.ok(stored);
  assert.notEqual(stored.proposal, proposal, 'the stored proposal must not alias the caller object');
  assert.equal(Object.isFrozen(stored.proposal), true, 'a retrieved proposal must be immutable');

  await store.confirm(
    request({
      decisions: [
        { stepId: 's1', verdict: 'edit', editedTitle: 'Reserve the venue' },
        { stepId: 's2', verdict: 'accept' },
        { stepId: 's3', verdict: 'reject' },
      ],
    }),
  );

  // An adapter normalizing spans in place is the realistic failure. It must not
  // be able to reach stored state through the batch it was handed.
  const before = JSON.parse(JSON.stringify(store.get('p1')?.proposal)) as unknown;
  const spans = recorder.batches[0].steps[0].step.sourceSpans;
  assert.equal(Object.isFrozen(spans), true, 'the batch must not carry a mutable span array');
  assert.throws(() => {
    (spans as unknown as { start: number }[])[0].start = 999;
  }, 'mutating a span handed to the port must fail loudly');

  assert.deepEqual(JSON.parse(JSON.stringify(store.get('p1')?.proposal)) as unknown, before);
});

test('mutating the proposal object after admission cannot change what is stored', () => {
  const proposal = proposalFrom('en-multi-wedding');
  const { store } = setup(proposal);
  const before = JSON.parse(JSON.stringify(store.get('p1')?.proposal)) as unknown;

  (proposal as unknown as { commitmentId: string }).commitmentId = 'somebody-elses-commitment';

  assert.deepEqual(JSON.parse(JSON.stringify(store.get('p1')?.proposal)) as unknown, before);
});

/* ── Untrusted requests reach the public confirm ──────────────────── */

/** `DecompositionConfirmationRequest` is erased at runtime like every other type here. */
function rawRequest(overrides: Record<string, unknown>): DecompositionConfirmationRequest {
  return { ...request(), ...overrides } as unknown as DecompositionConfirmationRequest;
}

test('a malformed request answers in contract codes instead of throwing', async () => {
  // Every one of these threw a raw TypeError out of `confirm` — the function
  // this module's own docblock calls the boundary. A boundary that throws its
  // implementation's internals at a caller has not refused the request; it has
  // crashed, and the caller cannot tell which.
  const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ['edit without editedTitle', { decisions: [{ stepId: 's1', verdict: 'edit' }] }, 'invalid_edit'],
    ['editedTitle: 5', { decisions: [{ stepId: 's1', verdict: 'edit', editedTitle: 5 }] }, 'invalid_edit'],
    ['decisions: null', { decisions: null }, 'incomplete_decisions'],
    ['decisions: a string', { decisions: 'abc' }, 'incomplete_decisions'],
    ['decisions: [null]', { decisions: [null] }, 'unknown_step'],
    ['verdict: maybe', { decisions: [{ stepId: 's1', verdict: 'maybe' }] }, 'incomplete_decisions'],
    ['proposalId not a string', { proposalId: 7 }, 'proposal_not_found'],
    ['scopeId not a string', { scopeId: null }, 'proposal_not_found'],
    ['idempotencyKey not a string', { idempotencyKey: {} }, 'proposal_not_found'],
  ];

  for (const [label, overrides, expected] of cases) {
    const { store, recorder } = setup();
    const result = await store.confirm(rawRequest(overrides));

    assert.equal(result.success, false, label);
    assert.equal(result.failureCode, expected, label);
    assert.deepEqual(result.persistedStepIds, [], label);
    assert.deepEqual(recorder.batches, [], `${label} must not reach the port`);
  }
});

test('an unrecognised verdict persists nothing and rejects nothing', async () => {
  // The measured symptom: success:true with rejectedStepIds:["s1"] — a recorded
  // rejection the user never made, reported as a completed confirmation.
  const { store, recorder } = setup();
  const result = await store.confirm(
    rawRequest({
      decisions: [
        { stepId: 's1', verdict: 'maybe' },
        { stepId: 's2', verdict: 'accept' },
        { stepId: 's3', verdict: 'accept' },
      ],
    }),
  );

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'incomplete_decisions');
  assert.deepEqual(result.rejectedStepIds, []);
  assert.deepEqual(result.persistedStepIds, []);
  assert.deepEqual(recorder.batches, []);
});

test('an oversized edited title never reaches the port', async () => {
  const { store, recorder } = setup();
  const result = await store.confirm(
    request({
      decisions: [
        { stepId: 's1', verdict: 'edit', editedTitle: 'x'.repeat(1000000) },
        { stepId: 's2', verdict: 'accept' },
        { stepId: 's3', verdict: 'accept' },
      ],
    }),
  );

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'invalid_edit');
  assert.deepEqual(recorder.batches, []);
});

test('a malformed request does not consume the proposal', async () => {
  // A refusal must leave the proposal confirmable, or one bad client request
  // would strand a user's proposal permanently.
  const { store, recorder } = setup();
  await store.confirm(rawRequest({ decisions: [{ stepId: 's1', verdict: 'maybe' }] }));

  const good = await store.confirm(request());
  assert.equal(good.success, true);
  assert.equal(recorder.batches.length, 1);
});
