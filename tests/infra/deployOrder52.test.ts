import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectionGroupOf, compareIndexes, indexKey, validateIndexFile,
} from '../../scripts/firestore-index-ready.mjs';

// Phase 5.2: the deploy workflow must not move live traffic before the Firestore
// indexes it needs are READY, and each environment must deploy only its own
// database. The workflow is checked as text, like the other infra tests, because
// root tests cannot import the mobile toolchain that a YAML parser would live in.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('the Firestore indexes are deployed and READY before a revision is deployed, and traffic moves last', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const at = (name: string): number => {
    const index = workflow.indexOf(name);
    assert.notEqual(index, -1, `step "${name}" is missing`);
    return index;
  };
  const deployFirestore = at('- name: Validate and deploy Firestore rules and indexes');
  const waitReady = at('- name: Wait until the new indexes are READY');
  const deployRevision = at('- name: Deploy (behind a tag once the service exists)');
  const smoke = at('- name: Smoke test the new revision');
  const traffic = at('- name: Send traffic to the new revision');
  assert.ok(deployFirestore < waitReady, 'indexes are not deployed before they are awaited');
  assert.ok(waitReady < deployRevision, 'a revision is deployed before the indexes are READY');
  assert.ok(deployRevision < smoke && smoke < traffic, 'traffic can move before the smoke test');
  assert.equal(workflow.match(/- name: Deploy Firestore rules and indexes/g), null, 'the old trailing Firestore step is back');
});

test('no executable line in the deploy workflow passes --force to the Firebase deploy', () => {
  const executable = read('.github/workflows/deploy.yml').split('\n').filter(line => !line.trim().startsWith('#'));
  assert.deepEqual(executable.filter(line => /--force\b/.test(line)), []);
});

test('each environment deploys only its own Firestore database', () => {
  const staging = JSON.parse(read('firebase.staging.json')).firestore as Array<{ database: string }>;
  const production = JSON.parse(read('firebase.production.json')).firestore as Array<{ database: string }>;
  assert.deepEqual(staging.map(entry => entry.database), ['staging']);
  assert.deepEqual(production.map(entry => entry.database), ['(default)']);
  // firebase.json keeps both, for manual use; the workflow never reads it.
  const both = (JSON.parse(read('firebase.json')).firestore as Array<{ database: string }>).map(entry => entry.database).sort();
  assert.deepEqual(both, ['(default)', 'staging']);
  // Production deploys its database from deploy.yml; the isolated staging
  // project deploys its own from infra-staging.yml. Neither reads firebase.json.
  const workflow = read('.github/workflows/deploy.yml');
  assert.doesNotMatch(workflow, /--config firebase\.json/);
  assert.match(workflow, /firebase\.production\.json/);
  assert.doesNotMatch(workflow, /FIREBASE_CONFIG="firebase\.staging\.json"/, 'deploy.yml deploys the legacy staging database again');
  const infra = read('.github/workflows/infra-staging.yml');
  assert.doesNotMatch(infra, /--config firebase\.json/);
  assert.match(infra, /FIREBASE_CONFIG: firebase\.staging-project\.json/);
  const isolated = JSON.parse(read('firebase.staging-project.json')).firestore as Array<{ database: string }>;
  assert.deepEqual(isolated.map(entry => entry.database), ['staging']);
});

test('the production deploy workflow is manual only, and deploys nothing on a push', () => {
  // The push-to-main staging deploy used the production deployer identity;
  // it was removed on purpose (Phase 5.8). Staging is deploy-staging.yml.
  const workflow = read('.github/workflows/deploy.yml');
  assert.match(workflow, /^on:\n(?:\s*#[^\n]*\n)*\s*workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /^\s*pull_request/m);
  assert.match(workflow, /^\s*environment: production$/m);
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

test('the index gate validates a well-formed file and names every shape error', () => {
  assert.deepEqual(validateIndexFile({ indexes: [{
    collectionGroup: 'busyBlocks', queryScope: 'COLLECTION',
    fields: [{ fieldPath: 'sourceId', order: 'ASCENDING' }, { fieldPath: 'startAt', arrayConfig: 'CONTAINS' }],
  }] }), []);
  assert.deepEqual(validateIndexFile({}), ['the file has no "indexes" array']);
  const bad = validateIndexFile({ indexes: [
    { collectionGroup: '', queryScope: 'DOCUMENT', fields: [{ fieldPath: 'a', order: 'ASCENDING', arrayConfig: 'CONTAINS' }] },
    { collectionGroup: 'x', queryScope: 'COLLECTION', fields: [] },
  ] });
  assert.ok(bad.some(error => error.includes('no collectionGroup')));
  assert.ok(bad.some(error => error.includes('queryScope must be')));
  assert.ok(bad.some(error => error.includes('exactly one of order or arrayConfig')));
  assert.ok(bad.some(error => error.includes('no fields')));
});

test('an index is matched by scope, collection group and field order, and the __name__ field is ignored', () => {
  const declared = [{ collectionGroup: 'g', queryScope: 'COLLECTION_GROUP', fields: [
    { fieldPath: 'a', order: 'ASCENDING' }, { fieldPath: 'b', order: 'DESCENDING' },
  ] }];
  const remote = (fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>, state: string) => ({
    name: 'projects/p/databases/staging/collectionGroups/g/indexes/abc', queryScope: 'COLLECTION_GROUP', fields, state,
  });
  // Same fields, Firestore adds __name__: READY, nothing missing.
  assert.equal(compareIndexes(declared, [remote([
    { fieldPath: 'a', order: 'ASCENDING' }, { fieldPath: 'b', order: 'DESCENDING' }, { fieldPath: '__name__', order: 'DESCENDING' },
  ], 'READY')]).ready, true);
  // Still building: not READY, even though it is accepted.
  const creating = compareIndexes(declared, [remote([{ fieldPath: 'a', order: 'ASCENDING' }, { fieldPath: 'b', order: 'DESCENDING' }], 'CREATING')]);
  assert.equal(creating.ready, false);
  assert.equal(creating.creating.length, 1);
  // Field order is part of the identity.
  const reordered = compareIndexes(declared, [remote([{ fieldPath: 'b', order: 'DESCENDING' }, { fieldPath: 'a', order: 'ASCENDING' }], 'READY')]);
  assert.equal(reordered.ready, false);
  assert.equal(reordered.missing.length, 1);
});

test('an index the database has and the file does not is reported, never counted as missing', () => {
  const declared = [{ collectionGroup: 'g', queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }] }];
  const result = compareIndexes(declared, [
    { name: 'projects/p/databases/d/collectionGroups/g/indexes/1', queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }], state: 'READY' },
    { name: 'projects/p/databases/d/collectionGroups/old/indexes/2', queryScope: 'COLLECTION', fields: [{ fieldPath: 'z', order: 'ASCENDING' }], state: 'READY' },
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.extra.length, 1);
});

test('the collection group is read from the index resource name, and the key is stable', () => {
  assert.equal(collectionGroupOf('projects/p/databases/staging/collectionGroups/intelligenceMonitors/indexes/x'), 'intelligenceMonitors');
  assert.equal(collectionGroupOf('not-a-name'), '');
  assert.equal(indexKey({ queryScope: 'COLLECTION', collectionGroup: 'c', fields: [{ fieldPath: 'a', order: 'ASCENDING' }] }),
    'COLLECTION|c|a:ASCENDING');
});
