/**
 * The release route.
 *
 * Only what the route itself owns is tested here — a body that is not JSON at
 * all, the fail-closed default stage, and the honest "not available" the
 * unwired seams produce end to end. Everything else is the handler's, and it is
 * tested there against in-memory stores.
 *
 * The data directory is redirected to a temp dir for the whole file, because
 * the route's stores are file-backed and a test that wrote into the developer's
 * `.maybesitter` would be a test that changed the machine it ran on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SHADOW_STUDY_RATING_SCALE } from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { SHADOW_COHORT_ENV_VAR, SHADOW_STAGE_ENV_VAR } from '../../lib/release/exposure.ts';
import { POST } from '../../src/app/api/release/route.ts';

const NOW = '2027-01-10T09:00:00.000Z';
const P = 'participant-route';

function request(body: unknown): Request {
  return new Request('http://127.0.0.1:4321/api/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await POST(request(body));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function withTempData(run: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ms-release-route-'));
    const previous = {
      data: process.env.MAYBESITTER_DATA_DIR,
      stage: process.env[SHADOW_STAGE_ENV_VAR],
      cohort: process.env[SHADOW_COHORT_ENV_VAR],
    };
    process.env.MAYBESITTER_DATA_DIR = dir;
    delete process.env[SHADOW_STAGE_ENV_VAR];
    delete process.env[SHADOW_COHORT_ENV_VAR];
    try {
      await run();
    } finally {
      if (previous.data === undefined) delete process.env.MAYBESITTER_DATA_DIR;
      else process.env.MAYBESITTER_DATA_DIR = previous.data;
      if (previous.stage !== undefined) process.env[SHADOW_STAGE_ENV_VAR] = previous.stage;
      if (previous.cohort !== undefined) process.env[SHADOW_COHORT_ENV_VAR] = previous.cohort;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('a body that is not JSON at all is the route\'s own rejection, not a 500', async () => {
  const response = await POST(
    new Request('http://127.0.0.1:4321/api/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    }),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, 'MALFORMED_REQUEST_BODY');
});

test('the route requires an instant from the caller and never invents one', withTempData(async () => {
  const missing = await post({ action: 'consent_status', participantId: P });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'MISSING_INSTANT');
}));

test('the default stage is the one that exposes nobody, and the pilot gate still refuses first', withTempData(async () => {
  const granted = await post({ now: NOW, action: 'grant_consent', participantId: P, scopes: ['shadow_execution'] });
  assert.equal(granted.status, 200);

  const exposure = await post({ now: NOW, action: 'exposure', participantId: P });
  const decision = exposure.json.decision as { allowed: boolean; reason: string; stage: string; cap: number; consentState: string };
  assert.equal(decision.allowed, false);
  // The default configuration, fail-closed: no stage variable is set.
  assert.equal(decision.stage, 'shadow_only');
  assert.equal(decision.cap, 0);
  // And the *pilot* gate's refusal is what is reported, because it is consulted
  // first and its refusal is final. A full consent could not widen it.
  assert.equal(decision.reason, 'not_allowlisted');
  assert.equal(decision.consentState, 'granted');
}));

test('a study answer round-trips through the route and appears in the summary', withTempData(async () => {
  const recorded = await post({
    now: NOW,
    action: 'submit_response',
    participantId: P,
    runId: null,
    question: 'helpfulness',
    status: 'rated',
    rating: SHADOW_STUDY_RATING_SCALE.maximum,
  });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.json.kind, 'response_recorded');

  const declined = await post({
    now: NOW,
    action: 'submit_response',
    participantId: P,
    runId: null,
    question: 'intrusiveness',
    status: 'declined',
  });
  assert.equal(declined.status, 200);

  const summary = await post({ now: NOW, action: 'study_summary' });
  const body = summary.json.summary as { responseCount: number; declinedCount: number };
  assert.equal(body.responseCount, 2);
  assert.equal(body.declinedCount, 1);
}));

test('the assembled package names the two pillars this build cannot yet measure', withTempData(async () => {
  const outcome = await post({ now: NOW, action: 'evidence_package', packageId: 'shadow-release-2027-01-10' });
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.json.unavailablePillars, ['safety', 'reliability']);
  assert.deepEqual(outcome.json.defects, []);
  const assembled = outcome.json.package as { decision: string; evidence: Record<string, unknown[]> };
  assert.equal(assembled.decision, 'hold', 'a build with two unmeasurable pillars authorised a release');
  for (const pillar of ['quality', 'safety', 'reliability']) {
    assert.ok(assembled.evidence[pillar].length >= 1, `${pillar} is missing from the package`);
  }
}));

test('deleting through the route removes the data and reports what it cannot prove', withTempData(async () => {
  await post({ now: NOW, action: 'grant_consent', participantId: P, scopes: ['feedback_study'] });
  await post({
    now: NOW,
    action: 'submit_response',
    participantId: P,
    runId: null,
    question: 'trust',
    status: 'rated',
    rating: SHADOW_STUDY_RATING_SCALE.minimum,
  });

  const deleted = await post({ now: NOW, action: 'delete', participantId: P });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.kind, 'deleted_unproven');
  assert.deepEqual(deleted.json.unprovable, ['traces', 'replay_bundles']);

  // Proven by asking the route again rather than by the delete's own report.
  const status = await post({ now: NOW, action: 'consent_status', participantId: P });
  assert.equal((status.json.consent as { state: string }).state, 'withheld');
  const summary = await post({ now: NOW, action: 'study_summary' });
  assert.equal((summary.json.summary as { responseCount: number }).responseCount, 0);
}));
