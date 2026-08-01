import test from 'node:test';
import assert from 'node:assert/strict';
import { buildV03GateReport, validateV03GateInput, type V03GateInput } from '../../lib/evaluation/v03PilotGate.ts';

function input(overrides: Partial<V03GateInput> = {}): V03GateInput {
  return {
    schemaVersion: 'v1', reviewedAt: '2026-10-11T09:00:00.000Z', candidateSha: 'a'.repeat(40),
    dependencies: { issue54Complete: true, issue55Complete: true, issue56Complete: true },
    interviews: { total: 30, commercial: 20, fastResearch: 10, recurringWeeklyPainWithConcreteCost: 22 },
    pilot: { qualifiedUsers: 30, activatedUsers: 12, recommendationShownUsers: 12, acceptedRecommendationUsers: 5, completedRecommendationUsers: 4, repeatedRecommendationUsers: 10, repeatedAcceptanceUsers: 4, repeatedCompletionUsers: 3, correctionUsers: 2, invasivenessResponseUsers: 10, invasiveFeedbackUsers: 2, trustPrivacyObjectionUsers: 3 },
    experiment: { assignmentIntegrityPassed: true, baselineUsers: 4, contextualUsers: 4, personalizedUsers: 4, medianLatencyMs: 120, p95LatencyMs: 300, averageCostCents: 0.4 },
    operations: { criticalReliabilityIncidents: 0, criticalSafetyIncidents: 0, privacyIncidents: 0, unresolvedIncidents: 0, rollbackVerified: true, ownerRecorded: true },
    competitive: { completedComparisons: 20, existingWorkflowPreferred: 5 },
    acceptedLimitations: [], evidenceRefs: ['https://github.com/anasakkari3/maybesitter/issues/54'],
    evidenceChecksums: {
      researchSha256: 'a'.repeat(64), pilotSha256: 'b'.repeat(64), experimentSha256: 'c'.repeat(64),
      operationsSha256: 'd'.repeat(64), competitiveSha256: 'e'.repeat(64),
    },
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
  assert.equal(report.metrics.earlyAcceptanceRate, 5 / 12);
});

test('V03 gate: behavioral misses produce CONDITIONAL GO with explicit changes', () => {
  const report = buildV03GateReport(input({ pilot: {
    ...input().pilot, activatedUsers: 6, recommendationShownUsers: 6,
    acceptedRecommendationUsers: 2, completedRecommendationUsers: 1,
    repeatedRecommendationUsers: 5, repeatedAcceptanceUsers: 1, repeatedCompletionUsers: 1,
    correctionUsers: 1, invasivenessResponseUsers: 4, invasiveFeedbackUsers: 0,
  }, experiment: { ...input().experiment, baselineUsers: 2, contextualUsers: 2, personalizedUsers: 2 } }));
  assert.equal(report.decision, 'CONDITIONAL GO');
  assert.ok(report.conditions.length >= 3);
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

test('V03 gate: missing or unsafe evidence takes HOLD precedence over a pivot signal', () => {
  const report = buildV03GateReport(input({
    dependencies: { issue54Complete: false, issue55Complete: true, issue56Complete: true },
    interviews: { total: 30, commercial: 20, fastResearch: 10, recurringWeeklyPainWithConcreteCost: 5 },
  }));
  assert.equal(report.decision, 'HOLD');
  assert.match(report.blockers.join(' '), /#54/);
});

test('V03 gate: absent repeated behavior or an empty experiment arm requires HOLD', () => {
  const report = buildV03GateReport(input({
    pilot: {
      ...input().pilot, repeatedRecommendationUsers: 0, repeatedAcceptanceUsers: 0,
      repeatedCompletionUsers: 0,
    },
    experiment: { ...input().experiment, baselineUsers: 0, contextualUsers: 6, personalizedUsers: 6 },
  }));
  assert.equal(report.decision, 'HOLD');
  assert.ok(report.blockers.some((blocker) => /Every experiment arm/.test(blocker)));
  assert.ok(report.blockers.some((blocker) => /Repeated recommendation/.test(blocker)));
});

test('V03 gate: latency, cost, correction, and response coverage affect the decision', () => {
  const conditional = buildV03GateReport(input({
    pilot: { ...input().pilot, correctionUsers: 4, invasivenessResponseUsers: 5, invasiveFeedbackUsers: 1 },
    experiment: { ...input().experiment, medianLatencyMs: 1_000, p95LatencyMs: 2_500, averageCostCents: 2 },
  }));
  assert.equal(conditional.decision, 'CONDITIONAL GO');
  assert.ok(conditional.conditions.some((condition) => /latency/.test(condition)));
  assert.ok(conditional.conditions.some((condition) => /cost/.test(condition)));
  assert.ok(conditional.conditions.some((condition) => /correction/.test(condition)));

  const hold = buildV03GateReport(input({ experiment: { ...input().experiment, medianLatencyMs: 2_000, p95LatencyMs: 5_001, averageCostCents: 0.4 } }));
  assert.equal(hold.decision, 'HOLD');
});

test('V03 gate: invalid denominators, SHAs, and unsafe evidence fail validation', () => {
  const invalid = input({ candidateSha: 'short', interviews: { total: 30, commercial: 30, fastResearch: 10, recurringWeeklyPainWithConcreteCost: 31 }, evidenceRefs: ['artifact://raw/transcript'] });
  const errors = validateV03GateInput(invalid);
  assert.ok(errors.some((error) => /candidateSha/.test(error)));
  assert.ok(errors.some((error) => /cohort/.test(error)));
  assert.ok(errors.some((error) => /pain count/.test(error)));
  assert.ok(errors.some((error) => /privacy-safe/.test(error)));
});
