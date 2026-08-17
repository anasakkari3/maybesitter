import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { FileFactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';

function withTempStore(fn: (store: FileFactMemoryStore) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-fact-test-'));
  try {
    fn(new FileFactMemoryStore(tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('factStore: create stores an active fact with a created event', () => {
  withTempStore((store) => {
    const fact = store.create({
      userId: 'user_1', statement: 'Tuesday I work 17:00-20:00', scope: 'work',
      confidence: 0.85, evidenceIds: ['obs_1'],
    }, 'Created from message', 'obs_1');

    assert.equal(fact.status, 'active');
    const events = store.getEvents(fact.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'created');
  });
});

test('factStore: getById returns null for unknown id', () => {
  withTempStore((store) => {
    assert.equal(store.getById('does_not_exist'), null);
  });
});

test('factStore: getActiveByUserId excludes other users and superseded entries', () => {
  withTempStore((store) => {
    const mine = store.create({
      userId: 'user_1', statement: 'Thursday Wolt shifts pay more', scope: 'wolt', confidence: 0.8, evidenceIds: [],
    }, 'created', undefined);
    store.create({
      userId: 'user_2', statement: 'unrelated fact', scope: 'work', confidence: 0.8, evidenceIds: [],
    }, 'created', undefined);
    store.update({ id: mine.id, status: 'superseded' }, 'replaced', 'system');

    const secondMine = store.create({
      userId: 'user_1', statement: 'Thursday and Friday Wolt shifts pay more', scope: 'wolt', confidence: 0.85, evidenceIds: [],
    }, 'created', undefined);

    const active = store.getActiveByUserId('user_1');
    assert.equal(active.length, 1);
    assert.equal(active[0].id, secondMine.id);
  });
});

test('factStore: update changes fields and records a corrected event on status change', () => {
  withTempStore((store) => {
    const fact = store.create({
      userId: 'user_1', statement: 'the gym closes at 10pm', scope: 'gym', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    const updated = store.update({ id: fact.id, statement: 'the gym closes at 9pm on weekdays' }, 'corrected by user', 'user');
    assert.equal(updated.statement, 'the gym closes at 9pm on weekdays');

    store.update({ id: fact.id, status: 'superseded' }, 'no longer accurate', 'user');
    const events = store.getEvents(fact.id);
    assert.ok(events.some((event) => event.type === 'corrected'));
  });
});

test('factStore: adjustConfidence clamps within [0.2, 0.99]', () => {
  withTempStore((store) => {
    const fact = store.create({
      userId: 'user_1', statement: 'Thursday Wolt shifts pay more', scope: 'wolt', confidence: 0.9, evidenceIds: [],
    }, 'created', undefined);
    assert.equal(store.adjustConfidence(fact.id, 0.5, 'confirmed repeatedly').confidence, 0.99);
    assert.equal(store.adjustConfidence(fact.id, -2, 'contradicted repeatedly').confidence, 0.2);
  });
});

test('factStore: persists across store instances (file-backed)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-fact-test-'));
  try {
    const first = new FileFactMemoryStore(tmpDir);
    const created = first.create({
      userId: 'user_1', statement: 'Tuesday I work 17:00-20:00', scope: 'work', confidence: 0.85, evidenceIds: [],
    }, 'created', undefined);
    const second = new FileFactMemoryStore(tmpDir);
    assert.deepEqual(second.getById(created.id), created);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
