import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The isolated staging project's workflows (Phase 5.8, Option A). deploy.yml is
// deliberately unchanged here; making it production-only is an owner decision
// kept on branch recovery/staging-isolation-cicd.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('the isolated staging config deploys only its own staging database', () => {
  const infra = read('.github/workflows/infra-staging.yml');
  assert.doesNotMatch(infra, /--config firebase\.json/);
  assert.match(infra, /FIREBASE_CONFIG: firebase\.staging-project\.json/);
  const isolated = JSON.parse(read('firebase.staging-project.json')).firestore as Array<{ database: string }>;
  assert.deepEqual(isolated.map(entry => entry.database), ['staging']);
});

test('the staging workflows are manual, environment-bound, and ask for no more than they need', () => {
  for (const file of ['.github/workflows/deploy-staging.yml', '.github/workflows/infra-staging.yml']) {
    const workflow = read(file);
    const triggers = (/^on:\n((?:[ \t]+[^\n]*\n|\n)*)/m.exec(workflow)?.[1] ?? '')
      .split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
    assert.deepEqual(triggers, ['workflow_dispatch:'], `${file} has a trigger other than workflow_dispatch`);
    assert.doesNotMatch(workflow, /^\s*(push|pull_request|pull_request_target|schedule|workflow_run):/m, `${file} has an automatic trigger`);
    assert.match(workflow, /^permissions: \{\}$/m, `${file} grants top-level token permissions`);
    assert.match(workflow, /^    environment: staging$/m, `${file} is not bound to the staging environment`);
    assert.match(workflow, /^    permissions:\n      contents: read\n      id-token: write\n    env:/m, `${file} asks for other permissions`);
    // Fail closed on production identifiers before authenticating.
    const preflight = workflow.indexOf('- name: Preflight');
    const auth = workflow.indexOf('uses: google-github-actions/auth@');
    assert.ok(preflight !== -1 && preflight < auth, `${file} authenticates before its preflight`);
    assert.match(workflow, /"\$\{PROJECT_ID\}" != "maybesitter-app"/);
    assert.match(workflow, /"\$\{PROJECT_NUMBER\}" != "955684917741"/);
    // Every gcloud and firebase call names the project (continuation lines joined).
    // A call inside $(...) counts too: everything from the command to the end
    // of its logical line must name the project.
    const logical = workflow.replace(/\\\n\s*/g, ' ').split('\n').map(line => line.trim()).filter(line => !line.startsWith('#'));
    const calls = logical.flatMap(line => Array.from(line.matchAll(/\b(?:gcloud|npx --yes firebase-tools(?:@\S+)?) .*/g), match => match[0]))
      .filter(call => !/^gcloud auth (list|configure-docker)\b/.test(call));
    assert.ok(calls.length >= 2, `${file}: no cloud calls found`);
    for (const call of calls) assert.match(call, /--project\b/, `${file}: "${call}" has no explicit --project`);
    assert.doesNotMatch(workflow, /vars\.GCP_DEPLOYER_SA|vars\.GCP_WIF_PROVIDER/, `${file} uses the production identity`);
  }
});
