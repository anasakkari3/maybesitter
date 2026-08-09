import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET as getTrust, POST as updateTrust } from '../../src/app/api/pilot/trust/route.ts';
import { GET as getNextStep } from '../../src/app/api/next-step/route.ts';
import { GET as getCalendar } from '../../src/app/api/calendar.ics/route.ts';
import { POST as recordAnalytics } from '../../src/app/api/analytics/route.ts';
import { GET as getIncidents, PATCH as updateIncident, POST as reportIncident } from '../../src/app/api/pilot/incidents/route.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';

const IDS = Array.from({ length: 25 }, (_, index) => `pilot-${index + 1}`);
const commitment: Commitment = {
  id: 'c1', kind: 'task', title: 'Call Maya', description: null, person: null, status: 'active',
  priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
  timeSpec: { kind: 'due_by', dueAt: '2099-08-02T10:00:00.000Z', remindAt: null, timezone: 'UTC' },
  currentAckState: 'aware', postponedUntil: null, createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', confirmedAt: '2026-08-01T00:00:00.000Z',
  completedAt: null, droppedAt: null,
};

test('V03 live pilot: allowlist, consent, first value, calendar, and incident audit are enforced end to end', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-v03-live-'));
  const previous = {
    ids: process.env.MAYBESITTER_CLOSED_PILOT_IDS,
    trust: process.env.MAYBESITTER_PILOT_TRUST_FILE,
    feature: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    kill: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
    token: process.env.MAYBESITTER_PILOT_ADMIN_TOKEN,
  };
  process.env.MAYBESITTER_CLOSED_PILOT_IDS = IDS.join(',');
  process.env.MAYBESITTER_PILOT_TRUST_FILE = join(directory, 'trust.json');
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  process.env.MAYBESITTER_PILOT_ADMIN_TOKEN = 'test-admin-token-123456';
  configureCommandService({
    stateFile: join(directory, 'domain-state.json'), schedulerStore: null,
    initialState: { ...createEmptyDomainState(), commitments: { c1: commitment } },
  });

  try {
    const outsider = await getTrust(new Request('http://local/api/pilot/trust?participantId=outsider'));
    assert.equal(outsider.status, 403);
    const otherAllowlistedParticipant = await getTrust(new Request('http://local/api/pilot/trust?participantId=pilot-2'));
    assert.equal(otherAllowlistedParticipant.status, 200);
    assert.equal((await otherAllowlistedParticipant.json()).exposure.reason, 'consent_required');

    const initial = await getTrust(new Request('http://local/api/pilot/trust?participantId=pilot-1'));
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).exposure.reason, 'consent_required');

    const blocked = await getNextStep(new Request('http://local/api/next-step?anonymousUserId=pilot-1&locale=en'));
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).reason, 'consent_required');

    const consented = await updateTrust(new Request('http://local/api/pilot/trust', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'pilot-1', action: { type: 'grant_recommendation_consent' } }),
    }));
    assert.equal(consented.status, 200);
    assert.equal((await consented.json()).exposure.allowed, true);

    const forgedConsent = await recordAnalytics(new Request('http://local/api/analytics', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anonymousUserId: 'pilot-1', consent: 'granted', eventName: 'reason_opened',
        properties: { proposalId: 'proposal-forged-consent' },
      }),
    }));
    assert.equal((await forgedConsent.json()).recorded, false);

    await updateTrust(new Request('http://local/api/pilot/trust', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'pilot-1', action: { type: 'set_analytics_consent', granted: true } }),
    }));
    const derivedConsent = await recordAnalytics(new Request('http://local/api/analytics', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        anonymousUserId: 'pilot-1', consent: 'essential', eventName: 'reason_opened',
        properties: { proposalId: 'proposal-derived-consent' },
      }),
    }));
    assert.equal((await derivedConsent.json()).recorded, true);

    const proposal = await getNextStep(new Request('http://local/api/next-step?anonymousUserId=pilot-1&locale=en'));
    assert.equal(proposal.status, 200);
    assert.equal((await proposal.json()).state, 'ready');

    const calendarConsent = await updateTrust(new Request('http://local/api/pilot/trust', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'pilot-1', action: { type: 'set_calendar_consent', granted: true } }),
    }));
    assert.equal(calendarConsent.status, 200);
    assert.equal((await calendarConsent.json()).trust.calendarConsent, true);
    assert.equal((await getCalendar(new Request('http://local/api/calendar.ics?participantId=pilot-1'))).status, 200);

    const reported = await reportIncident(new Request('http://local/api/pilot/incidents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId: 'pilot-1', surface: 'recommendation', category: 'privacy', notes: 'must be discarded' }),
    }));
    assert.equal(reported.status, 201);

    const unauthenticatedLog = await getIncidents(new Request('http://local/api/pilot/incidents'));
    assert.equal(unauthenticatedLog.status, 401);
    const log = await getIncidents(new Request('http://local/api/pilot/incidents', { headers: { authorization: 'Bearer test-admin-token-123456' } }));
    const evidence = await log.json();
    assert.equal(log.status, 200);
    assert.equal(evidence.incidents.length, 1);
    assert.equal('notes' in evidence.incidents[0], false);
    assert.ok(evidence.auditEvents.some((event: { eventType: string }) => event.eventType === 'support_reported'));

    const resolved = await updateIncident(new Request('http://local/api/pilot/incidents', {
      method: 'PATCH',
      headers: { authorization: 'Bearer test-admin-token-123456', 'content-type': 'application/json' },
      body: JSON.stringify({
        incidentId: evidence.incidents[0].incidentId, status: 'resolved',
        containmentCode: 'feature_stopped', resolutionCode: 'verified_fixed',
      }),
    }));
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).resolutionCode, 'verified_fixed');
  } finally {
    for (const [key, value] of [
      ['MAYBESITTER_CLOSED_PILOT_IDS', previous.ids],
      ['MAYBESITTER_PILOT_TRUST_FILE', previous.trust],
      ['MAYBESITTER_FEATURE_RECOMMENDATION', previous.feature],
      ['MAYBESITTER_KILL_SWITCH_RECOMMENDATION', previous.kill],
      ['MAYBESITTER_PILOT_ADMIN_TOKEN', previous.token],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
