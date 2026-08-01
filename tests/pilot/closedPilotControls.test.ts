import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPilotTrustAction,
  buildWhatMaybeSitterKnows,
  createPilotAuditEvent,
  createPilotTrustState,
  decidePilotExposure,
  parseClosedPilotAllowlist,
} from '../../lib/pilot/closedPilotControls.ts';

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
