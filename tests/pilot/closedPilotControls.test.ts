import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPilotTrustAction,
  buildWhatMaybeSitterKnows,
  createPilotAuditEvent,
  createPilotTrustState,
  createPilotTrustIncident,
  decidePilotExposure,
  parseClosedPilotAllowlist,
} from '../../lib/pilot/closedPilotControls.ts';
import { PilotTrustStore } from '../../lib/pilot/pilotTrustStore.ts';

const AT = '2026-09-14T09:00:00.000Z';
const IDS = Array.from({ length: 25 }, (_, index) => `pilot-${index + 1}`);
const allowlist = parseClosedPilotAllowlist(IDS.join(','));

test('closed pilot: admission enforces a pseudonymous 25–40 participant allowlist', () => {
  assert.equal(allowlist.size, 25);
  assert.throws(() => parseClosedPilotAllowlist(IDS.slice(0, 24).join(',')), /25–40/);
  assert.throws(() => parseClosedPilotAllowlist([...IDS, IDS[0]].join(',')), /duplicates/);
  assert.throws(() => parseClosedPilotAllowlist([...IDS.slice(1), 'person@example.com'].join(',')), /pseudonymous/);
});

test('closed pilot: exposure requires allowlist, runtime controls, and explicit consent', () => {
  const initial = createPilotTrustState('pilot-1', AT);
  const base = { participantId: 'pilot-1', allowlist, trust: initial, featureEnabled: true, killSwitchActive: false };
  assert.equal(decidePilotExposure(base).reason, 'consent_required');
  const consented = applyPilotTrustAction(initial, { type: 'grant_recommendation_consent', at: AT });
  assert.deepEqual(decidePilotExposure({ ...base, trust: consented }), { allowed: true, reason: 'authorized' });
  assert.equal(decidePilotExposure({ ...base, trust: consented, participantId: 'outsider' }).reason, 'not_allowlisted');
  assert.equal(decidePilotExposure({ ...base, trust: consented, killSwitchActive: true }).reason, 'kill_switch_active');
});

test('closed pilot: calendar consent is progressive and unavailable before first value', () => {
  const initial = createPilotTrustState('pilot-1', AT);
  assert.throws(() => applyPilotTrustAction(initial, { type: 'set_calendar_consent', granted: true, at: AT }), /after first value/);
  const valued = applyPilotTrustAction(initial, { type: 'record_first_value', at: AT });
  assert.equal(applyPilotTrustAction(valued, { type: 'set_calendar_consent', granted: true, at: AT }).calendarConsent, true);
});

test('closed pilot: quiet mode stops exposure without deleting canonical data', () => {
  const consented = applyPilotTrustAction(createPilotTrustState('pilot-1', AT), { type: 'grant_recommendation_consent', at: AT });
  const quiet = applyPilotTrustAction(consented, { type: 'set_quiet_mode', enabled: true, at: AT });
  assert.equal(decidePilotExposure({ participantId: 'pilot-1', allowlist, trust: quiet, featureEnabled: true, killSwitchActive: false }).reason, 'quiet_mode');
  assert.equal(quiet.deletedAt, null);
  assert.equal(quiet.recommendationConsent, true);
});

test('closed pilot: revocation removes consents and only deletion may follow', () => {
  const initial = createPilotTrustState('pilot-1', AT);
  const revoked = applyPilotTrustAction(initial, { type: 'revoke', at: AT });
  assert.equal(revoked.recommendationConsent, false);
  assert.equal(revoked.analyticsConsent, false);
  assert.equal(revoked.calendarConsent, false);
  assert.throws(() => applyPilotTrustAction(revoked, { type: 'set_quiet_mode', enabled: false, at: AT }), /only be deleted/);
  assert.ok(applyPilotTrustAction(revoked, { type: 'delete', at: AT }).deletedAt);
});

test('closed pilot: what-knows view exposes explicit state and denies sensitive capabilities', () => {
  const view = buildWhatMaybeSitterKnows({ trust: createPilotTrustState('pilot-1', AT), confirmedCommitmentCount: 3 });
  assert.equal(view.confirmedCommitmentCount, 3);
  assert.equal(view.privateMessageIngestion, false);
  assert.equal(view.sensitiveInference, false);
  assert.equal(view.medicalProfile, false);
  assert.doesNotMatch(JSON.stringify(view), /name|email|phone|diagnosis/i);
});

test('closed pilot: audit events accept safe codes and reject raw-text-like reasons', () => {
  assert.equal(createPilotAuditEvent({ version: 'v1', eventType: 'exposure_checked', participantId: 'pilot-1', occurredAt: AT, outcome: 'blocked', reasonCode: 'quiet_mode' }).reasonCode, 'quiet_mode');
  assert.throws(() => createPilotAuditEvent({ version: 'v1', eventType: 'exposure_checked', participantId: 'pilot-1', occurredAt: AT, outcome: 'blocked', reasonCode: 'user said private words' }), /safe code/);
});

test('closed pilot: audit and incident builders discard unknown raw fields', () => {
  const audit = createPilotAuditEvent({
    version: 'v1', eventType: 'support_reported', participantId: 'pilot-1', occurredAt: AT,
    outcome: 'recorded', reasonCode: 'privacy', rawText: 'private words',
  } as Parameters<typeof createPilotAuditEvent>[0] & { rawText: string });
  assert.equal('rawText' in audit, false);

  const incident = createPilotTrustIncident({
    version: 'v1', incidentId: 'incident-1', participantId: 'pilot-1', occurredAt: AT,
    surface: 'recommendation', category: 'privacy', severity: 'medium', status: 'open',
    ownerId: 'pilot_owner', containmentCode: 'reported_for_review', resolutionCode: null,
    notes: 'private words',
  } as Parameters<typeof createPilotTrustIncident>[0] & { notes: string });
  assert.equal('notes' in incident, false);
  assert.throws(() => createPilotTrustIncident({ ...incident, surface: 'messages' as typeof incident.surface }), /surface/);
});

test('closed pilot: trust state, audit, and incidents persist atomically in a private file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-pilot-trust-'));
  const file = join(directory, 'trust.json');
  try {
    const store = new PilotTrustStore(file);
    store.apply('pilot-1', { type: 'grant_recommendation_consent', at: AT });
    store.appendAudit(createPilotAuditEvent({ version: 'v1', eventType: 'consent_changed', participantId: 'pilot-1', occurredAt: AT, outcome: 'recorded', reasonCode: 'grant_recommendation_consent' }));
    store.appendIncident(createPilotTrustIncident({
      version: 'v1', incidentId: 'incident-1', participantId: 'pilot-1', occurredAt: AT,
      surface: 'recommendation', category: 'reliability', severity: 'medium', status: 'open',
      ownerId: 'pilot_owner', containmentCode: 'reported_for_review', resolutionCode: null,
    }));

    const reloaded = new PilotTrustStore(file);
    assert.equal(reloaded.getOrCreate('pilot-1', AT).recommendationConsent, true);
    assert.equal(reloaded.auditEvents().length, 1);
    assert.equal(reloaded.incidents().length, 1);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /private words/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
