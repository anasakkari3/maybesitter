/**
 * infra/cloudrun/private-staging-revision.sh (Wave D, lane D3).
 *
 * A private staging revision is the image staging serves, with the service
 * template's settings plus a few overrides, behind a `qa-*` tag and with no
 * traffic; a second no-traffic deploy then puts the template back exactly.
 * These tests run the real script against a fake `gcloud` on PATH that logs
 * its arguments, answers the reads with canned JSON and can fail or interrupt
 * a deploy. No real gcloud is ever called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repoRoot, 'infra/cloudrun/private-staging-revision.sh');
const flagsScript = join(repoRoot, 'infra/cloudrun/flags.sh');

const SERVICE = 'maybesitter-api-staging';
const REGION_FLAG = '--region=europe-west1';
const SERVING = `${SERVICE}-00042-xyz`;
const REPO = 'europe-west1-docker.pkg.dev/maybesitter-app/maybesitter/api';
const DIGEST = `${REPO}@sha256:${'ab12'.repeat(16)}`;
const TEMPLATE_DIGEST = `${REPO}@sha256:${'cd34'.repeat(16)}`;
const TAGGED_IMAGE = `${REPO}:latest`;
const SERVICE_URL = 'https://maybesitter-api-staging-abc123-ew.a.run.app';
const DEPLOYED_TAG_URL = 'https://qa-memoff---maybesitter-api-staging-deployed-ew.a.run.app';

const FAKE_GCLOUD = `#!/usr/bin/env bash
{ printf '%s\\n' "$@"; printf -- '--END--\\n'; } >>"\${FAKE_GCLOUD_LOG}"
case "$1 $2 $3" in
  "run services describe")
    if [ -e "\${FAKE_STATE}/deployed" ] && [ -n "\${FAKE_SERVICE_JSON_AFTER:-}" ]; then cat "\${FAKE_SERVICE_JSON_AFTER}"; else cat "\${FAKE_SERVICE_JSON}"; fi ;;
  "run revisions describe") cat "\${FAKE_REVISION_JSON}" ;;
esac
if [ "$1 $2" = "run deploy" ]; then
  n=$(( $(cat "\${FAKE_STATE}/deploys" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"\${FAKE_STATE}/deploys"
  touch "\${FAKE_STATE}/deployed"
  case " \${FAKE_FAIL_DEPLOYS:-} " in *" $n "*) echo "fake: deploy $n failed" >&2; exit 1 ;; esac
  case " \${FAKE_TERM_DEPLOYS:-} " in *" $n "*) kill -TERM "$PPID" ;; esac
fi
exit 0
`;

type EnvVar = { name: string; value?: string; valueFrom?: unknown };

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('MAYBESITTER_FLAGS_')) delete env[name];
  delete env.PROJECT_ID;
  delete env.REGION;
  return env;
}

/** The KEY=VALUE pairs of a `--update-env-vars=^;^…` word, in order. */
function envPairs(words: string[]): Array<[string, string]> {
  const word = words.find((entry) => entry.startsWith('--update-env-vars='));
  assert.ok(word, `no --update-env-vars word in ${words.join(' ')}`);
  const body = word.slice('--update-env-vars='.length);
  assert.ok(body.startsWith('^;^'), 'the env list lost its ^;^ delimiter');
  return body.slice(3).split(';').map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
}

const flagsWords = (): string[] =>
  execFileSync('bash', [flagsScript, 'staging'], { encoding: 'utf8', env: cleanEnv() }).trim().split(/\s+/);
const stagingBase = (): Array<[string, string]> => envPairs(flagsWords());

/** What the live template holds: flags.sh staging, what scheduler.sh adds, and a secret. */
function defaultTemplateEnv(): EnvVar[] {
  return [
    ...stagingBase().map(([name, value]) => ({ name, value })),
    { name: 'MAYBESITTER_SCHEDULER_SA_EMAIL', value: 'maybesitter-scheduler@maybesitter-app.iam.gserviceaccount.com' },
    { name: 'MAYBESITTER_INTERNAL_AUDIENCE', value: SERVICE_URL },
    { name: 'MAYBESITTER_LLM_UID_SALT', valueFrom: { secretKeyRef: { name: 'maybesitter-llm-uid-salt', key: 'latest' } } },
  ];
}

interface Fixture {
  traffic?: Array<Record<string, unknown>>;
  specTraffic?: Array<Record<string, unknown>>;
  templateEnv?: EnvVar[];
  templateImage?: string;
  revisionEnv?: EnvVar[];
  imageDigest?: string;
}

function serviceJson(fixture: Fixture, traffic?: Array<Record<string, unknown>>) {
  return {
    metadata: { name: SERVICE },
    spec: {
      template: { spec: { containers: [{ image: fixture.templateImage ?? TEMPLATE_DIGEST, env: fixture.templateEnv ?? defaultTemplateEnv() }] } },
      traffic: fixture.specTraffic ?? [{ revisionName: SERVING, percent: 100 }],
    },
    status: {
      url: SERVICE_URL,
      traffic: traffic ?? fixture.traffic ?? [
        { revisionName: SERVING, percent: 100 },
        { revisionName: SERVING, percent: 0, tag: 'sha-1234567', url: 'https://sha-1234567---maybesitter-api-staging-abc123-ew.a.run.app' },
        { revisionName: `${SERVICE}-00040-old`, percent: 0, tag: 'qa-old', url: 'https://qa-old---maybesitter-api-staging-abc123-ew.a.run.app' },
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
        env: fixture.revisionEnv ?? fixture.templateEnv ?? defaultTemplateEnv(),
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

interface RunOptions { failDeploys?: number[]; termDeploys?: number[] }

function run(args: string[], fixture: Fixture = {}, options: RunOptions = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'private-revision-'));
  try {
    const bin = join(dir, 'bin');
    const state = join(dir, 'state');
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(join(bin, 'gcloud'), FAKE_GCLOUD);
    chmodSync(join(bin, 'gcloud'), 0o755);
    const log = join(dir, 'gcloud.log');
    writeFileSync(join(dir, 'service.json'), JSON.stringify(serviceJson(fixture)));
    const after = serviceJson(fixture, [
      ...(serviceJson(fixture).status.traffic),
      { revisionName: `${SERVICE}-00043-qa`, percent: 0, tag: 'qa-memoff', url: DEPLOYED_TAG_URL },
    ]);
    writeFileSync(join(dir, 'service-after.json'), JSON.stringify(after));
    writeFileSync(join(dir, 'revision.json'), JSON.stringify(revisionJson(fixture)));
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_GCLOUD_LOG: log,
        FAKE_STATE: state,
        FAKE_SERVICE_JSON: join(dir, 'service.json'),
        FAKE_SERVICE_JSON_AFTER: join(dir, 'service-after.json'),
        FAKE_REVISION_JSON: join(dir, 'revision.json'),
        FAKE_FAIL_DEPLOYS: (options.failDeploys ?? []).join(' '),
        FAKE_TERM_DEPLOYS: (options.termDeploys ?? []).join(' '),
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

const isDeploy = (words: string[]) => words[0] === 'gcloud' && words[1] === 'run' && words[2] === 'deploy';
const deploys = (r: Run) => r.printed.filter(isDeploy);
/** Deploys the fake gcloud actually received (real mode); `gcloud` itself is not logged. */
const deployCalls = (r: Run) => r.calls.filter((args) => args[0] === 'run' && args[1] === 'deploy');
const MUTATING = /^(deploy|update|update-traffic|delete|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|replace)$/;
const mutatingCalls = (r: Run) => r.calls.filter((args) => args.some((arg) => MUTATING.test(arg)));

function refused(r: Run, pattern: RegExp, what: string) {
  assert.notEqual(r.status, 0, `${what} was not refused`);
  assert.match(r.stderr, pattern, `${what}: unexpected message:\n${r.stderr}`);
}

const CREATE = ['--name', 'memoff', '--set', 'MAYBESITTER_FEATURE_MEMORY=false', '--set', 'MAYBESITTER_FEATURE_GOAL_PLAN=true', '--dry-run'];
const CREATE_REAL = CREATE.filter((arg) => arg !== '--dry-run');

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
  assert.ok(r.calls.some((args) => args.slice(0, 3).join(' ') === 'run services describe' && args.includes(SERVICE)));
  assert.ok(r.calls.some((args) => args.slice(0, 3).join(' ') === 'run revisions describe' && args.includes(SERVING)));
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[lines.length - 1]!, /https:\/\/qa-memoff---maybesitter-api-staging-abc123-ew\.a\.run\.app/, 'the tag URL is not the last line');
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

test('every gcloud command, run or printed, names the region explicitly', () => {
  for (const args of [CREATE, ['--remove', 'qa-old', '--dry-run'], ['--list'], CREATE_REAL]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    for (const call of r.calls) assert.ok(call.includes(REGION_FLAG), `a call without ${REGION_FLAG}: ${call.join(' ')}`);
    for (const words of r.printed) assert.ok(words.includes(REGION_FLAG), `a printed command without ${REGION_FLAG}: ${words.join(' ')}`);
  }
  // The delete hint --remove prints, too.
  const removed = run(['--remove', 'qa-old', '--dry-run']);
  assert.match(removed.stdout, /gcloud run revisions delete \S+ --region=europe-west1 /);
});

test('every deploy carries --no-traffic, the template restore included', () => {
  const r = run(CREATE);
  assert.equal(r.status, 0, r.stderr);
  const all = deploys(r);
  assert.equal(all.length, 2, `expected the private deploy and the template restore:\n${r.stdout}`);
  for (const words of all) {
    assert.ok(words.includes('--no-traffic'), `a deploy without --no-traffic: ${words.join(' ')}`);
    assert.ok(!words.some((word) => /^--to-(latest|revisions|tags)/.test(word)), 'a deploy moves traffic');
  }
  assert.ok(!r.printed.some((words) => words.includes('update-traffic')), 'creating a revision must not call update-traffic');
});

test('the QA revision is the template settings with the overrides on top', () => {
  const r = run(CREATE);
  assert.equal(r.status, 0, r.stderr);
  const pairs = envPairs(deploys(r)[0]!);
  const keys = pairs.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length, 'a key appears twice in the env list');
  const env = new Map(pairs);
  const template = defaultTemplateEnv().filter((entry) => entry.value !== undefined).map((entry) => [entry.name, entry.value!] as [string, string]);
  assert.equal(new Map(template).get('MAYBESITTER_FEATURE_MEMORY'), 'true', 'the fixture no longer turns MEMORY on; pick another override for this test');
  for (const [key, value] of template) {
    if (key === 'MAYBESITTER_FEATURE_MEMORY') continue;
    assert.equal(env.get(key), value, `${key} differs from the template`);
  }
  assert.equal(env.get('MAYBESITTER_FEATURE_MEMORY'), 'false', 'the override did not replace the template value');
  assert.equal(env.get('MAYBESITTER_FEATURE_GOAL_PLAN'), 'true', 'a key the template does not set was not added');
  assert.deepEqual(keys.slice(0, template.length), template.map(([key]) => key), 'the template order is not kept');
  assert.equal(keys[keys.length - 1], 'MAYBESITTER_FEATURE_GOAL_PLAN');
  assert.ok(!env.has('MAYBESITTER_LLM_UID_SALT'), 'a secret-backed variable was copied as a plain value');
  // Only the env changes: every other setting stays as the template has it.
  const words = deploys(r)[0]!;
  for (const word of flagsWords()) {
    if (word.startsWith('--update-env-vars=') || word.startsWith('--region=')) continue;
    assert.ok(!words.includes(word), `the deploy re-sets ${word}; it should keep the template's`);
  }
});

test('the restore puts the template back exactly and removes added keys', () => {
  const r = run(CREATE, { templateImage: TEMPLATE_DIGEST });
  assert.equal(r.status, 0, r.stderr);
  const restore = deploys(r)[1]!;
  assert.ok(restore.includes(`--image=${TEMPLATE_DIGEST}`), `the restore does not redeploy the template's image: ${restore.join(' ')}`);
  assert.ok(!restore.some((word) => word.startsWith('--tag')), 'the restore revision must not be tagged');
  const template = defaultTemplateEnv().filter((entry) => entry.value !== undefined).map((entry) => [entry.name, entry.value!]);
  assert.deepEqual(envPairs(restore), template, 'the restore does not put back exactly the template env');
  assert.ok(restore.includes('--remove-env-vars=MAYBESITTER_FEATURE_GOAL_PLAN'), 'a key the template does not have would leak into the next deploy');
});

test('without overrides that add keys, the restore removes nothing', () => {
  const r = run(['--name', 'gate', '--set', 'MAYBESITTER_ADDON_GATE_MODE=enforce', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(new Map(envPairs(deploys(r)[0]!)).get('MAYBESITTER_ADDON_GATE_MODE'), 'enforce');
  assert.ok(!deploys(r)[1]!.some((word) => word.startsWith('--remove-env-vars')));
});

test('a template that differs from flags.sh staging is used as is, with a warning', () => {
  const templateEnv = defaultTemplateEnv().map((entry) =>
    entry.name === 'MAYBESITTER_FEATURE_FREE_SLOTS' ? { ...entry, value: 'false' } : entry);
  const r = run(CREATE, { templateEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning:.*template.*flags\.sh/i);
  assert.match(r.stderr, /MAYBESITTER_FEATURE_FREE_SLOTS/);
  assert.equal(new Map(envPairs(deploys(r)[0]!)).get('MAYBESITTER_FEATURE_FREE_SLOTS'), 'false');
  assert.equal(new Map(envPairs(deploys(r)[1]!)).get('MAYBESITTER_FEATURE_FREE_SLOTS'), 'false');

  const same = run(CREATE);
  assert.doesNotMatch(same.stderr, /warning/i, 'a warning although the template matches flags.sh');
});

test('a template value the env list cannot carry is refused', () => {
  const templateEnv = [...defaultTemplateEnv(), { name: 'MAYBESITTER_SITE_ORIGINS', value: 'a;b' }];
  refused(run(CREATE, { templateEnv }), /refusing:.*MAYBESITTER_SITE_ORIGINS/, 'a template value with ;');
});

test('traffic that follows the latest revision is refused', () => {
  refused(
    run(CREATE, { specTraffic: [{ latestRevision: true, percent: 100 }], traffic: [{ revisionName: SERVING, percent: 100, latestRevision: true }] }),
    /refusing:.*latest/i, 'latestRevision traffic',
  );
  refused(
    run(CREATE, { specTraffic: [{ latestRevision: true, percent: 100 }] }),
    /refusing:.*latest/i, 'latestRevision in the traffic spec only',
  );
});

test('pinned traffic that does not add up to 100 is refused', () => {
  refused(
    run(CREATE, { traffic: [{ revisionName: SERVING, percent: 100 }, { revisionName: `${SERVICE}-00041-a`, percent: 10 }] }),
    /refusing:.*100/, 'traffic summing to 110',
  );
  refused(
    run(CREATE, { traffic: [{ revisionName: SERVING, percent: 50 }, { revisionName: `${SERVICE}-00041-a`, percent: 50 }] }),
    /refusing:.*100/, 'a 50/50 split',
  );
  refused(run(CREATE, { traffic: [] }), /refusing:.*100/, 'no traffic at all');
});

test('a real run deploys twice, in order, and prints the tag URL it reads back', () => {
  const r = run(CREATE_REAL);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.printed, [], 'a real run printed DRY-RUN lines');
  const calls = deployCalls(r);
  assert.equal(calls.length, 2, `expected 2 deploys, got:\n${r.calls.map((c) => c.join(' ')).join('\n')}`);
  assert.ok(calls[0]!.includes('--tag=qa-memoff') && calls[0]!.includes(`--image=${DIGEST}`));
  assert.ok(!calls[1]!.some((word) => word.startsWith('--tag')) && calls[1]!.includes(`--image=${TEMPLATE_DIGEST}`));
  for (const call of calls) assert.ok(call.includes('--no-traffic'));
  assert.ok(!r.calls.some((args) => args.includes('update-traffic')), 'a real run moved traffic');
  // The URL comes from describing the service after the deploy, not from a guess.
  const last = r.calls[r.calls.length - 1]!;
  assert.equal(last.slice(0, 3).join(' '), 'run services describe', 'the tag URL was not read back');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[lines.length - 1], `tag URL: ${DEPLOYED_TAG_URL}`);
});

test('when the restore deploy fails, it is retried once and the run exits 4', () => {
  const r = run(CREATE_REAL, {}, { failDeploys: [2] });
  assert.equal(r.status, 4, `${r.status}\n${r.stderr}`);
  const calls = deployCalls(r);
  assert.equal(calls.length, 3, 'the restore was not retried');
  assert.deepEqual(calls[2], calls[1], 'the retry is not the same restore');
  assert.match(r.stderr, /restored/i);
  assert.match(r.stderr, /qa-memoff/);
});

test('when the retry fails too, it prints a ready restore command and exits 3', () => {
  const r = run(CREATE_REAL, {}, { failDeploys: [2, 3] });
  assert.equal(r.status, 3, `${r.status}\n${r.stderr}`);
  assert.equal(deployCalls(r).length, 3, 'more than one retry, or none');
  const line = r.stderr.split('\n').find((entry) => entry.trim().startsWith('gcloud run deploy'));
  assert.ok(line, `no ready command:\n${r.stderr}`);
  const words = line!.trim().split(/ +/).map((word) => word.replace(/\\(.)/g, '$1'));
  assert.deepEqual(words.slice(1), deployCalls(r)[1], 'the printed command is not the restore');
});

test('an interrupt after the first deploy still restores the template', () => {
  // TERM arrives while the restore deploy runs; the trap restores once more.
  const r = run(CREATE_REAL, {}, { termDeploys: [2] });
  assert.equal(r.status, 4, `${r.status}\n${r.stderr}`);
  const calls = deployCalls(r);
  assert.equal(calls.length, 3, 'the interrupt did not trigger exactly one restore');
  assert.ok(!calls[calls.length - 1]!.some((word) => word.startsWith('--tag')), 'the last deploy is not the restore');
  assert.match(r.stderr, /restored/i);
});

test('a failed first deploy is followed by one restore', () => {
  // Cloud Run can write the template and still fail the deploy (a bad value
  // that breaks the startup probe), so a failure here restores too.
  const r = run(CREATE_REAL, {}, { failDeploys: [1] });
  assert.equal(r.status, 4, `${r.status}\n${r.stderr}`);
  const calls = deployCalls(r);
  assert.equal(calls.length, 2, 'expected the failed deploy and exactly one restore');
  assert.ok(calls[0]!.includes('--tag=qa-memoff'));
  assert.ok(!calls[1]!.some((word) => word.startsWith('--tag')) && calls[1]!.includes(`--image=${TEMPLATE_DIGEST}`), 'the second deploy is not the restore');
  assert.match(r.stderr, /restored/i);
});

test('an interrupt during the first deploy restores the template', () => {
  const r = run(CREATE_REAL, {}, { termDeploys: [1] });
  assert.equal(r.status, 4, `${r.status}\n${r.stderr}`);
  const calls = deployCalls(r);
  assert.equal(calls.length, 2, 'expected the interrupted deploy and exactly one restore');
  assert.ok(!calls[1]!.some((word) => word.startsWith('--tag')), 'the second deploy is not the restore');
});

test('a failed first deploy and a failed restore print the ready command and exit 3', () => {
  const r = run(CREATE_REAL, {}, { failDeploys: [1, 2] });
  assert.equal(r.status, 3, `${r.status}\n${r.stderr}`);
  assert.equal(deployCalls(r).length, 2);
  assert.match(r.stderr, /^  gcloud run deploy /m);
});

test('an override of a secret-backed variable is refused', () => {
  const r = run(['--name', 'x', '--set', 'MAYBESITTER_LLM_UID_SALT=plain', '--dry-run']);
  refused(r, /refusing: MAYBESITTER_LLM_UID_SALT is a secret/, 'a secret override');
  assert.deepEqual(deploys(r), []);
});

test('a template image without a digest is refused', () => {
  const r = run(CREATE, { templateImage: TAGGED_IMAGE });
  refused(r, /refusing: the service template's image .* is not pinned by digest/, 'a tagged template image');
  assert.deepEqual(deploys(r), []);
});

test('template values with commas, equals signs and carets survive both deploys exactly', () => {
  const tricky = { name: 'MAYBESITTER_SITE_ORIGINS', value: 'https://a.example,https://b.example' };
  const equals = { name: 'MAYBESITTER_QA_NOTE', value: 'k=v=w' };
  const caret = { name: 'MAYBESITTER_QA_CARET', value: '^x^,y' };
  const templateEnv = [...defaultTemplateEnv(), tricky, equals, caret];
  const r = run(CREATE, { templateEnv });
  assert.equal(r.status, 0, r.stderr);
  for (const words of deploys(r)) {
    const env = new Map(envPairs(words));
    assert.equal(env.get(tricky.name), tricky.value);
    assert.equal(env.get(equals.name), equals.value);
    assert.equal(env.get(caret.name), caret.value);
  }
});

test('production is refused before any gcloud call', () => {
  for (const args of [
    ['--service', 'maybesitter-api', '--name', 'x', '--dry-run'],
    ['--service', 'maybesitter-api', '--list'],
    ['--service', 'maybesitter-api', '--remove', 'qa-old', '--dry-run'],
  ]) {
    const r = run(args);
    refused(r, /refusing: maybesitter-api is not maybesitter-api-staging/, args.join(' '));
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
    refused(r, /refusing: [A-Z_]+ is fixed to staging's value/, override);
    assert.deepEqual(r.calls, [], `${override}: gcloud was called before refusing`);
  }
});

test('a serving revision or template off the staging database or environment is refused', () => {
  const env = (db: string | null, name: string) => [
    { name: 'MAYBESITTER_ENV', value: name },
    ...(db === null ? [] : [{ name: 'MAYBESITTER_FIRESTORE_DATABASE_ID', value: db }]),
  ];
  for (const [fixture, pattern] of [
    [{ revisionEnv: env('(default)', 'staging') }, /refusing: the serving revision .* staging database/],
    [{ revisionEnv: env('staging', 'production') }, /refusing: the serving revision .* MAYBESITTER_ENV=staging/],
    [{ revisionEnv: env(null, 'staging') }, /refusing: the serving revision .* staging database/],
    [{ templateEnv: env('(default)', 'staging'), revisionEnv: env('staging', 'staging') }, /refusing: the service template .* staging database/],
  ] as Array<[Fixture, RegExp]>) {
    const r = run(CREATE, fixture);
    refused(r, pattern, JSON.stringify(fixture));
    assert.deepEqual(deploys(r), [], 'a deploy was printed for a non-staging revision');
  }
});

test('an image without a digest is refused', () => {
  const r = run(CREATE, { imageDigest: '' });
  refused(r, /no image digest/, 'no digest');
  assert.deepEqual(deploys(r), []);
});

test('bad names and bad overrides are refused', () => {
  for (const [args, pattern] of [
    [['--set', 'MAYBESITTER_FEATURE_MEMORY=false', '--dry-run'], /refusing: --set only goes with --name/],
    [['--name', 'Bad_Name', '--dry-run'], /refusing: --name Bad_Name/],
    [['--name', 'x'.repeat(30), '--dry-run'], /refusing: --name x+/],
    [['--name', 'x', '--set', 'lowercase=1', '--dry-run'], /refusing: .*upper-case/],
    [['--name', 'x', '--set', 'MAYBESITTER_FEATURE_MEMORY', '--dry-run'], /refusing: .*KEY=VALUE/],
    [['--name', 'x', '--set', 'MAYBESITTER_FEATURE_MEMORY=a;MAYBESITTER_ENV=production', '--dry-run'], /refusing: .*';' or whitespace/],
    [['--name', 'x', '--set', 'MAYBESITTER_FEATURE_MEMORY=a b', '--dry-run'], /refusing: .*';' or whitespace/],
    [['--name', 'x', '--set', 'MAYBESITTER_FEATURE_MEMORY=a', '--set', 'MAYBESITTER_FEATURE_MEMORY=b', '--dry-run'], /refusing: .*twice/],
    [['--name', 'x', '--bogus', '--dry-run'], /unknown argument: --bogus/],
  ] as Array<[string[], RegExp]>) {
    const r = run(args);
    refused(r, pattern, args.join(' '));
    assert.deepEqual(deploys(r), []);
  }
});

test('an existing tag is refused', () => {
  refused(run(['--name', 'old', '--dry-run']), /refusing: qa-old already exists/, 'an existing tag');
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
  for (const [args, fixture, pattern] of [
    [['--remove', 'sha-1234567', '--dry-run'], {}, /refusing: --remove sha-1234567: only qa-\*/],
    [['--remove', 'qa-missing', '--dry-run'], {}, /refusing: .* has no tag qa-missing/],
    [['--remove', 'qa-live', '--dry-run'], { traffic: [{ revisionName: SERVING, percent: 100, tag: 'qa-live', url: 'https://qa-live---x.a.run.app' }] }, /refusing: qa-live carries 100% of the traffic/],
  ] as Array<[string[], Fixture, RegExp]>) {
    const r = run(args, fixture);
    refused(r, pattern, args.join(' '));
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
