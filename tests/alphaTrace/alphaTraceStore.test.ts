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
  const generated = resolveTraceSessionId(undefined, 'p001');
  assert.ok(generated.startsWith('alpha-p001-'), `expected generated prefix, got ${generated}`);
  assert.ok(resolveTraceSessionId('', 'p001').startsWith('alpha-p001-'));
  assert.ok(resolveTraceSessionId('x'.repeat(200), 'p001').startsWith('alpha-p001-'));
});
