import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAnalyticsEvents, resetAnalyticsEventsForTests } from '../../lib/analytics/eventStore.ts';
import { NEXT_STEP_EXPERIMENT_ENV, resolveNextStepArm } from '../../lib/experiments/experimentControls.ts';
import { getPilotTrustStore } from '../../lib/pilot/pilotTrustStore.ts';
import { configureCommandService, getCommandServiceState } from '../../lib/services/commandService.ts';
import { resetMobilePilotDecisionReplaysForTests } from '../../lib/services/mobile/pilotService.ts';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { GET as getNextStep } from '../../src/app/api/mobile/recommendations/next-step/route.ts';
import { POST as recordNextStepAction } from '../../src/app/api/mobile/recommendations/next-step/actions/route.ts';
import { GET as getTrust, POST as updateTrust } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { POST as reportIncident } from '../../src/app/api/mobile/pilot/incidents/route.ts';
import type { NextStepArm } from '../../src/contracts/v1/experimentContracts.ts';
import type { NextStepDecision } from '../../src/contracts/v1/nextStepContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const IDS = Array.from({ length: 40 }, (_, index) => `pilot-${String(index + 1).padStart(3, '0')}`);
const TARGETS = Object.fromEntries(
  (['generic', 'contextual', 'personalized'] as const).map((arm) => {
    const participantId = IDS.find((id) => resolveNextStepArm(id, { [NEXT_STEP_EXPERIMENT_ENV]: 'true' }).arm === arm);
    if (!participantId) throw new Error(`No participant found for arm ${arm}`);
    return [arm, participantId];
  }),
) as Record<NextStepArm, string>;
const ALLOWLIST = Array.from(new Set([...Object.values(TARGETS), ...IDS])).slice(0, 25);

function request(path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  const now = new Date();
  return {
    id,
    kind: 'task',
    title: `Step ${id}`,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: {
      kind: 'due_by',
      dueAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      remindAt: null,
      timezone: 'UTC',
    },
    currentAckState: 'aware',
    postponedUntil: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    confirmedAt: now.toISOString(),
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

function pilotState(): DomainState {
  const history = [
    commitment('h-task-1', { status: 'completed', completedAt: '2026-09-01T14:00:00.000Z' }),
    commitment('h-task-2', { status: 'completed', completedAt: '2026-09-02T14:00:00.000Z' }),
    commitment('h-task-3', { status: 'completed', completedAt: '2026-09-03T14:00:00.000Z' }),
    commitment('h-follow-1', { kind: 'follow_up', status: 'dropped', droppedAt: '2026-09-01T14:00:00.000Z' }),
    commitment('h-follow-2', { kind: 'follow_up', status: 'dropped', droppedAt: '2026-09-02T14:00:00.000Z' }),
    commitment('h-follow-3', { kind: 'follow_up', status: 'dropped', droppedAt: '2026-09-03T14:00:00.000Z' }),
    commitment('a-follow', { kind: 'follow_up', title: 'Follow up with Sam' }),
    commitment('b-task', { kind: 'task', title: 'Call Maya' }),
  ];
  return { ...createEmptyDomainState(), commitments: Object.fromEntries(history.map((item) => [item.id, item])) };
}

function setup(participantId = TARGETS.generic, overrides: Record<string, string | undefined> = {}): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-mobile-pilot-api-'));
  const previous: Record<string, string | undefined> = {
    MAYBESITTER_CLOSED_PILOT_IDS: process.env.MAYBESITTER_CLOSED_PILOT_IDS,
    MAYBESITTER_PILOT_TRUST_FILE: process.env.MAYBESITTER_PILOT_TRUST_FILE,
    MAYBESITTER_FEATURE_RECOMMENDATION: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
    MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID: process.env.MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID,
    MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS: process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS,
    MAYBESITTER_PILOT_INCIDENT_OWNER_ID: process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID,
  };
  process.env.MAYBESITTER_CLOSED_PILOT_IDS = ALLOWLIST.join(',');
  process.env.MAYBESITTER_PILOT_TRUST_FILE = join(directory, 'trust.json');
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  process.env.MAYBESITTER_PILOT_INSTANCE_PARTICIPANT_ID = participantId;
  process.env.MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS = 'true';
  process.env.MAYBESITTER_PILOT_INCIDENT_OWNER_ID = 'pilot_owner';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  configureCommandService({
    initialState: pilotState(),
    schedulerStore: null,
    stateFile: join(directory, 'domain-state.json'),
  });
  resetAnalyticsEventsForTests();
  resetMobilePilotDecisionReplaysForTests();
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  };
}

async function setTrust(participantId: string, action: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await updateTrust(request('/api/mobile/pilot/trust', {
    participantId,
    scopeId: participantId,
    action,
  }));
  assert.equal(response.status, 200);
  return json(response);
}

async function grantRecommendation(participantId: string): Promise<void> {
  await setTrust(participantId, { type: 'grant_recommendation_consent' });
}

async function grantAnalytics(participantId: string): Promise<void> {
  await setTrust(participantId, { type: 'set_analytics_consent', granted: true });
}

async function recommendation(participantId: string): Promise<Record<string, unknown>> {
  const response = await getNextStep(request(`/api/mobile/recommendations/next-step?participantId=${participantId}&scopeId=${participantId}&locale=en&timezone=UTC`));
  assert.equal(response.status, 200);
  return json(response);
}

test('mobile pilot recommendation exposes exactly one explained recommendation for all V03 arms with stable server assignment', async () => {
  for (const arm of ['generic', 'contextual', 'personalized'] as const) {
    const participantId = TARGETS[arm];
    const cleanup = setup(participantId);
    try {
      await grantRecommendation(participantId);
      await grantAnalytics(participantId);
      const first = await recommendation(participantId);
      const second = await recommendation(participantId);
      const firstAssignment = first.assignment as { arm: string; enabled: boolean };
      const secondAssignment = second.assignment as { arm: string; enabled: boolean };
      const proposal = first.recommendation as {
        state: string;
        primaryStep: { commitmentId: string; title: string } | null;
        explanation: { summary: string; evidenceLabels: string[]; sensitiveInferenceUsed: boolean } | null;
        availableActions: string[];
        persistence: { occurred: boolean; confirmationRequired: boolean };
      };

      assert.equal(firstAssignment.arm, arm);
      assert.equal(firstAssignment.enabled, true);
      assert.equal(secondAssignment.arm, arm);
      assert.equal(proposal.state, 'ready');
      assert.ok(proposal.primaryStep);
      assert.ok(proposal.explanation?.summary);
      assert.ok(proposal.explanation?.evidenceLabels.length);
      assert.equal(proposal.explanation?.sensitiveInferenceUsed, false);
      assert.deepEqual(proposal.availableActions, ['accept', 'edit', 'defer', 'dismiss', 'done']);
      assert.equal(proposal.persistence.occurred, false);
      assert.equal(proposal.persistence.confirmationRequired, true);
      if (arm === 'personalized') {
        assert.equal(proposal.primaryStep.commitmentId, 'b-task');
      }
    } finally {
      cleanup();
    }
  }
});

test('mobile pilot recommendation fails closed for kill switch and disabled recommendation consent', async () => {
  const participantId = TARGETS.generic;
  const cleanup = setup(participantId, { MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'true' });
  try {
    await grantRecommendation(participantId);
    const killed = await getNextStep(request(`/api/mobile/recommendations/next-step?participantId=${participantId}&scopeId=${participantId}`));
    assert.equal(killed.status, 403);
    assert.equal((await json(killed)).reason, 'kill_switch_active');
  } finally {
    cleanup();
  }

  const consentCleanup = setup(participantId);
  try {
    const blocked = await getNextStep(request(`/api/mobile/recommendations/next-step?participantId=${participantId}&scopeId=${participantId}`));
    assert.equal(blocked.status, 403);
    assert.equal((await json(blocked)).reason, 'consent_required');
    await grantRecommendation(participantId);
    await setTrust(participantId, { type: 'set_recommendation_consent', granted: false });
    const optedOut = await getNextStep(request(`/api/mobile/recommendations/next-step?participantId=${participantId}&scopeId=${participantId}`));
    assert.equal(optedOut.status, 403);
    assert.equal((await json(optedOut)).reason, 'consent_required');
  } finally {
    consentCleanup();
  }
});

test('mobile pilot recommendation honors analytics consent without blocking recommendation exposure', async () => {
  const participantId = TARGETS.contextual;
  const cleanup = setup(participantId);
  try {
    await grantRecommendation(participantId);
    const proposal = await recommendation(participantId);
    assert.equal((proposal.recommendation as { state: string }).state, 'ready');
    assert.equal(getAnalyticsEvents().length, 0);
    await grantAnalytics(participantId);
    await recommendation(participantId);
    assert.equal(getAnalyticsEvents().some((event) => event.eventName === 'recommendation_shown'), true);
  } finally {
    cleanup();
  }
});

test('mobile pilot actions record accept, edit, defer, dismiss, and done without persistence', async () => {
  const participantId = TARGETS.generic;
  const cleanup = setup(participantId);
  try {
    await grantRecommendation(participantId);
    await grantAnalytics(participantId);
    const proposal = (await recommendation(participantId)).recommendation;
    resetAnalyticsEventsForTests();

    for (const decision of ['accept', 'edit', 'defer', 'dismiss', 'done'] as NextStepDecision[]) {
      const response = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', {
        participantId,
        scopeId: participantId,
        proposal,
        decision,
        idempotencyKey: `decision-${decision}`,
        ...(decision === 'edit' ? { editedTitle: 'Call Maya tomorrow' } : {}),
      }));
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(body.success, true);
      assert.equal(body.replayed, false);
      assert.equal((body.outcome as { persisted: boolean }).persisted, false);
    }

    assert.deepEqual(getAnalyticsEvents().map((event) => event.eventName), [
      'recommendation_accepted',
      'recommendation_edited',
      'recommendation_deferred',
      'recommendation_dismissed',
      'recommendation_completed',
    ]);
  } finally {
    cleanup();
  }
});

test('mobile pilot action replay is idempotent and mismatched replays fail closed', async () => {
  const participantId = TARGETS.generic;
  const cleanup = setup(participantId);
  try {
    await grantRecommendation(participantId);
    await grantAnalytics(participantId);
    const proposal = (await recommendation(participantId)).recommendation;
    resetAnalyticsEventsForTests();
    const payload = { participantId, scopeId: participantId, proposal, decision: 'accept', idempotencyKey: 'same-action' };

    const first = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', payload));
    const second = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', payload));
    const mismatch = await recordNextStepAction(request('/api/mobile/recommendations/next-step/actions', {
      ...payload,
      decision: 'dismiss',
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

test('mobile pilot trust controls quiet mode, revoke, what-knows, calendar consent, and deletion', async () => {
  const participantId = TARGETS.generic;
  const cleanup = setup(participantId);
  try {
    let view = await getTrust(request(`/api/mobile/pilot/trust?participantId=${participantId}&scopeId=${participantId}`));
    assert.equal(view.status, 200);
    let body = await json(view);
    assert.equal((body.whatKnows as { confirmedCommitmentCount: number }).confirmedCommitmentCount, 8);
    assert.equal((body.whatKnows as { privateMessageIngestion: boolean }).privateMessageIngestion, false);

    const calendarBeforeValue = await updateTrust(request('/api/mobile/pilot/trust', {
      participantId,
      scopeId: participantId,
      action: { type: 'set_calendar_consent', granted: true },
    }));
    assert.equal(calendarBeforeValue.status, 400);

    await grantRecommendation(participantId);
    await recommendation(participantId);
    await setTrust(participantId, { type: 'set_calendar_consent', granted: true });
    await setTrust(participantId, { type: 'set_quiet_mode', enabled: true });
    const quiet = await getNextStep(request(`/api/mobile/recommendations/next-step?participantId=${participantId}&scopeId=${participantId}`));
    assert.equal(quiet.status, 403);
    assert.equal((await json(quiet)).reason, 'quiet_mode');

    await setTrust(participantId, { type: 'set_quiet_mode', enabled: false });
    body = await setTrust(participantId, { type: 'revoke' });
    assert.ok((body.trust as { revokedAt: string | null }).revokedAt);
    const revoked = await getNextStep(request(`/api/mobile/recommendations/next-step?participantId=${participantId}&scopeId=${participantId}`));
    assert.equal(revoked.status, 403);
    assert.equal((await json(revoked)).reason, 'revoked');

    body = await setTrust(participantId, { type: 'delete' });
    assert.ok((body.trust as { deletedAt: string | null }).deletedAt);
    assert.equal(Object.keys(getCommandServiceState().commitments).length, 0);
    view = await getTrust(request(`/api/mobile/pilot/trust?participantId=${participantId}&scopeId=${participantId}`));
    assert.equal(view.status, 200);
    assert.equal(((await json(view)).whatKnows as { confirmedCommitmentCount: number }).confirmedCommitmentCount, 0);
  } finally {
    cleanup();
  }
});

test('mobile pilot incident reporting is participant-safe and wrong participant or scope fails closed', async () => {
  const participantId = TARGETS.generic;
  const cleanup = setup(participantId);
  try {
    const wrongParticipant = ALLOWLIST.find((id) => id !== participantId)!;
    const wrong = await getTrust(request(`/api/mobile/pilot/trust?participantId=${wrongParticipant}&scopeId=${wrongParticipant}`));
    assert.equal(wrong.status, 403);
    assert.equal((await json(wrong)).reason, 'wrong_instance');

    const wrongScope = await getTrust(request(`/api/mobile/pilot/trust?participantId=${participantId}&scopeId=${wrongParticipant}`));
    assert.equal(wrongScope.status, 403);
    assert.equal((await json(wrongScope)).reason, 'wrong_scope');

    const incident = await reportIncident(request('/api/mobile/pilot/incidents', {
      participantId,
      scopeId: participantId,
      surface: 'recommendation',
      category: 'privacy',
      notes: 'raw private text must not be stored',
    }));
    assert.equal(incident.status, 201);
    const body = await json(incident);
    assert.equal(body.success, true);

    const stored = getPilotTrustStore().incidents();
    assert.equal(stored.length, 1);
    assert.equal('notes' in stored[0], false);
    assert.equal(stored[0].participantId, participantId);
    assert.equal(getPilotTrustStore().auditEvents().some((event) => event.eventType === 'support_reported'), true);
  } finally {
    cleanup();
  }
});
