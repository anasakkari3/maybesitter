/**
 * Reproducibility: same non-revoked events => byte-identical profile.
 *
 * The acceptance criterion proved with the digest, both ways round:
 * deriving twice and deriving from a re-ordered log are byte-identical, a
 * revocation moves both the readings and every rung digest, and a revoked
 * event contributes exactly nothing — the readings equal those of a log where
 * the event never existed, while the basis honestly reports the correction
 * (`revokedCount`) and the digests honestly differ (the input is not the
 * same input).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackEvent,
  type FeedbackOutcome,
} from '../../src/contracts/v1/feedbackContracts.ts';
import {
  checkPersonalizationProfile,
  inertPersonalizationProfile,
  type EnabledPersonalizationProfile,
  type PersonalizationConsent,
} from '../../src/contracts/v1/personalizationContracts.ts';
import { rebuildPersonalizationProfile } from '../../lib/personalization/rebuild.ts';

const NOW = '2026-08-20T09:00:00.000Z';
const SCOPE = 'alice';
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const ENABLED: PersonalizationConsent = Object.freeze({ state: 'enabled', changedAt: NOW });
const DISABLED: PersonalizationConsent = Object.freeze({ state: 'disabled', changedAt: null });

let sequence = 0;

function event(outcome: FeedbackOutcome, ageDays: number): FeedbackEvent {
  sequence += 1;
  const occurredAt = new Date(Date.parse(NOW) - ageDays * MS_PER_DAY).toISOString();
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    id: `evt-${sequence}`,
    scopeId: SCOPE,
    outcome,
    subjectId: 'subject-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt,
    recordedAt: occurredAt,
    idempotencyKey: `key-${sequence}`,
  };
}

function many(outcome: FeedbackOutcome, count: number, ageDays: number): FeedbackEvent[] {
  return Array.from({ length: count }, () => event(outcome, ageDays));
}

function rebuild(events: readonly FeedbackEvent[], consent: PersonalizationConsent = ENABLED) {
  const profile = rebuildPersonalizationProfile({
    scopeId: SCOPE,
    now: NOW,
    consent,
    events,
    baseline: null,
  });
  assert.deepEqual(checkPersonalizationProfile(profile), []);
  return profile;
}

function mixedLog(): FeedbackEvent[] {
  return [
    ...many('accept', 3, 1),
    ...many('reject', 2, 30),
    ...many('ignore', 4, 100),
    ...many('defer', 1, 1),
  ];
}

test('rebuilding twice from one log is byte-identical', () => {
  const events = mixedLog();
  const first = rebuild(events);
  const second = rebuild(events);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('caller order of the log is not an input: a reversed log rebuilds byte-identically', () => {
  const events = mixedLog();
  const reversed = [...events].reverse();
  assert.equal(JSON.stringify(rebuild(events)), JSON.stringify(rebuild(reversed)));
});

test('revoking an event changes the profile, and every rung digest moves with it', () => {
  const events = mixedLog();
  const before = rebuild(events) as EnabledPersonalizationProfile;

  // Revoke both rejects, the way the store records it: revokedAt, no rewrite.
  const revoked = events.map((entry) =>
    entry.outcome === 'reject' ? { ...entry, revokedAt: NOW } : entry,
  );
  const after = rebuild(revoked) as EnabledPersonalizationProfile;

  assert.notEqual(JSON.stringify(before), JSON.stringify(after));
  // The ceiling read those rejects; the correction must reach it.
  assert.notDeepEqual(after.readings.pressure_ceiling, before.readings.pressure_ceiling);
  // Every rung aggregated a different input, and each says so.
  for (let index = 0; index < before.basis.rungs.length; index += 1) {
    assert.notEqual(after.basis.rungs[index].inputDigest, before.basis.rungs[index].inputDigest);
    assert.equal(before.basis.rungs[index].revokedCount, 0);
    assert.equal(after.basis.rungs[index].revokedCount, 2);
  }
});

test('a revoked event contributes exactly nothing: readings equal a log it never joined', () => {
  const events = mixedLog();
  const revoked = events.map((entry) =>
    entry.outcome === 'reject' ? { ...entry, revokedAt: NOW } : entry,
  );
  const withoutRejects = events.filter((entry) => entry.outcome !== 'reject');

  const revokedProfile = rebuild(revoked) as EnabledPersonalizationProfile;
  const absentProfile = rebuild(withoutRejects) as EnabledPersonalizationProfile;

  // Same readings: the correction is fully honoured.
  assert.deepEqual(revokedProfile.readings, absentProfile.readings);
  // Different basis: the input is honestly a different input, and the
  // correction is visible rather than erased.
  assert.notEqual(
    revokedProfile.basis.rungs[0].inputDigest,
    absentProfile.basis.rungs[0].inputDigest,
  );
  assert.equal(revokedProfile.basis.rungs[0].revokedCount, 2);
  assert.equal(absentProfile.basis.rungs[0].revokedCount, 0);
});

test('a disabled rebuild never aggregates: unparseable events cannot break it', () => {
  const poisoned = [{ nonsense: true } as unknown as FeedbackEvent];
  assert.deepEqual(rebuild(poisoned, DISABLED), inertPersonalizationProfile(SCOPE, NOW));
});
