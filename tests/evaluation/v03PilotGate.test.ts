import test from 'node:test';
import assert from 'node:assert/strict';
import { buildV03GateReport, validateV03GateInput, type V03GateInput } from '../../lib/evaluation/v03PilotGate.ts';

function input(overrides: Partial<V03GateInput> = {}): V03GateInput {
  return {
    schemaVersion: 'v1', reviewedAt: '2026-10-11T09:00:00.000Z', candidateSha: 'a'.repeat(40),
    dependencies: { issue54Complete: true, issue55Complete: true, issue56Complete: true },
    interviews: { total: 30, commercial: 20, fastResearch: 10, recurringWeeklyPainWithConcreteCost: 22 },
    pilot: { qualifiedUsers: 30, activatedUsers: 12, repeatedRecommendationUsers: 20, repeatedAcceptanceUsers: 8, repeatedCompletionUsers: 6, correctionUsers: 3, invasiveFeedbackUsers: 2, trustPrivacyObjectionUsers: 3 },
    experiment: { assignmentIntegrityPassed: true, baselineUsers: 10, contextualUsers: 10, personalizedUsers: 10, medianLatencyMs: 120, p95LatencyMs: 300, averageCostCents: 0.4 },
    operations: { criticalReliabilityIncidents: 0, criticalSafetyIncidents: 0, privacyIncidents: 0, unresolvedIncidents: 0, rollbackVerified: true, ownerRecorded: true },
    competitive: { completedComparisons: 20, existingWorkflowPreferred: 5 },
    acceptedLimitations: [], evidenceRefs: ['https://github.com/anasakkari3/maybesitter/issues/54'],
    ...overrides,
  };
}

test('V03 gate: current incomplete dependencies fail closed to HOLD', () => {
  const report = buildV03GateReport(input({ dependencies: { issue54Complete: false, issue55Complete: false, issue56Complete: false } }));
  assert.equal(report.decision, 'HOLD');
  assert.equal(report.pilotExposureMayContinue, false);
  assert.equal(report.blockers.length, 3);
});

test('V03 gate: complete safe evidence can record GO', () => {
  const report = buildV03GateReport(input());
  assert.equal(report.decision, 'GO');
  assert.equal(report.metrics.activationRate, 0.4);
  assert.equal(report.metrics.repeatedAcceptanceRate, 0.4);
  assert.equal(report.metrics.repeatedCompletionRate, 0.3);
});

test('V03 gate: behavioral misses produce CONDITIONAL GO with explicit changes', () => {
  const report = buildV03GateReport(input({ pilot: { ...input().pilot, activatedUsers: 6, repeatedAcceptanceUsers: 5, repeatedCompletionUsers: 4 } }));
  assert.equal(report.decision, 'CONDITIONAL GO');
  assert.equal(report.conditions.length, 3);
});

test('V03 gate: trust, safety, privacy, and assignment failures require HOLD', () => {
  const base = input();
  const report = buildV03GateReport(input({
    pilot: { ...base.pilot, invasiveFeedbackUsers: 8, trustPrivacyObjectionUsers: 10 },
    experiment: { ...base.experiment, assignmentIntegrityPassed: false },
    operations: { ...base.operations, privacyIncidents: 1, unresolvedIncidents: 1 },
  }));
  assert.equal(report.decision, 'HOLD');
  assert.ok(report.blockers.length >= 4);
});

test('V03 gate: weak recurring pain or overwhelming existing-workflow preference produces PIVOT', () => {
  assert.equal(buildV03GateReport(input({ interviews: { total: 30, commercial: 20, fastResearch: 10, recurringWeeklyPainWithConcreteCost: 11 } })).decision, 'PIVOT');
  assert.equal(buildV03GateReport(input({ competitive: { completedComparisons: 20, existingWorkflowPreferred: 14 } })).decision, 'PIVOT');
});

test('V03 gate: invalid denominators, SHAs, and unsafe evidence fail validation', () => {
  const invalid = input({ candidateSha: 'short', interviews: { total: 30, commercial: 30, fastResearch: 10, recurringWeeklyPainWithConcreteCost: 31 }, evidenceRefs: ['artifact://raw/transcript'] });
  const errors = validateV03GateInput(invalid);
  assert.ok(errors.some((error) => /candidateSha/.test(error)));
  assert.ok(errors.some((error) => /cohort/.test(error)));
  assert.ok(errors.some((error) => /pain count/.test(error)));
  assert.ok(errors.some((error) => /privacy-safe/.test(error)));
});
