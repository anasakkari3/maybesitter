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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
