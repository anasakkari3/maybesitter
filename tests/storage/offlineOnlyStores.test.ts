/**
 * The offline-only stores stay offline (UC-1.0c, #142).
 *
 * Two modules deliberately kept writing to the local filesystem when
 * everything else moved onto the storage adapter:
 *
 *   - `lib/priority/annotation/decisionStore.ts` — annotation tooling run by a
 *     reviewer on a laptop, over a corpus that is not user data;
 *   - `lib/operations/pilotDataBackup.ts` — pilot backup/restore, superseded
 *     for the launch path by UC-1.0a (#140)'s PITR.
 *
 * Both are fine where they run and wrong in a request handler: Cloud Run's
 * filesystem is per-instance and vanishes with the revision. `assertNotCloudRun`
 * turns that into a loud failure, but a guard only fires once someone has
 * already shipped the import. This test is the earlier line — it fails at
 * `npm test`, on the commit that adds the import, rather than in production.
 *
 * The walk is transitive on purpose. A direct-import check would pass the day
 * someone re-exports `decisionStore` through a barrel file, which is exactly
 * how the defect that motivated the closure in
 * `tests/decomposition/boundaryImportClosure.test.ts` got in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importClosure, resolveLocal, sourceFilesUnder } from './importClosure.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const appDir = join(repoRoot, 'src', 'app');

/** The modules that may only ever run offline, as repo-relative paths. */
const OFFLINE_ONLY = [
  'lib/priority/annotation/decisionStore.ts',
  'lib/operations/pilotDataBackup.ts',
] as const;

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

test('the offline-only modules exist, so this guard is never vacuous', () => {
  for (const file of OFFLINE_ONLY) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} is missing; update OFFLINE_ONLY`);
  }
  assert.ok(existsSync(appDir), 'src/app is missing; this guard would scan nothing');
  assert.ok(sourceFilesUnder(appDir).length > 0, 'src/app has no source files to scan');
});

test('the closure walks past the first hop, so it is not a direct-import check in disguise', () => {
  const roots = sourceFilesUnder(appDir);
  const closure = importClosure(roots);
  const directlyImported = new Set(
    roots.flatMap((file) => (closure.get(file) ?? [])
      .map((specifier) => resolveLocal(file, specifier))
      .filter((resolved): resolved is string => resolved !== null)),
  );
  assert.ok(
    Array.from(closure.keys()).some((file) => !roots.includes(file) && !directlyImported.has(file)),
    'expected the closure to reach at least one module more than one hop away',
  );
});

test('no file under src/app transitively imports an offline-only store', () => {
  const closure = importClosure(sourceFilesUnder(appDir));
  const reached = Array.from(closure.keys()).map(relative);

  for (const offline of OFFLINE_ONLY) {
    assert.equal(
      reached.includes(offline),
      false,
      `${offline} is reachable from src/app; it writes to the local filesystem, `
        + 'which on Cloud Run is per-instance and lost on every revision',
    );
  }
});
