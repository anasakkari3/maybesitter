/**
 * Personalization consent store (Sprint 10, issue #42; storage since UC-1.0c, #142).
 *
 * The consent record is the one piece of personalization state that *must*
 * persist — the profile itself never does. These tests pin the fail-closed
 * rules `PERSONALIZATION_CONSENT_POLICY` states as data: the default state is
 * disabled, an unreadable consent is a disabled consent, and both backends
 * share one behaviour.
 *
 * The three "file-backed" cases survive the move in their real form. They used
 * to corrupt a JSON file on disk; they now plant the same malformed record
 * directly in storage at the consent's own path, which is the equivalent of a
 * half-applied write or a hand edit — and the property under test, that
 * anything short of a well-formed record for this exact scope reads as
 * disabled, is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StoragePersonalizationConsentStore,
  createInMemoryPersonalizationConsentStore,
  type PersonalizationConsentStore,
} from '../../lib/personalizationControls/consentStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { CONSENTS, userCol, userIdForKey } from '../../lib/storage/paths.ts';

const NOW = '2026-08-20T10:00:00.000Z';
const LATER = '2026-08-20T11:00:00.000Z';

function consentPath(scopeId: string): string {
  return `${userCol(userIdForKey(scopeId), CONSENTS)}/personalization`;
}

for (const [name, make] of [
  ['in-memory', () => createInMemoryPersonalizationConsentStore()],
  ['storage', () => new StoragePersonalizationConsentStore(createMemoryStorage())],
] as const) {
  test(`${name}: a scope never written reads as disabled with changedAt null`, async () => {
    const store: PersonalizationConsentStore = make();
    assert.deepEqual(await store.read('scope-a'), { state: 'disabled', changedAt: null });
  });

  test(`${name}: an explicit grant reads back enabled with its instant`, async () => {
    const store: PersonalizationConsentStore = make();
    const written = await store.write('scope-a', 'enabled', NOW);
    assert.deepEqual(written, { state: 'enabled', changedAt: NOW });
    assert.deepEqual(await store.read('scope-a'), { state: 'enabled', changedAt: NOW });
  });

  test(`${name}: a flip to disabled is what the very next read returns`, async () => {
    const store: PersonalizationConsentStore = make();
    await store.write('scope-a', 'enabled', NOW);
    await store.write('scope-a', 'disabled', LATER);
    assert.deepEqual(await store.read('scope-a'), { state: 'disabled', changedAt: LATER });
  });

  test(`${name}: consent is per scope; one scope's grant says nothing about another`, async () => {
    const store: PersonalizationConsentStore = make();
    await store.write('scope-a', 'enabled', NOW);
    assert.equal((await store.read('scope-b')).state, 'disabled');
  });

  test(`${name}: deleteScope returns the record to the default disabled state`, async () => {
    const store: PersonalizationConsentStore = make();
    await store.write('scope-a', 'enabled', NOW);
    assert.equal(await store.deleteScope('scope-a'), 1);
    assert.deepEqual(await store.read('scope-a'), { state: 'disabled', changedAt: null });
    assert.equal(await store.deleteScope('scope-a'), 0);
  });

  test(`${name}: writing an unknown state or malformed instant is refused, not coerced`, async () => {
    const store: PersonalizationConsentStore = make();
    await assert.rejects(store.write('scope-a', 'paused' as never, NOW), /consent/);
    await assert.rejects(store.write('scope-a', 'enabled', 'not-a-time'), /consent/);
    await assert.rejects(store.write('', 'enabled', NOW), /consent/);
    assert.equal((await store.read('scope-a')).state, 'disabled');
  });
}

test('storage: a corrupt consent record reads as disabled — unreadable consent is disabled consent', async () => {
  const storage = createMemoryStorage();
  const store = new StoragePersonalizationConsentStore(storage);
  await store.write('scope-a', 'enabled', NOW);
  await storage.set(consentPath('scope-a'), { not: 'a consent record' });
  assert.deepEqual(await store.read('scope-a'), { state: 'disabled', changedAt: null });
});

test('storage: a hand-edited record carrying a third state reads as disabled', async () => {
  const storage = createMemoryStorage();
  const store = new StoragePersonalizationConsentStore(storage);
  await store.write('scope-a', 'enabled', NOW);
  const record = await storage.get<Record<string, unknown>>(consentPath('scope-a'));
  await storage.set(consentPath('scope-a'), { ...record, state: 'paused' });
  assert.equal((await store.read('scope-a')).state, 'disabled');
});

test('storage: a record whose stored scope disagrees with the requested one is not served', async () => {
  const storage = createMemoryStorage();
  const store = new StoragePersonalizationConsentStore(storage);
  await store.write('scope-a', 'enabled', NOW);
  const record = await storage.get<Record<string, unknown>>(consentPath('scope-a'));
  await storage.set(consentPath('scope-a'), { ...record, scopeId: 'scope-b' });
  assert.equal((await store.read('scope-a')).state, 'disabled');
});

test('storage: consent survives a restart — a second store over the same backend reads it', async () => {
  // What a second Cloud Run instance is. The file store's "reopen the
  // directory" case, made the test of the property that actually matters: a
  // withdrawal must be visible to every instance on its next read.
  const shared = createMemoryStorage();
  await new StoragePersonalizationConsentStore(shared).write('scope-a', 'enabled', NOW);
  const reopened = new StoragePersonalizationConsentStore(shared);
  assert.deepEqual(await reopened.read('scope-a'), { state: 'enabled', changedAt: NOW });

  await new StoragePersonalizationConsentStore(shared).write('scope-a', 'disabled', LATER);
  assert.equal((await reopened.read('scope-a')).state, 'disabled', 'a withdrawal was invisible to another handle');
});
