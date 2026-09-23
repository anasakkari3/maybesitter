/**
 * Nothing user-linked escapes deletion by living outside the tree (#149).
 *
 * `deleteTree('users/{uid}')` is thorough about everything beneath it and blind
 * to everything beside it. `jobs` carries its owner's uid in a field because the
 * scheduler queries all accounts at once; `incidents` does the same. Those are
 * reasonable designs, and each one is a place a person's data can survive them.
 *
 * `tests/storage/deletionCoverage.test.ts` already guards the collections
 * *inside* the tree. This is the other half: a new top-level collection has to
 * be either swept by the deletion engine or explicitly declared to hold nothing
 * about a person. Silence is what this file refuses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_SCOPED_COLLECTIONS } from '../../lib/storage/paths.ts';
import {
  TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA,
  TOP_LEVEL_PRE_ACCOUNT_COLLECTIONS,
  TOP_LEVEL_USER_COLLECTIONS,
} from '../../lib/account/topLevelUserData.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

/**
 * Collection-name constants a module exports, as the source declares them.
 *
 * Read from the text rather than imported, so a constant that exists but is
 * never referenced still counts — an unused collection name is exactly the kind
 * of thing that gets wired up later and forgotten here.
 */
function collectionConstants(file: string): string[] {
  return Array.from(
    read(file).matchAll(/^export const [A-Z_]+ = '([a-zA-Z][a-zA-Z0-9_]*)';$/gm),
    (match) => match[1]!,
  );
}

/** `users` is the tree itself, not a sibling of it. */
const THE_TREE = 'users';

test('every top-level collection is either swept by deletion or declared to hold no user data', () => {
  const declared = new Set<string>([
    ...TOP_LEVEL_USER_COLLECTIONS.map((entry) => entry.collection),
    ...TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA,
    ...TOP_LEVEL_PRE_ACCOUNT_COLLECTIONS.map((entry) => entry.collection),
    THE_TREE,
  ]);
  const userScoped = new Set<string>(USER_SCOPED_COLLECTIONS);

  const found = [
    ...collectionConstants('lib/storage/paths.ts'),
    ...collectionConstants('lib/scheduler/storageSchedulerStore.ts'),
    ...collectionConstants('lib/account/accountDeletion.ts'),
  ];
  assert.ok(found.length > USER_SCOPED_COLLECTIONS.length, 'no constants were parsed, so this would prove nothing');

  const unaccounted = found.filter((name) => !userScoped.has(name) && !declared.has(name));
  assert.deepEqual(
    unaccounted,
    [],
    `these top-level collections are neither deleted with an account nor declared free of user data: ${unaccounted.join(', ')}. `
      + 'Add them to TOP_LEVEL_USER_COLLECTIONS with the field holding the uid, or to '
      + 'TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA with the reason.',
  );
});

test('each swept collection names the field the sweep filters on', () => {
  // A registry entry with the wrong field name is worse than a missing one: the
  // sweep runs, finds nothing, and reports success.
  for (const entry of TOP_LEVEL_USER_COLLECTIONS) {
    assert.match(entry.collection, /^[a-z][A-Za-z0-9]*$/, `${entry.collection} is not a collection id`);
    assert.match(entry.field, /^[a-z][A-Za-z0-9]*$/, `${entry.collection} names no uid field`);
    assert.ok(entry.reason.length > 20, `${entry.collection} has no stated reason for living outside the tree`);
  }
});

test('each pre-account collection says why it exists and how it is deleted, and sits in no other list', () => {
  // Personal data with no uid: the account sweep cannot find it, so the only
  // honest declaration is one that names the route by which it *is* deleted.
  for (const entry of TOP_LEVEL_PRE_ACCOUNT_COLLECTIONS) {
    assert.match(entry.collection, /^[a-z][A-Za-z0-9]*$/, `${entry.collection} is not a collection id`);
    assert.ok(entry.reason.length > 20, `${entry.collection} has no stated reason for existing outside any account`);
    assert.ok(entry.deletion.length > 20, `${entry.collection} names no way for a person to have it deleted`);
    assert.ok(
      !TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA.includes(entry.collection),
      `${entry.collection} holds personal data and must not be declared free of it`,
    );
    assert.ok(
      !TOP_LEVEL_USER_COLLECTIONS.some((swept) => swept.collection === entry.collection),
      `${entry.collection} has no uid field for the account sweep to filter on`,
    );
  }
});

test('the deletion engine\'s own records are not swept as user data', () => {
  // They are keyed by the peppered subject hash and are the proof the deletion
  // happened. Deleting them as part of a deletion would erase the evidence.
  for (const name of ['accountDeletions', 'deletionReceipts']) {
    assert.ok(
      TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA.includes(name),
      `${name} must be declared as holding no user data`,
    );
    assert.ok(
      !TOP_LEVEL_USER_COLLECTIONS.some((entry) => entry.collection === name),
      `${name} must not be swept by the deletion it records`,
    );
  }
});
