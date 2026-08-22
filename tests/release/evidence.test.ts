/**
 * The go/hold/rollback evidence package: three pillars always, the engagement
 * rule enforced by the shape of the input, and the three asymmetries #43's
 * rollback gate is built on, each with its own test.
 *
 * The engagement enumeration is the load-bearing one:
 * `SHADOW_ENGAGEMENT_MEASURE_CLASSES` is walked against the generator's *actual
 * inputs*, not against its output, because the claim is that a go resting on
 * engagement is unrepresentable rather than rejected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONALIZATION_INVARIANTS,
  SHADOW_ENGAGEMENT_MEASURE_CLASSES,
  SHADOW_EVIDENCE_PILLARS,
  SHADOW_MEASURE_CLASSES,
  SHADOW_PIPELINE_LIMITS,
  SHADOW_RELEASE_GATE_INVARIANT,
  MIN_SLO_SAMPLE_COUNT,
  SHADOW_STUDY_RATING_SCALE,
  checkShadowEvidencePackage,
  type ShadowEvidencePillar,
  type ShadowSloReading,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  PACKAGE_ENFORCED_INVARIANTS,
  SHADOW_AUTHORISING_PROVENANCES,
  SHADOW_JUDGEMENT_MEASURE_CLASSES,
  SHADOW_STUDY_EVIDENCE_POLICY,
  buildEvidencePackage,
  mergePillarSources,
  qualityPillarFromEvaluationReport,
  qualityPillarFromStudy,
  reliabilityPillarFromSloReadings,
  safetyPillarFromObservations,
  unavailablePillarSource,
  type ShadowEvidenceProvenance,
  type ShadowFindingDisposition,
  type ShadowPillarSource,
} from '../../lib/release/evidence.ts';
import { summarizeStudyResponses } from '../../lib/release/study.ts';
import type { PersonalizationEvaluationReport } from '../../lib/evaluation/personalization/report.ts';

const ASSEMBLED_AT = '2027-01-17T09:00:00.000Z';
const PACKAGE_ID = 'shadow-release-2027-01-17';

function source(
  disposition: ShadowFindingDisposition,
  provenance: ShadowEvidenceProvenance = 'real_exposure',
  pillar: ShadowEvidencePillar = 'quality',
): ShadowPillarSource {
  return {
    provenance,
    findings: [
      {
        measureClass: pillar === 'safety' ? 'safety_outcome' : pillar === 'reliability' ? 'reliability_signal' : 'user_judgement',
        disposition,
        citation: `fixture.${disposition}.${pillar}`,
        sloReading: null,
      },
    ],
    engagementContext: [],
  };
}

function sourcesAll(
  disposition: ShadowFindingDisposition,
  provenance: ShadowEvidenceProvenance = 'real_exposure',
): Record<ShadowEvidencePillar, ShadowPillarSource> {
  return {
    quality: source(disposition, provenance, 'quality'),
    safety: source(disposition, provenance, 'safety'),
    reliability: source(disposition, provenance, 'reliability'),
  };
}

function build(sources: Record<ShadowEvidencePillar, ShadowPillarSource>) {
  const outcome = buildEvidencePackage({ packageId: PACKAGE_ID, assembledAt: ASSEMBLED_AT, stage: 'closed_pilot', sources });
  assert.equal(outcome.status, 'assembled', `the package was refused: ${JSON.stringify(outcome)}`);
  if (outcome.status !== 'assembled') throw new Error('unreachable');
  return outcome;
}

/* ── All three pillars, or the package does not exist ────────────── */

test('a package always carries every pillar, and each pillar carries at least one item', () => {
  const outcome = build(sourcesAll('benefit'));
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const bundle = outcome.package.evidence[pillar];
    assert.ok(bundle.length >= 1, `${pillar} carried no evidence`);
    // (pillar, item.pillar) pairs: every item names the pillar it sits under.
    for (const item of bundle) assert.equal(item.pillar, pillar);
  }
  assert.deepEqual(checkShadowEvidencePackage(outcome.package), []);
  assert.equal(outcome.package.decision, 'go');
});

test('an unavailable pillar is an honest "not available" item, never a missing pillar', () => {
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const sources = sourcesAll('benefit');
    const outcome = build({ ...sources, [pillar]: unavailablePillarSource('issue_46_slo_readings') });
    assert.deepEqual(outcome.unavailablePillars, [pillar]);
    const bundle = outcome.package.evidence[pillar];
    assert.equal(bundle.length, 1);
    assert.equal(bundle[0].support, 'inconclusive');
    assert.match(bundle[0].citation, /^not_available\./, `${pillar} did not say what was missing`);
    assert.ok(bundle[0].citation.includes('issue_46_slo_readings'), 'the citation does not name the owner of the missing input');
    assert.equal(outcome.package.decision, 'hold', 'an unavailable pillar authorised a release');
    assert.deepEqual(checkShadowEvidencePackage(outcome.package), []);
  }
});

test('a wired pillar that found nothing is told apart from a pillar nobody wired', () => {
  const empty: ShadowPillarSource = { provenance: 'real_exposure', findings: [], engagementContext: [] };
  const wired = build({ ...sourcesAll('benefit'), safety: empty });
  const unwired = build({ ...sourcesAll('benefit'), safety: unavailablePillarSource('issue_45_traces') });
  assert.equal(wired.package.evidence.safety[0].citation, 'no_findings.safety');
  assert.match(unwired.package.evidence.safety[0].citation, /^not_available\./);
  assert.deepEqual(wired.unavailablePillars, []);
  assert.deepEqual(unwired.unavailablePillars, ['safety']);
});

/* ── The engagement rule, enumerated against the generator's inputs ── */

test('the invariant this generator enforces is the contract\'s, by name', () => {
  assert.equal(SHADOW_RELEASE_GATE_INVARIANT, 'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE');
  assert.ok((PERSONALIZATION_INVARIANTS as readonly string[]).includes(SHADOW_RELEASE_GATE_INVARIANT));
  assert.deepEqual([...PACKAGE_ENFORCED_INVARIANTS], [SHADOW_RELEASE_GATE_INVARIANT]);
});

test('no engagement class is expressible on a finding — the only input that can argue', () => {
  // Enumerated, pair by pair: for every engagement class, assert it is absent
  // from the class set a finding may declare.
  for (const engagementClass of SHADOW_ENGAGEMENT_MEASURE_CLASSES) {
    assert.equal(
      (SHADOW_JUDGEMENT_MEASURE_CLASSES as readonly string[]).includes(engagementClass),
      false,
      `${engagementClass} can be declared on a finding, which can carry a disposition`,
    );
  }
  // And nothing was quietly dropped on the way: the two channels partition the
  // vocabulary rather than sampling it.
  for (const measureClass of SHADOW_MEASURE_CLASSES) {
    const inJudgement = (SHADOW_JUDGEMENT_MEASURE_CLASSES as readonly string[]).includes(measureClass);
    const inEngagement = (SHADOW_ENGAGEMENT_MEASURE_CLASSES as readonly string[]).includes(measureClass);
    assert.equal(inJudgement !== inEngagement, true, `${measureClass} is in both channels or in neither`);
  }
});

test('every engagement class reaching a package arrives as inconclusive context, in every pillar', () => {
  const withContext = (pillar: ShadowEvidencePillar): ShadowPillarSource => ({
    provenance: 'real_exposure',
    findings: [],
    engagementContext: SHADOW_ENGAGEMENT_MEASURE_CLASSES.map((measureClass) => ({
      citation: `engagement.${measureClass}`,
      sloReading: null,
    })),
  });
  const outcome = build({
    quality: withContext('quality'),
    safety: withContext('safety'),
    reliability: withContext('reliability'),
  });

  // (pillar, measureClass) pairs, not a deduplicated set of classes.
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    for (const measureClass of SHADOW_ENGAGEMENT_MEASURE_CLASSES) {
      const items = outcome.package.evidence[pillar].filter((item) => item.measureClass === measureClass);
      assert.equal(items.length, 1, `${pillar}/${measureClass} produced ${items.length} items`);
      assert.equal(items[0].support, 'inconclusive', `${pillar}/${measureClass} argued for something`);
    }
  }
  assert.notEqual(outcome.package.decision, 'go', 'a package of engagement alone authorised a release');
  assert.equal(outcome.package.decision, 'hold');
  assert.deepEqual(checkShadowEvidencePackage(outcome.package), []);
});

test('adding engagement context to a go package changes neither the decision nor the support', () => {
  const plain = build(sourcesAll('benefit'));
  const sources = sourcesAll('benefit');
  const withContext = build({
    quality: { ...sources.quality, engagementContext: [{ citation: 'engagement.sessions', sloReading: null }] },
    safety: { ...sources.safety, engagementContext: [{ citation: 'engagement.opens', sloReading: null }] },
    reliability: { ...sources.reliability, engagementContext: [{ citation: 'engagement.latency', sloReading: null }] },
  });
  assert.equal(plain.package.decision, 'go');
  assert.equal(withContext.package.decision, 'go');
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const goItems = withContext.package.evidence[pillar].filter((item) => item.support === 'go');
    assert.equal(goItems.length, 1);
    assert.equal(goItems[0].measureClass !== 'engagement', true, 'a go rests on an engagement item');
  }
  assert.deepEqual(checkShadowEvidencePackage(withContext.package), []);
});

/* ── Asymmetry 1: any harm alone refuses ─────────────────────────── */

test('a single harm in any one pillar rolls the release back', () => {
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const outcome = build({ ...sourcesAll('benefit'), [pillar]: source('harm', 'real_exposure', pillar) });
    assert.equal(outcome.package.decision, 'rollback', `a harm in ${pillar} did not roll back`);
    assert.ok(outcome.rationale.some((line) => line.startsWith(`${pillar}:`)), `${pillar}'s harm is not in the rationale`);
  }
});

test('a single concern in any one pillar holds', () => {
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const outcome = build({ ...sourcesAll('benefit'), [pillar]: source('concern', 'real_exposure', pillar) });
    assert.equal(outcome.package.decision, 'hold', `a concern in ${pillar} did not hold`);
  }
});

/* ── Asymmetry 2: no amount of benefit outvotes a harm ───────────── */

test('no quantity of benefit outvotes one harm, in any pillar', () => {
  const manyBenefits = SHADOW_PIPELINE_LIMITS.maxEvidenceItemsPerPillar - 1;
  for (const harmPillar of SHADOW_EVIDENCE_PILLARS) {
    const sources = {} as Record<ShadowEvidencePillar, ShadowPillarSource>;
    for (const pillar of SHADOW_EVIDENCE_PILLARS) {
      const measureClass = pillar === 'safety' ? 'safety_outcome' as const : pillar === 'reliability' ? 'reliability_signal' as const : 'user_judgement' as const;
      const benefits = Array.from({ length: manyBenefits }, (_unused, index) => ({
        measureClass,
        disposition: 'benefit' as const,
        citation: `fixture.benefit.${index}`,
        sloReading: null,
      }));
      sources[pillar] = {
        provenance: 'real_exposure',
        findings: pillar === harmPillar
          ? [...benefits, { measureClass, disposition: 'harm' as const, citation: 'fixture.harm', sloReading: null }]
          : benefits,
        engagementContext: [],
      };
    }
    const outcome = build(sources);
    assert.equal(
      outcome.package.decision,
      'rollback',
      `${manyBenefits} benefits outvoted one harm in ${harmPillar}`,
    );
  }
});

/* ── Asymmetry 3: non-real evidence refuses but never authorises ─── */

test('evidence that is not from real exposure cannot authorise a release', () => {
  const outcome = build(sourcesAll('benefit', 'simulated'));
  assert.equal(outcome.package.decision, 'hold');
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    for (const item of outcome.package.evidence[pillar]) {
      assert.notEqual(item.support, 'go', `a simulated benefit in ${pillar} argued for going`);
      assert.equal(item.support, 'inconclusive');
    }
  }
});

test('evidence that is not from real exposure can still refuse a release', () => {
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const outcome = build({ ...sourcesAll('benefit', 'simulated'), [pillar]: source('harm', 'simulated', pillar) });
    assert.equal(outcome.package.decision, 'rollback', `a simulated harm in ${pillar} was ignored`);
  }
});

test('the authorising provenance list is exactly the one real-exposure entry', () => {
  assert.deepEqual([...SHADOW_AUTHORISING_PROVENANCES], ['real_exposure']);
});

test('one non-real pillar is enough to stop a go, even beside two real ones', () => {
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const outcome = build({ ...sourcesAll('benefit'), [pillar]: source('benefit', 'simulated', pillar) });
    assert.equal(outcome.package.decision, 'hold', `a simulated ${pillar} pillar still authorised a go`);
  }
});

/* ── Asymmetry 4: an inconclusive reading is not a pass ──────────── */

function reading(status: 'measured' | 'inconclusive', breached = false): ShadowSloReading {
  return status === 'measured'
    ? {
        status: 'measured',
        sloId: 'pipeline-latency',
        value: 1,
        sampleCount: MIN_SLO_SAMPLE_COUNT,
        breached,
        inconclusiveReason: null,
        windowStart: '2027-01-16T09:00:00.000Z',
        observedAt: ASSEMBLED_AT,
      }
    : {
        status: 'inconclusive',
        sloId: 'pipeline-latency',
        value: null,
        sampleCount: 3,
        breached: null,
        inconclusiveReason: 'insufficient_sample',
        windowStart: '2027-01-16T09:00:00.000Z',
        observedAt: ASSEMBLED_AT,
      };
}

test('a benefit resting on an inconclusive reading is downgraded, and never trips the contract\'s defect', () => {
  const sources = sourcesAll('benefit');
  const outcome = build({
    ...sources,
    reliability: {
      provenance: 'real_exposure',
      findings: [{ measureClass: 'reliability_signal', disposition: 'benefit', citation: 'slo.latency', sloReading: reading('inconclusive') }],
      engagementContext: [],
    },
  });
  assert.equal(outcome.package.evidence.reliability[0].support, 'inconclusive');
  assert.equal(outcome.package.decision, 'hold');
  assert.deepEqual(
    checkShadowEvidencePackage(outcome.package).filter((defect) => defect.code === 'EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO'),
    [],
  );
});

/* ── Wiring: #43's evaluation report ─────────────────────────────── */

function reportWith(
  provenance: PersonalizationEvaluationReport['provenance'],
  readings: PersonalizationEvaluationReport['overall']['readings'],
): PersonalizationEvaluationReport {
  return {
    provenance,
    syntheticSeed: provenance === 'synthetic' ? 'seed-1' : null,
    generatedAt: ASSEMBLED_AT,
    memberCount: 30,
    overall: { sliceId: 'overall', memberCount: 30, readings },
    slices: [],
  };
}

const CLEAN_READINGS: PersonalizationEvaluationReport['overall']['readings'] = [
  { metric: 'usefulness', kind: 'measured', personalized: 0.9, baseline: 0.5, delta: 0.4, memberCount: 30 },
  { metric: 'stability', kind: 'measured', personalized: 0.9, baseline: 0.9, delta: 0, memberCount: 30 },
  { metric: 'overfitting', kind: 'measured', personalized: 0, baseline: 0, delta: 0, memberCount: 30 },
  { metric: 'unfair_pressure', kind: 'measured', personalized: 0, baseline: 0, delta: 0, memberCount: 30 },
  { metric: 'cold_start_invention', kind: 'measured', personalized: 0, baseline: 0, delta: 0, memberCount: 30 },
];

test('a real-logged report that keeps becomes a benefit the quality pillar can authorise on', () => {
  const pillar = qualityPillarFromEvaluationReport(reportWith('real_logged', CLEAN_READINGS));
  assert.equal(pillar.provenance, 'real_exposure');
  assert.deepEqual(pillar.findings.map((finding) => finding.disposition), ['benefit']);
  const outcome = build({ ...sourcesAll('benefit'), quality: pillar });
  assert.equal(outcome.package.decision, 'go');
});

test('a synthetic report is carried through as simulated, and cannot authorise', () => {
  const pillar = qualityPillarFromEvaluationReport(reportWith('synthetic', CLEAN_READINGS));
  assert.equal(pillar.provenance, 'simulated');
  const outcome = build({ ...sourcesAll('benefit'), quality: pillar });
  assert.equal(outcome.package.decision, 'hold', 'a synthetic quality report authorised a release');
});

test('a harm found in a synthetic report still rolls the release back', () => {
  const poisoned = reportWith('synthetic', [
    ...CLEAN_READINGS.filter((entry) => entry.metric !== 'unfair_pressure'),
    { metric: 'unfair_pressure', kind: 'measured', personalized: 0.6, baseline: 0, delta: 0.6, memberCount: 30 },
  ]);
  const pillar = qualityPillarFromEvaluationReport(poisoned);
  assert.deepEqual(pillar.findings.map((finding) => finding.disposition), ['harm']);
  assert.deepEqual(pillar.findings.map((finding) => finding.citation), ['evaluation_gate.harm.unfair_pressure']);
  const outcome = build({ ...sourcesAll('benefit'), quality: pillar });
  assert.equal(outcome.package.decision, 'rollback');
});

/* ── Wiring: the study ───────────────────────────────────────────── */

test('the study evidence policy derives its line from the scale, and the scale is pinned', () => {
  assert.equal(SHADOW_STUDY_RATING_SCALE.minimum, 1);
  assert.equal(SHADOW_STUDY_RATING_SCALE.maximum, 5);
  assert.equal(SHADOW_STUDY_EVIDENCE_POLICY.neutralRating, 3);
  assert.equal(
    SHADOW_STUDY_EVIDENCE_POLICY.neutralRating,
    (SHADOW_STUDY_RATING_SCALE.minimum + SHADOW_STUDY_RATING_SCALE.maximum) / 2,
  );
  assert.equal(SHADOW_STUDY_EVIDENCE_POLICY.minimumRespondents, MIN_SLO_SAMPLE_COUNT);
  assert.equal(MIN_SLO_SAMPLE_COUNT, 20);
  assert.deepEqual([...SHADOW_STUDY_EVIDENCE_POLICY.costQuestions], ['intrusiveness']);
});

function studyPillarFor(question: 'helpfulness' | 'intrusiveness', rating: number, respondents: number) {
  const responses = Array.from({ length: respondents }, (_unused, index) => ({
    status: 'rated' as const,
    participantId: `participant-${index}`,
    runId: null,
    question,
    rating,
    respondedAt: ASSEMBLED_AT,
  }));
  return qualityPillarFromStudy(summarizeStudyResponses(responses), 'real_exposure');
}

test('a study below the respondent floor reads inconclusive, one side of the floor at a time', () => {
  const floor = SHADOW_STUDY_EVIDENCE_POLICY.minimumRespondents;
  const above = SHADOW_STUDY_RATING_SCALE.maximum;
  for (const [respondents, expected] of [[floor - 1, 'inconclusive'], [floor, 'benefit']] as const) {
    const pillar = studyPillarFor('helpfulness', above, respondents);
    const finding = pillar.findings.find((entry) => entry.citation.endsWith('.helpfulness'));
    assert.ok(finding);
    assert.equal(finding.disposition, expected, `${respondents} respondents read as ${finding.disposition}`);
  }
});

test('the neutral rating is probed one side at a time, from the constant', () => {
  const floor = SHADOW_STUDY_EVIDENCE_POLICY.minimumRespondents;
  const neutral = SHADOW_STUDY_EVIDENCE_POLICY.neutralRating;
  const cases: [number, ShadowFindingDisposition][] = [
    [neutral - 1, 'concern'],
    [neutral, 'inconclusive'],
    [neutral + 1, 'benefit'],
  ];
  for (const [rating, expected] of cases) {
    const pillar = studyPillarFor('helpfulness', rating, floor);
    const finding = pillar.findings.find((entry) => entry.citation.endsWith('.helpfulness'));
    assert.ok(finding);
    assert.equal(finding.disposition, expected, `a mean of ${rating} read as ${finding.disposition}`);
  }
});

test('the cost question is read in the opposite direction to the benefit questions', () => {
  const floor = SHADOW_STUDY_EVIDENCE_POLICY.minimumRespondents;
  const neutral = SHADOW_STUDY_EVIDENCE_POLICY.neutralRating;
  const intrusive = studyPillarFor('intrusiveness', neutral + 1, floor).findings.find((entry) => entry.citation.endsWith('.intrusiveness'));
  const helpful = studyPillarFor('helpfulness', neutral + 1, floor).findings.find((entry) => entry.citation.endsWith('.helpfulness'));
  assert.ok(intrusive && helpful);
  assert.equal(helpful.disposition, 'benefit');
  assert.equal(intrusive.disposition, 'concern', 'a more intrusive product read as a better one');
});

test('an empty study yields inconclusive findings for every question, not an empty pillar', () => {
  const pillar = qualityPillarFromStudy(summarizeStudyResponses([]), 'real_exposure');
  assert.equal(pillar.findings.length, 5);
  for (const finding of pillar.findings) assert.equal(finding.disposition, 'inconclusive');
  const outcome = build({ ...sourcesAll('benefit'), quality: pillar });
  assert.equal(outcome.package.decision, 'hold');
});

test('merging two sources keeps the weaker provenance', () => {
  const real = source('benefit', 'real_exposure');
  const simulated = source('benefit', 'simulated');
  assert.equal(mergePillarSources(real, real).provenance, 'real_exposure');
  assert.equal(mergePillarSources(real, simulated).provenance, 'simulated');
  assert.equal(mergePillarSources(real, simulated).findings.length, 2);
});

/* ── Wiring: the safety and reliability seams ────────────────────── */

test('safety observations map to findings, and an incident is a harm on its own', () => {
  const withIncident = safetyPillarFromObservations({ runCount: 10_000, blockedCount: 3, incidentCount: 1 }, 'real_exposure');
  assert.equal(withIncident.findings[0].disposition, 'harm');

  const noRuns = safetyPillarFromObservations({ runCount: 0, blockedCount: 0, incidentCount: 0 }, 'real_exposure');
  assert.deepEqual(noRuns.findings.map((entry) => entry.citation), ['safety.no_runs_observed']);

  for (const [runCount, expected] of [[MIN_SLO_SAMPLE_COUNT - 1, 'inconclusive'], [MIN_SLO_SAMPLE_COUNT, 'benefit']] as const) {
    const pillar = safetyPillarFromObservations({ runCount, blockedCount: 0, incidentCount: 0 }, 'real_exposure');
    assert.equal(pillar.findings[0].disposition, expected, `${runCount} runs read as ${pillar.findings[0].disposition}`);
  }
});

test('SLO readings map to findings, and the reading travels with the item', () => {
  const pillar = reliabilityPillarFromSloReadings(
    [reading('measured', false), reading('measured', true), reading('inconclusive')],
    'real_exposure',
  );
  assert.deepEqual(pillar.findings.map((entry) => entry.disposition), ['benefit', 'harm', 'inconclusive']);
  for (const finding of pillar.findings) assert.notEqual(finding.sloReading, null);
  const outcome = build({ ...sourcesAll('benefit'), reliability: pillar });
  assert.equal(outcome.package.decision, 'rollback');
});

/* ── Limits and refusals ─────────────────────────────────────────── */

test('a pillar over its item cap is reported, one side of the cap at a time', () => {
  const cap = SHADOW_PIPELINE_LIMITS.maxEvidenceItemsPerPillar;
  assert.equal(cap, 32);
  for (const [count, shouldReport] of [[cap, false], [cap + 1, true]] as const) {
    const findings = Array.from({ length: count }, (_unused, index) => ({
      measureClass: 'user_judgement' as const,
      disposition: 'benefit' as const,
      citation: `fixture.benefit.${index}`,
      sloReading: null,
    }));
    const outcome = build({
      ...sourcesAll('benefit'),
      quality: { provenance: 'real_exposure', findings, engagementContext: [] },
    });
    assert.equal(
      outcome.defects.some((defect) => defect.code === 'EVIDENCE_EXCEEDS_LIMIT' && defect.limitName === 'maxEvidenceItemsPerPillar'),
      shouldReport,
      `${count} items against a cap of ${cap}`,
    );
  }
});

test('every refusal is reachable and none of them throws', () => {
  const sources = sourcesAll('benefit');
  const cases: [Record<string, unknown>, string][] = [
    [{ packageId: 'Not A Code' }, 'unsafe_package_id'],
    [{ assembledAt: '2026-02-30' }, 'malformed_instant'],
    [{ stage: 'general_availability' }, 'unknown_stage'],
    [{ sources: { quality: sources.quality, safety: sources.safety } }, 'missing_pillar_source'],
    [
      { sources: { ...sources, safety: { ...unavailablePillarSource('issue_45'), findings: sources.safety.findings } } },
      'unavailable_source_carries_findings',
    ],
  ];
  for (const [override, reason] of cases) {
    const outcome = buildEvidencePackage({
      packageId: PACKAGE_ID,
      assembledAt: ASSEMBLED_AT,
      stage: 'closed_pilot',
      sources,
      ...override,
    } as never);
    assert.equal(outcome.status, 'refused', `${reason} was not refused`);
    if (outcome.status === 'refused') assert.equal(outcome.reason, reason);
  }
});

test('the generator is deterministic: the same sources produce the same package', () => {
  const first = build(sourcesAll('benefit'));
  const second = build(sourcesAll('benefit'));
  assert.deepEqual(first.package, second.package);
  assert.deepEqual(first.rationale, second.rationale);
});

test('one concern holds even in a pillar that also supports going', () => {
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const measureClass = pillar === 'safety' ? 'safety_outcome' as const : pillar === 'reliability' ? 'reliability_signal' as const : 'user_judgement' as const;
    const outcome = build({
      ...sourcesAll('benefit'),
      [pillar]: {
        provenance: 'real_exposure',
        findings: [
          { measureClass, disposition: 'benefit' as const, citation: 'fixture.benefit', sloReading: null },
          { measureClass, disposition: 'concern' as const, citation: 'fixture.concern', sloReading: null },
        ],
        engagementContext: [],
      },
    });
    assert.equal(outcome.package.decision, 'hold', `a concern beside a go in ${pillar} did not hold`);
    assert.equal(outcome.rationale.length, 1, 'the rationale did not name exactly the one concern');
  }
});

test('one harm holds down a package in which every pillar otherwise supports going', () => {
  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const measureClass = pillar === 'safety' ? 'safety_outcome' as const : pillar === 'reliability' ? 'reliability_signal' as const : 'user_judgement' as const;
    const outcome = build({
      ...sourcesAll('benefit'),
      [pillar]: {
        provenance: 'real_exposure',
        findings: [
          { measureClass, disposition: 'benefit' as const, citation: 'fixture.benefit', sloReading: null },
          { measureClass, disposition: 'harm' as const, citation: 'fixture.harm', sloReading: null },
        ],
        engagementContext: [],
      },
    });
    assert.equal(outcome.package.decision, 'rollback', `a harm beside a go in ${pillar} did not roll back`);
    assert.equal(outcome.rationale.length, 1);
  }
});
