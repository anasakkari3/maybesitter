/**
 * The authenticated mobile API, end to end (UC-1.0e, #144).
 *
 * ── What changed under this file ─────────────────────────────────
 *
 * It used to mint HMAC pilot tokens and configure a 25–40 id allowlist to
 * make them valid. Identity is a Firebase ID token now, so the seam is the
 * verifier (`tests/support/fakeAuth`) and there is no roster to configure.
 * Two refusals it asserted are therefore gone — `not_allowlisted` and the
 * pilot-runtime 503 — and the scope claims it asserted are strengthened:
 * every route is guarded, so the body- and query-spoofing cases below run
 * against routes that have no unauthenticated path left at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAnalyticsEvents, resetAnalyticsEventsForTests } from '../../lib/analytics/eventStore.ts';
import { resolveNextStepArm } from '../../lib/experiments/experimentControls.ts';
import { applyTrustAction, listAllAuditEvents, listIncidents } from '../../lib/pilot/pilotTrustStore.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { RECOMMENDATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { resetMobilePilotDecisionReplaysForTests } from '../../lib/services/mobile/pilotService.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { deleteAccount, setDeletionAuthForTests } from '../../lib/account/accountDeletion.ts';
import { GET as getNextStep } from '../../src/app/api/mobile/recommendations/next-step/route.ts';
import { POST as recordNextStepAction } from '../../src/app/api/mobile/recommendations/next-step/actions/route.ts';
import { GET as getTrust, POST as updateTrust } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { POST as reportIncident } from '../../src/app/api/mobile/pilot/incidents/route.ts';
import { POST as analyticsPost } from '../../src/app/api/mobile/analytics/route.ts';
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

// Firebase uids rather than minted participant ids. Mixed case on purpose:
// the id pattern these replaced was lowercase-only and rejected real accounts.
const A = uidFor('AccountAlice');
const B = uidFor('AccountBlake');
const C = uidFor('AccountCarla');
const D = uidFor('AccountDiego');
/** Someone nobody has ever seen. There is no roster for them to be outside of. */
const NEWCOMER = uidFor('AccountNewbie');

let auth: FakeAuthControls | null = null;

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function request(path: string, options: {
  method?: string;
  participantId?: string;
  tokenOverride?: string;
  body?: unknown;
} = {}): Request {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const authToken = options.tokenOverride ?? (options.participantId ? tokenFor(options.participantId) : null);
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
    MAYBESITTER_DATA_DIR: process.env.MAYBESITTER_DATA_DIR,
    MAYBESITTER_FEATURE_RECOMMENDATION: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
    MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS: process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS,
    MAYBESITTER_PILOT_INCIDENT_OWNER_ID: process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID,
  };
  process.env.MAYBESITTER_DATA_DIR = directory;
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS = 'true';
  process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID = 'pilot_owner';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // Trust and participant state live in storage since UC-1.0b (#141), so a
  // fresh memory adapter per case is what isolates them now.
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  resetAnalyticsEventsForTests();
  resetMobilePilotDecisionReplaysForTests();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  };
}

/**
 * Consent the way a real account gets it.
 *
 * Both, deliberately. The trust flag is the closed pilot's admission control;
 * the launch consent in `users/{uid}.consents.recommendations` is what
 * onboarding writes and what the next step now reads (#170). Granting only the
 * first is what these tests used to do, and it is precisely the state a real
 * user could never be in.
 */
async function grantRecommendation(uid: string): Promise<void> {
  await applyTrustAction(uid, { type: 'grant_recommendation_consent', at: new Date().toISOString() });
  await setRecommendationConsent(uid, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
}

async function grantAnalytics(uid: string): Promise<void> {
  await applyTrustAction(uid, { type: 'set_analytics_consent', granted: true, at: new Date().toISOString() });
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

test('mobile analytics records content-free phone-presence events by token uid', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics(A);
    const response = await analyticsPost(request('/api/mobile/analytics', {
      participantId: A,
      body: {
        eventName: 'widget_tap',
        properties: {
          surface: 'homeWidget',
          targetRoute: 'capture',
          flagWidget: true,
          flagVoice: true,
          flagAwareness: false,
          flagWatch: false,
          flagImports: false,
        },
      },
    }));

    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.recorded, true);
    assert.equal(body.participantId, A);
    const event = (await getAnalyticsEvents()).at(-1);
    assert.equal(event?.anonymousUserId, A);
    assert.equal(event?.eventName, 'widget_tap');
    assert.doesNotMatch(JSON.stringify(event), /raw|title|message|email|content/i);
  } finally {
    cleanup();
  }
});

test('mobile analytics can be disabled without breaking product use', async () => {
  const cleanup = setup();
  try {
    const response = await analyticsPost(request('/api/mobile/analytics', {
      participantId: A,
      body: {
        eventName: 'voice_capture_started',
        properties: {
          source: 'app',
          locale: 'en-US',
          flagWidget: false,
          flagVoice: true,
          flagAwareness: false,
          flagWatch: false,
          flagImports: false,
        },
      },
    }));

    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.recorded, false);
    assert.equal((await getAnalyticsEvents()).length, 0);
  } finally {
    cleanup();
  }
});

test('mobile analytics rejects private content fields', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics(A);
    const response = await analyticsPost(request('/api/mobile/analytics', {
      participantId: A,
      body: {
        eventName: 'voice_capture_completed',
        properties: {
          source: 'app',
          locale: 'en-US',
          inputLength: 20,
          rawText: 'call Maya',
          flagWidget: false,
          flagVoice: true,
          flagAwareness: false,
          flagWatch: false,
          flagImports: false,
        },
      },
    }));

    assert.equal(response.status, 400);
    assert.equal((await getAnalyticsEvents()).length, 0);
  } finally {
    cleanup();
  }
});

test('mobile analytics rejects non-canonical deep-link targets', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics(A);
    const response = await analyticsPost(request('/api/mobile/analytics', {
      participantId: A,
      body: {
        eventName: 'widget_tap',
        properties: {
          surface: 'homeWidget',
          targetRoute: '/capture?source=Call%20Maya%20about%20hospital&input=voice',
          flagWidget: true,
          flagVoice: true,
          flagAwareness: false,
          flagWatch: false,
          flagImports: false,
        },
      },
    }));

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await json(response)), /targetRoute is not canonical/);
  } finally {
    cleanup();
  }
});

async function nextStep(participantId: string, spoofedScope?: string): Promise<Record<string, unknown>> {
  const query = spoofedScope ? `?participantId=${spoofedScope}&scopeId=${spoofedScope}&timezone=UTC` : '?timezone=UTC';
  const response = await getNextStep(request(`/api/mobile/recommendations/next-step${query}`, { participantId }));
  assert.equal(response.status, 200);
  return json(response);
}

test('without Authorization every mobile route fails closed instead of running anonymously', async () => {
  const cleanup = setup();
  try {
    const capture = await capturePost(request('/api/mobile/capture', {
      body: {
        text: 'Call Maya tomorrow at 3pm',
        referenceTime: REFERENCE_TIME,
        timezone: 'UTC',
        scopeId: 'legacy-scope',
      },
    }));
    assert.equal(capture.status, 401);
    assert.equal((await json(capture)).reason, 'missing_token');

    const today = await todayGet(request('/api/mobile/commitments/today?timezone=UTC'));
    assert.equal(today.status, 401);
    assert.equal((await json(today)).reason, 'missing_token');

    const detail = await commitmentGet(request('/api/mobile/commitments/legacy-id'), params('legacy-id'));
    assert.equal(detail.status, 401);
    assert.equal((await json(detail)).reason, 'missing_token');

    const upcoming = await upcomingGet(request('/api/mobile/commitments/upcoming?timezone=UTC'));
    assert.equal(upcoming.status, 401);

    const confirm = await confirmPost(request('/api/mobile/capture/confirm', { body: { proposalId: 'x', itemIds: ['y'] } }));
    assert.equal(confirm.status, 401);

    const action = await actionPost(request('/api/mobile/commitments/legacy-id/actions', {
      body: { action: 'complete' },
    }), params('legacy-id'));
    assert.equal(action.status, 401);
  } finally {
    cleanup();
  }
});

test('a valid token executes authenticated capture', async () => {
  const cleanup = setup();
  try {
    const commitmentId = await createConfirmedCommitment(A, 'Remind me to call Maya tomorrow at 3pm');
    const detail = await commitmentGet(request(`/api/mobile/commitments/${commitmentId}`, { participantId: A }), params(commitmentId));
    assert.equal(detail.status, 200);
    assert.equal((await json(detail)).id, commitmentId);
  } finally {
    cleanup();
  }
});

test('a brand-new uid can capture and confirm with no allowlist configured', async () => {
  const cleanup = setup();
  try {
    // The roster is gone: someone who signed in a second ago is a user.
    const commitmentId = await createConfirmedCommitment(NEWCOMER, 'Remind me to call the clinic tomorrow at 1pm');
    const detail = await commitmentGet(request(`/api/mobile/commitments/${commitmentId}`, { participantId: NEWCOMER }), params(commitmentId));
    assert.equal(detail.status, 200);
  } finally {
    cleanup();
  }
});

test('mobile routes refuse a malformed, revoked, disabled or deleted credential', async () => {
  const cleanup = setup();
  try {
    const missing = await getNextStep(request('/api/mobile/recommendations/next-step'));
    assert.equal(missing.status, 401);
    assert.equal((await json(missing)).reason, 'missing_token');

    const malformed = await getNextStep(request('/api/mobile/recommendations/next-step', { tokenOverride: 'not-a-token' }));
    assert.equal(malformed.status, 401);
    assert.equal((await json(malformed)).reason, 'invalid_token');

    // A leftover token in the retired HMAC format is just another bad token.
    const legacy = await getNextStep(request('/api/mobile/recommendations/next-step', { tokenOverride: 'p-token.p-100.nonce.signature' }));
    assert.equal(legacy.status, 401);
    assert.equal((await json(legacy)).reason, 'invalid_token');

    auth?.refuse(B, 'token_expired');
    const expired = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: B }));
    assert.equal(expired.status, 401);
    assert.equal((await json(expired)).reason, 'token_expired');
    auth?.allow(B);

    auth?.refuse(B, 'user_disabled');
    const disabled = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: B }));
    assert.equal(disabled.status, 403);
    assert.equal((await json(disabled)).reason, 'user_disabled');
    auth?.allow(B);

    // An id nobody has seen is not refused for membership; it is a consent
    // question, which is the reason `not_allowlisted` used to hide.
    const newcomer = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: NEWCOMER }));
    assert.equal(newcomer.status, 403);
    assert.equal((await json(newcomer)).reason, 'consent_required');

    await applyTrustAction(C, { type: 'revoke', at: new Date().toISOString() });
    const revoked = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: C }));
    assert.equal(revoked.status, 403);
    assert.equal((await json(revoked)).reason, 'revoked');

    await applyTrustAction(D, { type: 'delete', at: new Date().toISOString() });
    const deleted = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: D }));
    assert.equal(deleted.status, 403);
    assert.equal((await json(deleted)).reason, 'deleted');
  } finally {
    cleanup();
  }
});

test('authenticated mobile canonical flow stays inside the token uid scope', async () => {
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

test('a valid B token cannot fetch, patch, action, or delete an A commitment', async () => {
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

test('body and query uid spoofing cannot escape the token scope, and assignment is server-owned', async () => {
  const cleanup = setup();
  try {
    await grantRecommendation(B);
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

test('trust and recommendation decisions are isolated per authenticated user', async () => {
  const cleanup = setup();
  try {
    await grantRecommendation(A);
    await grantAnalytics(A);
    await grantRecommendation(B);
    await grantAnalytics(B);
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
    // 200 with no card, not 403 (#170). Quiet mode is something B switched on
    // deliberately; an error on that screen would report a problem where the
    // product is doing exactly what it was told. `exposure` carries the why.
    const bQuiet = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: B }));
    assert.equal(bQuiet.status, 200);
    const bQuietBody = await json(bQuiet) as {
      exposure: { allowed: boolean; reason: string };
      recommendation: { state: string; primaryStep: unknown };
    };
    assert.equal(bQuietBody.exposure.allowed, false);
    assert.equal(bQuietBody.exposure.reason, 'quiet_mode');
    assert.equal(bQuietBody.recommendation.state, 'empty');
    assert.equal(bQuietBody.recommendation.primaryStep, null);
    const aStillOpen = await getNextStep(request('/api/mobile/recommendations/next-step', { participantId: A }));
    assert.equal(aStillOpen.status, 200);

    assert.deepEqual((await getAnalyticsEvents()).map((event) => event.eventName), [
      'first_value_reached',
      'first_value_reached',
      'recommendation_shown',
      'recommendation_accepted',
      'recommendation_shown',
    ]);
  } finally {
    cleanup();
  }
});

test('the trust write route forces a fresh revocation read rather than trusting the cache', async () => {
  const cleanup = setup();
  try {
    await updateTrust(request('/api/mobile/pilot/trust', {
      participantId: A,
      body: { action: { type: 'grant_recommendation_consent' } },
    }));
    // `revoke` and `delete` arrive on this route, and a revocation up to a
    // minute stale is not good enough for either.
    assert.equal(auth?.lastForceRevocationCheck(), true);

    await getTrust(request('/api/mobile/pilot/trust', { participantId: A }));
    assert.equal(auth?.lastForceRevocationCheck(), false, 'the read path may use the cache');
  } finally {
    cleanup();
  }
});

test('recommendation action idempotency is uid-scoped and durable', async () => {
  const cleanup = setup();
  try {
    await grantRecommendation(A);
    await grantAnalytics(A);
    await createConfirmedCommitment(A, 'Remind me to submit the permit tomorrow at 2pm');
    const proposal = (await nextStep(A)).recommendation;
    await resetAnalyticsEventsForTests();
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
    assert.equal((await getAnalyticsEvents()).filter((event) => event.eventName === 'recommendation_accepted').length, 1);
  } finally {
    cleanup();
  }
});

test('deletion is local to A and keeps B state intact', async () => {
  // The trust `delete` action used to do this, deleting A's domain state while
  // leaving the sign-in account alive and issuing no receipt. UC-1.5 (#149)
  // retired it: it now refuses, and real deletion goes through the engine. The
  // property this test is about — A's deletion is invisible to B — is asserted
  // against that engine instead.
  const cleanup = setup();
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = 'pilot-route-test-pepper';
  setDeletionAuthForTests({ async revokeRefreshTokens() {}, async deleteUser() {} });
  try {
    await grantRecommendation(A);
    await grantRecommendation(B);
    const aId = await createConfirmedCommitment(A, 'Remind me to cancel A plan tomorrow at noon');
    const bId = await createConfirmedCommitment(B, 'Remind me to keep B plan tomorrow at noon');

    const retired = await updateTrust(request('/api/mobile/pilot/trust', {
      participantId: A,
      body: { action: { type: 'delete' } },
    }));
    assert.equal(retired.status, 400, 'the retired partial delete still runs');
    assert.equal((await json(retired)).reason, 'use_account_deletion');

    await deleteAccount(A, { initiatedBy: 'user' });

    const aAfterDelete = await commitmentGet(request(`/api/mobile/commitments/${aId}`, { participantId: A }), params(aId));
    assert.notEqual(aAfterDelete.status, 200, 'A can still read a commitment after deleting the account');

    const bAfterDelete = await commitmentGet(request(`/api/mobile/commitments/${bId}`, { participantId: B }), params(bId));
    assert.equal(bAfterDelete.status, 200, 'deleting A took B down with it');
    assert.equal((await json(bAfterDelete)).title, 'keep B plan at noon');
    const bTrust = await getTrust(request('/api/mobile/pilot/trust', { participantId: B }));
    assert.equal(bTrust.status, 200);
  } finally {
    setDeletionAuthForTests(null);
    delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
    cleanup();
  }
});

test('concurrent authenticated A/B and same-uid writes do not lose updates', async () => {
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

    const aCommitments = Object.values((await getParticipantStateSnapshot(A)).commitments);
    const bCommitments = Object.values((await getParticipantStateSnapshot(B)).commitments);
    assert.equal(aCommitments.length, 3);
    assert.equal(bCommitments.length, 2);
    assert.equal(aCommitments.every((item) => item.status === 'active'), true);
    assert.equal(bCommitments.every((item) => item.status === 'active'), true);
  } finally {
    cleanup();
  }
});

test('incident reporting uses the authenticated uid and drops raw notes', async () => {
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

    const stored = await listIncidents();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].participantId, B);
    assert.equal('notes' in stored[0], false);
    assert.equal((await listAllAuditEvents()).some((event) => event.eventType === 'support_reported'), true);
  } finally {
    cleanup();
  }
});

/**
 * The kill switch takes the card away; it does not report a fault (#170).
 *
 * `MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true` used to make the read answer
 * 403, and `QueryBoundary` draws a 403 it has no screen for as "something went
 * wrong" **with a Retry button**. So the one lever operators pull during an
 * incident told every user the product was broken, and then invited them to
 * press the button that re-attempts the thing the switch was thrown to stop.
 *
 * The read is silent now. The write is not: recording a decision is exactly
 * the work the switch stops, and `done` completes a commitment.
 */
test('a thrown kill switch hides the next step without reporting an error', async () => {
  const cleanup = setup();
  try {
    await grantRecommendation(A);
    await createConfirmedCommitment(A, 'Remind me to call Alice tomorrow at 9am');

    const before = await nextStep(A);
    const proposal = before.recommendation as NextStepRecommendationContract;
    assert.equal((before.exposure as { allowed: boolean }).allowed, true);
    assert.equal(proposal.state, 'ready');

    process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'true';

    // 200 and no card, exactly as quiet hours answer. `readRuntimeControls` is
    // read per call, so this is the live switch and not a restart.
    const thrown = await getNextStep(request('/api/mobile/recommendations/next-step?timezone=UTC', { participantId: A }));
    assert.equal(thrown.status, 200);
    const body = await json(thrown) as {
      exposure: { allowed: boolean; reason: string };
      recommendation: { state: string; primaryStep: unknown; availableActions: string[] };
    };
    assert.equal(body.exposure.allowed, false);
    // Silent to the user, legible to us: the reason is still on the response
    // and still in the audit log.
    assert.equal(body.exposure.reason, 'kill_switch_active');
    assert.equal(body.recommendation.state, 'empty');
    assert.equal(body.recommendation.primaryStep, null);
    assert.deepEqual(body.recommendation.availableActions, []);
    assert.equal(
      (await listAllAuditEvents()).some((event) => event.reasonCode === 'kill_switch_active'),
      true,
      'the switch must stay legible in the audit log',
    );

    // The write is still refused. Silencing the card and then accepting taps
    // against it would leave the switch half thrown.
    const decision = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', {
      participantId: A,
      body: { proposal, decision: 'done', idempotencyKey: 'during-the-incident' },
    }));
    assert.equal(decision.status, 403);
    assert.equal((await json(decision)).reason, 'kill_switch_active');

    process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
    assert.equal(((await nextStep(A)).exposure as { allowed: boolean }).allowed, true);
  } finally {
    cleanup();
  }
});

test('turning the feature off is still an answer the client can explain', async () => {
  // `feature_disabled` has a screen of its own — "not shipped here" — so it
  // must not be swept into the kill switch's silence.
  const cleanup = setup({ MAYBESITTER_FEATURE_RECOMMENDATION: 'false' });
  try {
    await grantRecommendation(A);
    const response = await getNextStep(request('/api/mobile/recommendations/next-step?timezone=UTC', { participantId: A }));
    assert.equal(response.status, 403);
    assert.equal((await json(response)).reason, 'feature_disabled');
  } finally {
    cleanup();
  }
});
