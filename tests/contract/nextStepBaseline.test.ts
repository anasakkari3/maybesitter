import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compareVariantSelection,
  scoreBaselineCandidate,
  selectBaselineNextStep,
  type BaselineCandidate,
} from '../../lib/services/nextStepBaseline.ts';

const fixture = JSON.parse(readFileSync('evaluation-data/next-step-baseline-fixtures.json', 'utf8'));
const now = new Date(fixture.referenceTime);

test('baseline: locked fixtures are reproducible independent of input order', () => {
  for (const entry of fixture.cases) {
    const forward = selectBaselineNextStep(entry.candidates, now, 'en', entry.id);
    const reversed = selectBaselineNextStep([...entry.candidates].reverse(), now, 'en', entry.id);
    assert.equal(forward.selectedCommitmentId, entry.expectedCommitmentId, entry.id);
    assert.deepEqual(forward, reversed, entry.id);
  }
});

test('baseline: hard constraints exclude unconfirmed, closed, and invalid-time candidates', () => {
  const base: BaselineCandidate = { commitmentId: 'x', title: 'X', confirmed: true, status: 'active', dueAt: null, remindAt: null, importance: 'high', explicitEffortMinutes: null };
  assert.equal(scoreBaselineCandidate({ ...base, confirmed: false }, now).exclusionReason, 'not_confirmed');
  assert.equal(scoreBaselineCandidate({ ...base, status: 'completed' }, now).exclusionReason, 'closed');
  assert.equal(scoreBaselineCandidate({ ...base, dueAt: 'not-a-date' }, now).exclusionReason, 'invalid_time');
});

test('baseline: inferred importance is unavailable and cannot influence selection', () => {
  const result = selectBaselineNextStep([
    { commitmentId: 'inferred', title: 'Inferred', confirmed: true, status: 'active', dueAt: null, remindAt: null, importance: null, explicitEffortMinutes: null },
  ], now, 'ar', 'insufficient');
  assert.equal(result.selectedCommitmentId, null);
  assert.equal(result.recommendation.state, 'insufficient_evidence');
});

test('baseline: every recommendation has concise evidence and no persistence', () => {
  const result = selectBaselineNextStep(fixture.cases[0].candidates, now, 'he', 'evidence');
  assert.equal(result.recommendation.state, 'ready');
  assert.ok(result.recommendation.explanation?.summary.length);
  assert.ok((result.recommendation.explanation?.summary.length || 0) <= 160);
  assert.equal(result.recommendation.persistence.occurred, false);
});

test('baseline: comparison interface cannot mutate or replace baseline evidence', () => {
  const baseline = selectBaselineNextStep(fixture.cases[0].candidates, now, 'en', 'compare');
  const comparison = compareVariantSelection(baseline, 'today');
  assert.equal(comparison.sameSelection, false);
  assert.equal(comparison.baselineCommitmentId, 'overdue');
  assert.deepEqual(comparison.baselineEvidenceLabels, ['overdue', 'importance: normal']);
});
