import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, isAbsolute } from 'node:path';

// First in `npm test`. If tests/support/isolateProcess.mjs was not preloaded,
// every other file would share the OS temp dir, the checkout's .maybesitter and
// the shell's zone, and fail (or pass) depending on what else was running. This
// says so before anything else runs.

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

test('the data dir is a per-process temp dir, not the checkout', () => {
  const dataDir = process.env.MAYBESITTER_DATA_DIR;
  assert.ok(dataDir, 'MAYBESITTER_DATA_DIR is unset: the suite was run without --import ./tests/support/isolateProcess.mjs');
  assert.equal(inside(dataDir, process.cwd()), false, `MAYBESITTER_DATA_DIR ${dataDir} is inside the checkout`);
  assert.equal(dirname(process.env.MAYBESITTER_DOMAIN_STATE_FILE ?? ''), dataDir);
  assert.equal(dirname(process.env.MAYBESITTER_PILOT_TRUST_FILE ?? ''), dataDir);
});

test('os.tmpdir() is inside the same per-process root', () => {
  const root = dirname(process.env.MAYBESITTER_DATA_DIR ?? '');
  assert.ok(root.includes(`maybesitter-test-${process.pid}-`), `the isolation root ${root} does not belong to this process`);
  assert.ok(tmpdir().startsWith(root), `os.tmpdir() ${tmpdir()} is not under the isolation root ${root}`);
});

test('the zone is pinned', () => {
  assert.equal(process.env.TZ, process.env.MAYBESITTER_TEST_TZ || 'UTC');
  if (!process.env.MAYBESITTER_TEST_TZ) {
    // The runtime actually applied it, not just the variable: UTC has no offset.
    assert.equal(new Date('2026-07-01T12:00:00Z').getTimezoneOffset(), 0);
    assert.equal(new Date('2026-01-01T12:00:00Z').getTimezoneOffset(), 0);
  }
});
