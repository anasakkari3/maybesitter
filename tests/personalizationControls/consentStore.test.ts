/**
 * Personalization consent store (Sprint 10, issue #42).
 *
 * The consent record is the one piece of personalization state that *must*
 * persist — the profile itself never does. These tests pin the fail-closed
 * rules `PERSONALIZATION_CONSENT_POLICY` states as data: the default state is
 * disabled, an unreadable consent is a disabled consent, and both backends
 * share one behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFilePersonalizationConsentStore,
  createInMemoryPersonalizationConsentStore,
  type PersonalizationConsentStore,
} from '../../lib/personalizationControls/consentStore.ts';

const NOW = '2026-08-20T10:00:00.000Z';
const LATER = '2026-08-20T11:00:00.000Z';

function withFileStore(run: (store: PersonalizationConsentStore, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'consent-store-'));
  try {
    run(createFilePersonalizationConsentStore({ dataDir: dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, make] of [
  ['in-memory', (run: (store: PersonalizationConsentStore) => void) => run(createInMemoryPersonalizationConsentStore())],
  ['file-backed', (run: (store: PersonalizationConsentStore) => void) => withFileStore(run)],
] as const) {
  test(`${name}: a scope never written reads as disabled with changedAt null`, () => {
    make((store) => {
      assert.deepEqual(store.read('scope-a'), { state: 'disabled', changedAt: null });
    });
  });

  test(`${name}: an explicit grant reads back enabled with its instant`, () => {
    make((store) => {
      const written = store.write('scope-a', 'enabled', NOW);
      assert.deepEqual(written, { state: 'enabled', changedAt: NOW });
      assert.deepEqual(store.read('scope-a'), { state: 'enabled', changedAt: NOW });
    });
  });

  test(`${name}: a flip to disabled is what the very next read returns`, () => {
    make((store) => {
      store.write('scope-a', 'enabled', NOW);
      store.write('scope-a', 'disabled', LATER);
      assert.deepEqual(store.read('scope-a'), { state: 'disabled', changedAt: LATER });
    });
  });

  test(`${name}: consent is per scope; one scope's grant says nothing about another`, () => {
    make((store) => {
      store.write('scope-a', 'enabled', NOW);
      assert.equal(store.read('scope-b').state, 'disabled');
    });
  });

  test(`${name}: deleteScope returns the record to the default disabled state`, () => {
    make((store) => {
      store.write('scope-a', 'enabled', NOW);
      assert.equal(store.deleteScope('scope-a'), 1);
      assert.deepEqual(store.read('scope-a'), { state: 'disabled', changedAt: null });
      assert.equal(store.deleteScope('scope-a'), 0);
    });
  });

  test(`${name}: writing an unknown state or malformed instant is refused, not coerced`, () => {
    make((store) => {
      assert.throws(() => store.write('scope-a', 'paused' as never, NOW), /consent/);
      assert.throws(() => store.write('scope-a', 'enabled', 'not-a-time'), /consent/);
      assert.throws(() => store.write('', 'enabled', NOW), /consent/);
      assert.equal(store.read('scope-a').state, 'disabled');
    });
  });
}

test('file-backed: a corrupt consent file reads as disabled — unreadable consent is disabled consent', () => {
  withFileStore((store, dir) => {
    store.write('scope-a', 'enabled', NOW);
    const files = readdirSync(dir).filter((entry) => entry.endsWith('.consent.json'));
    assert.equal(files.length, 1);
    writeFileSync(join(dir, files[0]), '{ not json', 'utf8');
    assert.deepEqual(store.read('scope-a'), { state: 'disabled', changedAt: null });
  });
});

test('file-backed: a hand-edited file carrying a third state reads as disabled', () => {
  withFileStore((store, dir) => {
    store.write('scope-a', 'enabled', NOW);
    const files = readdirSync(dir).filter((entry) => entry.endsWith('.consent.json'));
    const filePath = join(dir, files[0]);
    const record = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(filePath, JSON.stringify({ ...record, state: 'paused' }), 'utf8');
    assert.equal(store.read('scope-a').state, 'disabled');
  });
});

test('file-backed: a file whose stored scope disagrees with the requested one is not served', () => {
  withFileStore((store, dir) => {
    store.write('scope-a', 'enabled', NOW);
    const files = readdirSync(dir).filter((entry) => entry.endsWith('.consent.json'));
    const filePath = join(dir, files[0]);
    const record = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(filePath, JSON.stringify({ ...record, scopeId: 'scope-b' }), 'utf8');
    assert.equal(store.read('scope-a').state, 'disabled');
  });
});

test('file-backed: consent survives a store restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-store-'));
  try {
    createFilePersonalizationConsentStore({ dataDir: dir }).write('scope-a', 'enabled', NOW);
    const reopened = createFilePersonalizationConsentStore({ dataDir: dir });
    assert.deepEqual(reopened.read('scope-a'), { state: 'enabled', changedAt: NOW });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
