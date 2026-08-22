/**
 * The study consent store: opt-in by default, revocation as a shape, and a
 * delete that is proven by re-listing rather than by a returned count.
 *
 * Every acceptance-bearing assertion here re-reads the store. A test that
 * trusted `grant()`'s return value would be checking one function against
 * itself — the same reason `deletePersonalizationScope` re-lists instead of
 * subtracting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SHADOW_CONSENT_SCOPES,
  SHADOW_EXPOSURE_POLICY,
  checkShadowStudyConsent,
  type ShadowConsentScope,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  SHADOW_CONSENT_WRITE_REJECTIONS,
  createFileShadowStudyConsentStore,
  createInMemoryShadowStudyConsentStore,
  type ShadowStudyConsentStore,
} from '../../lib/release/consentStore.ts';

const P = 'participant-a';
const Q = 'participant-b';
const T1 = '2027-01-04T09:00:00.000Z';
const T2 = '2027-01-05T09:00:00.000Z';
const T3 = '2027-01-06T09:00:00.000Z';

function stores(): { name: string; make: () => ShadowStudyConsentStore; cleanup: () => void }[] {
  const dirs: string[] = [];
  return [
    { name: 'memory', make: createInMemoryShadowStudyConsentStore, cleanup: () => {} },
    {
      name: 'file',
      make: () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'ms-study-consent-'));
        dirs.push(dir);
        return createFileShadowStudyConsentStore({ dataDir: dir });
      },
      cleanup: () => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      },
    },
  ];
}

for (const flavour of stores()) {
  test(`[${flavour.name}] the default state is withheld, and it is the policy's default`, () => {
    const store = flavour.make();
    const consent = store.read(P);
    assert.equal(consent.state, 'withheld');
    assert.equal(consent.state, SHADOW_EXPOSURE_POLICY.defaultConsentState);
    assert.deepEqual(consent.scopes, []);
    assert.equal(consent.grantedAt, null);
    assert.equal(consent.revokedAt, null);
    assert.deepEqual(checkShadowStudyConsent(consent), []);
    flavour.cleanup();
  });

  test(`[${flavour.name}] a grant is readable back, scope by scope, and is structurally clean`, () => {
    const store = flavour.make();
    const written = store.grant(P, ['shadow_execution', 'feedback_study'], T1);
    assert.equal(written.status, 'written');

    const consent = store.read(P);
    assert.equal(consent.state, 'granted');
    assert.equal(consent.grantedAt, T1);
    assert.equal(consent.revokedAt, null);
    const scopes: readonly ShadowConsentScope[] = consent.scopes;
    // Pair-wise, not as a deduplicated set: a store that collapsed two scopes
    // into one would still satisfy a set comparison.
    for (const scope of ['shadow_execution', 'feedback_study'] as const) {
      assert.equal(
        scopes.filter((granted) => granted === scope).length,
        1,
        `${scope} was not granted exactly once`,
      );
    }
    assert.equal(scopes.includes('trace_retention'), false);
    assert.deepEqual(checkShadowStudyConsent(consent), []);
    flavour.cleanup();
  });

  test(`[${flavour.name}] revocation leaves nothing to read, and the next read says so`, () => {
    const store = flavour.make();
    store.grant(P, ['shadow_execution'], T1);
    const result = store.revoke(P, T2);
    assert.equal(result.status, 'written');

    const consent = store.read(P);
    assert.equal(consent.state, 'revoked');
    assert.deepEqual(consent.scopes, [], 'a revoked consent still carried live scopes');
    assert.equal(consent.grantedAt, T1, 'revocation forgot when consent was granted');
    assert.equal(consent.revokedAt, T2);
    assert.deepEqual(checkShadowStudyConsent(consent), []);
    flavour.cleanup();
  });

  test(`[${flavour.name}] deletion is proven by re-listing the store, not by the returned count`, () => {
    const store = flavour.make();
    store.grant(P, ['shadow_execution'], T1);
    store.grant(Q, ['feedback_study'], T1);
    assert.equal(store.countFor(P), 1);

    const removed = store.deleteParticipant(P);
    assert.equal(removed, 1);
    // The load-bearing assertion: the store is asked again.
    assert.equal(store.countFor(P), 0, 'a consent record survived its own deletion');
    assert.equal(store.read(P).state, 'withheld', 'a deleted participant did not return to the default');
    assert.deepEqual(store.listParticipants(), [Q], 'deletion removed the wrong participant, or too many');
    assert.equal(store.countFor(Q), 1, 'one participant deleted another');
    flavour.cleanup();
  });

  test(`[${flavour.name}] a participant may re-join after revoking`, () => {
    const store = flavour.make();
    store.grant(P, ['shadow_execution'], T1);
    store.revoke(P, T2);
    assert.equal(store.grant(P, ['shadow_execution'], T3).status, 'written');
    const consent = store.read(P);
    assert.equal(consent.state, 'granted');
    assert.equal(consent.grantedAt, T3);
    assert.deepEqual(checkShadowStudyConsent(consent), []);
    flavour.cleanup();
  });
}

test('every rejection reason is reachable, and none of them throws', () => {
  const store = createInMemoryShadowStudyConsentStore();
  const seen = new Set<string>();

  const record = (result: { status: string; reason?: string }): void => {
    assert.equal(result.status, 'rejected', 'a write that should have been refused was accepted');
    if (result.reason !== undefined) seen.add(result.reason);
  };

  record(store.grant('Participant A', ['shadow_execution'], T1) as never);
  record(store.grant(P, [], T1) as never);
  record(store.grant(P, ['telepathy' as never], T1) as never);
  record(store.grant(P, ['shadow_execution'], 'yesterday') as never);
  record(store.revoke(P, T1) as never);

  store.grant(P, ['shadow_execution'], T2);
  record(store.revoke(P, T1) as never);
  store.revoke(P, T3);
  record(store.revoke(P, T3) as never);

  assert.deepEqual(
    SHADOW_CONSENT_WRITE_REJECTIONS.filter((reason) => !seen.has(reason)),
    [],
    'a declared rejection reason has no test reaching it',
  );
});

test('a refused grant leaves the previous state exactly as it was', () => {
  const store = createInMemoryShadowStudyConsentStore();
  store.grant(P, ['shadow_execution'], T1);
  const before = store.read(P);
  store.grant(P, ['telepathy' as never], T2);
  assert.deepEqual(store.read(P), before, 'a rejected write still changed the record');
});

test('every scope in the vocabulary is separately grantable and separately readable', () => {
  const store = createInMemoryShadowStudyConsentStore();
  for (const scope of SHADOW_CONSENT_SCOPES) {
    const participant = `p-${scope.replace(/_/g, '-')}`;
    assert.equal(store.grant(participant, [scope], T1).status, 'written');
    const granted: readonly ShadowConsentScope[] = store.read(participant).scopes;
    // (participant, scope) pairs: every other scope must be absent for this one.
    for (const other of SHADOW_CONSENT_SCOPES) {
      assert.equal(
        granted.includes(other),
        other === scope,
        `${participant} reads ${other} as ${granted.includes(other) ? 'granted' : 'absent'}`,
      );
    }
  }
});

test('a corrupt record reads as withheld rather than as anything else', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ms-study-consent-corrupt-'));
  try {
    const store = createFileShadowStudyConsentStore({ dataDir: dir });
    store.grant(P, ['shadow_execution'], T1);
    const [file] = readdirSync(dir);
    writeFileSync(path.join(dir, file), '{"version":"shadow-study-consent-v1",');
    const consent = store.read(P);
    assert.equal(consent.state, 'withheld', 'a truncated file did not fail closed');
    assert.deepEqual(consent.scopes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a record whose stored participant disagrees with the requested one is withheld', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ms-study-consent-mismatch-'));
  try {
    const store = createFileShadowStudyConsentStore({ dataDir: dir });
    store.grant(P, ['shadow_execution'], T1);
    const [file] = readdirSync(dir);
    writeFileSync(
      path.join(dir, file),
      JSON.stringify({
        version: 'shadow-study-consent-v1',
        participantId: Q,
        state: 'granted',
        scopes: ['shadow_execution'],
        grantedAt: T1,
        revokedAt: null,
      }),
    );
    assert.equal(store.read(P).state, 'withheld', 'one participant read another participant\'s grant');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the revocation instant is probed against the grant instant, one millisecond at a time', () => {
  const grantedAt = '2027-01-04T09:00:00.000Z';
  const cases: [string, 'written' | 'rejected'][] = [
    ['2027-01-04T08:59:59.999Z', 'rejected'],
    [grantedAt, 'written'],
    ['2027-01-04T09:00:00.001Z', 'written'],
  ];
  for (const [revokedAt, expected] of cases) {
    const store = createInMemoryShadowStudyConsentStore();
    store.grant(P, ['shadow_execution'], grantedAt);
    const result = store.revoke(P, revokedAt);
    assert.equal(result.status, expected, `revoking at ${revokedAt} was ${result.status}`);
    if (expected === 'written') {
      // And the contract agrees the pair is well-ordered.
      assert.deepEqual(checkShadowStudyConsent(store.read(P)), []);
    }
  }
});
