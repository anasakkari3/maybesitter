/**
 * The staging database exists everywhere it is used (UC-1.0a #140, UC-1.0d #143).
 *
 * `infra/cloudrun/flags.sh` pointed the staging service at a Firestore
 * database named `staging`, while `infra/bootstrap.sh` created only
 * `(default)`, `infra/verify.sh` checked only `(default)`, `firebase.json`
 * deployed rules and indexes only to `(default)` — and the adapter ignored the
 * setting altogether, so staging would have used production's database. Four
 * places had to agree and none of them checked the others. This does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { getFirestore } from 'firebase-admin/firestore';
import { getAdminApp } from '../../lib/firebase/admin.ts';
import {
  DATABASE_ENV_VAR,
  DEFAULT_DATABASE,
  resolveFirestoreDatabaseId,
} from '../../lib/storage/firestoreAdapter.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

/** What `flags.sh <target>` sets, as the running service would see it. */
function serviceEnv(target: 'staging' | 'production'): Record<string, string> {
  const flags = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), target], { encoding: 'utf8' });
  // Either verb: the deploy merges (--update-env-vars) so it cannot erase
  // what infra/scheduler.sh sets. What this test cares about is which
  // database each service is pointed at, not how the flag is spelled.
  const match = /--(?:set|update)-env-vars=(\S+)/.exec(flags);
  assert.ok(match, `flags.sh ${target} sets no env vars`);
  // gcloud's `^D^` prefix (`gcloud topic escaping`) picks the pair delimiter;
  // flags.sh uses `^;^` because one value is a comma-separated list.
  let value = match[1]!;
  let delimiter = ',';
  const custom = /^\^([^^]+)\^/.exec(value);
  if (custom) {
    delimiter = custom[1]!;
    value = value.slice(custom[0].length);
  }
  return Object.fromEntries(value.split(delimiter).map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)] as [string, string];
  }));
}

/** The `FIRESTORE_DATABASES=(...)` list in a shell script. */
function scriptDatabases(file: string): string[] {
  const match = /^FIRESTORE_DATABASES=\((.*)\)$/m.exec(read(file));
  assert.ok(match, `${file} has no FIRESTORE_DATABASES list`);
  return Array.from(match[1]!.matchAll(/'([^']+)'/g), (m) => m[1]!);
}

const ENVIRONMENTS = ['staging', 'production'] as const;

test('each service is paired with the database its environment requires', () => {
  const expected = { staging: 'staging', production: DEFAULT_DATABASE };
  for (const target of ENVIRONMENTS) {
    const env = serviceEnv(target);
    assert.equal(resolveFirestoreDatabaseId(env), expected[target], `flags.sh ${target}`);
  }
});

test('every database a service uses is created, verified, and gets rules and indexes', () => {
  const used = new Set(ENVIRONMENTS.map((target) => serviceEnv(target)[DATABASE_ENV_VAR]!));
  const created = new Set(scriptDatabases('infra/bootstrap.sh'));
  const verified = new Set(scriptDatabases('infra/verify.sh'));
  const deployed = new Set((JSON.parse(read('firebase.json')).firestore as Array<{ database: string }>).map((entry) => entry.database));

  for (const database of Array.from(used)) {
    assert.ok(created.has(database), `infra/bootstrap.sh does not create ${database}`);
    assert.ok(verified.has(database), `infra/verify.sh does not check ${database}`);
    assert.ok(deployed.has(database), `firebase.json deploys no rules or indexes to ${database}`);
  }
  assert.deepEqual(Array.from(created).sort(), Array.from(verified).sort(), 'bootstrap.sh and verify.sh disagree');
});

test('bootstrap re-applies PITR and delete protection to every database on every run', () => {
  const script = read('infra/bootstrap.sh');
  assert.match(script, /databases update --database="\$\{database\}" --enable-pitr --delete-protection/);
});

test('the post-create update is retried, because a new database is briefly busy', () => {
  // First real run: `update` right after `create` failed with
  // "ABORTED: There are concurrent database changes".
  assert.match(read('infra/bootstrap.sh'), /retry \d+ \d+ gcloud firestore databases update/);
});

test('staging on the production database is refused, not defaulted', () => {
  // The failure this guards is silent: (default) exists, so readiness passes
  // and staging test accounts write into production.
  assert.throws(() => resolveFirestoreDatabaseId({ MAYBESITTER_ENV: 'staging' }), /production data/);
  assert.throws(() => resolveFirestoreDatabaseId({ MAYBESITTER_ENV: 'staging', [DATABASE_ENV_VAR]: DEFAULT_DATABASE }), /production data/);
  assert.throws(() => resolveFirestoreDatabaseId({ MAYBESITTER_ENV: 'production', [DATABASE_ENV_VAR]: 'staging' }), /must use/);
});

test('the database id is resolved from the environment, defaulting only outside staging', () => {
  assert.equal(resolveFirestoreDatabaseId({}), DEFAULT_DATABASE);
  assert.equal(resolveFirestoreDatabaseId({ [DATABASE_ENV_VAR]: '  staging  ' }), 'staging');
  assert.equal(resolveFirestoreDatabaseId({ MAYBESITTER_ENV: 'development', [DATABASE_ENV_VAR]: 'staging' }), 'staging');
  assert.equal(resolveFirestoreDatabaseId({ MAYBESITTER_ENV: 'production' }), DEFAULT_DATABASE);
  for (const bad of ['Staging', 'abc', 'has space', '../x', 'ends-', '(DEFAULT)']) {
    assert.throws(() => resolveFirestoreDatabaseId({ [DATABASE_ENV_VAR]: bad }), /must be/, JSON.stringify(bad));
  }
});

test('independent route modules configure the shared Firestore client only once', async (t) => {
  const previousDatabase = process.env[DATABASE_ENV_VAR];
  const previousEnvironment = process.env.MAYBESITTER_ENV;
  process.env[DATABASE_ENV_VAR] = 'route-reload-test';
  process.env.MAYBESITTER_ENV = 'development';
  const db = getFirestore(getAdminApp(), 'route-reload-test');
  // Exercise the SDK's real settings() guard without making a network call.
  const documents = t.mock.method(db, 'doc', () => {
    throw new Error('document read reached');
  });
  const modulePath = pathToFileURL(join(repoRoot, 'lib/storage/firestoreAdapter.ts'));
  // Separate evaluated copies reproduce independently compiled Next.js routes,
  // while their imports still share Firebase Admin's actual client singleton.
  const source = readFileSync(modulePath, 'utf8').replace(/from '([^']+)'/g, (_, specifier: string) => {
    const resolved = specifier.startsWith('.')
      ? new URL(`${specifier}.ts`, modulePath).href
      : import.meta.resolve(specifier);
    return `from '${resolved}'`;
  });
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  try {
    for (let copy = 0; copy < 2; copy += 1) {
      const encoded = Buffer.from(`${compiled}\n// route copy ${copy}`).toString('base64');
      const adapter = await import(`data:text/javascript;base64,${encoded}`) as typeof import('../../lib/storage/firestoreAdapter.ts');
      await assert.rejects(adapter.createFirestoreStorage().get('_health/probe'), /document read reached/);
    }
    assert.equal(documents.mock.callCount(), 2, 'both routes must reach storage without configuring the client twice');
  } finally {
    if (previousDatabase === undefined) delete process.env[DATABASE_ENV_VAR];
    else process.env[DATABASE_ENV_VAR] = previousDatabase;
    if (previousEnvironment === undefined) delete process.env.MAYBESITTER_ENV;
    else process.env.MAYBESITTER_ENV = previousEnvironment;
  }
});
