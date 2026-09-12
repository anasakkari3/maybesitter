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

test('the deployer may pass firebase-tools\' API-enabled check before deploying rules and indexes', () => {
  // ensureApiEnabled.check() does not catch a 403, so a missing
  // serviceusage.services.get/.use fails the whole Firestore step.
  const workflow = read('.github/workflows/deploy.yml');
  if (/firebase-tools[^\n]*deploy --only firestore/.test(workflow)) {
    assert.match(read('infra/bootstrap.sh'), /add_role "\$\{DEPLOYER_SA\}" roles\/serviceusage\.serviceUsageConsumer/);
  }
});
