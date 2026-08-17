import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { FilePreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';
import { FileFactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';
import { applyDecisionFeedback } from '../../lib/experiments/statedPreferenceFeedback.ts';
import type { PreferenceTraceEntry } from '../../lib/experiments/nextStepArms.ts';

function withStores(fn: (stores: { preferenceStore: FilePreferenceMemoryStore; factStore: FileFactMemoryStore }) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-feedback-test-'));
  try {
    fn({ preferenceStore: new FilePreferenceMemoryStore(tmpDir), factStore: new FileFactMemoryStore(tmpDir) });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('feedback: accepting a recommendation raises the confidence of the preference that drove it', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.6, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.6, effect: 'bonus', magnitude: 2 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'accept', 'user accepted the recommendation');

    const updated = preferenceStore.getById(preference.id)!;
    assert.ok(updated.confidence > 0.6);
  });
});

test('feedback: dismissing a recommendation lowers the confidence of the preference that drove it', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.6, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.6, effect: 'bonus', magnitude: 2 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'dismiss', 'user dismissed the recommendation');

    const updated = preferenceStore.getById(preference.id)!;
    assert.ok(updated.confidence < 0.6);
  });
});

test('feedback: repeated dismissal eventually drops confidence below the arm\'s effective floor (0.5)', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.55, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.55, effect: 'bonus', magnitude: 2 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'dismiss', 'dismissed once');
    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'dismiss', 'dismissed twice');

    const updated = preferenceStore.getById(preference.id)!;
    assert.ok(updated.confidence < 0.5);
  });
});

test('feedback: a vetoing trace entry is never confidence-adjusted', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
      strength: 'hard', polarity: 'avoid', confidence: 0.9, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.9, effect: 'veto', magnitude: 0 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'accept', 'user accepted the alternative');

    const updated = preferenceStore.getById(preference.id)!;
    assert.equal(updated.confidence, 0.9);
  });
});

test('feedback: a matching fact in the trace is also adjusted', () => {
  withStores(({ preferenceStore, factStore }) => {
    const fact = factStore.create({
      userId: 'user_1', statement: 'Wolt shifts pay more', scope: 'wolt', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'fact', id: fact.id, statement: fact.statement, confidence: 0.7, effect: 'bonus', magnitude: 1 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'accept', 'user accepted');

    const updated = factStore.getById(fact.id)!;
    assert.ok(updated.confidence > 0.7);
  });
});
