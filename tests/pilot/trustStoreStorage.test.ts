/**
 * The pilot trust record on storage (UC-1.0b, #141).
 *
 * The defect these tests exist for: the store used to load one JSON file into
 * a process-wide object at first use, so a revoke on instance A stayed
 * invisible on instance B until B restarted. A revocation that does not take
 * effect everywhere is not a revocation, so "a second reader sees it
 * immediately" is asserted directly rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendAudit,
  appendIncident,
  applyTrustAction,
  getOrCreateTrust,
  listAllAuditEvents,
  listAuditEvents,
  listIncidents,
  updateIncident,
} from '../../lib/pilot/pilotTrustStore.ts';
import { createPilotAuditEvent, createPilotTrustIncident } from '../../lib/pilot/closedPilotControls.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { AUDIT_EVENTS, INCIDENTS, userCol, userDoc } from '../../lib/storage/paths.ts';

const AT = '2026-09-14T09:00:00.000Z';
const LATER = '2026-09-14T10:00:00.000Z';
const A = 'pilot-1';
const B = 'pilot-2';

function setup(): { storage: MemoryStorageAdapter; cleanup: () => void } {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  return { storage, cleanup: () => resetStorageForTests() };
}

function auditFor(participantId: string, occurredAt: string, reasonCode: string) {
  return createPilotAuditEvent({
    version: 'v1',
    eventType: 'consent_changed',
    participantId,
    occurredAt,
    outcome: 'recorded',
    reasonCode,
  });
}

function incidentFor(incidentId: string, participantId = A) {
  return createPilotTrustIncident({
    version: 'v1',
    incidentId,
    participantId,
    occurredAt: AT,
    surface: 'recommendation',
    category: 'reliability',
    severity: 'medium',
    status: 'open',
    ownerId: 'pilot_owner',
    containmentCode: 'reported_for_review',
    resolutionCode: null,
  });
}

test('trust: a record is created once and read back from the user document', async () => {
  const { storage, cleanup } = setup();
  try {
    const created = await getOrCreateTrust(A, AT);
    assert.equal(created.participantId, A);
    assert.equal(created.recommendationConsent, false);
    assert.equal(created.updatedAt, AT);

    const again = await getOrCreateTrust(A, LATER);
    assert.deepEqual(again, created, 'a second call minted a second record');

    const user = await storage.get<{ trust: { participantId: string }; schemaVersion: number }>(userDoc(A));
    assert.equal(user?.trust.participantId, A);
    assert.equal(user?.schemaVersion, 1);
  } finally {
    cleanup();
  }
});

test('trust: two concurrent first sightings produce one record, not two', async () => {
  const { cleanup } = setup();
  try {
    const [first, second] = await Promise.all([getOrCreateTrust(A, AT), getOrCreateTrust(A, AT)]);
    assert.deepEqual(first, second);
  } finally {
    cleanup();
  }
});

// The privacy defect, stated as a test: no per-instance copy survives a write.
test('trust: a revocation is visible to the very next read', async () => {
  const { cleanup } = setup();
  try {
    await applyTrustAction(A, { type: 'grant_recommendation_consent', at: AT });
    assert.equal((await getOrCreateTrust(A, AT)).recommendationConsent, true);

    const revoked = await applyTrustAction(A, { type: 'revoke', at: LATER });
    assert.equal(revoked.revokedAt, LATER);
    assert.equal(revoked.recommendationConsent, false);

    const seenByAnotherReader = await getOrCreateTrust(A, LATER);
    assert.equal(seenByAnotherReader.revokedAt, LATER);
    assert.equal(seenByAnotherReader.recommendationConsent, false);
  } finally {
    cleanup();
  }
});

test('trust: the domain rules still hold through storage', async () => {
  const { cleanup } = setup();
  try {
    await applyTrustAction(A, { type: 'revoke', at: AT });
    await assert.rejects(
      applyTrustAction(A, { type: 'set_quiet_mode', enabled: false, at: LATER }),
      /only be deleted/,
    );
    assert.ok((await applyTrustAction(A, { type: 'delete', at: LATER })).deletedAt);
  } finally {
    cleanup();
  }
});

test('trust: two concurrent consent changes both land, neither is lost', async () => {
  const { cleanup } = setup();
  try {
    await Promise.all([
      applyTrustAction(A, { type: 'grant_recommendation_consent', at: AT }),
      applyTrustAction(A, { type: 'set_analytics_consent', granted: true, at: AT }),
    ]);
    const trust = await getOrCreateTrust(A, AT);
    assert.equal(trust.recommendationConsent, true);
    assert.equal(trust.analyticsConsent, true, 'one of two concurrent consent writes was lost');
  } finally {
    cleanup();
  }
});

test('audit: events append per participant, in order, and never overwrite each other', async () => {
  const { storage, cleanup } = setup();
  try {
    await appendAudit(auditFor(A, AT, 'grant_recommendation_consent'));
    await appendAudit(auditFor(A, LATER, 'set_analytics_consent'));
    await appendAudit(auditFor(B, AT, 'grant_recommendation_consent'));

    const forA = await listAuditEvents(A);
    assert.deepEqual(forA.map((event) => event.reasonCode), [
      'grant_recommendation_consent',
      'set_analytics_consent',
    ]);
    assert.equal((await listAuditEvents(B)).length, 1);

    // Cross-participant, for the operator surface.
    const all = await listAllAuditEvents();
    assert.equal(all.length, 3);
    assert.equal(all.filter((event) => event.participantId === A).length, 2);

    // Two events in the same millisecond still get two documents.
    await Promise.all([
      appendAudit(auditFor(A, AT, 'set_quiet_mode')),
      appendAudit(auditFor(A, AT, 'set_quiet_mode')),
    ]);
    assert.equal((await storage.list(userCol(A, AUDIT_EVENTS))).length, 4);
  } finally {
    cleanup();
  }
});

test('incidents: operator-only, outside every user tree, and unique by id', async () => {
  const { storage, cleanup } = setup();
  try {
    await appendIncident(incidentFor('incident-1'));
    await assert.rejects(appendIncident(incidentFor('incident-1')), /already exists/);

    const resolved = await updateIncident('incident-1', {
      status: 'resolved',
      containmentCode: 'feature_stopped',
      resolutionCode: 'verified_fixed',
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolutionCode, 'verified_fixed');
    await assert.rejects(updateIncident('incident-404', {
      status: 'resolved', containmentCode: 'feature_stopped', resolutionCode: 'verified_fixed',
    }), /not found/);

    const incidents = await listIncidents();
    assert.equal(incidents.length, 1);
    // Raw notes are dropped by the builder, and nothing puts them back.
    assert.equal('notes' in incidents[0], false);
    // The path is operator-only: not under any user's readable tree.
    assert.deepEqual(storage.pathsForTests().filter((path) => path.startsWith(`${INCIDENTS}/`)), ['incidents/incident-1']);
  } finally {
    cleanup();
  }
});
