/**
 * Account deletion reaches every place a user's data lives (UC-1.0c #142).
 *
 * `lib/storage/paths.ts` promises that a collection added without appearing in
 * `USER_SCOPED_COLLECTIONS` is caught here. Seeding the listed collections
 * cannot keep that promise on its own — an unlisted collection is never
 * seeded, so it is never checked. So this file checks the list itself against
 * the code, in both of the ways a collection gets named: a constant in
 * `paths.ts`, and a string literal handed straight to `userCol`/`userSubDoc`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { USER_SCOPED_COLLECTIONS } from '../../lib/storage/paths.ts';
import { sourceFilesUnder } from './importClosure.ts';
import { assertDeleteTreeCoversEveryUserCollection } from './deletionCoverageSuite.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const listed = new Set<string>(USER_SCOPED_COLLECTIONS);

/**
 * Collection constants that are deliberately not inside a user's tree.
 *
 * `LLM_USAGE` is the service's own daily model spend (#160): a count per UTC
 * day and nothing else, with no uid in it. The per-account half of that guard
 * is `USAGE`, which *is* user-scoped and goes with the tree.
 *
 * `FIXTURES` is a football match (football fixtures MVP, Task 5): shared
 * public data about a game, not a fact about any one account, so it is
 * declared in `lib/account/topLevelUserData.ts`'s
 * `TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA` instead of here. `FOOTBALL_FOLLOWS`
 * and `EXTERNAL_TASK_REFS` are the per-account halves of this feature and
 * *are* user-scoped, so they stay out of this set and go with the tree.
 *
 * `FOOTBALL_CLUB_SYNC_STATE` is when a curated club was last synced
 * (football fixtures MVP, Task 9): keyed by clubId, holding no uid and
 * nothing a person typed, also declared in
 * `TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA` for the same reason `FIXTURES`
 * is.
 */
const NOT_USER_SCOPED = new Set([
  'USERS',
  'INCIDENTS',
  'LLM_USAGE',
  'FIXTURES',
  'FOOTBALL_CLUB_SYNC_STATE',
  // Website tester sign-ups and their rate-limit window: no uid exists for
  // either. Declared in `lib/account/topLevelUserData.ts`, the sign-ups as
  // pre-account personal data deleted on request, the window as holding none.
  'EARLY_ACCESS_REGISTRATIONS',
  'EARLY_ACCESS_RATE_LIMITS',
]);

test('deleteTree(users/U) leaves nothing of U in any user collection, and nothing of V is lost', async () => {
  await assertDeleteTreeCoversEveryUserCollection(createMemoryStorage(), 'user_U', 'user_V');
});

test('every collection constant in paths.ts is either user-scoped or deliberately outside the user tree', () => {
  const source = readFileSync(join(repoRoot, 'lib/storage/paths.ts'), 'utf8');
  const constants = Array.from(source.matchAll(/^export const ([A-Z_]+) = '([A-Za-z]+)';$/gm));
  assert.ok(constants.length >= USER_SCOPED_COLLECTIONS.length, 'parsed too few constants; this check would be vacuous');

  const unlisted = constants
    .filter(([, name]) => !NOT_USER_SCOPED.has(name!))
    .map(([, name, value]) => `${name} = '${value}'`)
    .filter((entry) => !listed.has(entry.split("'")[1]!));
  assert.deepEqual(unlisted, [], 'a collection constant is missing from USER_SCOPED_COLLECTIONS, so deletion would skip it');
});

test('no code writes a user collection by a literal name the deletion list does not know', () => {
  const files = [...sourceFilesUnder(join(repoRoot, 'lib')), ...sourceFilesUnder(join(repoRoot, 'src'))];
  assert.ok(files.length > 50, 'scanned too few source files; this check would be vacuous');

  const literal = /\buser(?:Col|SubDoc)\(\s*[^,()]+,\s*'([A-Za-z_]+)'/g;
  const unknown: string[] = [];
  for (const file of files) {
    for (const match of Array.from(readFileSync(file, 'utf8').matchAll(literal))) {
      if (!listed.has(match[1]!)) unknown.push(`${file.slice(repoRoot.length + 1)}: '${match[1]}'`);
    }
  }
  assert.deepEqual(unknown, [], 'these user collections would survive account deletion');
});
