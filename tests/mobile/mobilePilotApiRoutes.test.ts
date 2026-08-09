import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAnalyticsEvents, resetAnalyticsEventsForTests } from '../../lib/analytics/eventStore.ts';
import { NEXT_STEP_EXPERIMENT_ENV, resolveNextStepArm } from '../../lib/experiments/experimentControls.ts';
import { generatePilotToken } from '../../lib/pilot/pilotTokenService.ts';
import { getPilotTrustStore } from '../../lib/pilot/pilotTrustStore.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { resetMobilePilotDecisionReplaysForTests } from '../../lib/services/mobile/pilotService.ts';
import { GET as getNextStep } from '../../src/app/api/mobile/recommendations/next-step/route.ts';
import { POST as recordNextStepAction } from '../../src/app/api/mobile/recommendations/next-step/actions/route.ts';
import { GET as getTrust, POST as updateTrust } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { POST as reportIncident } from '../../src/app/api/mobile/pilot/incidents/route.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import {
  DELETE as commitmentDelete,
  GET as commitmentGet,
  PATCH as commitmentPatch,
} from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import type { NextStepRecommendationContract } from '../../src/contracts/v1/nextStepContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const REFERENCE_TIME = '2026-08-09T08:00:00.000Z';
const TEST_SECRET = 'test-secret-min-16-chars-long-security-key';
const IDS = Array.from({ length: 40 }, (_, index) => `p-${String(index + 100).padStart(3, '0')}`);
const [A, B, C, D] = IDS;
const OUTSIDER = 'p-999';

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function token(participantId: string): string {
  return generatePilotToken(participantId, TEST_SECRET);
}

function request(path: string, options: {
  method?: string;
  participantId?: string;
  tokenOverride?: string;
  body?: unknown;
} = {}): Request {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const authToken = options.tokenOverride ?? (options.participantId ? token(options.participantId) : null);
  if (authToken) headers.set('authorization', `Bearer ${authToken}`);
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function setup(overrides: Record<string, string | undefined> = {}): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-mobile-pilot-api-'));
  const previous: Record<string, string | undefined> = {
    MAYBESITTER_CLOSED_PILOT_IDS: process.env.MAYBESITTER_CLOSED_PILOT_IDS,
    MAYBESITTER_PILOT_TRUST_FILE: process.env.MAYBESITTER_PILOT_TRUST_FILE,
    MAYBESITTER_PILOT_TOKEN_SECRET: process.env.MAYBESITTER_PILOT_TOKEN_SECRET,
    MAYBESITTER_DATA_DIR: process.env.MAYBESITTER_DATA_DIR,
    MAYBESITTER_FEATURE_RECOMMENDATION: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
    MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS: process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS,
    MAYBESITTER_PILOT_INCIDENT_OWNER_ID: process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID,
  };
  process.env.MAYBESITTER_CLOSED_PILOT_IDS = IDS.slice(0, 25).join(',');
  process.env.MAYBESITTER_PILOT_TRUST_FILE = join(directory, 'pilot-trust.json');
  process.env.MAYBESITTER_PILOT_TOKEN_SECRET = TEST_SECRET;
  process.env.MAYBESITTER_DATA_DIR = directory;
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS = 'true';
  process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID = 'pilot_owner';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetAnalyticsEventsForTests();
  resetMobilePilotDecisionReplaysForTests();
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  };
}

function grantRecommendation(participantId: string): void {
  getPilotTrustStore().apply(participantId, {
    type: 'grant_recommendation_consent',
    at: new Date().toISOString(),
  });
}

function grantAnalytics(participantId: string): void {
  getPilotTrustStore().apply(participantId, {
    type: 'set_analytics_consent',
    granted: true,
    at: new Date().toISOString(),
  });
}

async function createConfirmedCommitment(
  participantId: string,
  text: string,
  spoofedScope?: string,
): Promise<string> {
  const proposalResponse = await capturePost(request('/api/mobile/capture', {
    participantId,
    body: {
      text,
      referenceTime: REFERENCE_TIME,
      timezone: 'UTC',
      participantId: spoofedScope,
      scopeId: spoofedScope,
    },
  }));
  assert.equal(proposalResponse.status, 200);
  const proposal = await json(proposalResponse);
  assert.equal(proposal.status, 'proposed');
  const itemId = (proposal.items as Array<{ itemId: string }>)[0].itemId;
  const confirmResponse = await confirmPost(request('/api/mobile/capture/confirm', {
    participantId,
    body: {
      proposalId: proposal.proposalId,
      scopeId: spoofedScope,
      participantId: spoofedScope,
      itemIds: [itemId],
      idempotencyKey: `confirm-${participantId}-${itemId}`,
    },
  }));
  assert.equal(confirmResponse.status, 200);
  const confirmation = await json(confirmResponse);
  assert.equal(confirmation.success, true);
  return ((confirmation.persisted as Array<{ commitmentId: string }>)[0]).commitmentId;
}

async function nextStep(participantId: string, spoofedScope?: string): Promise<Record<string, unknown>> {
  const query = spoofedScope ? `?participantId=${spoofedScope}&scopeId=${spoofedScope}&timezone=UTC` : '?timezone=UTC';
  const response = await getNextStep(request(`/api/mobile/recommendations/next-step${query}`, { participantId }));
  assert.equal(response.status, 200);
  return json(response);
}

test('mobile pilot routes require valid bearer token authorization', async () => {
  const cleanup = setup();
  try {
    const missing = await getNextStep(request('/api/mobile/recommendations/next-step'));
    assert.equal(missing.status, 401);
    assert.equal((await json(missing)).reason, 'missing_token');

    const malformed = await getNextStep(request('/api/mobile/recommendations/next-step', { tokenOverride: 'not-a-token' }));
    assert.equal(malformed.status, 401);
    assert.equal((await json(malformed)).reason, 'malformed_token');

    const valid = token(A);
    const invalidSignature = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`;
    const invalid = await getNextStep(request('/api/mobile/recommendations/next-step', { tokenOverride: invalidSignature }));
    assert.equal(invalid.status, 401);
    assert.equal((await json(invalid)).reason, 'invalid_signature');

    const nonAllowlisted = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: OUTSIDER }));
    assert.equal(nonAllowlisted.status, 403);
    assert.equal((await json(nonAllowlisted)).reason, 'not_allowlisted');

    getPilotTrustStore().apply(C, { type: 'revoke', at: new Date().toISOString() });
    const revoked = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: C }));
    assert.equal(revoked.status, 403);
    assert.equal((await json(revoked)).reason, 'revoked');

    getPilotTrustStore().apply(D, { type: 'delete', at: new Date().toISOString() });
    const deleted = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: D }));
    assert.equal(deleted.status, 403);
    assert.equal((await json(deleted)).reason, 'deleted');
  } finally {
    cleanup();
  }
});

test('authenticated mobile canonical flow stays inside bearer participant scope', async () => {
  const cleanup = setup();
  try {
    const todayId = await createConfirmedCommitment(A, 'Remind me to call Maya at 11am');
    const today = await json(await todayGet(request('/api/mobile/commitments/today?timezone=UTC&referenceTime=2026-08-09T08%3A00%3A00.000Z', { participantId: A })));
    assert.equal((today.items as Array<{ id: string }>).some((item) => item.id === todayId), true);

    const detail = await commitmentGet(request(`/api/mobile/commitments/${todayId}`, { participantId: A }), params(todayId));
    assert.equal(detail.status, 200);

    const patch = await commitmentPatch(request(`/api/mobile/commitments/${todayId}`, {
      method: 'PATCH',
      participantId: A,
      body: { title: 'Call Maya with update', dueDate: '2026-08-10T12:00:00.000Z' },
    }), params(todayId));
    assert.equal(patch.status, 200);
    assert.equal((await json(patch)).title, 'Call Maya with update');

    const upcoming = await json(await upcomingGet(request('/api/mobile/commitments/upcoming?timezone=UTC&referenceTime=2026-08-09T08%3A00%3A00.000Z', { participantId: A })));
    assert.equal((upcoming.items as Array<{ id: string }>).some((item) => item.id === todayId), true);

    const complete = await actionPost(request(`/api/mobile/commitments/${todayId}/actions`, {
      participantId: A,
      body: { action: 'complete' },
    }), params(todayId));
    assert.equal(complete.status, 200);

    const deletion = await commitmentDelete(request(`/api/mobile/commitments/${todayId}`, {
      method: 'DELETE',
      participantId: A,
    }), params(todayId));
    assert.equal(deletion.status, 200);
  } finally {
    cleanup();
  }
});

test('valid B token cannot fetch, patch, action, or delete A commitment', async () => {
  const cleanup = setup();
  try {
    const aId = await createConfirmedCommitment(A, 'Remind me to call A tomorrow at 9am');

    const getAsB = await commitmentGet(request(`/api/mobile/commitments/${aId}`, { participantId: B }), params(aId));
    assert.equal(getAsB.status, 404);

    const patchAsB = await commitmentPatch(request(`/api/mobile/commitments/${aId}`, {
      method: 'PATCH',
      participantId: B,
      body: { title: 'B should not mutate A' },
    }), params(aId));
    assert.equal(patchAsB.status, 404);

    const actionAsB = await actionPost(request(`/api/mobile/commitments/${aId}/actions`, {
      participantId: B,
      body: { action: 'complete' },
    }), params(aId));
    assert.notEqual(actionAsB.status, 200);

    const deleteAsB = await commitmentDelete(request(`/api/mobile/commitments/${aId}`, {
      method: 'DELETE',
      participantId: B,
    }), params(aId));
    assert.notEqual(deleteAsB.status, 200);

    const aDetail = await json(await commitmentGet(request(`/api/mobile/commitments/${aId}`, { participantId: A }), params(aId)));
    assert.equal(aDetail.title, 'call A');
    assert.equal(aDetail.status, 'active');
  } finally {
    cleanup();
  }
});

test('body and query participant spoofing cannot escape authenticated scope and assignment is server-owned', async () => {
  const cleanup = setup();
  try {
    grantRecommendation(B);
    const bId = await createConfirmedCommitment(B, 'Remind me to call B tomorrow at 10am', A);

    const bDetail = await commitmentGet(request(`/api/mobile/commitments/${bId}`, { participantId: B }), params(bId));
    assert.equal(bDetail.status, 200);
    const aDetail = await commitmentGet(request(`/api/mobile/commitments/${bId}`, { participantId: A }), params(bId));
    assert.equal(aDetail.status, 404);

    const trust = await json(await getTrust(request(`/api/mobile/pilot/trust?participantId=${A}&scopeId=${A}`, { participantId: B })));
    assert.equal(trust.participantId, B);

    const recommendation = await nextStep(B, A);
    assert.equal(recommendation.participantId, B);
    assert.equal((recommendation.assignment as { arm: string }).arm, resolveNextStepArm(B).arm);
  } finally {
    cleanup();
  }
});

test('trust and recommendation decisions are isolated per authenticated participant', async () => {
  const cleanup = setup();
  try {
    grantRecommendation(A);
    grantAnalytics(A);
    grantRecommendation(B);
    grantAnalytics(B);
    await createConfirmedCommitment(A, 'Remind me to call Alice tomorrow at 9am');
    await createConfirmedCommitment(B, 'Remind me to email Blake tomorrow at 4pm');

    const aProposal = (await nextStep(A)).recommendation as NextStepRecommendationContract;
    const staleForB = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', {
      participantId: B,
      body: { proposal: aProposal, decision: 'accept', idempotencyKey: 'cross-participant' },
    }));
    assert.equal(staleForB.status, 409);

    const acceptedByA = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', {
      participantId: A,
      body: { proposal: aProposal, decision: 'accept', idempotencyKey: 'a-accepts' },
    }));
    assert.equal(acceptedByA.status, 200);

    await updateTrust(request('/api/mobile/pilot/trust', {
      participantId: B,
      body: { action: { type: 'set_quiet_mode', enabled: true } },
    }));
    const bQuiet = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: B }));
    assert.equal(bQuiet.status, 403);
    assert.equal((await json(bQuiet)).reason, 'quiet_mode');
    const aStillOpen = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: A }));
    assert.equal(aStillOpen.status, 200);

    assert.deepEqual(getAnalyticsEvents().map((event) => event.eventName), [
      'recommendation_shown',
      'recommendation_accepted',
      'recommendation_shown',
    ]);
  } finally {
    cleanup();
  }
});

test('mobile pilot recommendation action idempotency is participant-scoped and durable', async () => {
  const cleanup = setup();
  try {
    grantRecommendation(A);
    grantAnalytics(A);
    await createConfirmedCommitment(A, 'Remind me to submit the permit tomorrow at 2pm');
    const proposal = (await nextStep(A)).recommendation;
    resetAnalyticsEventsForTests();
    const payload = { proposal, decision: 'accept', idempotencyKey: 'same-action' };

    const first = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', { participantId: A, body: payload }));
    const second = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', { participantId: A, body: payload }));
    const mismatch = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', {
      participantId: A,
      body: { ...payload, decision: 'dismiss' },
    }));

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await json(second)).replayed, true);
    assert.equal(mismatch.status, 409);
    assert.equal(getAnalyticsEvents().filter((event) => event.eventName === 'recommendation_accepted').length, 1);
  } finally {
    cleanup();
  }
});

test('participant deletion is local to A and keeps B state intact', async () => {
  const cleanup = setup();
  try {
    grantRecommendation(A);
    grantRecommendation(B);
    const aId = await createConfirmedCommitment(A, 'Remind me to cancel A plan tomorrow at noon');
    const bId = await createConfirmedCommitment(B, 'Remind me to keep B plan tomorrow at noon');

    const deleteA = await updateTrust(request('/api/mobile/pilot/trust', {
      participantId: A,
      body: { action: { type: 'delete' } },
    }));
    assert.equal(deleteA.status, 200);
    assert.equal((await json(deleteA)).participantId, A);

    const aAfterDelete = await commitmentGet(request(`/api/mobile/commitments/${aId}`, { participantId: A }), params(aId));
    assert.equal(aAfterDelete.status, 403);
    assert.equal((await json(aAfterDelete)).reason, 'deleted');

    const bAfterDelete = await commitmentGet(request(`/api/mobile/commitments/${bId}`, { participantId: B }), params(bId));
    assert.equal(bAfterDelete.status, 200);
    assert.equal((await json(bAfterDelete)).title, 'keep B plan at noon');
    const bTrust = await getTrust(request('/api/mobile/pilot/trust', { participantId: B }));
    assert.equal(bTrust.status, 200);
  } finally {
    cleanup();
  }
});

test('concurrent authenticated A/B and same-participant writes do not lose updates', async () => {
  const cleanup = setup();
  try {
    const created = await Promise.all([
      createConfirmedCommitment(A, 'Remind me to call Ava tomorrow at 9am'),
      createConfirmedCommitment(B, 'Remind me to call Ben tomorrow at 9am'),
      createConfirmedCommitment(A, 'Remind me to call Ada tomorrow at 10am'),
      createConfirmedCommitment(B, 'Remind me to call Bea tomorrow at 10am'),
      createConfirmedCommitment(A, 'Remind me to call Ari tomorrow at 11am'),
    ]);
    assert.equal(new Set(created).size, 5);

    const aCommitments = Object.values(getParticipantStateSnapshot(A).commitments);
    const bCommitments = Object.values(getParticipantStateSnapshot(B).commitments);
    assert.equal(aCommitments.length, 3);
    assert.equal(bCommitments.length, 2);
    assert.equal(aCommitments.every((item) => item.status === 'active'), true);
    assert.equal(bCommitments.every((item) => item.status === 'active'), true);
  } finally {
    cleanup();
  }
});

test('mobile pilot incident reporting uses authenticated participant and drops raw notes', async () => {
  const cleanup = setup();
  try {
    const incident = await reportIncident(request('/api/mobile/pilot/incidents', {
      participantId: B,
      body: {
        participantId: A,
        scopeId: A,
        surface: 'recommendation',
        category: 'privacy',
        notes: 'raw private text must not be stored',
      },
    }));
    assert.equal(incident.status, 201);
    assert.equal((await json(incident)).success, true);

    const stored = getPilotTrustStore().incidents();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].participantId, B);
    assert.equal('notes' in stored[0], false);
    assert.equal(getPilotTrustStore().auditEvents().some((event) => event.eventType === 'support_reported'), true);
  } finally {
    cleanup();
  }
});
