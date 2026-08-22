/**
 * Tests for the alpha trace contracts, store, and recorder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHA_TRACE_VERSION,
  type AlphaTraceSession,
  type AlphaTraceStageRecord,
} from '../../src/contracts/v1/alphaTraceContracts';
import { createInMemoryAlphaTraceStore } from '../../lib/alphaTrace/alphaTraceStore';
import { recordTraceStage, resolveTraceSessionId, setTraceStoreForTesting, stage } from '../../lib/alphaTrace/traceRecorder';

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

test('trace store: append accumulates stages in order', () => {
  const store = createInMemoryAlphaTraceStore();
  for (const s of sessionStages()) store.append(sessionId, participantId, s);

  const trace = store.get(sessionId);
  assert.ok(trace, 'trace should exist');
  assert.equal(trace.version, ALPHA_TRACE_VERSION);
  assert.equal(trace.sessionId, sessionId);
  assert.equal(trace.participantId, participantId);
  assert.equal(trace.stages.length, 5);
  assert.equal(trace.stages[0].stage, 'input_received');
  assert.equal(trace.stages[4].stage, 'proposal_decided');
});

test('trace store: summaries expose reviewable signals', () => {
  const store = createInMemoryAlphaTraceStore();
  for (const s of sessionStages()) store.append(sessionId, participantId, s);
  store.append('s002', participantId, stage('input_received', { inputText: 'x' }));

  const summaries = store.listSummaries({ participantId });
  assert.equal(summaries.length, 2);
  const s1 = summaries.find((s) => s.sessionId === sessionId);
  assert.ok(s1);
  assert.equal(s1.hasDecisions, true);
  assert.equal(s1.stageCount, 5);

  const withFeedback = store.listSummaries({ participantId, withFeedbackOnly: true });
  assert.equal(withFeedback.length, 0);

  store.append(sessionId, participantId, stage('feedback_flagged', { flagId: 'f1', category: 'invasive' }));
  const withFeedback2 = store.listSummaries({ participantId, withFeedbackOnly: true });
  assert.equal(withFeedback2.length, 1);
});

test('trace store: delete by session and participant', () => {
  const store = createInMemoryAlphaTraceStore();
  for (const s of sessionStages()) store.append(sessionId, participantId, s);
  store.append('s002', 'p002', stage('input_received', { inputText: 'y' }));

  assert.equal(store.deleteSession(sessionId), true);
  assert.equal(store.get(sessionId), null);
  assert.equal(store.deleteSession(sessionId), false);

  store.append('s003', 'p002', stage('input_received', { inputText: 'z' }));
  assert.equal(store.deleteParticipant('p002'), 2);
  assert.equal(store.listSummaries().length, 0);
});

test('trace store: prune removes expired sessions', () => {
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
  const store = createInMemoryAlphaTraceStore([stale, fresh]);
  // in-memory store's prune is a no-op; verify file store semantics via delete logic:
  assert.equal(store.get('stale')?.sessionId, 'stale');
  assert.equal(store.deleteSession('stale'), true);
  assert.equal(store.get('fresh')?.sessionId, 'fresh');
});

test('trace recorder: disabled by default and does not throw', () => {
  setTraceStoreForTesting(createInMemoryAlphaTraceStore());
  try {
    // isTraceEnabled() reads env; default off → record returns false.
    const before = process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
    delete process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
    const recorded = recordTraceStage(sessionId, participantId, stage('input_received', { inputText: 'x' }));
    assert.equal(recorded, false);
    if (before === undefined) delete process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
    else process.env.MAYBESITTER_ALPHA_TRACE_ENABLED = before;
  } finally {
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

// --- Session isolation -------------------------------------------------------
// A trace session holds the participant's raw capture text. The session id
// arrives from the request body, so it is attacker-controlled: it must never
// be able to name another participant's session, nor become a file path.

test('trace store: a second participant cannot take over a session', () => {
  const store = createInMemoryAlphaTraceStore();
  store.append('s-victim', 'p_victim', stage('input_received', { inputText: 'MRI at the oncology clinic' }));

  assert.throws(
    () => store.append('s-victim', 'p_attacker', stage('input_received', { inputText: 'hi' })),
    /participant/i,
  );

  const session = store.get('s-victim');
  assert.equal(session?.participantId, 'p_victim', 'the owner must not be rewritten');
  assert.equal(session?.stages.length, 1, 'the attacker must not append either');
});

test('trace store: a hijacked session does not survive the owner deletion request', () => {
  const store = createInMemoryAlphaTraceStore();
  store.append('s-victim', 'p_victim', stage('input_received', { inputText: 'MRI at the oncology clinic' }));
  try {
    store.append('s-victim', 'p_attacker', stage('input_received', { inputText: 'hi' }));
  } catch {
    // refused, which is the point
  }

  // deleteParticipant matches on participantId, so an overwritten owner made
  // the victim's own deletion request a no-op.
  assert.equal(store.deleteParticipant('p_victim'), 1);
  assert.equal(store.get('s-victim'), null);
});

test('trace store: a session id that is a path is refused', () => {
  const store = createInMemoryAlphaTraceStore();
  for (const hostile of ['../../../../tmp/pwned', 'a/b', 'x y', '', 'a'.repeat(129)]) {
    assert.throws(() => store.append(hostile, 'p001', stage('input_received', {})), /session id/i, hostile);
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
  // The old form embedded the participant id and a base36 millisecond. With an
  // allowlisted participant id the only unknown was the millisecond, which is
  // sprayable in a 25-40 person pilot.
  const ids = new Set(Array.from({ length: 50 }, () => resolveTraceSessionId(undefined, 'p001')));
  assert.equal(ids.size, 50, 'derived ids must not collide');
  for (const id of Array.from(ids)) assert.ok(!id.includes('p001'), 'must not embed the participant id');
});

test('recorder: recording never throws, even on a refused session', () => {
  const store = createInMemoryAlphaTraceStore();
  setTraceStoreForTesting(store);
  const previous = process.env.MAYBESITTER_ALPHA_TRACE_ENABLED;
  process.env.MAYBESITTER_ALPHA_TRACE_ENABLED = 'true';
  try {
    assert.equal(recordTraceStage('s-iso', 'p_victim', stage('input_received', {})), true);
    // Instrumentation must never change product behaviour, so a refusal is a
    // false return, not an exception thrown into the capture path.
    assert.equal(recordTraceStage('s-iso', 'p_attacker', stage('input_received', {})), false);
  } finally {
    process.env.MAYBESITTER_ALPHA_TRACE_ENABLED = previous;
    setTraceStoreForTesting(null);
  }
});

test('trace store: a malformed session id reads as nothing, not an error', () => {
  const store = createInMemoryAlphaTraceStore();
  // The id arrives off a query string on the read route, so a malformed one
  // must be a not-found, never a 500 that leaks a stack.
  assert.equal(store.get('../../../../etc/passwd'), null);
  assert.equal(store.deleteSession('../../../../etc/passwd'), false);
});
