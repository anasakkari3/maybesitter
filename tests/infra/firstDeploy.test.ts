/**
 * The first deploy of each Cloud Run service can succeed (UC-1.0d #143).
 *
 * Three things would have failed the very first staging deploy, and none of
 * them could be seen until it ran against real GCP:
 *
 *   - `--no-traffic` is rejected when Cloud Run is creating a service;
 *   - the smoke test read its URL from `status.traffic[0].url`, which is empty
 *     when no revision carries a tag, so it probed a URL with no host;
 *   - flags.sh deploys `--allow-unauthenticated`, which needs
 *     `run.services.setIamPolicy`, and the deployer only had `run.developer`.
 *
 * These are static checks, the only kind possible without a project. They pin
 * the fixes so a later edit cannot quietly reintroduce any of the three.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleEarlyAccessEvent } from '../../lib/earlyAccess/service.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');
const workflow = read('.github/workflows/deploy.yml');

test('--no-traffic is only used once the service already exists', () => {
  const guarded = /if gcloud run services describe "\$\{SERVICE\}"[^\n]*\n\s*TRAFFIC_FLAGS=\(--no-traffic --tag /;
  assert.match(workflow, guarded, 'the --no-traffic/--tag flags are not behind an "exists" check');
  const unguarded = workflow.split('\n').filter((line) => /^\s*--no-traffic\b/.test(line));
  assert.deepEqual(unguarded, [], 'a bare --no-traffic line would fail the first deploy');
});

test('the smoke test falls back to the service URL, not a traffic entry that may be empty', () => {
  assert.doesNotMatch(workflow, /status\.traffic\[0\]\.url/);
  assert.match(workflow, /jq -r '\.status\.url \/\/ empty'/);
  assert.match(workflow, /PROBE="\$\{TAG_URL:-\$URL\}"/);
  assert.match(workflow, /\[ -n "\$\{PROBE\}" \] \|\| \{/, 'an unresolved URL must fail loudly, not probe "/api/health"');
});

test('the tagged revision URL is found with jq, not a gcloud filter() projection', () => {
  // `--format="value(status.traffic.filter(tag=...).url)"` is not valid gcloud
  // syntax: "Transform function expected". It failed the first real deploy.
  assert.doesNotMatch(workflow, /traffic\.filter\(/);
  assert.match(workflow, /select\(\.tag == \$tag\)/);
});

test('deploying does not erase the environment scheduler.sh set on the service', () => {
  // infra/scheduler.sh sets MAYBESITTER_SCHEDULER_SA_EMAIL and
  // MAYBESITTER_INTERNAL_AUDIENCE, which cannot be static flags: the audience
  // is the service's own URL. --set-env-vars replaces the whole set, so a
  // deploy would erase them and the internal job routes would answer 503.
  const flags = read('infra/cloudrun/flags.sh');
  assert.match(flags, /--update-env-vars=/);
  assert.doesNotMatch(flags, /--set-env-vars=/);
});

test('a public service is deployed by an identity that may make it public', () => {
  const flags = read('infra/cloudrun/flags.sh');
  const bootstrap = read('infra/bootstrap.sh');
  if (flags.includes('--allow-unauthenticated')) {
    assert.match(bootstrap, /add_role "\$\{DEPLOYER_SA\}" roles\/run\.admin/, 'the deployer cannot set the allUsers invoker binding');
  }
  assert.doesNotMatch(bootstrap, /add_role "\$\{DEPLOYER_SA\}" roles\/run\.developer/);
});

test('a merge to main deploys staging', () => {
  // UC-1.0d (#143) asks for this, and it only became safe to add once real
  // manual runs had succeeded.
  assert.match(workflow, /^on:\n\s*push:\n\s*branches: \[main\]/m, 'staging does not deploy on a merge to main');
});

test('the deploy target is resolved once, and an unknown one is refused rather than sent to production', () => {
  // A push carries no inputs. The old selection was
  //   SERVICE="maybesitter-api"; [ "${{ inputs.target }}" = "staging" ] && SERVICE=…
  // which reaches production whenever the target is not exactly "staging" —
  // an empty string included. Adding the push trigger without this would have
  // pointed every merge at production.
  assert.match(workflow, /TARGET: \$\{\{ inputs\.target \|\| 'staging' \}\}/, 'the target is not resolved to a default');
  assert.match(workflow, /case "\$\{TARGET\}" in/, 'the service is not chosen by an explicit case');
  assert.match(workflow, /\*\) echo "refusing to deploy: unknown target/, 'an unknown target is not refused');

  // Nothing below the job header may read the raw input again: that is the
  // value that is empty on a push.
  const steps = workflow.slice(workflow.indexOf('    steps:'));
  assert.doesNotMatch(steps, /inputs\.target/, 'a step still reads inputs.target instead of TARGET');
});

test('the hosted model is configured for staging and switched off for production', () => {
  // Enabling a paid model for real users is an owner decision, not something a
  // deploy does because a branch landed (UC-2.0 #160, UC-2.1 #161). Staging is
  // where it is exercised; production stays `none` until someone changes this
  // line deliberately and a reviewer sees it.
  const staging = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), 'staging'], { encoding: 'utf8' });
  const production = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), 'production'], { encoding: 'utf8' });

  assert.match(staging, /MAYBESITTER_LLM_PROVIDER=gemini/);
  assert.match(production, /MAYBESITTER_LLM_PROVIDER=none/, 'production is configured to call a paid model');

  // A region, never `global`: capture text is processed where the consent
  // screen says it is.
  for (const [name, flags] of [['staging', staging], ['production', production]] as const) {
    assert.match(flags, /MAYBESITTER_VERTEX_LOCATION=europe-west1/, `${name} has no EU region pinned`);
    assert.doesNotMatch(flags, /MAYBESITTER_VERTEX_LOCATION=global/, `${name} routes anywhere with capacity`);
  }
});

test('the deployer may pass firebase-tools\' API-enabled check before deploying rules and indexes', () => {
  // ensureApiEnabled.check() does not catch a 403, so a missing
  // serviceusage.services.get/.use fails the whole Firestore step.
  const workflow = read('.github/workflows/deploy.yml');
  if (/firebase-tools[^\n]*deploy --only firestore/.test(workflow)) {
    assert.match(read('infra/bootstrap.sh'), /add_role "\$\{DEPLOYER_SA\}" roles\/serviceusage\.serviceUsageConsumer/);
  }
});

test('the memory module is on for staging and explicitly off for production', () => {
  // UC-2.7a (#167). The owner approved memory for staging only; production
  // stays off until that changes deliberately. `MAYBESITTER_KILL_SWITCH_MEMORY`
  // is belt and braces the same way `MAYBESITTER_AI_DISABLED` is above the
  // model provider: the feature flag already keeps memory off in production,
  // and the kill switch is a second, independent block.
  const staging = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), 'staging'], { encoding: 'utf8' });
  const production = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), 'production'], { encoding: 'utf8' });

  assert.match(staging, /MAYBESITTER_FEATURE_MEMORY=true/, 'staging does not enable memory');
  assert.match(staging, /MAYBESITTER_KILL_SWITCH_MEMORY=false/, 'staging leaves no explicit kill switch for an incident');

  assert.match(production, /MAYBESITTER_FEATURE_MEMORY=false/, 'production enables memory without an explicit owner decision');
  assert.match(production, /MAYBESITTER_KILL_SWITCH_MEMORY=true/, 'production has no independent block on memory');
});

test('the football-data.org credential is mounted on staging only', () => {
  const staging = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), 'staging'], { encoding: 'utf8' });
  const production = execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), 'production'], { encoding: 'utf8' });

  assert.match(
    staging,
    /FOOTBALL_DATA_API_KEY=maybesitter-football-data-api-key:latest/,
    'staging does not receive the managed football-data.org credential',
  );
  assert.doesNotMatch(
    production,
    /FOOTBALL_DATA_API_KEY/,
    'production football sync was activated without an explicit production decision',
  );
});

// ── The env list gcloud actually receives ───────────────────────────────

const flagsFor = (target: 'staging' | 'production') =>
  execFileSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), target], { encoding: 'utf8' });

/**
 * `--update-env-vars` parsed the way gcloud's ArgDict does (`gcloud topic
 * escaping`): an optional `^D^` prefix picks the pair delimiter, else `,`;
 * each pair splits on its first `=`. The workflow expands flags.sh unquoted,
 * so words are what bash would split on whitespace.
 */
function envVarsOf(printed: string): Map<string, string> {
  const words = printed.trim().split(/\s+/);
  const flag = words.filter((word) => word.startsWith('--update-env-vars='));
  assert.equal(flag.length, 1, 'exactly one --update-env-vars word (a second one would replace the first)');
  let value = flag[0]!.slice('--update-env-vars='.length);
  let delimiter = ',';
  const custom = /^\^([^^]+)\^/.exec(value);
  if (custom) {
    delimiter = custom[1]!;
    value = value.slice(custom[0].length);
  }
  const vars = new Map<string, string>();
  for (const pair of value.split(delimiter)) {
    const at = pair.indexOf('=');
    const key = at < 0 ? pair : pair.slice(0, at);
    // A comma-separated value split on the default delimiter shows up here as
    // a "key" like `https://maybesitter-app.web.app`, which gcloud rejects.
    assert.match(key, /^[A-Z_][A-Z0-9_]*$/, `"${pair}" is not a KEY=VALUE pair: the delimiter is splitting a value`);
    assert.ok(!vars.has(key), `${key} is set twice`);
    vars.set(key, pair.slice(at + 1));
  }
  return vars;
}

const PRODUCTION_SITE_ORIGINS = [
  'https://maybesitter.com',
  'https://maybesitter-app.web.app',
  'https://maybesitter-app.firebaseapp.com',
];
const KMS_KEY = 'projects/maybesitter-app/locations/europe-west1/keyRings/maybesitter/cryptoKeys/user-secrets';

test('production allows exactly the live site origins, the custom domain included, as one env value', () => {
  // Before this the value lived on the service only because someone set it by
  // hand, without maybesitter.com: sign-ups from the custom domain got a 403.
  const production = envVarsOf(flagsFor('production'));
  assert.deepEqual(production.get('MAYBESITTER_SITE_ORIGINS')?.split(','), PRODUCTION_SITE_ORIGINS);
  for (const origin of PRODUCTION_SITE_ORIGINS) {
    // The service compares the Origin header exactly: no path, no trailing slash.
    assert.equal(new URL(origin).origin, origin);
  }
  // No website posts to staging's sign-up.
  assert.equal(envVarsOf(flagsFor('staging')).has('MAYBESITTER_SITE_ORIGINS'), false);
});

test('each production site origin passes the sign-up\'s own origin check with the value flags.sh sets', async () => {
  const env = { K_SERVICE: 'maybesitter-api', MAYBESITTER_SITE_ORIGINS: envVarsOf(flagsFor('production')).get('MAYBESITTER_SITE_ORIGINS') } as unknown as NodeJS.ProcessEnv;
  const ping = (origin: string) => handleEarlyAccessEvent(
    new Request('https://maybesitter-api.example/api/early-access/events', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' } }),
    { env },
  );
  for (const origin of PRODUCTION_SITE_ORIGINS) assert.equal((await ping(origin)).status, 204, origin);
  assert.equal((await ping('https://www.maybesitter.com')).status, 403, 'www redirects at Hosting and is not listed');
});

test('both services are deployed with the KMS key that seals per-user secrets', () => {
  // Staging had it by hand and production not at all, so Google connect on
  // production answered `not_configured`. A deploy must carry it.
  for (const target of ['staging', 'production'] as const) {
    assert.equal(envVarsOf(flagsFor(target)).get('MAYBESITTER_KMS_KEY_NAME'), KMS_KEY, target);
  }
});

test('switching the env list to a custom delimiter dropped none of the existing settings', () => {
  const production = envVarsOf(flagsFor('production'));
  const staging = envVarsOf(flagsFor('staging'));
  for (const [key, value] of [
    ['MAYBESITTER_ENV', 'production'],
    ['MAYBESITTER_STORAGE_BACKEND', 'firestore'],
    ['MAYBESITTER_FIRESTORE_DATABASE_ID', '(default)'],
    ['GOOGLE_CLOUD_PROJECT', 'maybesitter-app'],
    ['MAYBESITTER_LLM_PROVIDER', 'none'],
    ['MAYBESITTER_AI_DISABLED', 'true'],
    ['MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP', '3000'],
    ['MAYBESITTER_FEATURE_MEMORY', 'false'],
    ['MAYBESITTER_KILL_SWITCH_MEMORY', 'true'],
  ] as const) {
    assert.equal(production.get(key), value, `production ${key}`);
  }
  assert.equal(staging.get('MAYBESITTER_FIRESTORE_DATABASE_ID'), 'staging');
  assert.equal(staging.get('MAYBESITTER_LLM_PROVIDER'), 'gemini');
  assert.equal(production.size, 22);
  assert.equal(staging.size, 21);
});

// ── Same-digest production promotion ────────────────────────────────────

const buildStep = () => {
  const start = workflow.indexOf('Build and push the image');
  const end = workflow.indexOf('- name:', workflow.indexOf('\n', start));
  return workflow.slice(start, end);
};

const resolveStep = () => {
  const start = workflow.indexOf('Resolve the staging image');
  const end = workflow.indexOf('Smoke test the new revision');
  return workflow.slice(start, end);
};

const deployStep = () => {
  const start = workflow.indexOf('Deploy (behind a tag');
  const end = workflow.indexOf('Smoke test the new revision');
  return workflow.slice(start, end);
};

test('production does not rebuild the image', () => {
  // A rebuild from the same commit is not guaranteed byte-identical to what
  // staging already pushed and smoke-tested — Docker layer timestamps and
  // base-image resolution are not pinned bit-for-bit — so rebuilding on
  // promote can silently deploy bytes staging never ran.
  assert.match(buildStep(), /if:\s*env\.TARGET == 'staging'/, 'the build step is not gated to staging');

  assert.notEqual(workflow.indexOf('Resolve the staging image'), -1, 'there is no production digest-resolution step');
  assert.match(resolveStep(), /if:\s*env\.TARGET == 'production'/, 'the resolve step is not gated to production');
  assert.doesNotMatch(resolveStep(), /docker build/, 'production still builds its own image');
});

test('production resolves the digest of the commit tag staging pushed', () => {
  assert.match(
    resolveStep(),
    /IMAGE_URI="\$\{REGION\}-docker\.pkg\.dev\/\$\{PROJECT_ID\}\/\$\{REPOSITORY\}\/\$\{IMAGE\}:\$\{GITHUB_SHA\}"/,
    'production does not resolve the commit tag staging pushed',
  );
  assert.match(
    resolveStep(),
    /gcloud artifacts docker images describe "\$\{IMAGE_URI\}"/,
    'production does not look up the pushed image by its commit tag',
  );
});

test('production fails with a clear message when no staging image exists for this commit', () => {
  assert.match(resolveStep(), /Deploy staging for this commit first/i, 'a missing staging image does not tell the operator what to do');
  assert.match(resolveStep(), /exit 1/, 'a missing staging image does not fail the run');
});

test('production verifies staging is actually serving the digest it promotes, not merely that one was pushed', () => {
  // A tag can be pushed by a staging deploy that then failed its own smoke
  // test, or be superseded by a later push before this run started. Promotion
  // must check what staging is serving, not just what once reached the
  // registry.
  assert.match(resolveStep(), /maybesitter-api-staging/, 'production never looks at the staging service');
  assert.match(resolveStep(), /select\(\.percent == 100\)/, 'production does not find the revision actually serving traffic');
  assert.match(resolveStep(), /"\$\{STAGING_IMAGE\}"\s*!=\s*"\$\{IMAGE_DIGEST\}"/, 'production does not compare against the resolved digest');
});

test('the deploy step sources its image from whichever of build or resolve ran', () => {
  assert.match(
    deployStep(),
    /steps\.build\.outputs\.image_digest \|\| steps\.resolve\.outputs\.image_digest/,
    'the deploy step cannot get an image on a production run',
  );
});

// ── The production image survives registry cleanup ──────────────────────

test('the cleanup policy keeps every version tagged prod-*', () => {
  // The Delete rule removes anything older than 30 days outside the newest
  // 10, and staging pushes on every merge, so without this the digest
  // production runs becomes deletable within days of being promoted.
  const policy = JSON.parse(read('infra/artifact-cleanup.json')) as Array<{
    action: { type: string };
    condition?: { tagState?: string; tagPrefixes?: string[] };
  }>;
  const keepProd = policy.filter((rule) => rule.action.type === 'Keep'
    && rule.condition?.tagState === 'tagged'
    && (rule.condition.tagPrefixes ?? []).includes('prod-'));
  assert.equal(keepProd.length, 1, 'no Keep rule protects prod-* tags');
});

test('a production run tags the promoted digest prod-<sha> before any revision uses it or traffic moves', () => {
  const start = workflow.indexOf('Protect the production image from registry cleanup');
  assert.notEqual(start, -1, 'there is no step that tags the production image');
  const step = workflow.slice(start, workflow.indexOf('- name:', workflow.indexOf('\n', start)));
  assert.match(step, /if:\s*env\.TARGET == 'production'/, 'the prod- tag must only be written by a production run');
  assert.match(step, /IMAGE_DIGEST: \$\{\{ steps\.resolve\.outputs\.image_digest \}\}/, 'the tag must go on the digest staging is serving');
  assert.match(step, /TAG_URI="\$\{REGION\}-docker\.pkg\.dev\/\$\{PROJECT_ID\}\/\$\{REPOSITORY\}\/\$\{IMAGE\}:prod-\$\{GITHUB_SHA\}"/);
  assert.match(step, /gcloud artifacts docker tags add "\$\{IMAGE_DIGEST\}" "\$\{TAG_URI\}"/);
  // Order: resolve → tag → deploy → smoke → traffic.
  assert.ok(workflow.indexOf('Resolve the staging image') < start);
  assert.ok(start < workflow.indexOf('Deploy (behind a tag'));
  assert.ok(start < workflow.indexOf('Send traffic to the new revision'));
  // Tagging needs artifactregistry.tags.create/update, which the writer role
  // the deployer already has on the repository includes.
  assert.match(read('infra/bootstrap.sh'), /--member="serviceAccount:\$\{DEPLOYER_SA\}" --role=roles\/artifactregistry\.writer/);
});

test('re-running a production deploy for the same commit does not need tags.delete', () => {
  // `gcloud artifacts docker tags add` on an existing tag is delete + create
  // (docker_util.AddDockerTag), and roles/artifactregistry.writer has no
  // tags.delete. So the step looks first, and adds only when the tag is absent.
  const start = workflow.indexOf('Protect the production image from registry cleanup');
  const step = workflow.slice(start, workflow.indexOf('- name:', workflow.indexOf('\n', start)));
  const lookup = step.indexOf('gcloud artifacts docker images describe "${TAG_URI}"');
  const add = step.indexOf('gcloud artifacts docker tags add "${IMAGE_DIGEST}"');
  assert.notEqual(lookup, -1, 'the step does not look the tag up before adding it');
  assert.ok(lookup < add, 'the lookup must come before the add');
  assert.match(step, /WANT="\$\{IMAGE_DIGEST#\*@\}"/, 'the comparison must be against the bare sha256 digest');
  assert.match(step, /if \[ "\$\{CURRENT\}" = "\$\{WANT\}" \]; then\n\s*echo "[^"]*nothing to do"/, 'an identical tag must be a no-op');
  // A tag on another digest fails loudly; it is never silently moved.
  assert.match(step, /else\n\s*echo "::error::[^"]*Refusing to move a production tag[^"]*"\n\s*exit 1\n\s*fi\n\s*else\n\s*gcloud artifacts docker tags add/);
  assert.equal(step.split('gcloud artifacts docker tags add "').length - 1, 1, 'exactly one add, in the absent branch');
});

test('the tag step, run against a stand-in gcloud: adds when absent, no-op when same, fails when different', () => {
  const start = workflow.indexOf('Protect the production image from registry cleanup');
  const step = workflow.slice(start, workflow.indexOf('- name:', workflow.indexOf('\n', start)));
  const body = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length);
  const script = body.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');

  const digest = 'sha256:' + 'a'.repeat(64);
  const dir = mkdtempSync(join(tmpdir(), 'prod-tag-'));
  try {
    const log = join(dir, 'calls.log');
    // `describe` answers from $TAG_STATE: absent → exit 1, else prints that digest.
    writeFileSync(join(dir, 'gcloud'), [
      '#!/usr/bin/env bash',
      `echo "$*" >>"${log}"`,
      'if [ "$1 $2 $3 $4" = "artifacts docker images describe" ]; then',
      '  [ "${TAG_STATE}" = absent ] && { echo "NOT_FOUND" >&2; exit 1; }',
      '  echo "${TAG_STATE}"; exit 0',
      'fi',
      'exit 0',
    ].join('\n'));
    chmodSync(join(dir, 'gcloud'), 0o755);

    const run = (tagState: string) => {
      rmSync(log, { force: true });
      let status = 0;
      let output = '';
      try {
        output = execFileSync('bash', ['-e', '-c', script], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            TAG_STATE: tagState,
            REGION: 'europe-west1', PROJECT_ID: 'p', REPOSITORY: 'r', IMAGE: 'api', GITHUB_SHA: 'c0ffee',
            IMAGE_DIGEST: `europe-west1-docker.pkg.dev/p/r/api@${digest}`,
          } as unknown as NodeJS.ProcessEnv,
        });
      } catch (error) {
        status = (error as { status: number }).status;
        output = String((error as { stdout: string }).stdout);
      }
      let calls: string[] = [];
      try { calls = readFileSync(log, 'utf8').trim().split('\n'); } catch { /* no calls */ }
      return { status, output, adds: calls.filter((call) => call.startsWith('artifacts docker tags add')) };
    };

    const absent = run('absent');
    assert.equal(absent.status, 0);
    assert.deepEqual(absent.adds, [`artifacts docker tags add europe-west1-docker.pkg.dev/p/r/api@${digest} europe-west1-docker.pkg.dev/p/r/api:prod-c0ffee`]);

    const same = run(digest);
    assert.equal(same.status, 0, 'a re-run for the same digest must succeed');
    assert.deepEqual(same.adds, [], 'a re-run must not call tags add (it would need tags.delete)');

    const other = run('sha256:' + 'b'.repeat(64));
    assert.notEqual(other.status, 0, 'a tag on another digest must fail the run');
    assert.deepEqual(other.adds, [], 'a production tag is never silently moved');
    assert.match(other.output, /::error::.*Refusing to move a production tag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
