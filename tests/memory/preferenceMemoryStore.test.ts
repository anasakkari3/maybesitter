import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { FilePreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';

function withTempStore(fn: (store: FilePreferenceMemoryStore) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-pref-test-'));
  try {
    fn(new FilePreferenceMemoryStore(tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('preferenceStore: create stores an active preference with a created event', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
      strength: 'hard', polarity: 'avoid', confidence: 0.9, evidenceIds: ['obs_1'],
    }, 'Created from message', 'obs_1');

    assert.equal(preference.status, 'active');
    assert.equal(preference.strength, 'hard');
    assert.equal(preference.polarity, 'avoid');

    const events = store.getEvents(preference.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'created');
  });
});

test('preferenceStore: getById returns null for unknown id', () => {
  withTempStore((store) => {
    assert.equal(store.getById('does_not_exist'), null);
  });
});

test('preferenceStore: getActiveByUserId excludes other users and superseded entries', () => {
  withTempStore((store) => {
    const mine = store.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    store.create({
      userId: 'user_2', statement: 'avoid gym', scope: 'gym',
      strength: 'soft', polarity: 'avoid', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    store.update({ id: mine.id, status: 'superseded' }, 'replaced by a newer statement', 'system');

    const secondMine = store.create({
      userId: 'user_1', statement: 'prefer deep work blocks in the morning', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.8, evidenceIds: [],
    }, 'created', undefined);

    const active = store.getActiveByUserId('user_1');
    assert.equal(active.length, 1);
    assert.equal(active[0].id, secondMine.id);
  });
});

test('preferenceStore: update changes fields and records a corrected event on terminal status', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
      strength: 'soft', polarity: 'avoid', confidence: 0.6, evidenceIds: [],
    }, 'created', undefined);
    store.update({ id: preference.id, status: 'superseded' }, 'user corrected this', 'user');
    const updated = store.update({ id: preference.id, status: 'active' }, 'user restored this', 'user');

    assert.equal(updated.status, 'active');
    const events = store.getEvents(preference.id);
    assert.ok(events.some((event) => event.type === 'corrected'));
  });
});

test('preferenceStore: adjustConfidence clamps within [0.2, 0.99] and records events', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'prefer short tasks in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.95, evidenceIds: [],
    }, 'created', undefined);

    const boosted = store.adjustConfidence(preference.id, 0.5, 'accepted repeatedly');
    assert.equal(boosted.confidence, 0.99);

    const lowered = store.adjustConfidence(preference.id, -2, 'dismissed repeatedly');
    assert.equal(lowered.confidence, 0.2);

    const events = store.getEvents(preference.id);
    assert.ok(events.filter((event) => event.type === 'confidence_adjusted').length === 2);
  });
});

test('preferenceStore: addEvidence appends without duplicating', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'prefer short tasks', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.7, evidenceIds: ['obs_1'],
    }, 'created', undefined);
    store.addEvidence(preference.id, 'obs_2');
    store.addEvidence(preference.id, 'obs_2');
    const stored = store.getById(preference.id);
    assert.deepEqual(stored!.evidenceIds, ['obs_1', 'obs_2']);
  });
});

test('preferenceStore: persists across store instances (file-backed)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-pref-test-'));
  try {
    const first = new FilePreferenceMemoryStore(tmpDir);
    const created = first.create({
      userId: 'user_1', statement: 'prefer mornings', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);

    const second = new FilePreferenceMemoryStore(tmpDir);
    assert.deepEqual(second.getById(created.id), created);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
