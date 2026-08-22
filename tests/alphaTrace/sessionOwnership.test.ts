import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileAlphaTraceStore } from '../../lib/alphaTrace/alphaTraceStore';
import { stage as traceStage } from '../../lib/alphaTrace/traceRecorder';

function withStore(run: (store: ReturnType<typeof createFileAlphaTraceStore>) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'alpha-trace-ownership-'));
  try {
    run(createFileAlphaTraceStore({ dataDir }));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const stage = (name: 'input_received' | 'extraction_completed') =>
  traceStage(name, { inputText: 'my private medical note' });

test('a second participant cannot take over an existing trace session', () => {
  withStore((store) => {
    store.append('session-1', 'victim', stage('input_received'));

    // The attacker appends to a session id they do not own. Whatever the store
    // decides to do, it must not hand them the session.
    try {
      store.append('session-1', 'attacker', stage('input_received'));
    } catch {
      // Refusing outright is a valid outcome.
    }

    const session = store.get('session-1');
    assert.notEqual(
      session?.participantId,
      'attacker',
      'appending to another participant\'s session transferred ownership to the caller',
    );
  });
});

test("a hijack attempt cannot expose the original participant's recorded text", () => {
  withStore((store) => {
    store.append('session-2', 'victim', stage('input_received'));
    try {
      store.append('session-2', 'attacker', stage('extraction_completed'));
    } catch {
      // Refusing outright is a valid outcome.
    }

    const session = store.get('session-2');
    const readableByAttacker = session?.participantId === 'attacker' ? session.stages : [];
    assert.deepEqual(
      readableByAttacker,
      [],
      'the attacker ended up owning stages recorded by the victim',
    );
  });
});

test('a session id cannot escape the trace directory', () => {
  withStore((store) => {
    // A traversing id must not resolve to a path outside the store.
    try {
      store.append('../escaped', 'attacker', stage('input_received'));
    } catch {
      return; // Refusing is the correct behaviour.
    }
    assert.equal(
      store.get('../escaped'),
      null,
      'a traversing session id was accepted and is readable',
    );
  });
});
