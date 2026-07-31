import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { validateAnnotationPolicyRegistry } from '../../lib/calibration/policy.ts';
import { validateAdjudications } from '../../lib/calibration/adjudication.ts';
import { validateGoldFreezeManifest } from '../../lib/calibration/goldFreeze.ts';
import { gateAuthorizesFreeze, gateAuthorizesTraining } from '../../lib/calibration/gate.ts';
import { canonicalJson, checksumOf } from '../../lib/evaluation/registry/fingerprint.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const CALIBRATION_DIR = path.join(repoRoot, 'data/calibration');

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(CALIBRATION_DIR, name), 'utf8')) as T;
}

function readJsonl<T>(name: string): T[] {
  return readFileSync(path.join(CALIBRATION_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

const policies = readJson<any>('annotation-policy.json');
const adjudications = readJsonl<any>('adjudications.jsonl');
const gateReport = readJson<any>('consistency-gate-report.json');
const freeze = readJson<any>('capture-gold-freeze.json');

/** The three disagreements the blind pass actually produced. */
const DISAGREED = [
  'pilot-v4-review-arabic-003',
  'pilot-v4-review-hebrew-039',
  'pilot-v4-review-ambiguous-029',
];

test('evidence: the shipped annotation policy validates', () => {
  const result = validateAnnotationPolicyRegistry(policies);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('evidence: the policy records the mid-round guideline change that caused the disagreement', () => {
  const v2 = policies.policies.find((policy: any) => policy.version === '2.0.0');
  assert.ok(v2, 'policy 2.0.0 must exist');
  assert.equal(v2.supersedes, '1.0.0');

  const multi = v2.changedRules.find((rule: any) => rule.ruleId === 'MULTI-001');
  assert.ok(multi, 'the separation rule must be recorded');
  assert.ok(multi.affects.includes('decision'));

  // It became effective between the first pass (2026-07-28T23:56 to
  // 2026-07-29T00:43) and the blind second pass (2026-07-29T02:15 to 02:17).
  const effective = Date.parse(v2.effectiveFrom);
  assert.ok(effective > Date.parse('2026-07-29T00:43:12Z'));
  assert.ok(effective < Date.parse('2026-07-29T02:15:53Z'));
});

test('evidence: the shipped adjudications validate against the policy and the real disagreements', () => {
  const result = validateAdjudications(adjudications, {
    policies,
    disagreedSourceIds: DISAGREED,
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('evidence: every disagreement is adjudicated, and nothing else is', () => {
  const decisionAdjudications = adjudications
    .filter((record) => record.dimension === 'decision')
    .map((record) => record.sourceQueueId)
    .sort();

  assert.deepEqual(decisionAdjudications, [...DISAGREED].sort());
  assert.deepEqual(gateReport.unadjudicatedDisagreements, []);
});

test('evidence: two disagreements are a guideline change, one is reviewer noise', () => {
  assert.deepEqual(gateReport.classification, {
    agreement: 7,
    policy_shift: 2,
    tooling_defect: 0,
    reviewer_noise: 1,
  });
});

test('evidence: the multi-commitment dimensions are measurable now, and were not before', () => {
  // The original instrument read completion.segments and
  // completion.commitmentCount, which the review completion has never carried.
  for (const dimension of gateReport.perItemAgreement) {
    assert.equal(dimension.measurable, true, `${dimension.dimension} must be measurable`);
    assert.ok(dimension.compared > 0, `${dimension.dimension} must have comparisons`);
  }

  const names = gateReport.perItemAgreement.map((d: any) => d.dimension).sort();
  assert.deepEqual(names, ['boundary', 'commitment_count', 'date_time', 'slots']);
});

test('evidence: the gate passes its threshold, provisionally, with every proviso stated', () => {
  assert.equal(gateReport.status, 'pass_provisional');
  assert.deepEqual(gateReport.failures, []);

  assert.equal(gateReport.rawDecisionAgreement.rate, 0.7);
  assert.equal(gateReport.policyNormalizedDecisionAgreement.rate, 0.875);
  assert.ok(
    gateReport.policyNormalizedDecisionAgreement.rate >=
      gateReport.thresholds.minPolicyNormalizedDecisionAgreement,
  );

  // Nothing here may be read as a final result at n=8.
  assert.equal(gateReport.policyNormalizedDecisionAgreement.underpowered, true);
  assert.ok(gateReport.provisos.some((proviso: string) => proviso.includes('below the 30 needed')));
  assert.ok(gateReport.provisos.some((proviso: string) => proviso.includes('need re-annotation')));
});

test('evidence: a provisional gate authorizes the freeze but not training', () => {
  assert.equal(gateAuthorizesFreeze(gateReport), true);
  assert.equal(gateAuthorizesTraining(gateReport), false);
});

test('evidence: the shipped freeze manifest validates and cites its gate', () => {
  const result = validateGoldFreezeManifest(freeze, { gateReport });
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  assert.equal(freeze.gateReportId, gateReport.reportId);
  assert.equal(freeze.policyVersion, '2.1.0');
});

test('evidence: the freeze covers all 50 decisions and excludes only the defective one', () => {
  assert.equal(freeze.records.length, 50);
  assert.equal(freeze.includedCount, 49);
  assert.equal(freeze.excludedCount, 1);

  const excluded = freeze.records.filter((record: any) => record.excluded);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].sourceQueueId, 'pilot-v4-review-hebrew-039');
  assert.match(excluded[0].exclusionReason, /CAL-002/);
});

test('evidence: the freeze records checksum covers its own records', () => {
  assert.deepEqual(freeze.recordsChecksum, checksumOf(canonicalJson(freeze.records)));
});

test('evidence: no training is started anywhere in this issue', () => {
  assert.equal(freeze.trainingStarted, false);
  assert.equal(gateAuthorizesTraining(gateReport), false);
});

test('evidence: canonical human decisions are traceable, not rewritten', () => {
  // The freeze points at decisions by checksum. It stores no completion text,
  // no reviewer identity, and no edited decision value of its own.
  const serialized = JSON.stringify(freeze);
  assert.ok(!serialized.includes('reviewer_id'));
  assert.ok(!serialized.includes('"completion"'));

  for (const record of freeze.records) {
    assert.match(record.decisionChecksum.value, /^[0-9a-f]{64}$/);
    assert.ok(['first', 'second', 'neither'].includes(record.canonicalPass));
  }

  // Adjudicated sources point at the second pass; everything else stays first.
  const secondPass = freeze.records
    .filter((record: any) => record.canonicalPass === 'second')
    .map((record: any) => record.sourceQueueId)
    .sort();
  assert.deepEqual(secondPass, ['pilot-v4-review-ambiguous-029', 'pilot-v4-review-hebrew-039']);
});

test('evidence: the gate report pins the checksum of every input it read', () => {
  const names = gateReport.inputs.map((input: any) => input.name).sort();
  assert.deepEqual(names, [
    'consistency-10-manifest',
    'consistency-second-pass',
    'gold-decisions',
    'per-item-gold',
  ]);

  for (const input of gateReport.inputs) {
    assert.match(input.checksum.value, /^[0-9a-f]{64}$/);
  }
});
