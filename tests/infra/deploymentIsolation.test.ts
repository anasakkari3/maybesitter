/**
 * Integration is not deployment (repository consolidation, 2026-11-08).
 *
 * The production Workload Identity provider trusts any workflow run on
 * `refs/heads/main` of this repository; it does not check the GitHub
 * environment. So the boundary that keeps a merge to `main` from reaching
 * Cloud Run or Firebase has to be in the workflow files themselves:
 *
 *   - a workflow that can mint a cloud credential (`id-token: write`) or that
 *     deploys runs only on a manual dispatch, never on a push, a pull request,
 *     a schedule or another workflow;
 *   - only `deploy.yml`, in the protected `production` environment, may name
 *     the production deployer identity;
 *   - nothing can reach a deploying workflow indirectly (reusable workflows,
 *     `pull_request_target`, `workflow_run`).
 *
 * Every file in `.github/workflows/` is checked, including ones added later,
 * so a new workflow cannot quietly reopen the path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, '.github', 'workflows');
const files = readdirSync(DIR).filter(name => /\.ya?ml$/.test(name)).sort();
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');
/** The text without full-line comments, so a comment cannot satisfy or trip a check. */
const code = (name: string): string => read(name).split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

/** The trigger names under the top-level `on:` block. */
function triggers(name: string): string[] {
  const text = code(name);
  const inline = /^on:[ \t]*(\S.*)$/m.exec(text);
  if (inline) return inline[1].replace(/[[\]]/g, '').split(',').map(part => part.trim()).filter(Boolean);
  const block = /^on:\n((?:[ \t]+[^\n]*\n|\n)*)/m.exec(text)?.[1] ?? '';
  return block.split('\n').filter(line => /^ {2}[a-z_]+:/.test(line)).map(line => line.trim().replace(/:.*$/, ''));
}

const DEPLOYS = /\bgcloud\s+run\s+(deploy|services\s+update|services\s+update-traffic|services\s+replace|jobs\s+deploy)\b|firebase-tools[^\n]*\sdeploy\b|\bfirebase\s+deploy\b|\bgcloud\s+(app|functions|builds)\s+(deploy|submit)\b|\bgcloud\s+scheduler\s+jobs\s+(create|update|delete)\b|\bgcloud\s+firestore\s+indexes\b/;

test('the workflow directory is what this test expects to guard', () => {
  assert.ok(files.length >= 5, `only ${files.length} workflow files found`);
  for (const expected of ['ci.yml', 'dependency-review.yml', 'deploy.yml', 'deploy-staging.yml', 'infra-staging.yml']) {
    assert.ok(files.includes(expected), `${expected} is missing`);
  }
});

test('a workflow that can obtain a cloud credential or deploys runs only on a manual dispatch', () => {
  for (const name of files) {
    const text = code(name);
    const credential = /id-token:\s*write/.test(text) || /google-github-actions\/auth@/.test(text);
    const deploys = DEPLOYS.test(text);
    if (!credential && !deploys) continue;
    assert.deepEqual(triggers(name), ['workflow_dispatch'], `${name} can deploy or authenticate to Google Cloud but is triggered by ${triggers(name).join(', ')}`);
  }
});

test('the integration workflows that run on main or on pull requests hold no cloud credential', () => {
  for (const name of files) {
    const on = triggers(name);
    if (on.every(trigger => trigger === 'workflow_dispatch')) continue;
    const text = code(name);
    assert.doesNotMatch(text, /id-token:\s*write/, `${name} runs automatically and can mint an OIDC token`);
    assert.doesNotMatch(text, /google-github-actions\/(auth|setup-gcloud|deploy-cloudrun)@/, `${name} runs automatically and uses a Google Cloud action`);
    assert.doesNotMatch(text, /\bsecrets\.(?!GITHUB_TOKEN\b)[A-Z_]+/, `${name} runs automatically and reads a repository secret`);
    assert.doesNotMatch(text, /vars\.(GCP_|STAGING_)/, `${name} runs automatically and names a cloud identity`);
    assert.doesNotMatch(text, DEPLOYS, `${name} runs automatically and contains a deploy command`);
    assert.doesNotMatch(text, /^\s*environment:/m, `${name} runs automatically and enters a deployment environment`);
  }
});

test('ci.yml is the only workflow a push to main starts, and it is read-only', () => {
  const onPush = files.filter(name => triggers(name).includes('push'));
  assert.deepEqual(onPush, ['ci.yml']);
  assert.match(code('ci.yml'), /^permissions:\n\s+contents: read\n(?!\s+\S+:\s*write)/m);
});

test('deploy.yml is production-only, manual, and bound to the protected environment', () => {
  const text = code('deploy.yml');
  assert.deepEqual(triggers('deploy.yml'), ['workflow_dispatch']);
  assert.match(text, /^\s*environment: production$/m);
  assert.doesNotMatch(text, /^\s*environment: staging$/m);
  assert.doesNotMatch(text, /maybesitter-api-staging"|database_id="staging"|firebase\.staging\.json/, 'deploy.yml can still target the legacy shared-project staging');
});

test('only deploy.yml names the production deployer identity', () => {
  for (const name of files) {
    if (name === 'deploy.yml') continue;
    const text = code(name);
    assert.doesNotMatch(text, /vars\.GCP_DEPLOYER_SA|vars\.GCP_WIF_PROVIDER|maybesitter-deployer@/, `${name} names the production deployer`);
    assert.doesNotMatch(text, /workloadIdentityPools\/github\/providers\/github-actions/, `${name} names the production WIF provider`);
  }
});

test('nothing reaches a deploying workflow indirectly', () => {
  for (const name of files) {
    const on = triggers(name);
    assert.ok(!on.includes('pull_request_target'), `${name} uses pull_request_target`);
    assert.ok(!on.includes('workflow_run'), `${name} is started by another workflow`);
    assert.ok(!on.includes('workflow_call'), `${name} is a reusable workflow another one could call`);
    assert.ok(!on.includes('repository_dispatch'), `${name} can be started by an API event`);
    assert.ok(!on.includes('schedule'), `${name} runs on a schedule`);
    assert.doesNotMatch(code(name), /^\s*uses:\s*\.\/\.github\/workflows\//m, `${name} calls a local reusable workflow`);
    assert.doesNotMatch(code(name), /^\s*uses:\s*[^\s]+\/\.github\/workflows\/[^\s]+@/m, `${name} calls a remote reusable workflow`);
  }
});
