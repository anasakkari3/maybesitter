/**
 * infra/cloudrun/private-staging-revision.sh (Wave D, lane D3).
 *
 * A private staging revision is the same image staging serves, with the full
 * staging settings plus a few overrides, behind a `qa-*` tag and with no
 * traffic. These tests run the real script in --dry-run only, against a fake
 * `gcloud` on PATH that logs its arguments and answers the two reads with
 * canned JSON. No real gcloud is ever called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repoRoot, 'infra/cloudrun/private-staging-revision.sh');
const flagsScript = join(repoRoot, 'infra/cloudrun/flags.sh');

const SERVICE = 'maybesitter-api-staging';
const SERVING = `${SERVICE}-00042-xyz`;
const DIGEST = `europe-west1-docker.pkg.dev/maybesitter-app/maybesitter/api@sha256:${'ab12'.repeat(16)}`;
const TAGGED_IMAGE = 'europe-west1-docker.pkg.dev/maybesitter-app/maybesitter/api:latest';
const SERVICE_URL = 'https://maybesitter-api-staging-abc123-ew.a.run.app';

const FAKE_GCLOUD = `#!/usr/bin/env bash
{ printf '%s\\n' "$@"; printf -- '--END--\\n'; } >>"\${FAKE_GCLOUD_LOG}"
case "$1 $2 $3" in
  "run services describe") cat "\${FAKE_SERVICE_JSON}" ;;
  "run revisions describe") cat "\${FAKE_REVISION_JSON}" ;;
  *) : ;;
esac
`;

interface Fixture {
  traffic?: Array<Record<string, unknown>>;
  revisionEnv?: Array<{ name: string; value: string }>;
  imageDigest?: string;
}

function serviceJson(fixture: Fixture) {
  return {
    metadata: { name: SERVICE },
    spec: { template: { spec: { containers: [{ image: TAGGED_IMAGE }] } } },
    status: {
      url: SERVICE_URL,
      traffic: fixture.traffic ?? [
        { revisionName: SERVING, percent: 100 },
        { revisionName: `${SERVICE}-00042-xyz`, percent: 0, tag: 'sha-1234567', url: `https://sha-1234567---maybesitter-api-staging-abc123-ew.a.run.app` },
        { revisionName: `${SERVICE}-00040-old`, percent: 0, tag: 'qa-old', url: `https://qa-old---maybesitter-api-staging-abc123-ew.a.run.app` },
      ],
    },
  };
}

function revisionJson(fixture: Fixture) {
  return {
    metadata: { name: SERVING },
    spec: {
      containers: [{
        image: TAGGED_IMAGE,
        env: fixture.revisionEnv ?? [
          { name: 'MAYBESITTER_ENV', value: 'staging' },
          { name: 'MAYBESITTER_FIRESTORE_DATABASE_ID', value: 'staging' },
        ],
      }],
    },
    status: { imageDigest: fixture.imageDigest ?? DIGEST },
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every fake gcloud call, as its argument list. */
  calls: string[][];
  /** Every command the dry run printed, as its argument list. */
  printed: string[][];
}

function run(args: string[], fixture: Fixture = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'private-revision-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'gcloud'), FAKE_GCLOUD);
    chmodSync(join(bin, 'gcloud'), 0o755);
    const log = join(dir, 'gcloud.log');
    writeFileSync(join(dir, 'service.json'), JSON.stringify(serviceJson(fixture)));
    writeFileSync(join(dir, 'revision.json'), JSON.stringify(revisionJson(fixture)));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('MAYBESITTER_FLAGS_')) delete env[name];
    delete env.PROJECT_ID;
    delete env.REGION;
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_GCLOUD_LOG: log,
        FAKE_SERVICE_JSON: join(dir, 'service.json'),
        FAKE_REVISION_JSON: join(dir, 'revision.json'),
      },
    });
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8').split('--END--\n').filter(Boolean).map((block) => block.split('\n').filter((line) => line !== ''))
      : [];
    const printed = (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('DRY-RUN: '))
      .map((line) => line.slice('DRY-RUN: '.length).trim().split(/ +/).map((word) => word.replace(/\\(.)/g, '$1')));
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', calls, printed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The KEY=VALUE pairs of a `--update-env-vars=^;^…` word, in order. */
function envPairs(words: string[]): Array<[string, string]> {
  const word = words.find((entry) => entry.startsWith('--update-env-vars='));
  assert.ok(word, 'no --update-env-vars word');
  const body = word.slice('--update-env-vars='.length);
  assert.ok(body.startsWith('^;^'), 'the env list lost its ^;^ delimiter');
  return body.slice(3).split(';').map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
}

function stagingBase(): Array<[string, string]> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('MAYBESITTER_FLAGS_')) delete env[name];
  delete env.PROJECT_ID;
  delete env.REGION;
  const words = execFileSync('bash', [flagsScript, 'staging'], { encoding: 'utf8', env }).trim().split(/\s+/);
  return envPairs(words);
}

const deploys = (r: Run) => r.printed.filter((words) => words[0] === 'gcloud' && words[1] === 'run' && words[2] === 'deploy');
const MUTATING = /^(deploy|update|update-traffic|delete|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|replace)$/;
const mutatingCalls = (r: Run) => r.calls.filter((args) => args.some((arg) => MUTATING.test(arg)));

const CREATE = ['--name', 'memoff', '--set', 'MAYBESITTER_FEATURE_MEMORY=false', '--set', 'MAYBESITTER_FEATURE_GOAL_PLAN=true', '--dry-run'];

test('a dry run deploys the serving revision by digest, behind a qa tag, with no traffic', () => {
  const r = run(CREATE);
  assert.equal(r.status, 0, r.stderr);
  const [privateDeploy] = deploys(r);
  assert.ok(privateDeploy, `no deploy printed:\n${r.stdout}`);
  assert.ok(privateDeploy.includes(SERVICE), 'the deploy does not name the staging service');
  assert.ok(privateDeploy.includes(`--image=${DIGEST}`), `the deploy does not use the serving digest: ${privateDeploy.join(' ')}`);
  assert.ok(!privateDeploy.some((word) => word.includes(TAGGED_IMAGE)), 'the deploy used the image tag, not the digest');
  assert.ok(privateDeploy.includes('--tag=qa-memoff'));
  assert.ok(privateDeploy.includes('--no-traffic'));
  assert.ok(!privateDeploy.includes('--allow-unauthenticated'), 'the private revision must not touch the service IAM policy');
  // The serving revision was found from the traffic list, then read.
  assert.ok(r.calls.some((args) => args.slice(0, 3).join(' ') === 'run services describe' && args.includes(SERVICE)));
  assert.ok(r.calls.some((args) => args.slice(0, 3).join(' ') === 'run revisions describe' && args.includes(SERVING)));
  assert.match(r.stdout, /https:\/\/qa-memoff---maybesitter-api-staging-abc123-ew\.a\.run\.app/, 'the tag URL is not printed');
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[lines.length - 1]!, /qa-memoff---/, 'the tag URL is not the last line');
});

test('a dry run calls gcloud for reads only', () => {
  for (const args of [CREATE, ['--remove', 'qa-old', '--dry-run'], ['--list']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(mutatingCalls(r), [], `${args.join(' ')} ran a mutating gcloud call`);
    for (const call of r.calls) {
      assert.ok(call.includes('describe'), `${args.join(' ')} ran a non-read call: ${call.join(' ')}`);
    }
  }
});

test('every deploy it prints carries --no-traffic, the template reset included', () => {
  const r = run(CREATE);
  assert.equal(r.status, 0, r.stderr);
  const all = deploys(r);
  assert.equal(all.length, 2, `expected the private deploy and the template reset:\n${r.stdout}`);
  for (const words of all) {
    assert.ok(words.includes('--no-traffic'), `a deploy without --no-traffic: ${words.join(' ')}`);
    assert.ok(!words.some((word) => /^--to-(latest|revisions|tags)/.test(word)), 'a deploy moves traffic');
  }
  assert.ok(!r.printed.some((words) => words.includes('update-traffic')), 'creating a revision must not call update-traffic');
});

test('the overrides are applied after the full staging settings', () => {
  const r = run(CREATE);
  assert.equal(r.status, 0, r.stderr);
  const pairs = envPairs(deploys(r)[0]!);
  const keys = pairs.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length, 'a key appears twice in the env list');
  const env = new Map(pairs);
  const base = stagingBase();
  assert.equal(new Map(base).get('MAYBESITTER_FEATURE_MEMORY'), 'true', 'the base no longer turns MEMORY on; pick another override for this test');
  for (const [key, value] of base) {
    if (key === 'MAYBESITTER_FEATURE_MEMORY') continue;
    assert.equal(env.get(key), value, `${key} differs from flags.sh staging`);
  }
  assert.equal(env.get('MAYBESITTER_FEATURE_MEMORY'), 'false', 'the override did not replace the base value');
  assert.equal(env.get('MAYBESITTER_FEATURE_GOAL_PLAN'), 'true', 'a key flags.sh does not set was not added');
  // The base order is kept, and a new key comes after every base key.
  assert.deepEqual(keys.slice(0, base.length), base.map(([key]) => key));
  assert.equal(keys[keys.length - 1], 'MAYBESITTER_FEATURE_GOAL_PLAN');
  assert.equal(env.get('MAYBESITTER_FIRESTORE_DATABASE_ID'), 'staging');
  assert.equal(env.get('MAYBESITTER_ENV'), 'staging');

  // The other flags.sh words are carried over unchanged.
  const flags = execFileSync('bash', [flagsScript, 'staging'], { encoding: 'utf8' }).trim().split(/\s+/);
  for (const word of flags) {
    if (word.startsWith('--update-env-vars=') || word === '--allow-unauthenticated') continue;
    assert.ok(deploys(r)[0]!.includes(word), `the deploy lost ${word}`);
  }
});

test('the template reset puts the staging settings back and removes added keys', () => {
  const r = run(CREATE);
  assert.equal(r.status, 0, r.stderr);
  const reset = deploys(r)[1]!;
  assert.ok(reset.includes(`--image=${DIGEST}`));
  assert.ok(!reset.some((word) => word.startsWith('--tag')), 'the reset revision must not be tagged');
  assert.deepEqual(envPairs(reset), stagingBase(), 'the reset does not restore exactly the staging settings');
  assert.ok(reset.includes('--remove-env-vars=MAYBESITTER_FEATURE_GOAL_PLAN'), 'a key the base does not set would leak into the next staging deploy');
});

test('without overrides that add keys, the reset removes nothing', () => {
  const r = run(['--name', 'gate', '--set', 'MAYBESITTER_ADDON_GATE_MODE=enforce', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(new Map(envPairs(deploys(r)[0]!)).get('MAYBESITTER_ADDON_GATE_MODE'), 'enforce');
  assert.ok(!deploys(r)[1]!.some((word) => word.startsWith('--remove-env-vars')));
});

test('production is refused before any gcloud call', () => {
  for (const args of [
    ['--service', 'maybesitter-api', '--name', 'x', '--dry-run'],
    ['--service', 'maybesitter-api', '--list'],
    ['--service', 'maybesitter-api', '--remove', 'qa-old', '--dry-run'],
  ]) {
    const r = run(args);
    assert.notEqual(r.status, 0, `${args.join(' ')} was not refused`);
    assert.match(r.stderr, /refus/i);
    assert.deepEqual(r.calls, [], `${args.join(' ')} called gcloud before refusing`);
  }
});

test('the default database, another environment or another project is refused', () => {
  for (const override of [
    'MAYBESITTER_FIRESTORE_DATABASE_ID=(default)',
    'MAYBESITTER_FIRESTORE_DATABASE_ID=staging',
    'MAYBESITTER_ENV=production',
    'MAYBESITTER_STORAGE_BACKEND=memory',
    'GOOGLE_CLOUD_PROJECT=other',
    'MAYBESITTER_INTERNAL_AUDIENCE=https://example.com',
  ]) {
    const r = run(['--name', 'x', '--set', override, '--dry-run']);
    assert.notEqual(r.status, 0, `${override} was not refused`);
    assert.match(r.stderr, /refus/i);
    assert.deepEqual(r.calls, [], `${override}: gcloud was called before refusing`);
  }
});

test('a serving revision on the default database or in production is refused', () => {
  for (const revisionEnv of [
    [{ name: 'MAYBESITTER_ENV', value: 'staging' }, { name: 'MAYBESITTER_FIRESTORE_DATABASE_ID', value: '(default)' }],
    [{ name: 'MAYBESITTER_ENV', value: 'production' }, { name: 'MAYBESITTER_FIRESTORE_DATABASE_ID', value: 'staging' }],
    [{ name: 'MAYBESITTER_ENV', value: 'staging' }],
  ]) {
    const r = run(CREATE, { revisionEnv });
    assert.notEqual(r.status, 0, `${JSON.stringify(revisionEnv)} was not refused`);
    assert.deepEqual(deploys(r), [], 'a deploy was printed for a non-staging revision');
  }
});

test('an image without a digest, or a split of traffic, is refused', () => {
  const noDigest = run(CREATE, { imageDigest: '' });
  assert.notEqual(noDigest.status, 0);
  assert.match(noDigest.stderr, /digest/);
  assert.deepEqual(deploys(noDigest), []);

  const split = run(CREATE, { traffic: [{ revisionName: SERVING, percent: 50 }, { revisionName: `${SERVICE}-00041-a`, percent: 50 }] });
  assert.notEqual(split.status, 0);
  assert.deepEqual(deploys(split), []);
});

test('bad names and bad overrides are refused', () => {
  for (const args of [
    ['--set', 'MAYBESITTER_FEATURE_MEMORY=false', '--dry-run'],
    ['--name', 'Bad_Name', '--dry-run'],
    ['--name', 'x'.repeat(30), '--dry-run'],
    ['--name', 'x', '--set', 'lowercase=1', '--dry-run'],
    ['--name', 'x', '--set', 'MAYBESITTER_FEATURE_MEMORY', '--dry-run'],
    ['--name', 'x', '--set', 'MAYBESITTER_FEATURE_MEMORY=a;MAYBESITTER_ENV=production', '--dry-run'],
    ['--name', 'x', '--set', 'MAYBESITTER_FEATURE_MEMORY=a b', '--dry-run'],
    ['--name', 'x', '--bogus', '--dry-run'],
  ]) {
    const r = run(args);
    assert.notEqual(r.status, 0, `${args.join(' ')} was not refused`);
    assert.deepEqual(deploys(r), []);
  }
});

test('--remove drops only the tag and never touches traffic', () => {
  const r = run(['--remove', 'qa-old', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.printed.length, 1, r.stdout);
  const [words] = r.printed;
  assert.deepEqual(words!.slice(0, 5), ['gcloud', 'run', 'services', 'update-traffic', SERVICE]);
  assert.ok(words!.includes('--remove-tags=qa-old'));
  assert.ok(!words!.some((word) => /^--(to-latest|to-revisions|to-tags|set-tags|update-tags|clear-tags)/.test(word)), `--remove moves traffic: ${words!.join(' ')}`);
  assert.equal(deploys(r).length, 0);
});

test('--remove refuses a tag that is not a qa tag, does not exist or serves traffic', () => {
  for (const [args, fixture] of [
    [['--remove', 'sha-1234567', '--dry-run'], {}],
    [['--remove', 'qa-missing', '--dry-run'], {}],
    [['--remove', 'qa-live', '--dry-run'], { traffic: [{ revisionName: SERVING, percent: 100, tag: 'qa-live', url: 'https://qa-live---x.a.run.app' }] }],
  ] as Array<[string[], Fixture]>) {
    const r = run(args, fixture);
    assert.notEqual(r.status, 0, `${args.join(' ')} was not refused`);
    assert.deepEqual(r.printed, [], `${args.join(' ')} printed a command`);
  }
});

test('--list shows the qa tags only', () => {
  const r = run(['--list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /qa-old/);
  assert.match(r.stdout, /qa-old---maybesitter-api-staging-abc123-ew\.a\.run\.app/);
  assert.doesNotMatch(r.stdout, /sha-1234567/);
});
