/**
 * The decomposition boundary, built as a sibling of Sprint 01's capture
 * boundary: propose, confirm explicitly, persist transactionally, audit
 * without the input.
 *
 * The tests that matter most here are the negative ones. A boundary that only
 * ever gets exercised on its happy path is a boundary whose failure modes are
 * theoretical, and every acceptance criterion for #27 is about what must *not*
 * happen — an unreviewed proposal must not persist, a replay must not
 * double-apply, a failed batch must not half-apply, and an audit record must
 * not carry what the user typed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECOMPOSITION_PERSISTENCE_POLICY } from '../../src/contracts/v1/decompositionContracts.ts';
import type {
  DecompositionConfirmationRequest,
  StepDecision,
} from '../../src/contracts/v1/decompositionContracts.ts';
import type { AuditEventEnvelope } from '../../src/contracts/v1/runtimeControls.ts';
import {
  confirmDecomposition,
  createEmptyDecompositionState,
  proposeDecompositionBoundary,
  MemoryDecompositionProposalStore,
  TransactionalDecompositionPersistenceAdapter,
  type ConfirmedDecompositionStep,
  type DecompositionPersistenceAdapter,
} from '../../lib/decomposition/boundary/index.ts';
import { DECOMPOSITION_GOLDEN, goldenById } from '../fixtures/decompositionGolden.ts';

const now = new Date('2026-08-19T09:00:00.000Z');
const WEDDING = goldenById('en-multi-wedding');

interface Harness {
  readonly store: MemoryDecompositionProposalStore;
  readonly persistence: DecompositionPersistenceAdapter;
  readonly audit: (event: AuditEventEnvelope) => void;
  readonly events: AuditEventEnvelope[];
}

function harness(persistence?: DecompositionPersistenceAdapter): Harness {
  const events: AuditEventEnvelope[] = [];
  return {
    store: new MemoryDecompositionProposalStore(),
    persistence: persistence ?? new TransactionalDecompositionPersistenceAdapter(createEmptyDecompositionState()),
    audit: (event) => events.push(event),
    events,
  };
}

function countingAdapter(behaviour: 'ok' | 'throw'): DecompositionPersistenceAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    async persistAtomically() {
      adapter.calls += 1;
      if (behaviour === 'throw') throw new Error('adapter refused the batch');
      return { state: createEmptyDecompositionState() };
    },
    snapshot: () => createEmptyDecompositionState(),
  };
  return adapter;
}

async function proposeWedding(dependencies: Harness, sourceText = WEDDING.sourceText) {
  return proposeDecompositionBoundary(sourceText, {
    commitmentId: 'c1',
    scopeId: 'scope-a',
    now,
  }, dependencies);
}

function request(
  proposalId: string,
  decisions: readonly StepDecision[],
  overrides: Partial<DecompositionConfirmationRequest> = {},
): DecompositionConfirmationRequest {
  return { proposalId, scopeId: 'scope-a', decisions, idempotencyKey: 'key-1', ...overrides };
}

test('the shared policy still forbids proposal persistence and requires an atomic batch', () => {
  assert.equal(DECOMPOSITION_PERSISTENCE_POLICY.proposalCanPersist, false);
  assert.equal(DECOMPOSITION_PERSISTENCE_POLICY.confirmationRequired, true);
  assert.equal(DECOMPOSITION_PERSISTENCE_POLICY.adapterOwnsCanonicalWrites, true);
  assert.equal(DECOMPOSITION_PERSISTENCE_POLICY.atomicBatchRequired, true);
  assert.equal(DECOMPOSITION_PERSISTENCE_POLICY.rawInputInAudit, false);
  assert.equal(DECOMPOSITION_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical, true);
  assert.equal(DECOMPOSITION_PERSISTENCE_POLICY.everyStepNeedsExplicitDecision, true);
});

test('proposing never reaches the adapter, whatever the outcome', async () => {
  for (const sourceText of [
    WEDDING.sourceText,
    goldenById('en-atomic-dentist').sourceText,
    goldenById('ar-nosplit-terms').sourceText,
  ]) {
    const adapter = countingAdapter('ok');
    await proposeWedding({ ...harness(adapter), persistence: adapter }, sourceText);
    assert.equal(adapter.calls, 0, 'a proposal is an offer, not a write');
  }
});

test('an atomic proposal cannot be confirmed into existence', async () => {
  const adapter = countingAdapter('ok');
  const dependencies = { ...harness(adapter), persistence: adapter };
  const proposal = await proposeWedding(dependencies, 'Call the dentist.');
  assert.equal(proposal.outcome, 'atomic');

  const result = await confirmDecomposition(request(proposal.proposalId, []), dependencies);
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_not_decomposed');
  assert.equal(adapter.calls, 0);
});

test('a rejected proposal cannot be confirmed', async () => {
  const adapter = countingAdapter('ok');
  const dependencies = { ...harness(adapter), persistence: adapter };
  const proposal = await proposeDecompositionBoundary(WEDDING.sourceText, {
    commitmentId: 'c1', scopeId: 'scope-a', now, declaredAtomic: true,
  }, dependencies);
  assert.equal(proposal.outcome, 'rejected');

  const result = await confirmDecomposition(request(proposal.proposalId, []), dependencies);
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_not_decomposed');
  assert.equal(adapter.calls, 0);
});

test('confirmation is scoped: another scope cannot confirm this proposal', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  assert.equal(proposal.outcome, 'decomposed');
  if (proposal.outcome !== 'decomposed') return;

  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));
  const result = await confirmDecomposition(
    request(proposal.proposalId, decisions, { scopeId: 'scope-b' }),
    dependencies,
  );
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_not_found');
  assert.deepEqual(Object.keys(dependencies.persistence.snapshot().steps), []);
});

test('a step the user never ruled on invalidates the request instead of defaulting', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  const partial = proposal.steps.slice(0, 2).map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));
  const result = await confirmDecomposition(request(proposal.proposalId, partial), dependencies);
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'incomplete_decisions');
  assert.deepEqual(Object.keys(dependencies.persistence.snapshot().steps), []);
});

test('a decision naming a step outside the proposal is refused', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));
  const result = await confirmDecomposition(
    request(proposal.proposalId, [...decisions, { stepId: 'ghost', verdict: 'accept' }]),
    dependencies,
  );
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'unknown_step');
});

test('two rulings on one step are refused rather than last-write-wins', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));
  const result = await confirmDecomposition(
    request(proposal.proposalId, [...decisions, { stepId: proposal.steps[0].stepId, verdict: 'reject' }]),
    dependencies,
  );
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'duplicate_decision');
});

test('an edit to a blank title is refused', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  const decisions = proposal.steps.map((step, index): StepDecision =>
    index === 0
      ? { stepId: step.stepId, verdict: 'edit', editedTitle: '   ' }
      : { stepId: step.stepId, verdict: 'accept' });
  const result = await confirmDecomposition(request(proposal.proposalId, decisions), dependencies);
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'invalid_edit');
  assert.deepEqual(Object.keys(dependencies.persistence.snapshot().steps), []);
});

test('partial acceptance persists only the accepted and edited steps, and an edit keeps its span', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const [first, second, third] = proposal.steps;

  const result = await confirmDecomposition(request(proposal.proposalId, [
    { stepId: first.stepId, verdict: 'accept' },
    { stepId: second.stepId, verdict: 'edit', editedTitle: 'Post the invitations' },
    { stepId: third.stepId, verdict: 'reject' },
  ]), dependencies);

  assert.equal(result.success, true);
  assert.equal(result.replayed, false);
  assert.deepEqual(result.persistedStepIds, [first.stepId, second.stepId]);
  assert.deepEqual(result.rejectedStepIds, [third.stepId]);

  const persisted = dependencies.persistence.snapshot().steps;
  assert.deepEqual(Object.keys(persisted).sort(), [first.stepId, second.stepId].sort());
  assert.equal(persisted[second.stepId].title, 'Post the invitations');
  assert.deepEqual(persisted[second.stepId].sourceSpans, second.sourceSpans);
});

test('a rejected step drops the dependency edges that pointed at it', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const [first, second, third] = proposal.steps;
  assert.deepEqual(second.dependsOn.map((edge) => edge.dependsOnStepId), [first.stepId]);

  const result = await confirmDecomposition(request(proposal.proposalId, [
    { stepId: first.stepId, verdict: 'reject' },
    { stepId: second.stepId, verdict: 'accept' },
    { stepId: third.stepId, verdict: 'accept' },
  ]), dependencies);

  assert.equal(result.success, true);
  const persisted = dependencies.persistence.snapshot().steps;
  assert.deepEqual(persisted[second.stepId].dependsOn, []);
});

test('a replayed confirmation returns replayed:true and does not apply twice', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));

  const first = await confirmDecomposition(request(proposal.proposalId, decisions), dependencies);
  const second = await confirmDecomposition(request(proposal.proposalId, decisions), dependencies);

  assert.equal(first.success, true);
  assert.equal(first.replayed, false);
  assert.equal(second.success, true);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.persistedStepIds, first.persistedStepIds);
  assert.equal(Object.keys(dependencies.persistence.snapshot().steps).length, 3);
});

test('a different confirmation of a spent proposal is not a replay', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));

  await confirmDecomposition(request(proposal.proposalId, decisions), dependencies);
  const conflicting = await confirmDecomposition(
    request(proposal.proposalId, decisions, { idempotencyKey: 'a-different-key' }),
    dependencies,
  );
  assert.equal(conflicting.success, false);
  // `already_confirmed`, not `proposal_not_found`: the caller holds a real
  // proposal id and the reason its ruling was refused is that someone already
  // ruled. A caller told "not found" retries; this one must stop.
  assert.equal(conflicting.failureCode, 'already_confirmed');
  assert.equal(Object.keys(dependencies.persistence.snapshot().steps).length, 3);
});

test('an adapter failure leaves nothing persisted and does not spend the proposal', async () => {
  const adapter = countingAdapter('throw');
  const dependencies = { ...harness(adapter), persistence: adapter };
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));

  const failed = await confirmDecomposition(request(proposal.proposalId, decisions), dependencies);
  assert.equal(failed.success, false);
  assert.equal(failed.failureCode, 'persistence_failed');
  assert.deepEqual(failed.persistedStepIds, []);

  // A failed write must not look like a completed one on retry.
  const retried = await confirmDecomposition(request(proposal.proposalId, decisions), dependencies);
  assert.equal(retried.replayed, false);
  assert.equal(adapter.calls, 2);
});

test('the adapter evaluates the whole batch before committing any of it', async () => {
  const adapter = new TransactionalDecompositionPersistenceAdapter(createEmptyDecompositionState());
  const good: ConfirmedDecompositionStep = {
    stepId: 'a', proposalId: 'p', commitmentId: 'c', title: 'Book the venue',
    sourceSpans: [{ start: 0, end: 14, text: 'Book the venue' }],
    dependsOn: [], statedTiming: null, statedOwner: null,
  };
  const dangling: ConfirmedDecompositionStep = {
    ...good, stepId: 'b', title: 'Send invitations',
    dependsOn: [{ dependsOnStepId: 'never-persisted', kind: 'temporal' }],
  };

  await assert.rejects(adapter.persistAtomically([good, dangling]));
  assert.deepEqual(adapter.snapshot().steps, {}, 'the valid half of a failed batch must not survive');

  await adapter.persistAtomically([good]);
  assert.deepEqual(Object.keys(adapter.snapshot().steps), ['a']);
  await assert.rejects(adapter.persistAtomically([good]), 'a step id may not be persisted twice');
  assert.deepEqual(Object.keys(adapter.snapshot().steps), ['a']);
});

test('the adapter refuses an empty batch rather than reporting a successful no-op', async () => {
  const adapter = new TransactionalDecompositionPersistenceAdapter(createEmptyDecompositionState());
  await assert.rejects(adapter.persistAtomically([]));
});

test('a confirmation that accepts nothing is refused before it reaches the adapter', async () => {
  const adapter = countingAdapter('ok');
  const dependencies = { ...harness(adapter), persistence: adapter };
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');

  const result = await confirmDecomposition(request(
    proposal.proposalId,
    proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'reject' })),
  ), dependencies);
  assert.equal(result.success, true);
  assert.deepEqual(result.persistedStepIds, []);
  assert.equal(adapter.calls, 0, 'an all-rejected confirmation has nothing to write');
});

test('audit envelopes carry a hash and a length, never the text they describe', async () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    const dependencies = harness();
    const proposal = await proposeDecompositionBoundary(example.sourceText, {
      commitmentId: 'c1', scopeId: 'scope-a', now,
    }, dependencies);

    if (proposal.outcome === 'decomposed') {
      await confirmDecomposition(request(
        proposal.proposalId,
        proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' })),
      ), dependencies);
    }

    assert.ok(dependencies.events.length > 0, `${example.exampleId} produced no audit event`);
    const serialized = JSON.stringify(dependencies.events);
    assert.equal(
      serialized.includes(example.sourceText),
      false,
      `${example.exampleId}: raw source text reached an audit payload`,
    );
    for (const step of example.expectedSteps) {
      assert.equal(
        serialized.includes(step.title),
        false,
        `${example.exampleId}: a step title reached an audit payload`,
      );
    }
    assert.match(serialized, /"inputHash":"[0-9a-f]{64}"/);
    assert.match(serialized, /"inputLength":\d+/);
  }
});

test('the audit hash is of the input, so identical inputs correlate and different ones do not', async () => {
  const a = harness();
  const b = harness();
  const c = harness();
  await proposeWedding(a);
  await proposeWedding(b);
  await proposeWedding(c, goldenById('ar-multi-wedding').sourceText);
  assert.equal(a.events[0].fields.inputHash, b.events[0].fields.inputHash);
  assert.notEqual(a.events[0].fields.inputHash, c.events[0].fields.inputHash);
});

test('unreadable input is a failed attempt, not a finding that the commitment is one task', async () => {
  // `not_decomposable` is a claim *about the commitment*: "we read this and it
  // is one action". Saying that about input we never read — and auditing it as
  // a success — records a caller bug as a determination.
  const dependencies = harness();
  for (const bad of [null, undefined, 42, {}, [], true]) {
    const proposal = await proposeDecompositionBoundary(bad, {
      commitmentId: 'c1', scopeId: 'scope-a', now,
    }, dependencies);
    assert.equal(proposal.outcome, 'atomic');
    assert.equal(proposal.outcome === 'atomic' && proposal.reason, 'engine_unavailable');
    assert.equal(
      dependencies.events[dependencies.events.length - 1].fields.outcome,
      'failed',
      'an unreadable request is not a successful execution',
    );
  }
  assert.deepEqual(Object.keys(dependencies.persistence.snapshot().steps), []);
});

/* ── Concurrency (Blocker 2) ─────────────────────────────────────── */

test('two concurrent confirmations with different rulings cannot both apply', async () => {
  // The proposal was read, the guard passed, and control was yielded to the
  // adapter before anything was recorded — so a second confirmation arriving in
  // that window saw an unspent proposal. Both wrote, and every step rejected in
  // the first ruling became canonical anyway, which is exactly what
  // `everyStepNeedsExplicitDecision` exists to prevent. A UI double-submit is
  // enough to reach it.
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const [a, b, c] = proposal.steps.map((step) => step.stepId);

  const [first, second] = await Promise.all([
    confirmDecomposition(request(proposal.proposalId, [
      { stepId: a, verdict: 'accept' },
      { stepId: b, verdict: 'reject' },
      { stepId: c, verdict: 'reject' },
    ], { idempotencyKey: 'ruling-A' }), dependencies),
    confirmDecomposition(request(proposal.proposalId, [
      { stepId: a, verdict: 'reject' },
      { stepId: b, verdict: 'accept' },
      { stepId: c, verdict: 'accept' },
    ], { idempotencyKey: 'ruling-B' }), dependencies),
  ]);

  const winners = [first, second].filter((result) => result.success);
  assert.equal(winners.length, 1, 'exactly one ruling may apply');
  assert.deepEqual(
    Object.keys(dependencies.persistence.snapshot().steps).sort(),
    winners[0].persistedStepIds.slice().sort(),
    'nothing outside the winning ruling may be persisted',
  );
  const loser = [first, second].find((result) => !result.success);
  assert.equal(loser?.replayed, false);
});

test('a concurrent double-submit of the same ruling applies once and replays', async () => {
  const dependencies = harness();
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));

  const [first, second] = await Promise.all([
    confirmDecomposition(request(proposal.proposalId, decisions), dependencies),
    confirmDecomposition(request(proposal.proposalId, decisions), dependencies),
  ]);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.deepEqual(first.persistedStepIds, second.persistedStepIds);
  assert.equal([first, second].filter((result) => result.replayed).length, 1, 'one of the two is a replay');
  assert.equal(Object.keys(dependencies.persistence.snapshot().steps).length, 3);
});

test('a concurrent confirmation that fails to persist leaves the proposal retryable', async () => {
  let calls = 0;
  const adapter: DecompositionPersistenceAdapter = {
    async persistAtomically() {
      calls += 1;
      throw new Error('adapter refused the batch');
    },
    snapshot: () => createEmptyDecompositionState(),
  };
  const dependencies = { ...harness(adapter), persistence: adapter };
  const proposal = await proposeWedding(dependencies);
  if (proposal.outcome !== 'decomposed') throw new Error('setup');
  const decisions = proposal.steps.map((step): StepDecision => ({ stepId: step.stepId, verdict: 'accept' }));

  const results = await Promise.all([
    confirmDecomposition(request(proposal.proposalId, decisions), dependencies),
    confirmDecomposition(request(proposal.proposalId, decisions), dependencies),
  ]);
  assert.deepEqual(results.map((result) => result.failureCode), ['persistence_failed', 'persistence_failed']);

  // The claim must be released, or a genuine retry would answer with a replay
  // of a batch that never landed.
  const retried = await confirmDecomposition(
    request(proposal.proposalId, decisions, { idempotencyKey: 'a-fresh-key' }),
    dependencies,
  );
  assert.equal(retried.failureCode, 'persistence_failed');
  assert.equal(retried.replayed, false);
  assert.ok(calls >= 2);
});
