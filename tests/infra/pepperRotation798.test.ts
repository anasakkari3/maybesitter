/**
 * Deploys keep the previous deletion pepper while a rotation is active (#798).
 *
 * `infra/cloudrun/flags.sh` mounts secrets with `--set-secrets`, which replaces
 * the whole set, and staging deploys on every merge. A PREVIOUS mapping added
 * by hand would be dropped by the next unrelated deploy, hiding every tombstone
 * written under the old key (#794). So the mapping comes from the committed
 * `infra/cloudrun/pepper-rotation.env`, and these tests run the real script
 * against fixture copies of that file (`MAYBESITTER_PEPPER_ROTATION_FILE`).
 *
 * Static checks, like the rest of tests/infra: no project is needed and no
 * gcloud command runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repoRoot, 'infra/cloudrun/flags.sh');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

const PEPPER = 'MAYBESITTER_DELETION_RECEIPT_PEPPER';
const PREVIOUS = 'MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS';
const WRITE = 'MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE';
const SECRET = 'maybesitter-deletion-receipt-pepper';

type Target = 'staging' | 'production';
type State = Record<`${Target}_${'phase' | 'current_version' | 'previous_version'}`, string>;

const STEADY: State = {
  staging_phase: 'steady',
  staging_current_version: 'latest',
  staging_previous_version: '',
  production_phase: 'steady',
  production_current_version: 'latest',
  production_previous_version: '',
};

function stateFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pepper-rotation-798-'));
  const path = join(dir, 'pepper-rotation.env');
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const render = (state: State) => Object.entries(state).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';

/** flags.sh against a rotation state; null file means the committed one. */
function run(target: Target, content: string | null): { status: number | null; stdout: string; stderr: string } {
  const fixture = content === null ? null : stateFile(content);
  try {
    const env = { ...process.env };
    delete env.MAYBESITTER_PEPPER_ROTATION_FILE;
    if (fixture) env.MAYBESITTER_PEPPER_ROTATION_FILE = fixture.path;
    const result = spawnSync('bash', [script, target], { encoding: 'utf8', env });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fixture?.cleanup();
  }
}

function flags(target: Target, state: State | null): string {
  const result = run(target, state === null ? null : render(state));
  assert.equal(result.status, 0, `flags.sh ${target} failed: ${result.stderr}`);
  return result.stdout;
}

function secretsOf(printed: string): Map<string, string> {
  const words = printed.trim().split(/\s+/).filter((word) => word.startsWith('--set-secrets='));
  assert.equal(words.length, 1, 'exactly one --set-secrets word');
  const secrets = new Map<string, string>();
  for (const pair of words[0]!.slice('--set-secrets='.length).split(',')) {
    const at = pair.indexOf('=');
    assert.ok(!secrets.has(pair.slice(0, at)), `${pair.slice(0, at)} is mounted twice`);
    secrets.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return secrets;
}

function envOf(printed: string): Map<string, string> {
  const match = printed.match(/--update-env-vars=\^;\^(\S+)/);
  assert.ok(match, 'no ^;^-delimited --update-env-vars');
  const env = new Map<string, string>();
  for (const pair of match[1]!.split(';')) env.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
  return env;
}

test('the committed state is steady: one pepper, no PREVIOUS, writes current, on both services', () => {
  for (const target of ['staging', 'production'] as const) {
    const printed = flags(target, null);
    const secrets = secretsOf(printed);
    assert.equal(secrets.get(PEPPER), `${SECRET}:latest`, target);
    assert.equal(secrets.has(PREVIOUS), false, `${target} mounts a previous pepper with no rotation active`);
    assert.equal(envOf(printed).get(WRITE), 'current', target);
  }
  // The fixture STEADY is the committed file, so the tests below vary only what they name.
  const committed = new Map(read('infra/cloudrun/pepper-rotation.env').split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const));
  assert.deepEqual(committed, new Map(Object.entries(STEADY)));
});

test('phase 1 (readers) mounts both pinned versions and keeps writing the old key', () => {
  const printed = flags('staging', { ...STEADY, staging_phase: 'readers', staging_current_version: '3', staging_previous_version: '2' });
  const secrets = secretsOf(printed);
  assert.equal(secrets.get(PEPPER), `${SECRET}:3`);
  assert.equal(secrets.get(PREVIOUS), `${SECRET}:2`, 'phase 1 dropped the previous pepper');
  assert.equal(envOf(printed).get(WRITE), 'previous', 'phase 1 writes the new key before older revisions can read it');
  // A secret is never a plain env value, and the other secrets are untouched.
  assert.equal(envOf(printed).has(PREVIOUS), false);
  assert.equal(secrets.size, 5);
});

test('phase 2 (writer) keeps PREVIOUS and switches writes to the new key', () => {
  const printed = flags('production', { ...STEADY, production_phase: 'writer', production_current_version: '3', production_previous_version: '2' });
  const secrets = secretsOf(printed);
  assert.equal(secrets.get(PEPPER), `${SECRET}:3`);
  assert.equal(secrets.get(PREVIOUS), `${SECRET}:2`, 'phase 2 dropped the previous pepper');
  assert.equal(envOf(printed).get(WRITE), 'current');
});

test('each service follows its own state: a rotating staging does not leak into production, or back', () => {
  const state: State = { ...STEADY, staging_phase: 'writer', staging_current_version: '3', staging_previous_version: '2', production_current_version: '2' };
  const staging = flags('staging', state);
  const production = flags('production', state);
  assert.equal(secretsOf(staging).get(PREVIOUS), `${SECRET}:2`);
  assert.equal(secretsOf(production).has(PREVIOUS), false);
  assert.equal(secretsOf(production).get(PEPPER), `${SECRET}:2`, 'production picked up staging\'s new key');
  assert.equal(envOf(production).get(WRITE), 'current');
});

test('returning to steady drops PREVIOUS and writes WRITE=current explicitly, so a merged env cannot keep `previous`', () => {
  const printed = flags('staging', { ...STEADY, staging_current_version: '3' });
  assert.equal(secretsOf(printed).has(PREVIOUS), false);
  assert.equal(secretsOf(printed).get(PEPPER), `${SECRET}:3`);
  // --update-env-vars merges: omitting WRITE would leave `previous` on the service.
  assert.match(read('infra/cloudrun/flags.sh'), /--update-env-vars=/);
  assert.equal(envOf(printed).get(WRITE), 'current');
});

test('a malformed rotation state fails the deploy instead of guessing', () => {
  const bad: Array<[string, string]> = [
    ['latest during a rotation', render({ ...STEADY, staging_phase: 'readers', staging_previous_version: '2' })],
    ['previous latest', render({ ...STEADY, staging_phase: 'readers', staging_current_version: '3', staging_previous_version: 'latest' })],
    ['rotating to the same version', render({ ...STEADY, staging_phase: 'writer', staging_current_version: '2', staging_previous_version: '2' })],
    ['a missing previous version', render({ ...STEADY, staging_phase: 'readers', staging_current_version: '3' })],
    ['steady with a previous version', render({ ...STEADY, staging_previous_version: '2' })],
    ['an unknown phase', render({ ...STEADY, staging_phase: 'phase1' })],
    ['a broken production line (checked on a staging deploy too)', render({ ...STEADY, production_phase: 'writer' })],
    ['a missing key', render(STEADY).replace('production_previous_version=\n', '')],
    ['a duplicated key', render(STEADY) + 'staging_phase=steady\n'],
    ['an unknown key', render(STEADY) + 'staging_write=current\n'],
    ['a value that is not letters or digits', render(STEADY).replace('staging_current_version=latest', 'staging_current_version=3;FOO=1')],
    ['a CRLF file', render(STEADY).replace(/\n/g, '\r\n')],
    ['a line that is not KEY=VALUE', render(STEADY) + 'staging_phase\n'],
  ];
  for (const [name, content] of bad) {
    const result = run('staging', content);
    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.equal(result.stdout, '', `${name} still printed flags`);
    assert.match(result.stderr, /pepper-rotation\.env/, name);
  }

  const env = { ...process.env, MAYBESITTER_PEPPER_ROTATION_FILE: join(tmpdir(), 'no-such-pepper-rotation-798.env') };
  const missing = spawnSync('bash', [script, 'staging'], { encoding: 'utf8', env });
  assert.notEqual(missing.status, 0, 'a missing rotation file was accepted');
});

test('the names flags.sh mounts are the names the deletion code reads', () => {
  const source = read('lib/account/deletionTombstone.ts');
  for (const name of [PEPPER, PREVIOUS, WRITE]) {
    assert.match(source, new RegExp(`= '${name}';`), `lib/account/deletionTombstone.ts no longer reads ${name}`);
  }
  // And the workflow runs flags.sh from the repository checkout, where the
  // committed state is, as an assignment of its own (see the test below).
  assert.match(read('.github/workflows/deploy.yml'), /^\s*FLAGS="\$\(bash infra\/cloudrun\/flags\.sh "\$\{TARGET\}"\)"$/m);
});

test('no runbook fetches the pepper by `latest`, which a rotation makes a key no live revision reads', () => {
  for (const file of ['docs/operations/ACCOUNT_DELETION.md', 'docs/operations/GCP_BOOTSTRAP.md', 'docs/operations/DEPLOY.md', 'scripts/delete-account.ts']) {
    const fetches = read(file).split('\n').filter((line) => /versions access\s+latest\b[^\n]*deletion-receipt-pepper|deletion-receipt-pepper[^\n]*versions access\s+latest\b/.test(line));
    assert.deepEqual(fetches, [], `${file} fetches the deletion pepper by latest`);
  }
  // The operator recipe reads the versions the service mounts instead.
  assert.match(read('docs/operations/ACCOUNT_DELETION.md'), /ref MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS/);
});

/** The workflow's deploy step, as the shell script GitHub would run. */
function deployStepScript(): string {
  const workflow = read('.github/workflows/deploy.yml');
  const start = workflow.indexOf('- name: Deploy (behind a tag once the service exists)');
  assert.notEqual(start, -1, 'the deploy step was renamed; point this test at it');
  const step = workflow.slice(start, workflow.indexOf('- name:', workflow.indexOf('\n', start)));
  const body = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length);
  return body
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
    // The only expression in the step is the image digest.
    .replace(/\$\{\{[^}]*\}\}/g, 'europe-west1-docker.pkg.dev/p/r/api@sha256:' + 'a'.repeat(64));
}

test('the deploy step fails, and deploys nothing, when flags.sh refuses the rotation state', () => {
  // Under `bash -e` (GitHub's default `run` shell) a failing $(...) inside
  // another command's arguments is ignored: `gcloud run deploy` would run with
  // no flags, the revision would inherit the old env and secrets, and the job
  // would go green. The step must capture flags.sh on its own first.
  const script = deployStepScript();
  const dir = mkdtempSync(join(tmpdir(), 'deploy-step-798-'));
  try {
    const log = join(dir, 'calls.log');
    // `services describe` says the service exists; `run deploy` records each argument on its own line.
    writeFileSync(join(dir, 'gcloud'), [
      '#!/usr/bin/env bash',
      'if [ "$1 $2" = "run deploy" ]; then printf \'%s\\n\' "$@" >>"${CALL_LOG}"; fi',
      'exit 0',
    ].join('\n'));
    spawnSync('chmod', ['755', join(dir, 'gcloud')]);

    const runStep = (state: string, shellFlags: string[]) => {
      rmSync(log, { force: true });
      const rotation = join(dir, 'pepper-rotation.env');
      writeFileSync(rotation, state);
      const result = spawnSync('bash', [...shellFlags, '-c', script], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          TARGET: 'staging',
          REGION: 'europe-west1',
          GITHUB_SHA: 'c0ffee0123456789',
          GITHUB_OUTPUT: join(dir, 'github-output'),
          CALL_LOG: log,
          MAYBESITTER_PEPPER_ROTATION_FILE: rotation,
        } as unknown as NodeJS.ProcessEnv,
      });
      let args: string[] = [];
      try { args = readFileSync(log, 'utf8').trim().split('\n'); } catch { /* never called */ }
      return { status: result.status, args };
    };

    for (const shellFlags of [['-e'], ['--noprofile', '--norc', '-eo', 'pipefail']]) {
      const refused = runStep(render({ ...STEADY, staging_phase: 'readers' }), shellFlags);
      assert.notEqual(refused.status, 0, `the deploy step went green on a refused rotation state (bash ${shellFlags.join(' ')})`);
      assert.deepEqual(refused.args, [], `gcloud run deploy ran without flags (bash ${shellFlags.join(' ')})`);

      // And a valid state reaches gcloud as separate words, exactly what flags.sh printed.
      const rotating = { ...STEADY, staging_phase: 'readers', staging_current_version: '3', staging_previous_version: '2' } satisfies State;
      const ok = runStep(render(rotating), shellFlags);
      assert.equal(ok.status, 0, `the deploy step failed on a valid state (bash ${shellFlags.join(' ')})`);
      const printed = flags('staging', rotating).trim().split(/\s+/);
      assert.deepEqual(ok.args.slice(ok.args.length - printed.length), printed, 'gcloud did not receive the flags as flags.sh printed them');
      assert.ok(ok.args.includes('--no-traffic'), 'the existing-service path lost its traffic flags');
      assert.equal(secretsOf(ok.args.find((arg) => arg.startsWith('--set-secrets='))!).get(PREVIOUS), `${SECRET}:2`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
