/**
 * A write to the staging database is invisible in (default) (UC-1.0a #140).
 *
 * Selecting the database from the environment is only worth something if the
 * two databases are really separate from the adapter's point of view. This
 * writes through a staging-bound adapter and reads the same path through a
 * default-bound one, against the Firestore emulator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { DATABASE_ENV_VAR } from '../../lib/storage/firestoreAdapter.ts';

function bindTo(database: string | undefined) {
  if (database === undefined) delete process.env[DATABASE_ENV_VAR];
  else process.env[DATABASE_ENV_VAR] = database;
  resetFirestoreForTests();
  return createFirestoreStorage();
}

test('firestore: a document written to staging does not exist in (default)', async () => {
  const previous = process.env[DATABASE_ENV_VAR];
  const path = `isolation/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    const staging = bindTo('staging');
    await staging.set(path, { written: 'staging' });
    assert.deepEqual(await staging.get(path), { written: 'staging' });

    const production = bindTo(undefined);
    assert.equal(await production.get(path), null, 'the staging write is visible in (default)');

    await bindTo('staging').delete(path);
  } finally {
    if (previous === undefined) delete process.env[DATABASE_ENV_VAR];
    else process.env[DATABASE_ENV_VAR] = previous;
    resetFirestoreForTests();
  }
});
