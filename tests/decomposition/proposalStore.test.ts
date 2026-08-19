/**
 * The proposal store and the path from a stored proposal to a written step.
 *
 * Sprint 06 shipped two of these. #25 had `lib/decomposition/proposal/proposalStore.ts`
 * over a declared `DecompositionPersistencePort`, #27 had
 * `lib/decomposition/boundary/proposalStore.ts` over a real adapter, and the two
 * could not interoperate — `TransactionalDecompositionPersistenceAdapter` does
 * not implement `DecompositionPersistencePort`. Nothing outside the tests ever
 * imported #25's, and every review round found a defect on one side that had
 * already been fixed on the other. #27's is the survivor because it is the one
 * with a writer behind it.
 *
 * **This file is where #25's store tests went.** It is deliberately not a
 * rewrite of #27's suite: tests/decomposition/boundaryService.test.ts already
 * covers scope, idempotency, concurrency, the failure codes and the audit
 * envelope. What is here is the set of properties the deleted store pinned that
 * nothing else did — admission is a clone and not an alias, a confirmation
 * leaves the proposal it came from byte-identical, an all-rejected ruling is a
 * success that writes nothing, a refused request does not consume the proposal,
 * and nothing mutable reaches the writer. Each is re-pinned against the
 * surviving store and the real adapter rather than against a recording double,
 * so "was not written" is an assertion about canonical state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECOMPOSITION_CONTRACT_VERSION,
  type DecompositionConfirmationRequest,
  type DecompositionStepProposal,
  type StepDecision,
} from '../../src/contracts/v1/decompositionContracts.ts';
import {
  confirmDecomposition,
  createEmptyDecompositionState,
  proposeDecompositionBoundary,
  MemoryDecompositionProposalStore,
  TransactionalDecompositionPersistenceAdapter,
  type ConfirmedDecompositionStep,
  type DecompositionPersistenceAdapter,
  type DecompositionPersistedState,
} from '../../lib/decomposition/boundary/index.ts';
import { goldenById } from '../fixtures/decompositionGolden.ts';

const SCOPE = 'scope-1';
const now = new Date('2026-08-19T09:00:00.000Z');
const WEDDING = goldenById('en-multi-wedding');

interface Harness {
  readonly store: MemoryDecompositionProposalStore;
  readonly persistence: DecompositionPersistenceAdapter;
}

function harness(persistence?: DecompositionPersistenceAdapter): Harness {
  return {
    store: new MemoryDecompositionProposalStore(),
    persistence: persistence ?? new TransactionalDecompositionPersistenceAdapter(createEmptyDecompositionState()),
  };
}

/**
 * An adapter that records the batch it was handed rather than filing it, so
 * "the writer was not reached" is an assertion rather than an absence of
 * evidence, and so the batch itself can be inspected for mutability.
 */
function recordingAdapter() {
  const batches: ConfirmedDecompositionStep[][] = [];
  const adapter: DecompositionPersistenceAdapter = {
    async persistAtomically(steps): Promise<{ state: DecompositionPersistedState }> {
      batches.push(steps.slice());
      return { state: createEmptyDecompositionState() };
    },
    snapshot: () => createEmptyDecompositionState(),
  };
  return { adapter, batches };
}

async function proposeWedding(dependencies: Harness, sourceText = WEDDING.sourceText) {
  return proposeDecompositionBoundary(sourceText, {
    commitmentId: 'c1',
    scopeId: SCOPE,
    now,
  }, dependencies);
}

function request(
  proposalId: string,
  decisions: readonly StepDecision[],
  overrides: Partial<DecompositionConfirmationRequest> = {},
): DecompositionConfirmationRequest {
  return { proposalId, scopeId: SCOPE, decisions, idempotencyKey: 'key-1', ...overrides };
}

function acceptAll(steps: readonly { readonly stepId: string }[]): readonly StepDecision[] {
  return steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/* ── Admission is a copy, not a handle ────────────────────────────── */

test('an admitted proposal is retrievable and is not the caller object', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  const stored = dependencies.store.get(proposal.proposalId);

  assert.ok(stored);
  // Compared against a clone taken from the returned proposal, not against the
  // stored object itself: the deleted store used to hand back the caller's own
  // object, so the old assertion compared an object with itself and could not
  // have failed.
  assert.deepEqual(clone(stored.proposal), clone(proposal));
  assert.notEqual(stored.proposal, proposal, 'the store must not hand back the caller object');
  assert.equal(stored.scopeId, SCOPE);
});

test('mutating the proposal object after admission cannot change what is stored', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  const before = clone(dependencies.store.get(proposal.proposalId)?.proposal);

  (proposal as unknown as { commitmentId: string }).commitmentId = 'somebody-elses-commitment';

  assert.deepEqual(clone(dependencies.store.get(proposal.proposalId)?.proposal), before);
});

/* ── Lookup ───────────────────────────────────────────────────────── */

test('confirming an unknown proposal fails without reaching the adapter', async () => {
  const recorder = recordingAdapter();
  const dependencies = harness(recorder.adapter);
  await proposeWedding(dependencies);

  const result = await confirmDecomposition(request('nope', []), dependencies);

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_not_found');
  assert.equal(result.version, DECOMPOSITION_CONTRACT_VERSION);
  assert.equal(recorder.batches.length, 0);
});

/* ── A confirmation never rewrites the proposal it came from ──────── */

test('confirming, including an edit, leaves the stored proposal byte-identical', async () => {
  // "The original commitment remains canonical" at the store level: an edit
  // rewrites what is confirmed, never what was proposed. A write-back into the
  // stored proposal is the shape a "just update the title in place" refactor
  // takes, and it would make the spans stop selecting the text they claim.
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const before = clone(dependencies.store.get(proposal.proposalId)?.proposal);

  const result = await confirmDecomposition(request(proposal.proposalId, [
    { stepId: proposal.steps[0].stepId, verdict: 'edit', editedTitle: 'Reserve the venue' },
    { stepId: proposal.steps[1].stepId, verdict: 'accept' },
    { stepId: proposal.steps[2].stepId, verdict: 'reject' },
  ]), dependencies);

  assert.equal(result.success, true);
  assert.deepEqual(clone(dependencies.store.get(proposal.proposalId)?.proposal), before);
});

/* ── An all-rejected ruling is a success that writes nothing ──────── */

test('rejecting every step succeeds and reaches the adapter not at all', async () => {
  const recorder = recordingAdapter();
  const dependencies = harness(recorder.adapter);
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  const result = await confirmDecomposition(request(
    proposal.proposalId,
    proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'reject' })),
  ), dependencies);

  assert.equal(result.success, true);
  assert.deepEqual(result.persistedStepIds, []);
  assert.deepEqual(result.rejectedStepIds, proposal.steps.map((step) => step.stepId));
  assert.equal(
    recorder.batches.length,
    0,
    'an empty batch is not a write with nothing in it; it is no write',
  );
});

/* ── A refusal does not consume the proposal ──────────────────────── */

test('a malformed request does not spend the proposal', async () => {
  // A refusal must leave the proposal confirmable, or one bad client request
  // would strand a user's proposal permanently.
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  const refused = await confirmDecomposition(
    request(proposal.proposalId, [{ stepId: proposal.steps[0].stepId, verdict: 'maybe' } as unknown as StepDecision]),
    dependencies,
  );
  assert.equal(refused.success, false);

  const good = await confirmDecomposition(request(proposal.proposalId, acceptAll(proposal.steps)), dependencies);
  assert.equal(good.success, true);
  assert.equal(Object.keys(dependencies.persistence.snapshot().steps).length, 3);
});

/* ── Nothing mutable reaches the writer ───────────────────────────── */

test('the batch handed to the adapter carries no span a caller could rewrite', async () => {
  // An adapter normalizing spans in place is the realistic failure. It must not
  // be able to reach stored state through the batch it was handed — provenance
  // that can be edited after the fact is not provenance.
  const recorder = recordingAdapter();
  const dependencies = harness(recorder.adapter);
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  await confirmDecomposition(request(proposal.proposalId, [
    { stepId: proposal.steps[0].stepId, verdict: 'edit', editedTitle: 'Reserve the venue' },
    { stepId: proposal.steps[1].stepId, verdict: 'accept' },
    { stepId: proposal.steps[2].stepId, verdict: 'reject' },
  ]), dependencies);

  const before = clone(dependencies.store.get(proposal.proposalId)?.proposal);
  const spans = recorder.batches[0][0].sourceSpans;
  assert.equal(Object.isFrozen(spans), true, 'the batch must not carry a mutable span array');
  assert.throws(() => {
    (spans as unknown as { start: number }[])[0].start = 999;
  }, 'mutating a span handed to the writer must fail loudly');

  assert.deepEqual(clone(dependencies.store.get(proposal.proposalId)?.proposal), before);
});

test('the batch carries the spans the proposal was offered with, unedited', async () => {
  const recorder = recordingAdapter();
  const dependencies = harness(recorder.adapter);
  const proposal = await proposeDecompositionBoundary(goldenById('ar-multi-wedding').sourceText, {
    commitmentId: 'c1', scopeId: SCOPE, now,
  }, dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  await confirmDecomposition(request(proposal.proposalId, proposal.steps.map((step, index): StepDecision =>
    index === 1
      ? { stepId: step.stepId, verdict: 'edit', editedTitle: 'ابعت الدعوات' }
      : { stepId: step.stepId, verdict: 'accept' })), dependencies);

  for (const written of recorder.batches[0]) {
    const original: DecompositionStepProposal | undefined = proposal.steps
      .find((step) => step.stepId === written.stepId);
    assert.ok(original);
    assert.deepEqual(written.sourceSpans, original.sourceSpans);
    for (const span of written.sourceSpans) {
      assert.equal(proposal.sourceText.slice(span.start, span.end), span.text);
    }
  }
});

/* ── The written shape carries no instruction to rewrite anything ─── */

test('no confirmed-step field can express a change to the commitment', async () => {
  // Ported from the deleted persistencePort's boundary test, which made this
  // claim about `ConfirmedStepBatch`. The claim belongs to whatever shape
  // actually reaches a writer, and that is now `ConfirmedDecompositionStep`: a
  // record that could express "and rename the commitment" would let a malformed
  // proposal talk the adapter into a canonical edit. The shape carries no such
  // field, so there is nothing for the adapter to obey.
  const recorder = recordingAdapter();
  const dependencies = harness(recorder.adapter);
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  await confirmDecomposition(request(proposal.proposalId, acceptAll(proposal.steps)), dependencies);

  const written = recorder.batches[0][0];
  assert.equal(written.commitmentId, 'c1', 'the record says what the step belongs to');
  for (const forbidden of ['commitmentTitle', 'commitmentUpdate', 'commitmentPatch', 'replaceCommitment']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(written, forbidden),
      false,
      `a confirmed step must not carry ${forbidden}; decomposition adds steps beside a commitment, never rewrites it`,
    );
  }
});
