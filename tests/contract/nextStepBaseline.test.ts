import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compareVariantSelection,
  candidatesFromDomainState,
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
  const base: BaselineCandidate = { commitmentId: 'x', title: 'X', confirmed: true, status: 'active', dueAt: null, remindAt: null, importance: 'high', importanceIsStated: true, explicitEffortMinutes: null };
  assert.equal(scoreBaselineCandidate({ ...base, confirmed: false }, now).exclusionReason, 'not_confirmed');
  assert.equal(scoreBaselineCandidate({ ...base, status: 'completed' }, now).exclusionReason, 'closed');
  assert.equal(scoreBaselineCandidate({ ...base, dueAt: 'not-a-date' }, now).exclusionReason, 'invalid_time');
});

/**
 * ── A contract UC-2.9 (#170) deliberately changed ────────────────
 *
 * This used to read "inferred importance is unavailable and cannot influence
 * selection", and it was true of the caller: `candidatesFromDomainState` passed
 * `importance: null` for anything the user had not stated, so an extractor that
 * was confident something mattered contributed exactly nothing.
 *
 * #170 decided that a read importance should count, at half weight, and the
 * shape of that decision is what keeps it safe: every guessed band sits
 * strictly below its stated counterpart, so a guess can help order two items
 * and can never outrank something the person actually said.
 *
 * What has *not* changed, and is the reason the old rule existed: no importance
 * at all is still no evidence at all, and a `default` priority is not an
 * estimate. Both are pinned below.
 */
test('baseline: no importance is still no evidence, whatever the source', () => {
  const result = selectBaselineNextStep([
    { commitmentId: 'inferred', title: 'Inferred', confirmed: true, status: 'active', dueAt: null, remindAt: null, importance: null, importanceIsStated: false, explicitEffortMinutes: null },
  ], now, 'ar', 'insufficient');
  assert.equal(result.selectedCommitmentId, null);
  assert.equal(result.recommendation.state, 'insufficient_evidence');
});

test('baseline: a stated importance always outranks the same level guessed', () => {
  const base = {
    title: 'X', confirmed: true as const, status: 'active' as const,
    dueAt: null, remindAt: null, explicitEffortMinutes: null,
  };
  const result = selectBaselineNextStep([
    { ...base, commitmentId: 'guessed', importance: 'high' as const, importanceIsStated: false },
    { ...base, commitmentId: 'stated', importance: 'normal' as const, importanceIsStated: true },
  ], now, 'en', 'weighting');
  // A guessed Must does not beat a stated Should. What the person said wins.
  assert.equal(result.selectedCommitmentId, 'stated');
});

test('baseline: every recommendation has concise evidence and no persistence', () => {
  const result = selectBaselineNextStep(fixture.cases[0].candidates, now, 'he', 'evidence');
  assert.equal(result.recommendation.state, 'ready');
  assert.ok(result.recommendation.explanation?.summary.length);
  assert.ok((result.recommendation.explanation?.summary.length || 0) <= 160);
  assert.equal(result.recommendation.persistence.occurred, false);
});

/**
 * "Baseline evidence" is what `selectBaselineNextStep` computed: the selection
 * and each score's evidence codes and labels. Nothing here is frozen: the
 * fixture pins candidates and the expected id, and the labels come from the
 * live label table on every run.
 *
 * The lateness label once read "overdue". #383 stopped the product saying that
 * word (onboarding promises there is no "overdue"); the evidence *code* kept its
 * name and the label became "waiting since its time passed" (0e12e5d6). This
 * test was outside `npm test`, so it kept expecting the old word until #376.
 */
test('baseline: comparison interface cannot mutate or replace baseline evidence', () => {
  const baseline = selectBaselineNextStep(fixture.cases[0].candidates, now, 'en', 'compare');
  const before = structuredClone(baseline);
  const comparison = compareVariantSelection(baseline, 'today');
  assert.deepEqual(baseline, before, 'comparing a variant changed the baseline selection');
  assert.equal(comparison.sameSelection, false);
  assert.equal(comparison.baselineCommitmentId, 'overdue');
  const selected = baseline.scores.find((score) => score.commitmentId === 'overdue');
  assert.deepEqual(selected?.evidenceCodes.map((evidence) => evidence.code), ['overdue', 'importance']);
  assert.deepEqual(comparison.baselineEvidenceLabels, selected?.evidenceLabels);
  assert.deepEqual(comparison.baselineEvidenceLabels, ['waiting since its time passed', 'importance: normal']);
});

test('baseline: a meeting\'s prep step is late after the meeting starts, not at the hour it is shown at (FX1)', () => {
  // Shown at 14:00, done by the 15:00 start (`deadlineOfTimeSpec`). At 14:30
  // the person is preparing on time; the card must not say «الوقت مرق».
  const prep = {
    id: 'prep', kind: 'task', title: 'Prep', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-09-28T11:00:00.000Z', endAt: '2026-09-28T12:00:00.000Z', remindAt: '2026-09-28T11:00:00.000Z', allDay: false, timezone: 'Asia/Amman' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '', updatedAt: '', confirmedAt: '2026-09-27T11:50:00.000Z', completedAt: null, droppedAt: null,
  };
  const [candidate] = candidatesFromDomainState({ commitments: { prep }, reminders: {} } as never);
  const codes = (at: string) => scoreBaselineCandidate(candidate!, new Date(at)).evidenceCodes.map((entry) => entry.code);
  assert.ok(!codes('2026-09-28T11:30:00.000Z').includes('overdue'));
  assert.ok(codes('2026-09-28T12:01:00.000Z').includes('overdue'));
});
