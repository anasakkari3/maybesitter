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
  assert.match(workflow, /--format='value\(status\.url\)'/);
  assert.match(workflow, /PROBE="\$\{TAG_URL:-\$URL\}"/);
});

test('a public service is deployed by an identity that may make it public', () => {
  const flags = read('infra/cloudrun/flags.sh');
  const bootstrap = read('infra/bootstrap.sh');
  if (flags.includes('--allow-unauthenticated')) {
    assert.match(bootstrap, /add_role "\$\{DEPLOYER_SA\}" roles\/run\.admin/, 'the deployer cannot set the allUsers invoker binding');
  }
  assert.doesNotMatch(bootstrap, /add_role "\$\{DEPLOYER_SA\}" roles\/run\.developer/);
});

test('the deployer may pass firebase-tools\' API-enabled check before deploying rules and indexes', () => {
  // ensureApiEnabled.check() does not catch a 403, so a missing
  // serviceusage.services.get/.use fails the whole Firestore step.
  const workflow = read('.github/workflows/deploy.yml');
  if (/firebase-tools[^\n]*deploy --only firestore/.test(workflow)) {
    assert.match(read('infra/bootstrap.sh'), /add_role "\$\{DEPLOYER_SA\}" roles\/serviceusage\.serviceUsageConsumer/);
  }
});
