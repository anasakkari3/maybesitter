/**
 * The index configuration matches the queries the code makes (UC-1.0c #142).
 *
 * The first real deploy failed with:
 *
 *   HTTP Error: 400, this index is not necessary,
 *   configure using single field index controls
 *
 * on `jobs/dedupeKey`. A single field inside one collection is indexed
 * automatically, so declaring it as a composite index is an error — while a
 * single field queried across a *collection group* is not automatic at all and
 * has to be a field override. The file had both kinds in the wrong place, and
 * nothing checked it against the queries, which is what this does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFilesUnder } from './importClosure.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string }> }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: Array<{ queryScope: string }> }>;
};

/** `listGroup(COLLECTION, { where: [['field', ...]] })` — the group queries that need an override. */
function groupQueriesInSource(): Array<{ collection: string; field: string; where: string }> {
  const found: Array<{ collection: string; field: string; where: string }> = [];
  const call = /listGroup<[^>]*>\(\s*([A-Z_]+)\s*,\s*\{[^}]*?where:\s*\[\[\s*'([^']+)'/g;
  for (const file of [...sourceFilesUnder(join(repoRoot, 'lib')), ...sourceFilesUnder(join(repoRoot, 'src'))]) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('storageAdapter.ts') || file.endsWith('memoryAdapter.ts') || file.endsWith('firestoreAdapter.ts')) continue;
    for (const match of Array.from(text.matchAll(call))) {
      found.push({ collection: match[1]!, field: match[2]!, where: `${file.slice(repoRoot.length + 1)}` });
    }
  }
  return found;
}

/** `MEMORY` -> `memory`: the constants in lib/storage/paths.ts. */
function collectionNames(): Record<string, string> {
  const paths = readFileSync(join(repoRoot, 'lib/storage/paths.ts'), 'utf8');
  return Object.fromEntries(Array.from(paths.matchAll(/^export const ([A-Z_]+) = '([A-Za-z]+)';$/gm), (m) => [m[1]!, m[2]!]));
}

test('no composite index declares a single field in one collection, which Firestore rejects', () => {
  const offenders = config.indexes
    .filter((index) => index.queryScope === 'COLLECTION' && index.fields.length < 2)
    .map((index) => `${index.collectionGroup}.${index.fields.map((f) => f.fieldPath).join(',')}`);
  assert.deepEqual(offenders, [], 'Firestore answers 400 "this index is not necessary" for these');
});

test('every filtered collection-group query has a COLLECTION_GROUP field override', () => {
  const names = collectionNames();
  const queries = groupQueriesInSource();
  assert.ok(queries.length >= 4, `expected to find the known group queries, found ${queries.length}`);

  for (const query of queries) {
    const collection = names[query.collection];
    assert.ok(collection, `unknown collection constant ${query.collection} in ${query.where}`);
    const override = config.fieldOverrides.find(
      (entry) => entry.collectionGroup === collection && entry.fieldPath === query.field,
    );
    assert.ok(override, `${query.where}: listGroup('${collection}') filters on '${query.field}' with no field override`);
    assert.ok(
      override.indexes.some((index) => index.queryScope === 'COLLECTION_GROUP'),
      `${collection}.${query.field} has an override but no COLLECTION_GROUP scope, so the query fails`,
    );
  }
});

test('the scheduler composite indexes match what claimDueJobs and recoverClaimedJobs query', () => {
  const store = readFileSync(join(repoRoot, 'lib/scheduler/storageSchedulerStore.ts'), 'utf8');
  const pairs = [
    ['status', 'runAt'],
    ['status', 'claimedAt'],
  ] as const;
  for (const [first, second] of pairs) {
    assert.match(store, new RegExp(`where: \\[\\['${first}', '==', [^\\]]+\\], \\['${second}', '<=',`), `no query uses ${first}+${second}`);
    assert.ok(
      config.indexes.some((index) =>
        index.collectionGroup === 'jobs' && index.fields.map((f) => f.fieldPath).join(',') === `${first},${second}`),
      `jobs is missing the ${first}+${second} composite index`,
    );
  }
});
