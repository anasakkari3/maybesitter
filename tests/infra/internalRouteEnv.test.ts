/**
 * Every environment variable an internal route reads is set by an infra
 * script (#810).
 *
 * `/api/internal/m5a-controls` authorized its caller from
 * `MAYBESITTER_DEPLOYER_SA_EMAIL`, and nothing in `infra/` set it, so
 * m5a-controls-init, m5a-enable and m5a-kill answered 503 `not_configured` on
 * every environment. Nobody could see it without calling the deployed route.
 *
 * The scan sees direct reads in the route files (`process.env.X`,
 * `process.env['X']`) and the shared OIDC check's `*_ENV_VAR` constants. It
 * does not follow `lib/` helpers a route imports, so the second test keeps the
 * route files themselves to direct reads: a destructured or aliased
 * `process.env` there would hide a variable from the scan.
 *
 * A variable counts as set when `infra/cloudrun/flags.sh` puts it on the
 * service for *both* environments (the internal routes run in both), or when
 * `infra/scheduler.sh` sets it with `--update-env-vars`. Static checks only,
 * like the rest of tests/infra: no project is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');
const internalRoot = join(repoRoot, 'src', 'app', 'api', 'internal');
const DEPLOYER_VAR = 'MAYBESITTER_DEPLOYER_SA_EMAIL';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Variables each internal route reads, directly or through the shared OIDC check. */
function internalRouteReads(): Map<string, string[]> {
  const oidcVars = Array.from(read('lib/auth/schedulerOidc.ts').matchAll(/export const \w+_ENV_VAR = '([A-Z0-9_]+)'/g), (match) => match[1]);
  assert.ok(oidcVars.length >= 2, 'lib/auth/schedulerOidc.ts no longer names its variables as *_ENV_VAR constants');

  const reads = new Map<string, string[]>();
  const add = (name: string, file: string) => reads.set(name, [...(reads.get(name) ?? []), file]);
  for (const path of sourceFiles(internalRoot)) {
    const source = readFileSync(path, 'utf8');
    const file = relative(repoRoot, path);
    for (const match of Array.from(source.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g))) {
      add(match[1] ?? match[2], file);
    }
    if (/\bauthorizeSchedulerRequest\b/.test(source)) for (const name of oidcVars) add(name, file);
  }
  return reads;
}

function flagsEnv(target: 'staging' | 'production'): Map<string, string> {
  const output = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), target], { encoding: 'utf8' });
  const env = new Map<string, string>();
  const update = output.match(/--update-env-vars=\^;\^(\S+)/);
  assert.ok(update, `flags.sh ${target} has no ^;^-delimited --update-env-vars`);
  for (const pair of update[1].split(';')) {
    const at = pair.indexOf('=');
    env.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const secrets = output.match(/--set-secrets=(\S+)/);
  for (const pair of secrets?.[1].split(',') ?? []) env.set(pair.slice(0, pair.indexOf('=')), '<secret>');
  return env;
}

function schedulerSets(): Set<string> {
  const names = new Set<string>();
  for (const match of Array.from(read('infra/scheduler.sh').matchAll(/--update-env-vars="([^"]+)"/g))) {
    for (const pair of match[1].split(',')) names.add(pair.slice(0, pair.indexOf('=')));
  }
  assert.ok(names.size > 0, 'infra/scheduler.sh no longer sets anything with --update-env-vars="…"');
  return names;
}

test('every variable an internal route reads is set by flags.sh (both environments) or scheduler.sh', () => {
  const reads = internalRouteReads();
  assert.ok(reads.has(DEPLOYER_VAR), `the scan no longer finds ${DEPLOYER_VAR} in src/app/api/internal; it is broken or the route moved`);

  const staging = flagsEnv('staging');
  const production = flagsEnv('production');
  const scheduler = schedulerSets();
  const unset = Array.from(reads)
    .filter(([name]) => !(scheduler.has(name) || (staging.has(name) && production.has(name))))
    .map(([name, files]) => `${name} (read by ${Array.from(new Set(files)).join(', ')})`);
  assert.deepEqual(unset, [], 'an internal route reads a variable no infra script sets, so it answers 503 on every environment');
});

test('both services name maybesitter-deployer as the M5a controls caller, and scheduler.sh checks the same account', () => {
  for (const target of ['staging', 'production'] as const) {
    assert.equal(
      flagsEnv(target).get(DEPLOYER_VAR),
      'maybesitter-deployer@maybesitter-app.iam.gserviceaccount.com',
      `flags.sh ${target} does not set ${DEPLOYER_VAR} to the deployer account`,
    );
  }

  // The account bootstrap.sh creates, the account flags.sh sets and the
  // account scheduler.sh --check expects must be the same string.
  const definition = /^DEPLOYER_SA="maybesitter-deployer@\$\{PROJECT_ID\}\.iam\.gserviceaccount\.com"$/m;
  for (const file of ['infra/bootstrap.sh', 'infra/cloudrun/flags.sh', 'infra/scheduler.sh']) {
    assert.match(read(file), definition, `${file} defines a different deployer account`);
  }
  assert.match(read('infra/scheduler.sh'), /select\(\.name == "MAYBESITTER_DEPLOYER_SA_EMAIL"\)/, 'scheduler.sh --check no longer reads the deployer variable');
});

test('internal route files read process.env only directly, so the scan above sees every read', () => {
  const indirect = sourceFiles(internalRoot).flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    const forms = [/process\.env\?\./, /process\.env\s*\[\s*[^'"\s]/, /=\s*process\.env\s*(?:[;,)\n]|$)/m, /\}\s*=\s*process\.env\b/];
    return forms.some((form) => form.test(source)) ? [relative(repoRoot, path)] : [];
  });
  assert.deepEqual(indirect, [], 'an internal route destructures, aliases or computes a process.env read; read each variable as process.env.NAME so the infra check can see it');
});
