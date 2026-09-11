import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPilotTrustAction,
  buildWhatMaybeSitterKnows,
  createPilotAuditEvent,
  createPilotTrustState,
  createPilotTrustIncident,
  decidePilotExposure,
  requirePilotParticipantId,
} from '../../lib/pilot/closedPilotControls.ts';
import {
  appendAudit,
  appendIncident,
  applyTrustAction,
  getOrCreateTrust,
  listAuditEvents,
  listIncidents,
} from '../../lib/pilot/pilotTrustStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';

const AT = '2026-09-14T09:00:00.000Z';

/**
 * The 25–40 participant allowlist this file used to open with is gone
 * (UC-1.0e, #144), along with its parser: anyone who signs in with Firebase
 * is a user, and admission is a Google signature rather than a roster. What
 * the exposure decision still turns on — trust, consent and the operator's
 * runtime controls — is unchanged, and is what the rest of this file covers.
 */
test('closed pilot: a participant id may now be a Firebase uid, not only a minted one', () => {
  // The pattern was lowercase-only, so it rejected every real account.
  const uid = 'Ab3XyZ90QwErTyUiOpAsDfGhJkL1';
  assert.equal(requirePilotParticipantId(uid), uid);
  // Still a path check: what breaks a document path is still refused.
  assert.throws(() => requirePilotParticipantId('person@example.com'), /userId/);
  assert.throws(() => requirePilotParticipantId('a/b'), /userId/);
  assert.throws(() => requirePilotParticipantId(''), /userId/);
});

test('closed pilot: exposure requires runtime controls and explicit consent', () => {
  const initial = createPilotTrustState('pilot-1', AT);
  const base = { trust: initial, featureEnabled: true, killSwitchActive: false };
  assert.equal(decidePilotExposure(base).reason, 'consent_required');
  const consented = applyPilotTrustAction(initial, { type: 'grant_recommendation_consent', at: AT });
  assert.deepEqual(decidePilotExposure({ ...base, trust: consented }), { allowed: true, reason: 'authorized' });
  // No input produces `not_allowlisted` any more: the membership branch that
  // did is gone with the roster it consulted.
  assert.notEqual(decidePilotExposure({ ...base, trust: consented }).reason, 'not_allowlisted');
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
  assert.equal(decidePilotExposure({ trust: quiet, featureEnabled: true, killSwitchActive: false }).reason, 'quiet_mode');
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

/**
 * Was "…persist atomically in a private file", against `new PilotTrustStore(file)`.
 *
 * The file is gone (UC-1.0b, #141): trust, audit and incidents live in
 * storage. The invariants it protected are kept and re-pointed — a write is
 * durable and readable back by a reader that holds no in-memory copy, and
 * nothing raw is stored. The 0600 file-mode assertion has no successor,
 * because there is no file; access is `firestore.rules`, covered by
 * `tests/storage/firestoreRules.emulator.test.ts`.
 */
test('closed pilot: trust state, audit, and incidents persist and read back with no cached copy', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    await applyTrustAction('pilot-1', { type: 'grant_recommendation_consent', at: AT });
    await appendAudit(createPilotAuditEvent({ version: 'v1', eventType: 'consent_changed', participantId: 'pilot-1', occurredAt: AT, outcome: 'recorded', reasonCode: 'grant_recommendation_consent' }));
    await appendIncident(createPilotTrustIncident({
      version: 'v1', incidentId: 'incident-1', participantId: 'pilot-1', occurredAt: AT,
      surface: 'recommendation', category: 'reliability', severity: 'medium', status: 'open',
      ownerId: 'pilot_owner', containmentCode: 'reported_for_review', resolutionCode: null,
    }));

    assert.equal((await getOrCreateTrust('pilot-1', AT)).recommendationConsent, true);
    assert.equal((await listAuditEvents('pilot-1')).length, 1);
    assert.equal((await listIncidents()).length, 1);
    const everything = await Promise.all(
      storage.pathsForTests().map(async (path) => JSON.stringify(await storage.get(path))),
    );
    assert.doesNotMatch(everything.join('\n'), /private words/);
  } finally {
    resetStorageForTests();
  }
});
