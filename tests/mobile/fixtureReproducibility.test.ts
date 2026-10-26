import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The mobile API fixtures are written by the exporter, so they must be a pure
// function of the code: two exports give the same bytes, and those bytes are
// the tracked files. This runs the exporter into scratch directories, never
// into the tracked ones.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRACKED = join(ROOT, 'mobile', 'src', 'api', '__fixtures__');

function exportInto(directory: string): void {
  // This test runs under `node --test`, which marks its children with
  // NODE_TEST_CONTEXT. The child would then report as a test-runner subprocess
  // instead of running the export, so the variable is removed.
  const env: NodeJS.ProcessEnv = { ...process.env, MAYBESITTER_FIXTURE_DIR: directory };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--loader', './scripts/ts-resolver.mjs',
      '--import', './tests/support/isolateProcess.mjs',
      '--test', 'tests/mobile/exportMobileApiFixtures.test.ts',
    ],
    {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    `the fixture export exited ${result.status}:\n${(result.stdout ?? '').slice(-2_000)}\n${result.stderr ?? ''}`,
  );
}

function jsonNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
}

test('two exports write identical bytes, and those bytes are the tracked fixtures', () => {
  // Not under os.tmpdir(): the child process's isolation wrapper points TMPDIR
  // at a directory it deletes on exit, which would take this scratch with it.
  const scratch = join(ROOT, 'node_modules', '.cache', 'fixture-reproducibility', String(process.pid));
  mkdirSync(scratch, { recursive: true });
  try {
    const first = join(scratch, 'first');
    const second = join(scratch, 'second');
    exportInto(first);
    exportInto(second);

    const names = jsonNames(first);
    assert.ok(names.length > 0, 'the export wrote no fixtures');
    assert.deepEqual(jsonNames(second), names, 'the two exports wrote different file sets');
    // The mobile client's endpoint and schema tests read these two, and no
    // exporter writes them, so they are kept by hand and sit outside the set.
    const handWritten = ['habit.created.json', 'pilot.incident.json'];
    assert.deepEqual(
      jsonNames(TRACKED).filter((name) => !names.includes(name)),
      handWritten,
      'a tracked fixture that the exporter does not write has appeared or gone',
    );

    for (const name of names) {
      const exported = readFileSync(join(first, name));
      assert.ok(exported.equals(readFileSync(join(second, name))), `${name} differs between two exports`);
      assert.ok(exported.equals(readFileSync(join(TRACKED, name))), `${name} differs from the tracked fixture`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // Leave no empty directory behind once the last of several runs is done.
    try {
      rmdirSync(join(ROOT, 'node_modules', '.cache', 'fixture-reproducibility'));
    } catch {
      // Another run may still be using the parent.
    }
  }
});
