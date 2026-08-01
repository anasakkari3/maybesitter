import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildV03ResearchReport,
  validateInterviewRecord,
  validateRecruitmentRecord,
  type BehavioralInterviewRecord,
  type PilotRecruitmentRecord,
} from '../../lib/research/v03BehavioralResearch.ts';

function interview(index: number, overrides: Partial<BehavioralInterviewRecord> = {}): BehavioralInterviewRecord {
  return {
    schemaVersion: 'v1', interviewId: `interview-${index}`, cohort: index % 2 ? 'commercial' : 'fast_research',
    occurredAt: '2026-09-14T09:00:00.000Z', consentRecorded: true, adultConfirmed: true,
    pastBehaviorExampleObserved: true, recurringWeeklyPain: true, concreteCostObserved: true,
    currentWorkflows: ['calendar'], abandonedToolObserved: true, paidForRelatedTool: index % 2 === 1,
    privacyBoundaryObserved: true, switchingPain: 'medium', preferredBaseline: 'current_workflow',
    evidenceRef: `research://v03/interview-${index}`, ...overrides,
  };
}

function recruit(index: number, overrides: Partial<PilotRecruitmentRecord> = {}): PilotRecruitmentRecord {
  return {
    schemaVersion: 'v1', candidateId: `candidate-${index}`, cohort: index % 2 ? 'commercial' : 'fast_research',
    screenedAt: '2026-09-14T09:00:00.000Z', adultConfirmed: true, qualified: true,
    researchConsentRecorded: true, pilotContactConsentRecorded: true, pilotStatus: 'accepted', ...overrides,
  };
}

test('V03 research: strict schemas reject identifiers, transcripts, and invalid consent', () => {
  assert.deepEqual(validateInterviewRecord(interview(1)), []);
  assert.match(validateInterviewRecord({ ...interview(1), email: 'private@example.com' })[0], /privacy-safe/);
  assert.match(validateInterviewRecord({ ...interview(1), transcript: 'raw words' })[0], /privacy-safe/);
  assert.match(validateRecruitmentRecord({ ...recruit(1), pilotContactConsentRecorded: false })[0], /contact-consented/);
});

test('V03 research: success requires 30–40 interviews and at least 70% qualified pain', () => {
  const rows = Array.from({ length: 30 }, (_, index) => interview(index, index < 21 ? {} : { concreteCostObserved: false }));
  const report = buildV03ResearchReport(rows, Array.from({ length: 25 }, (_, index) => recruit(index)));
  assert.equal(report.problemEvidence.rate, 0.7);
  assert.equal(report.problemEvidence.decision, 'success');
  assert.equal(report.recruitment.complete, true);
});

test('V03 research: fewer than 40% qualified pain is a failure signal', () => {
  const rows = Array.from({ length: 30 }, (_, index) => interview(index, index < 11 ? {} : { recurringWeeklyPain: false }));
  assert.equal(buildV03ResearchReport(rows, []).problemEvidence.decision, 'failure');
});

test('V03 research: incomplete samples cannot claim success', () => {
  const report = buildV03ResearchReport(Array.from({ length: 29 }, (_, index) => interview(index)), []);
  assert.equal(report.problemEvidence.rate, 1);
  assert.equal(report.problemEvidence.decision, 'insufficient_sample');
});

test('V03 research: commercial and fast-research evidence stays segmented', () => {
  const report = buildV03ResearchReport([
    interview(1, { cohort: 'commercial', paidForRelatedTool: true }),
    interview(2, { cohort: 'fast_research', recurringWeeklyPain: false }),
  ], []);
  assert.equal(report.cohorts.commercial.interviews, 1);
  assert.equal(report.cohorts.commercial.paidForRelatedToolCount, 1);
  assert.equal(report.cohorts.fast_research.qualifiedPainRate, 0);
  assert.match(report.limitations[0], /not global market evidence/);
});

test('V03 research: duplicate pseudonymous IDs fail closed', () => {
  assert.throws(() => buildV03ResearchReport([interview(1), interview(1)], []), /duplicate interviewId/);
});
