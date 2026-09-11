/**
 * Tests for the alpha trace contracts, store, and recorder (UC-1.0c, #142).
 *
 * ── One case was removed, deliberately ───────────────────────────
 *
 * "deletion reaches a file whose contents disagree with its name" is gone with
 * the files. It existed because the store wrote `<sessionId>.trace.json` and
 * trusted the *filename* over the record, so anything written before session
 * ids were validated could carry a different id inside and be unreachable by
 * deletion. There is no filename now: a trace is looked up by its `sessionId`
 * field through a collection-group query, so the name and the contents cannot
 * disagree. The property that replaces it — deletion reaches every session a
 * participant owns — is asserted directly below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHA_TRACE_VERSION,
  type AlphaTraceSession,
  type AlphaTraceStageRecord,
} from '../../src/contracts/v1/alphaTraceContracts';
import {
  StorageAlphaTraceStore,
  createInMemoryAlphaTraceStore,
} from '../../lib/alphaTrace/alphaTraceStore.ts';
import { recordTraceStage, resolveTraceSessionId, setTraceStoreForTesting, stage } from '../../lib/alphaTrace/traceRecorder.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';

const participantId = 'p001';
const sessionId = 's001';

function sessionStages(): AlphaTraceStageRecord[] {
  return [
    stage('input_received', { inputText: 'Remind me to call Maya tomorrow' }),
    stage('extraction_completed', { engine: 'rule-based', type: 'task', title: 'Call Maya', disposition: 'auto_confirm' }),
    stage('commitment_created', { commitmentId: 'c001', title: 'Call Maya' }),
    stage('recommendation_generated', { proposalId: 'pr001', state: 'ready', arm: 'baseline' }),
    stage('proposal_decided', { proposalId: 'pr001', decision: 'edit', originalTitle: 'Call Maya', editedTitle: 'Call Maya at 10' }),
  ];
}

test('trace store: append accumulates stages in order', async () => {
  const store = createInMemoryAlphaTraceStore();
  for (const s of sessionStages()) await store.append(sessionId, participantId, s);

  const trace = await store.get(sessionId);
  assert.ok(trace, 'trace should exist');
  assert.equal(trace.version, ALPHA_TRACE_VERSION);
  assert.equal(trace.sessionId, sessionId);
  assert.equal(trace.participantId, participantId);
  assert.equal(trace.stages.length, 5);
  assert.equal(trace.stages[0].stage, 'input_received');
  assert.equal(trace.stages[4].stage, 'proposal_decided');
});

test('trace store: summaries expose reviewable signals', async () => {
  const store = createInMemoryAlphaTraceStore();
  for (const s of sessionStages()) await store.append(sessionId, participantId, s);
  await store.append('s002', participantId, stage('input_received', { inputText: 'x' }));

  const summaries = await store.listSummaries({ participantId });
  assert.equal(summaries.length, 2);
  const s1 = summaries.find((s) => s.sessionId === sessionId);
  assert.ok(s1);
  assert.equal(s1.hasDecisions, true);
  assert.equal(s1.stageCount, 5);

  assert.equal((await store.listSummaries({ participantId, withFeedbackOnly: true })).length, 0);

  await store.append(sessionId, participantId, stage('feedback_flagged', { flagId: 'f1', category: 'invasive' }));
  assert.equal((await store.listSummaries({ participantId, withFeedbackOnly: true })).length, 1);
});

test('trace store: delete by session and participant', async () => {
  const store = createInMemoryAlphaTraceStore();
  for (const s of sessionStages()) await store.append(sessionId, participantId, s);
  await store.append('s002', 'p002', stage('input_received', { inputText: 'y' }));

  assert.equal(await store.deleteSession(sessionId), true);
  assert.equal(await store.get(sessionId), null);
  assert.equal(await store.deleteSession(sessionId), false);

  await store.append('s003', 'p002', stage('input_received', { inputText: 'z' }));
  assert.equal(await store.deleteParticipant('p002'), 2);
  assert.equal((await store.listSummaries()).length, 0);
});

test('trace store: prune removes sessions past the retention window', async () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
  const stale: AlphaTraceSession = {
    version: ALPHA_TRACE_VERSION,
    sessionId: 'stale',
    participantId: 'p009',
    createdAt: old,
    updatedAt: old,
    stages: [stage('input_received', { inputText: 'old' })],
  };
  const fresh: AlphaTraceSession = {
    version: ALPHA_TRACE_VERSION,
    sessionId: 'fresh',
    participantId: 'p009',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages: [stage('input_received', { inputText: 'new' })],
  };
  // Unlike the old in-memory store, whose prune() was a silent no-op, this is
  // the same implementation production runs.
  const store = createInMemoryAlphaTraceStore([stale, fresh]);

  assert.equal(await store.prune(), 1);
  assert.equal(await store.get('stale'), null);
  assert.equal((await store.get('fresh'))?.sessionId, 'fresh');
});

test('trace store: a trace written through one handle is read through a fresh one', async () => {
  // The simulated restart. Raw capture text used to live on a per-instance
  // disk, so a second instance could not see it at all.
  const shared = createMemoryStorage();
  const writer = new StorageAlphaTraceStore({ storage: shared });
  const reader = new StorageAlphaTraceStore({ storage: shared });

  await writer.append('s-durable', 'p010', stage('input_received', { inputText: 'MRI at the oncology clinic' }));

  const seen = await reader.get('s-durable');
  assert.equal(seen?.participantId, 'p010', 'the trace did not survive the handle');
  assert.equal(seen?.stages.length, 1);
});

test('trace store: deletion reaches every session a participant owns', async () => {
  const store = createInMemoryAlphaTraceStore();
  await store.append('a1', 'p_victim', stage('input_received', { inputText: 'one' }));
  await store.append('a2', 'p_victim', stage('input_received', { inputText: 'two' }));
  await store.append('b1', 'p_other', stage('input_received', { inputText: 'three' }));

  assert.equal(await store.deleteParticipant('p_victim'), 2);
  assert.equal(await store.get('a1'), null);
  assert.equal(await store.get('a2'), null);
  assert.equal((await store.get('b1'))?.participantId, 'p_other', 'another participant was deleted too');
});

test('trace recorder: disabled by default and does not throw', async () => {
  setTraceStoreForTesting(createInMemoryAlphaTraceStore());
  const before = process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
  try {
    delete process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
    assert.equal(await recordTraceStage(sessionId, participantId, stage('input_received', { inputText: 'x' })), false);
  } finally {
    if (before === undefined) delete process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
    else process.env.MAYBESITTER_ALPHA_TRACE_ENABLED = before;
    setTraceStoreForTesting(null);
  }
});

test('trace recorder: session id resolution', () => {
  assert.equal(resolveTraceSessionId('my-session', 'p001'), 'my-session');

  // A usable client value is honoured; anything else gets a derived id. This
  // used to assert the derived form began `alpha-p001-`, which is exactly the
  // guessability that made another participant's session addressable -- so the
  // shape is deliberately no longer pinned, only that an id is produced.
  for (const unusable of [undefined, '', 'x'.repeat(200)]) {
    const generated = resolveTraceSessionId(unusable, 'p001');
    assert.ok(generated.startsWith('alpha-'), `expected generated prefix, got ${generated}`);
    assert.match(generated, /^[A-Za-z0-9_-]{1,128}$/);
  }
});

test('recorder: a client session id that is not a plain token is replaced', () => {
  for (const hostile of ['../../../../tmp/pwned', 'a/b', 'has space', 'a'.repeat(129)]) {
    const resolved = resolveTraceSessionId(hostile, 'p001');
    assert.notEqual(resolved, hostile, hostile);
    assert.match(resolved, /^[A-Za-z0-9_-]{1,128}$/);
  }
});

test('recorder: an ordinary client session id is still honoured', () => {
  assert.equal(resolveTraceSessionId('alpha-p001-abc123', 'p001'), 'alpha-p001-abc123');
});

test('recorder: a derived session id is not guessable from the participant id', () => {
  const ids = new Set(Array.from({ length: 50 }, () => resolveTraceSessionId(undefined, 'p001')));
  assert.equal(ids.size, 50, 'derived ids must not collide');
  for (const id of Array.from(ids)) assert.ok(!id.includes('p001'), 'must not embed the participant id');
});

test('recorder: recording never throws, even on a refused session', async () => {
  setTraceStoreForTesting(createInMemoryAlphaTraceStore());
  const previous = process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
  process.env.MAYBESITTER_ALPHA_TRACE_ENABLED = 'true';
  try {
    assert.equal(await recordTraceStage('s-iso', 'p_victim', stage('input_received', {})), true);
    // Instrumentation must never change product behaviour, so a refusal is a
    // false return, not an exception thrown into the capture path.
    assert.equal(await recordTraceStage('s-iso', 'p_attacker', stage('input_received', {})), false);
  } finally {
    process.env.MAYBESITTER_ALPHA_TRACE_ENABLED = previous;
    setTraceStoreForTesting(null);
  }
});

test('trace store: a malformed session id reads as nothing, not an error', async () => {
  const store = createInMemoryAlphaTraceStore();
  // The id arrives off a query string on the read route, so a malformed one
  // must be a not-found, never a 500 that leaks a stack.
  assert.equal(await store.get('../../../../etc/passwd'), null);
  assert.equal(await store.deleteSession('../../../../etc/passwd'), false);
});
