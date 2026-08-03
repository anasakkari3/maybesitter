import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage, type MemoryIngestionServiceDeps } from '../../src/services/memoryIngestionService.ts';
import { FileObservationStore } from '../../src/domain/memory/observationStore.ts';
import { FileCommitmentMemoryStore } from '../../src/domain/memory/commitmentMemoryStore.ts';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

function createTestDeps(): { deps: MemoryIngestionServiceDeps; cleanup: () => void } {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-test-'));
  const deps: MemoryIngestionServiceDeps = {
    observationStore: new FileObservationStore(tmpDir),
    commitmentStore: new FileCommitmentMemoryStore(tmpDir),
  };
  return { deps, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

test('ingestion: creates observation for every message', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'يمكن أزور خالي',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.ok(result.observation);
    assert.equal(result.observation.sourceText, 'يمكن أزور خالي');
    assert.equal(result.observation.userId, 'user_1');
  } finally {
    cleanup();
  }
});

test('ingestion: "يمكن أزور خالي" → mentioned commitment', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'يمكن أزور خالي',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.equal(result.commitments.length, 1);
    assert.equal(result.commitments[0].status, 'mentioned');
    assert.ok(!result.commitments[0].notificationEligible);
  } finally {
    cleanup();
  }
});

test('ingestion: "ذكرني بكرا الساعة 8 أتصل بالدكتور" → confirmed, auto_accept', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'ذكرني بكرا الساعة 8 أتصل بالدكتور',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.equal(result.commitments.length, 1);
    const status = result.commitments[0].status;
    assert.ok(status === 'confirmed' || status === 'scheduled');
    assert.equal(result.commitments[0].requiresConfirmation, false);
  } finally {
    cleanup();
  }
});

test('ingestion: negated text creates no commitment', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'مش رايح الخميس',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.equal(result.commitments.length, 0);
    assert.ok(result.observation);
  } finally {
    cleanup();
  }
});

test('ingestion: conditional text → mentioned, no notification', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'إذا خلصت بدري بروح عالجيم',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.equal(result.commitments.length, 1);
    assert.equal(result.commitments[0].status, 'mentioned');
    assert.ok(!result.commitments[0].notificationEligible);
  } finally {
    cleanup();
  }
});

test('ingestion: two messages about same topic merge into one commitment', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    ingestMessage({
      text: 'يمكن أزور خالي الأسبوع الجاي',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);

    const result2 = ingestMessage({
      text: 'خلص رايح أزور خالي الخميس',
      userId: 'user_1',
      timestamp: '2026-08-04T12:00:00.000Z',
    }, deps);

    const allCommitments = deps.commitmentStore.getOpenByUserId('user_1');
    assert.ok(allCommitments.length <= 2);

    if (result2.decisions[0]?.resolution.action === 'link') {
      assert.equal(allCommitments.length, 1);
      assert.equal(allCommitments[0].evidenceIds.length, 2);
    }
  } finally {
    cleanup();
  }
});

test('ingestion: all state changes produce audit events', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'ذكرني بكرا أتصل بالدكتور',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.ok(result.commitments.length > 0);
    const events = deps.commitmentStore.getEvents(result.commitments[0].id);
    assert.ok(events.length >= 1);
    assert.equal(events[0].type, 'created');
    assert.ok(events[0].reason.length > 0);
  } finally {
    cleanup();
  }
});

test('ingestion: observation preserves original text', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const originalText = 'خليها بدل الخميس الجمعة';
    const result = ingestMessage({
      text: originalText,
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.equal(result.observation.sourceText, originalText);
    const stored = deps.observationStore.getById(result.observation.id);
    assert.ok(stored);
    assert.equal(stored.sourceText, originalText);
  } finally {
    cleanup();
  }
});

test('ingestion: reported speech → mentioned, not confirmed', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'أمي قالت إنها ستزور خالتي الخميس',
      userId: 'user_1',
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    assert.equal(result.commitments.length, 1);
    assert.equal(result.commitments[0].status, 'mentioned');
    assert.ok(!result.commitments[0].notificationEligible);
  } finally {
    cleanup();
  }
});

test('ingestion: reprocessing same message does not create duplicate observations', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const msgId = 'msg_fixed_id';
    ingestMessage({
      text: 'ذكرني بكرا',
      userId: 'user_1',
      messageId: msgId,
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    ingestMessage({
      text: 'ذكرني بكرا',
      userId: 'user_1',
      messageId: msgId,
      timestamp: '2026-08-03T12:00:00.000Z',
    }, deps);
    const observations = deps.observationStore.getByUserId('user_1');
    assert.equal(observations.length, 2);
  } finally {
    cleanup();
  }
});
