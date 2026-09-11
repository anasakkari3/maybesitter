import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    assert.equal(session?.participantId, 'victim', 'the session changed hands');
    assert.ok(
      (session?.stages ?? []).some((s) => s.stage === 'input_received'),
      'the victim lost the stage they recorded',
    );
  });
});

test('a session id cannot write outside the trace directory', () => {
  // Asserting only that `get` returns null would pass even if the write
  // landed outside the store, so this watches the filesystem instead.
  const dataDir = mkdtempSync(join(tmpdir(), 'alpha-trace-ownership-'));
  const parent = dirname(dataDir);
  const before = new Set(readdirSync(parent));
  try {
    const store = createFileAlphaTraceStore({ dataDir });
    try {
      store.append('../escaped', 'attacker', stage('input_received'));
    } catch {
      // Refusing outright is a valid outcome; the filesystem check still runs.
    }
    const created = readdirSync(parent).filter((entry) => !before.has(entry));
    assert.deepEqual(created, [], `a traversing session id created ${created.join(', ')} outside the store`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
