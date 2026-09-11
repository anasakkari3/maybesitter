/**
 * A trace session belongs to the participant who opened it (UC-1.0c, #142).
 *
 * A trace holds the participant's raw capture text, so session ownership is
 * the boundary that keeps one person's words out of another's read route. The
 * store used to rewrite `participantId` on every append while keeping the
 * existing stages, which meant anyone who guessed a session id became its
 * owner — and made the original owner's deletion request match nothing.
 *
 * ── What the third case checks now, and why it changed ───────────
 *
 * It used to watch the filesystem: a traversing session id like `../escaped`
 * could create a file outside the store's directory. There is no directory any
 * more, so watching one would be a test that cannot fail. The property that
 * survives the move is the one that mattered — a traversing id must be refused
 * and must create *nothing* — so the assertion is now that the store holds no
 * session at all afterwards, which is checkable against storage rather than
 * against a temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageAlphaTraceStore } from '../../lib/alphaTrace/alphaTraceStore.ts';
import { stage as traceStage } from '../../lib/alphaTrace/traceRecorder.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';

function store(): StorageAlphaTraceStore {
  return new StorageAlphaTraceStore({ storage: createMemoryStorage() });
}

const stage = (name: 'input_received' | 'extraction_completed') =>
  traceStage(name, { inputText: 'my private medical note' });

test('a second participant cannot take over an existing trace session', async () => {
  const traces = store();
  await traces.append('session-1', 'victim', stage('input_received'));

  // The attacker appends to a session id they do not own. Whatever the store
  // decides to do, it must not hand them the session.
  await assert.rejects(
    traces.append('session-1', 'attacker', stage('input_received')),
    /participant/i,
  );

  const session = await traces.get('session-1');
  assert.notEqual(
    session?.participantId,
    'attacker',
    "appending to another participant's session transferred ownership to the caller",
  );
});

test("a hijack attempt cannot expose the original participant's recorded text", async () => {
  const traces = store();
  await traces.append('session-2', 'victim', stage('input_received'));
  try {
    await traces.append('session-2', 'attacker', stage('extraction_completed'));
  } catch {
    // Refusing outright is the expected outcome; the state check still runs.
  }

  const session = await traces.get('session-2');
  assert.equal(session?.participantId, 'victim', 'the session changed hands');
  assert.ok(
    (session?.stages ?? []).some((s) => s.stage === 'input_received'),
    'the victim lost the stage they recorded',
  );
});

test('a traversing session id is refused and writes nothing', async () => {
  const traces = store();
  await assert.rejects(
    traces.append('../escaped', 'attacker', stage('input_received')),
    /session id/i,
  );

  // The load-bearing half: not merely that the read misses, but that no
  // document was created anywhere for it.
  assert.deepEqual(await traces.listSummaries(), [], 'a traversing session id created a trace');
  assert.equal(await traces.get('../escaped'), null);
});

test('a hijacked session still answers the owner deletion request', async () => {
  // deleteParticipant matches on participantId, so an overwritten owner used
  // to make the victim's own deletion request a no-op.
  const traces = store();
  await traces.append('session-3', 'victim', stage('input_received'));
  try {
    await traces.append('session-3', 'attacker', stage('input_received'));
  } catch {
    // refused, which is the point
  }

  assert.equal(await traces.deleteParticipant('victim'), 1);
  assert.equal(await traces.get('session-3'), null);
});
