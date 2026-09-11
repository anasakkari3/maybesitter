/**
 * The local-disk boundary, enumerated (UC-1.0c, #142).
 *
 * Before this migration, nineteen non-test call sites across sixteen modules
 * reached `resolveDataDir()` and wrote to the local filesystem. UC-1.0c moved
 * most of them onto the storage adapter and left four on disk on purpose.
 *
 * The problem with "most of them" is that it decays. A future change can add a
 * seventeenth caller, or quietly revive one of the twelve, and every other
 * test in this repo would stay green — the code works perfectly on a laptop.
 * It only fails in production, where Cloud Run gives each instance its own
 * filesystem and deletes it with the revision.
 *
 * So the boundary is a registry rather than a promise. Every module that
 * reaches `resolveDataDir` must appear in `GUARDED` **and** actually call
 * `assertNotCloudRun`; every module in `MIGRATED` must no longer reach it at
 * all. A new caller in neither list fails the build, which is the whole point:
 * whoever adds one has to come here and say which kind it is.
 *
 * Both directions are checked deliberately. Asserting only "guarded callers
 * are guarded" would let a revert slip a `resolveDataDir` back into a migrated
 * store unnoticed, and asserting only the totals would let one module be
 * swapped for another.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFilesUnder } from './importClosure.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

/** The module that defines it. Not a caller. */
const DEFINITION = 'lib/runtime/dataDir.ts';

/**
 * Still on the local filesystem, deliberately, and therefore guarded.
 *
 * Each entry records why it was not migrated. "It is only used offline" is not
 * enough on its own — `assertNotCloudRun` is what makes that true at runtime
 * rather than by convention.
 */
const GUARDED: Readonly<Record<string, string>> = {
  'lib/priority/annotation/decisionStore.ts':
    'offline annotation tooling over a reviewer corpus that is not user data',
  'src/server/dataStore.ts':
    'legacy single-user web store; every row is SINGLE_USER_ID, so there is no user tree to key',
  'src/domain/memory/commitmentMemoryStore.ts':
    'legacy web store superseded by users/{uid}/commitments',
  'src/domain/memory/observationStore.ts':
    'legacy web store superseded by users/{uid}/memory',
};

/**
 * Moved onto the storage adapter (or de-persisted outright) by UC-1.0c, and
 * asserted to stay moved. A `resolveDataDir` reappearing in any of these is a
 * durability regression that no behavioural test would catch.
 */
const MIGRATED: readonly string[] = [
  'lib/runtimeMemory/runtimeMemoryStore.ts',
  'lib/feedback/feedbackEventStore.ts',
  'lib/personalizationControls/consentStore.ts',
  'lib/release/consentStore.ts',
  'lib/release/studyStore.ts',
  'lib/alphaTrace/alphaTraceStore.ts',
  'lib/alphaFeedback/alphaFeedbackStore.ts',
  'lib/services/behaviorFeedbackService.ts',
  'lib/services/pressureService.ts',
  'lib/services/clarificationStore.ts',
  // De-persisted rather than migrated: the global domain-state file is gone
  // and the state is now openly per-process. It still guards its bootstrap.
  'lib/services/commandService.ts',
  // Only used resolveDataDir to name a throwaway state file for test resets,
  // which no longer exist now that commandService keeps no file.
  'lib/services/mobile/mobileCaptureService.ts',
];

function read(file: string): string {
  return readFileSync(join(repoRoot, file), 'utf8');
}

function callsResolveDataDir(source: string): boolean {
  return /\bresolveDataDir\b/.test(source);
}

/** Every non-test module under lib/ and src/ that reaches resolveDataDir. */
function currentCallers(): string[] {
  return [...sourceFilesUnder(join(repoRoot, 'lib')), ...sourceFilesUnder(join(repoRoot, 'src'))]
    .map((file) => file.slice(repoRoot.length + 1))
    .filter((file) => file !== DEFINITION)
    .filter((file) => callsResolveDataDir(read(file)))
    .sort();
}

test('the registry names real files, so a rename cannot empty it silently', () => {
  for (const file of [DEFINITION, ...Object.keys(GUARDED), ...MIGRATED]) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} is in the registry but does not exist`);
  }
  // If this ever reads zero the two directions below both pass vacuously.
  assert.ok(Object.keys(GUARDED).length > 0, 'the guarded list is empty; the scan would prove nothing');
  assert.ok(MIGRATED.length > 0, 'the migrated list is empty; the scan would prove nothing');
});

test('every module that reaches resolveDataDir is classified as guarded', () => {
  const unclassified = currentCallers().filter((file) => !(file in GUARDED));
  assert.deepEqual(
    unclassified,
    [],
    'these modules write to the local filesystem and are in neither list. On Cloud Run that '
      + 'filesystem is per-instance and is deleted with the revision, so the write is lost and no '
      + 'test says so. Either move the module onto lib/storage and add it to MIGRATED, or call '
      + 'assertNotCloudRun at its first use and add it to GUARDED with the reason.',
  );
});

test('every guarded module actually calls assertNotCloudRun', () => {
  // Listing a module as guarded is a claim; this is the check on the claim.
  for (const [file, why] of Object.entries(GUARDED)) {
    const source = read(file);
    assert.ok(
      /\bassertNotCloudRun\s*\(/.test(source),
      `${file} is registered as guarded (${why}) but never calls assertNotCloudRun, `
        + 'so on Cloud Run it would write to a disappearing filesystem and report success',
    );
  }
});

test('every guarded module is still a caller, so a stale entry is noticed', () => {
  // A module that stopped touching the disk should move to MIGRATED. Leaving
  // it in GUARDED would let the next real caller inherit a rubber-stamped slot.
  const callers = new Set(currentCallers());
  for (const file of Object.keys(GUARDED)) {
    assert.ok(
      callers.has(file),
      `${file} no longer reaches resolveDataDir; move it from GUARDED to MIGRATED`,
    );
  }
});

test('no migrated module has quietly gone back to the local filesystem', () => {
  const reverted = MIGRATED.filter((file) => callsResolveDataDir(read(file)));
  assert.deepEqual(
    reverted,
    [],
    'these modules were moved off the local filesystem by UC-1.0c and now reach resolveDataDir '
      + 'again. Every one of them holds user data, which on Cloud Run would be written to an '
      + 'instance-local disk and lost on the next deploy.',
  );
});

test('commandService keeps guarding its shared, user-less state', () => {
  // It is in MIGRATED because its domain-state file is gone, not because it
  // became safe: the in-process state it still keeps is shared across every
  // user, so the bootstrap stays refused on Cloud Run.
  const source = read('lib/services/commandService.ts');
  assert.ok(
    /\bassertNotCloudRun\s*\(/.test(source),
    'commandService still holds process-global domain state and must refuse to bootstrap on Cloud Run',
  );
});
