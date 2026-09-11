/**
 * The study consent store: opt-in by default, revocation as a shape, and a
 * delete that is proven by re-listing rather than by a returned count.
 *
 * Every acceptance-bearing assertion here re-reads the store. A test that
 * trusted `grant()`'s return value would be checking one function against
 * itself — the same reason `deletePersonalizationScope` re-lists instead of
 * subtracting.
 *
 * Storage since UC-1.0c (#142). The two corruption cases that used to rewrite
 * a file now plant the same malformed record at the consent's own path in
 * storage; what they prove — that an unreadable or misattributed record is
 * withheld, never granted — is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_CONSENT_SCOPES,
  SHADOW_EXPOSURE_POLICY,
  checkShadowStudyConsent,
  type ShadowConsentScope,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  SHADOW_CONSENT_WRITE_REJECTIONS,
  StorageShadowStudyConsentStore,
  createInMemoryShadowStudyConsentStore,
  type ShadowStudyConsentStore,
} from '../../lib/release/consentStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { CONSENTS, userCol, userIdForKey } from '../../lib/storage/paths.ts';

const P = 'participant-a';
const Q = 'participant-b';
const T1 = '2027-01-04T09:00:00.000Z';
const T2 = '2027-01-05T09:00:00.000Z';
const T3 = '2027-01-06T09:00:00.000Z';

function consentPath(participantId: string): string {
  return `${userCol(userIdForKey(participantId), CONSENTS)}/shadowStudy`;
}

const FLAVOURS: readonly (readonly [string, () => ShadowStudyConsentStore])[] = [
  ['memory', () => createInMemoryShadowStudyConsentStore()],
  ['storage', () => new StorageShadowStudyConsentStore(createMemoryStorage())],
];

for (const [flavour, make] of FLAVOURS) {
  test(`[${flavour}] the default state is withheld, and it is the policy's default`, async () => {
    const store = make();
    const consent = await store.read(P);
    assert.equal(consent.state, 'withheld');
    assert.equal(consent.state, SHADOW_EXPOSURE_POLICY.defaultConsentState);
    assert.deepEqual(consent.scopes, []);
    assert.equal(consent.grantedAt, null);
    assert.equal(consent.revokedAt, null);
    assert.deepEqual(checkShadowStudyConsent(consent), []);
  });

  test(`[${flavour}] a grant is readable back, scope by scope, and is structurally clean`, async () => {
    const store = make();
    const written = await store.grant(P, ['shadow_execution', 'feedback_study'], T1);
    assert.equal(written.status, 'written');

    const consent = await store.read(P);
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
  });

  test(`[${flavour}] revocation leaves nothing to read, and the next read says so`, async () => {
    const store = make();
    await store.grant(P, ['shadow_execution'], T1);
    const result = await store.revoke(P, T2);
    assert.equal(result.status, 'written');

    const consent = await store.read(P);
    assert.equal(consent.state, 'revoked');
    assert.deepEqual(consent.scopes, [], 'a revoked consent still carried live scopes');
    assert.equal(consent.grantedAt, T1, 'revocation forgot when consent was granted');
    assert.equal(consent.revokedAt, T2);
    assert.deepEqual(checkShadowStudyConsent(consent), []);
  });

  test(`[${flavour}] deletion is proven by re-listing the store, not by the returned count`, async () => {
    const store = make();
    await store.grant(P, ['shadow_execution'], T1);
    await store.grant(Q, ['feedback_study'], T1);
    assert.equal(await store.countFor(P), 1);

    const removed = await store.deleteParticipant(P);
    assert.equal(removed, 1);
    // The load-bearing assertion: the store is asked again.
    assert.equal(await store.countFor(P), 0, 'a consent record survived its own deletion');
    assert.equal((await store.read(P)).state, 'withheld', 'a deleted participant did not return to the default');
    assert.deepEqual(await store.listParticipants(), [Q], 'deletion removed the wrong participant, or too many');
    assert.equal(await store.countFor(Q), 1, 'one participant deleted another');
  });

  test(`[${flavour}] a participant may re-join after revoking`, async () => {
    const store = make();
    await store.grant(P, ['shadow_execution'], T1);
    await store.revoke(P, T2);
    assert.equal((await store.grant(P, ['shadow_execution'], T3)).status, 'written');
    const consent = await store.read(P);
    assert.equal(consent.state, 'granted');
    assert.equal(consent.grantedAt, T3);
    assert.deepEqual(checkShadowStudyConsent(consent), []);
  });
}

test('every rejection reason is reachable, and none of them throws', async () => {
  const store = createInMemoryShadowStudyConsentStore();
  const seen = new Set<string>();

  const record = (result: { status: string; reason?: string }): void => {
    assert.equal(result.status, 'rejected', 'a write that should have been refused was accepted');
    if (result.reason !== undefined) seen.add(result.reason);
  };

  record(await store.grant('Participant A', ['shadow_execution'], T1) as never);
  record(await store.grant(P, [], T1) as never);
  record(await store.grant(P, ['telepathy' as never], T1) as never);
  record(await store.grant(P, ['shadow_execution'], 'yesterday') as never);
  record(await store.revoke(P, T1) as never);

  await store.grant(P, ['shadow_execution'], T2);
  record(await store.revoke(P, T1) as never);
  await store.revoke(P, T3);
  record(await store.revoke(P, T3) as never);

  assert.deepEqual(
    SHADOW_CONSENT_WRITE_REJECTIONS.filter((reason) => !seen.has(reason)),
    [],
    'a declared rejection reason has no test reaching it',
  );
});

test('a refused grant leaves the previous state exactly as it was', async () => {
  const store = createInMemoryShadowStudyConsentStore();
  await store.grant(P, ['shadow_execution'], T1);
  const before = await store.read(P);
  await store.grant(P, ['telepathy' as never], T2);
  assert.deepEqual(await store.read(P), before, 'a rejected write still changed the record');
});

test('every scope in the vocabulary is separately grantable and separately readable', async () => {
  const store = createInMemoryShadowStudyConsentStore();
  for (const scope of SHADOW_CONSENT_SCOPES) {
    const participant = `p-${scope.replace(/_/g, '-')}`;
    assert.equal((await store.grant(participant, [scope], T1)).status, 'written');
    const granted: readonly ShadowConsentScope[] = (await store.read(participant)).scopes;
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

test('a corrupt record reads as withheld rather than as anything else', async () => {
  const storage = createMemoryStorage();
  const store = new StorageShadowStudyConsentStore(storage);
  await store.grant(P, ['shadow_execution'], T1);
  await storage.set(consentPath(P), { version: 'shadow-study-consent-v1' });
  const consent = await store.read(P);
  assert.equal(consent.state, 'withheld', 'a truncated record did not fail closed');
  assert.deepEqual(consent.scopes, []);
});

test('a record whose stored participant disagrees with the requested one is withheld', async () => {
  const storage = createMemoryStorage();
  const store = new StorageShadowStudyConsentStore(storage);
  await store.grant(P, ['shadow_execution'], T1);
  await storage.set(consentPath(P), {
    version: 'shadow-study-consent-v1',
    participantId: Q,
    state: 'granted',
    scopes: ['shadow_execution'],
    grantedAt: T1,
    revokedAt: null,
  });
  assert.equal((await store.read(P)).state, 'withheld', "one participant read another participant's grant");
});

test('a withdrawal is visible to a second handle over the same backend', async () => {
  // The defect the file store had on Cloud Run: an opt-out on one instance was
  // invisible to the others, so a participant could keep being exposed.
  const shared = createMemoryStorage();
  const instanceA = new StorageShadowStudyConsentStore(shared);
  const instanceB = new StorageShadowStudyConsentStore(shared);
  await instanceA.grant(P, ['shadow_execution'], T1);
  assert.equal((await instanceB.read(P)).state, 'granted');

  await instanceA.revoke(P, T2);
  assert.equal((await instanceB.read(P)).state, 'revoked', 'a revocation did not reach the other instance');
});

test('the revocation instant is probed against the grant instant, one millisecond at a time', async () => {
  const grantedAt = '2027-01-04T09:00:00.000Z';
  const cases: [string, 'written' | 'rejected'][] = [
    ['2027-01-04T08:59:59.999Z', 'rejected'],
    [grantedAt, 'written'],
    ['2027-01-04T09:00:00.001Z', 'written'],
  ];
  for (const [revokedAt, expected] of cases) {
    const store = createInMemoryShadowStudyConsentStore();
    await store.grant(P, ['shadow_execution'], grantedAt);
    const result = await store.revoke(P, revokedAt);
    assert.equal(result.status, expected, `revoking at ${revokedAt} was ${result.status}`);
    if (expected === 'written') {
      // And the contract agrees the pair is well-ordered.
      assert.deepEqual(checkShadowStudyConsent(await store.read(P)), []);
    }
  }
});
