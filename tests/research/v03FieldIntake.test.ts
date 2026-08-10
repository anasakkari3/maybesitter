import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFieldworkStatus,
  handoffBlockers,
  parseCsv,
  parseInterviewTracker,
  parseRecruitmentTracker,
  requiredDoubleCodedInterviews,
  trackerTemplate,
  INTERVIEW_TRACKER_COLUMNS,
  RECRUITMENT_TRACKER_COLUMNS,
} from '../../lib/research/v03FieldIntake.ts';

/**
 * Every fixture below is synthetic. Synthetic rows exercise the intake rules and must never be
 * submitted as #54 evidence; the coded artifact may contain real consented interviews only.
 */

type Cells = Record<string, string>;

function pad(index: number): string {
  return String(index).padStart(3, '0');
}

function interviewLine(index: number, overrides: Cells = {}): string {
  const commercial = index % 2 === 1;
  const cells: Cells = {
    interview_id: `int-${pad(index)}`,
    sample_inclusion: 'sample',
    cohort: commercial ? 'commercial' : 'fast_research',
    interview_language: commercial ? 'en' : 'mixed',
    cohort_eligibility_confirmed: 'yes',
    occurred_at: '2026-09-14T09:00:00Z',
    research_consent_recorded: 'yes',
    adult_confirmed: 'yes',
    past_behavior_example: 'yes',
    recurring_weekly_pain: 'yes',
    concrete_cost: 'yes',
    current_workflows: 'calendar|notes',
    abandoned_tool: 'yes',
    paid_for_related_tool: commercial ? 'yes' : 'no',
    privacy_boundary: 'yes',
    switching_pain: 'medium',
    preferred_baseline: 'current_workflow',
    competitive_comparison_completed: 'yes',
    evidence_ref: `research://v03/int-${pad(index)}`,
    primary_coder: 'coder-a',
    second_coder: '',
    second_coder_pain_qualified: '',
    adjudicated: 'no',
    ...overrides,
  };
  return INTERVIEW_TRACKER_COLUMNS.map((column) => cells[column]).join(',');
}

function recruitmentLine(index: number, overrides: Cells = {}): string {
  const cells: Cells = {
    candidate_id: `cand-${pad(index)}`,
    cohort: index % 2 === 1 ? 'commercial' : 'fast_research',
    source_channel: index % 2 === 1 ? 'adhd_community' : 'university_board',
    screened_at: '2026-09-10T09:00:00Z',
    screener_outcome: 'qualified',
    adult_confirmed: 'yes',
    cohort_eligibility_confirmed: 'yes',
    research_consent_recorded: 'yes',
    screener_pain_signal: 'yes',
    linked_interview_id: `int-${pad(index)}`,
    pilot_contact_consent_recorded: 'yes',
    pilot_status: 'accepted',
    withdrawn_at: '',
    deletion_completed: '',
    ...overrides,
  };
  return RECRUITMENT_TRACKER_COLUMNS.map((column) => cells[column]).join(',');
}

function csv(columns: readonly string[], lines: readonly string[]): string {
  return `${columns.join(',')}\n${lines.join('\n')}\n`;
}

function interviewCsv(lines: readonly string[]): string {
  return csv(INTERVIEW_TRACKER_COLUMNS, lines);
}

function recruitmentCsv(lines: readonly string[]): string {
  return csv(RECRUITMENT_TRACKER_COLUMNS, lines);
}

function parsedInterviews(lines: readonly string[]) {
  const result = parseInterviewTracker(interviewCsv(lines));
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
  return result.rows;
}

function parsedRecruitment(lines: readonly string[]) {
  const result = parseRecruitmentTracker(recruitmentCsv(lines));
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
  return result.rows;
}

test('V03 intake: CSV parsing handles quoted cells, doubled quotes, and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,1","he said ""no"""\r\n'), [['a', 'b'], ['x,1', 'he said "no"']]);
});

test('V03 intake: committed CSV templates match the column definitions', () => {
  assert.equal(
    readFileSync('docs/research/v03/templates/interview-evidence-tracker.template.csv', 'utf8'),
    trackerTemplate('interview'),
  );
  assert.equal(
    readFileSync('docs/research/v03/templates/recruitment-tracker.template.csv', 'utf8'),
    trackerTemplate('recruitment'),
  );
});

test('V03 intake: a drifted header is rejected before any row is read', () => {
  const result = parseInterviewTracker('interview_id,cohort\nint-001,commercial\n');
  assert.equal(result.rows.length, 0);
  assert.match(result.issues[0].message, /header must be exactly/);
});

test('V03 intake: cells that look like direct identifiers are rejected', () => {
  const result = parseInterviewTracker(interviewCsv([interviewLine(1, { primary_coder: 'anas@example.com' })]));
  assert.ok(result.issues.some((issue) => /direct identifier/.test(issue.message)), JSON.stringify(result.issues));
  assert.equal(result.rows.length, 0);
});

test('V03 intake: consent, adult confirmation, and cohort eligibility are required to code an interview', () => {
  const missingConsent = parseInterviewTracker(interviewCsv([interviewLine(1, { research_consent_recorded: 'no' })]));
  assert.ok(missingConsent.issues.some((issue) => /research consent must be recorded/.test(issue.message)));
  const missingAdult = parseInterviewTracker(interviewCsv([interviewLine(1, { adult_confirmed: 'no' })]));
  assert.ok(missingAdult.issues.some((issue) => /adult confirmation is required/.test(issue.message)));
  const commercialUnpaid = parseInterviewTracker(interviewCsv([interviewLine(1, { paid_for_related_tool: 'no' })]));
  assert.ok(commercialUnpaid.issues.some((issue) => /paid-tool behavior/.test(issue.message)));
});

test('V03 intake: rehearsal interviews are excluded from the sample and the coded artifact', () => {
  const rows = parsedInterviews([
    interviewLine(1, { sample_inclusion: 'rehearsal' }),
    interviewLine(2),
  ]);
  const status = buildFieldworkStatus(rows, []);
  assert.equal(status.intake.interviewRowsRead, 2);
  assert.equal(status.intake.rehearsalRowsExcluded, 1);
  assert.equal(status.progress.interviews.sample, 1);
  assert.equal(status.report.interviewSample.total, 1);
});

test('V03 intake: an interviewed participant only becomes a pilot candidate through the handoff rules', () => {
  const interviews = parsedInterviews([
    interviewLine(1),
    interviewLine(3, { recurring_weekly_pain: 'no' }),
    interviewLine(5, { sample_inclusion: 'rehearsal' }),
  ]);
  const noInterview = parsedRecruitment([recruitmentLine(7, { linked_interview_id: '' })])[0];
  assert.deepEqual(handoffBlockers(noInterview, interviews), ['no linked interview']);

  const noPain = parsedRecruitment([recruitmentLine(3)])[0];
  assert.deepEqual(handoffBlockers(noPain, interviews), ['linked interview is not behaviorally pain-qualified']);

  const rehearsalOnly = parsedRecruitment([recruitmentLine(5)])[0];
  assert.deepEqual(handoffBlockers(rehearsalOnly, interviews), ['linked interview is a rehearsal and carries no evidence']);

  const noContactConsent = parsedRecruitment([recruitmentLine(1, { pilot_contact_consent_recorded: 'no' })])[0];
  assert.deepEqual(handoffBlockers(noContactConsent, interviews), ['separate pilot-contact consent not recorded']);

  const cohortMismatch = parsedRecruitment([recruitmentLine(1, { candidate_id: 'cand-100', cohort: 'fast_research' })])[0];
  assert.deepEqual(handoffBlockers(cohortMismatch, interviews), ['linked interview cohort does not match the candidate cohort']);

  assert.deepEqual(handoffBlockers(parsedRecruitment([recruitmentLine(1)])[0], interviews), []);
});

test('V03 intake: a candidate parked at accepted without a valid handoff is withheld, not counted', () => {
  const interviews = parsedInterviews([interviewLine(1), interviewLine(3, { concrete_cost: 'no' })]);
  const recruitment = parsedRecruitment([recruitmentLine(1), recruitmentLine(3)]);
  const status = buildFieldworkStatus(interviews, recruitment);
  assert.deepEqual(status.handoff.blockedFromAccept, [
    { candidateId: 'cand-003', reasons: ['linked interview is not behaviorally pain-qualified'] },
  ]);
  assert.ok(status.blockers.some((blocker) => /cand-003/.test(blocker) && /withheld/.test(blocker)));
  assert.equal(status.funnel.accepted, 1);
  assert.equal(status.funnel.acceptedWithUnmetHandoff, 1);
  assert.equal(status.funnel.painQualified, 1);
  assert.equal(status.decisionReadiness.ready, false);
});

test('V03 intake: qualified, not-yet-invited candidates surface as ready to invite', () => {
  const interviews = parsedInterviews([interviewLine(1)]);
  const recruitment = parsedRecruitment([recruitmentLine(1, { pilot_status: 'not_invited' })]);
  const status = buildFieldworkStatus(interviews, recruitment);
  assert.deepEqual(status.handoff.readyToInvite, ['cand-001']);
  assert.deepEqual(status.handoff.blockedFromAccept, []);
});

test('V03 intake: unadjudicated double-coding disagreements block the evidence', () => {
  const disagreeing = parsedInterviews([interviewLine(1, { second_coder: 'coder-b', second_coder_pain_qualified: 'no' })]);
  const blocked = buildFieldworkStatus(disagreeing, []);
  assert.equal(blocked.coding.disagreements, 1);
  assert.equal(blocked.coding.unadjudicatedDisagreements, 1);
  assert.ok(blocked.blockers.some((blocker) => /not adjudicated/.test(blocker)));

  const resolved = parsedInterviews([
    interviewLine(1, { second_coder: 'coder-b', second_coder_pain_qualified: 'no', adjudicated: 'yes' }),
  ]);
  assert.equal(buildFieldworkStatus(resolved, []).coding.unadjudicatedDisagreements, 0);
});

test('V03 intake: a second coder needs its own independent judgement', () => {
  const missingJudgement = parseInterviewTracker(interviewCsv([interviewLine(1, { second_coder: 'coder-b' })]));
  assert.ok(missingJudgement.issues.some((issue) => /independent pain judgement/.test(issue.message)));
  const sameCoder = parseInterviewTracker(interviewCsv([
    interviewLine(1, { second_coder: 'coder-a', second_coder_pain_qualified: 'yes' }),
  ]));
  assert.ok(sameCoder.issues.some((issue) => /must differ from the primary coder/.test(issue.message)));
});

test('V03 intake: a bilingual-heavy sample cannot carry an overall pass on its own', () => {
  const lines = Array.from({ length: 30 }, (_, offset) => interviewLine(offset + 1, {
    cohort: 'fast_research', paid_for_related_tool: 'no', interview_language: 'mixed',
  }));
  const status = buildFieldworkStatus(parsedInterviews(lines), []);
  assert.equal(status.report.problemEvidence.decision, 'success');
  assert.equal(status.cohortIntegrity.commercialInterviews, 0);
  assert.equal(status.cohortIntegrity.commercialCohortUnderpowered, true);
  assert.equal(status.decisionReadiness.ready, false);
  assert.ok(status.decisionReadiness.unmetRequirements.some((item) => /bilingual student cohort dominates/.test(item)));
});

test('V03 intake: 30 interviews at exactly 70% qualified pain reach the success threshold', () => {
  const lines = Array.from({ length: 30 }, (_, offset) => {
    const index = offset + 1;
    const doubleCoded: Cells = index <= 6
      ? { second_coder: 'coder-b', second_coder_pain_qualified: index <= 21 ? 'yes' : 'no' }
      : {};
    return interviewLine(index, index <= 21 ? doubleCoded : { ...doubleCoded, concrete_cost: 'no' });
  });
  const status = buildFieldworkStatus(parsedInterviews(lines), []);
  assert.equal(status.report.problemEvidence.qualifiedPainCount, 21);
  assert.equal(status.report.problemEvidence.rate, 0.7);
  assert.equal(status.report.problemEvidence.decision, 'success');
  assert.equal(status.cohortIntegrity.commercialInterviews, 15);
  assert.equal(status.coding.doubleCoded, 6);
  assert.equal(status.coding.agreementRate, 1);
  assert.equal(status.coding.doubleCodingBelowMinimum, false);
  assert.deepEqual(status.blockers, []);
  assert.deepEqual(status.decisionReadiness.unmetRequirements, [
    'Closed-pilot cohort holds 0 of the required 25 accepted participants.',
  ]);
  assert.ok(status.nextActions.some((action) => /25 more qualified candidates/.test(action)));
});

test('V03 intake: marginal rates separate recurring pain from concrete cost', () => {
  const interviews = parsedInterviews([
    interviewLine(1),
    interviewLine(2, { concrete_cost: 'no' }),
    interviewLine(3, { recurring_weekly_pain: 'no' }),
    interviewLine(4, { recurring_weekly_pain: 'no', concrete_cost: 'no' }),
  ]);
  const { overall, commercial, fastResearch, cohortDifferences } = buildFieldworkStatus(interviews, []).rates;
  assert.equal(overall.denominator, 4);
  assert.equal(overall.recurringWeeklyPainRate, 0.5);
  assert.equal(overall.concreteCostRate, 0.5);
  assert.equal(overall.qualifiedPainRate, 0.25);
  assert.equal(commercial.qualifiedPainRate, 0.5);
  assert.equal(fastResearch.qualifiedPainRate, 0);
  assert.equal(cohortDifferences.qualifiedPain, 0.5);
  assert.equal(cohortDifferences.paidForRelatedTool, 1);
});

test('V03 intake: rates and differences stay null rather than guessing an empty denominator', () => {
  const { overall, cohortDifferences } = buildFieldworkStatus([], []).rates;
  assert.equal(overall.denominator, 0);
  assert.equal(overall.qualifiedPainRate, null);
  assert.equal(cohortDifferences.qualifiedPain, null);
});

test('V03 intake: a skipped competitive block is excluded from the comparison denominator', () => {
  const interviews = parsedInterviews([
    interviewLine(1),
    interviewLine(2, { preferred_baseline: 'chatgpt_calendar' }),
    interviewLine(3, { competitive_comparison_completed: 'no' }),
  ]);
  const { competitive } = buildFieldworkStatus(interviews, []);
  assert.equal(competitive.completedComparisons, 2);
  assert.equal(competitive.existingWorkflowPreferred, 1);
  assert.equal(competitive.existingWorkflowPreferenceRate, 0.5);
  assert.deepEqual(competitive.baselineCounts, { current_workflow: 1, chatgpt_calendar: 1, chatgpt_todoist: 0 });
  assert.equal(competitive.belowGateMinimum, true);
});

test('V03 intake: a sample dominated by the founder network is not reportable', () => {
  const interviews = parsedInterviews([interviewLine(1), interviewLine(2)]);
  const recruitment = parsedRecruitment([
    recruitmentLine(1, { source_channel: 'personal_network' }),
    recruitmentLine(2, { source_channel: 'university_board' }),
  ]);
  const status = buildFieldworkStatus(interviews, recruitment);
  assert.equal(status.cohortIntegrity.personalNetworkInterviews, 1);
  assert.equal(status.cohortIntegrity.personalNetworkShare, 0.5);
  assert.equal(status.cohortIntegrity.personalNetworkOverRepresented, true);
  assert.ok(status.decisionReadiness.unmetRequirements.some((item) => /personal network/.test(item)));
});

test('V03 intake: double-coding requires 20% of the sample with an absolute floor of 6', () => {
  assert.equal(requiredDoubleCodedInterviews(0), 6);
  assert.equal(requiredDoubleCodedInterviews(10), 6);
  assert.equal(requiredDoubleCodedInterviews(30), 6);
  assert.equal(requiredDoubleCodedInterviews(35), 7);
  assert.equal(requiredDoubleCodedInterviews(40), 8);

  const lines = Array.from({ length: 35 }, (_, offset) => {
    const index = offset + 1;
    const doubleCoded: Cells = index <= 6
      ? { second_coder: 'coder-b', second_coder_pain_qualified: 'yes' }
      : {};
    return interviewLine(index, doubleCoded);
  });
  const status = buildFieldworkStatus(parsedInterviews(lines), []);
  assert.equal(status.coding.doubleCoded, 6);
  assert.equal(status.coding.required, 7);
  assert.equal(status.coding.doubleCodingBelowMinimum, true);
  assert.ok(status.decisionReadiness.unmetRequirements.some((item) => /7 are required/.test(item)));
  assert.ok(status.nextActions.some((action) => /Double-code 1 more/.test(action)));
});

test('V03 intake: cohort recruitment targets are planning actions, never gates on the rates', () => {
  const lines = Array.from({ length: 30 }, (_, offset) => interviewLine(offset + 1));
  const status = buildFieldworkStatus(parsedInterviews(lines), []);
  assert.deepEqual(status.progress.cohortTargets.commercial,
    { interviews: 15, minimum: 20, maximum: 25, remainingToMinimum: 5 });
  assert.deepEqual(status.progress.cohortTargets.fastResearch,
    { interviews: 15, minimum: 10, maximum: 15, remainingToMinimum: 0 });
  assert.ok(status.nextActions.some((action) => /5 more commercial-cohort/.test(action)));
  // Being off-target changes no measured value: 15 commercial clears the readiness floor of 15,
  // and every rate is computed from the coded rows alone.
  assert.equal(status.cohortIntegrity.commercialCohortUnderpowered, false);
  assert.equal(status.rates.overall.qualifiedPainRate, 1);
  assert.equal(status.report.problemEvidence.decision, 'success');
});

test('V03 intake: an oversized sample invalidates the decision window', () => {
  const lines = Array.from({ length: 41 }, (_, offset) => interviewLine(offset + 1, {
    second_coder: 'coder-b', second_coder_pain_qualified: 'yes',
  }));
  const status = buildFieldworkStatus(parsedInterviews(lines), []);
  assert.equal(status.progress.interviews.stopScheduling, true);
  assert.equal(status.report.problemEvidence.decision, 'insufficient_sample');
  assert.ok(status.blockers.some((blocker) => /exceeds 40/.test(blocker)));
});

test('V03 intake: withdrawal must be timestamped and never silently accepted', () => {
  const missingTime = parseRecruitmentTracker(recruitmentCsv([recruitmentLine(1, { pilot_status: 'withdrawn' })]));
  assert.ok(missingTime.issues.some((issue) => /records the time|record the time/.test(issue.message)));

  const interviews = parsedInterviews([interviewLine(1)]);
  const withdrawn = parsedRecruitment([
    recruitmentLine(1, { pilot_status: 'withdrawn', withdrawn_at: '2026-09-20T12:00:00Z', deletion_completed: 'yes' }),
  ]);
  const status = buildFieldworkStatus(interviews, withdrawn);
  assert.equal(status.funnel.withdrawn, 1);
  assert.equal(status.funnel.accepted, 0);
  assert.ok(status.handoff.blockedFromAccept.some((entry) => entry.reasons.includes('participant withdrew')));
});

test('V03 intake: candidates without research consent stay out of the coded artifact', () => {
  const interviews = parsedInterviews([interviewLine(1)]);
  const recruitment = parsedRecruitment([
    recruitmentLine(1),
    recruitmentLine(9, {
      screener_outcome: 'declined', research_consent_recorded: 'no', linked_interview_id: '',
      pilot_contact_consent_recorded: 'no', pilot_status: 'not_invited',
    }),
  ]);
  const status = buildFieldworkStatus(interviews, recruitment);
  assert.equal(status.funnel.screened, 2);
  assert.equal(status.report.recruitment.qualifiedAndContactConsented, 1);
});
