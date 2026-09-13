import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoldFreezeManifest,
  validateGoldFreezeManifest,
} from '../../lib/calibration/goldFreeze.ts';
import { evaluateConsistencyGate } from '../../lib/calibration/gate.ts';
import { buildDecisionPairs } from '../../lib/calibration/consistency.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';
import type { AdjudicationRecord } from '../../lib/calibration/contracts.ts';
import { adjudication, clone, decision, perItem } from './calibrationFixtures.ts';

const SOURCES = ['src-a', 'src-b', 'src-c'];

const DECISION_LINES = new Map(
  SOURCES.map((id) => [id, JSON.stringify({ source_id: id, decision: 'accepted', reviewer_id: 'anas' })]),
);

function passingGate(adjudications: readonly AdjudicationRecord[] = []) {
  return evaluateConsistencyGate({
    reportId: 'test-gate',
    createdAt: '2026-07-31T00:00:00.000Z',
    inputs: [],
    pairs: buildDecisionPairs(
      SOURCES.map((id) => decision(id, 'accepted')),
      SOURCES.map((id) => decision(id, 'accepted')),
      SOURCES,
    ),
    adjudications,
    perItemAnnotations: [perItem('src-a'), perItem('src-a')],
  });
}

function build(
  adjudications: readonly AdjudicationRecord[] = [],
  gateReport = passingGate(adjudications),
  secondPassDecisions: readonly ReturnType<typeof decision>[] = [],
) {
  return buildGoldFreezeManifest({
    freezeId: 'test-freeze',
    version: '1.0.0',
    frozenAt: '2026-07-31T00:00:00.000Z',
    frozenBy: 'model-data track',
    authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/5',
    policyVersion: '2.1.0',
    gateReport,
    inputs: [],
    decisions: SOURCES.map((id) => decision(id, 'accepted')),
    decisionLines: DECISION_LINES,
    secondPassDecisions,
    adjudications,
    perItemAnnotations: [perItem('src-a')],
  });
}

test('freeze: a manifest built from a passing gate validates', () => {
  const manifest = build();
  const result = validateGoldFreezeManifest(manifest, { decisionLines: DECISION_LINES });
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  assert.equal(manifest.includedCount, 3);
  assert.equal(manifest.excludedCount, 0);
});

test('freeze: the manifest pins decisions by checksum and copies no reviewer text', () => {
  const manifest = build();
  const serialized = JSON.stringify(manifest);

  assert.ok(!serialized.includes('reviewer_id'), 'a freeze must not copy reviewer identity');
  for (const record of manifest.records) {
    assert.match(record.decisionChecksum.value, /^[0-9a-f]{64}$/);
  }
});

test('freeze: an adjudicated source exposes the decision that actually governs', () => {
  // The field a consumer must read is canonicalDecision. firstPassDecision is
  // what the canonical file says, which for an adjudicated source is NOT the
  // decision in force — reading it would silently train on the wrong label.
  const adjudications = [
    adjudication({
      sourceQueueId: 'src-a',
      classification: 'policy_shift',
      firstPassPolicy: '1.0.0',
      secondPassPolicy: '2.0.0',
      canonicalPass: 'second',
    }),
  ];

  const manifest = buildGoldFreezeManifest({
    freezeId: 'test-freeze',
    version: '1.0.0',
    frozenAt: '2026-07-31T00:00:00.000Z',
    frozenBy: 'model-data track',
    authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/5',
    policyVersion: '2.1.0',
    gateReport: passingGate(adjudications),
    inputs: [],
    decisions: SOURCES.map((id) => decision(id, 'accepted')),
    decisionLines: DECISION_LINES,
    secondPassDecisions: [decision('src-a', 'rejected')],
    adjudications,
    perItemAnnotations: [perItem('src-a')],
  });

  const adjudicated = manifest.records.find((record) => record.sourceQueueId === 'src-a');
  assert.equal(adjudicated?.firstPassDecision, 'accepted');
  assert.equal(adjudicated?.canonicalDecision, 'rejected');

  const untouched = manifest.records.find((record) => record.sourceQueueId === 'src-b');
  assert.equal(untouched?.firstPassDecision, 'accepted');
  assert.equal(untouched?.canonicalDecision, 'accepted');
});

test('freeze: adjudicating to the second pass without supplying it is refused', () => {
  const adjudications = [
    adjudication({
      sourceQueueId: 'src-a',
      classification: 'policy_shift',
      firstPassPolicy: '1.0.0',
      secondPassPolicy: '2.0.0',
      canonicalPass: 'second',
    }),
  ];

  assert.throws(() => build(adjudications), /no second-pass decision was supplied/);
});

test('freeze: canonicalDecision must agree with canonicalPass', () => {
  const contradictory = clone(build()) as unknown as Record<string, any>;
  contradictory.records[0].canonicalDecision = 'rejected';

  const result = validateGoldFreezeManifest(contradictory);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ036'));
});

test('freeze: a record with no canonical pass must be excluded and carry no decision', () => {
  const orphan = clone(build()) as unknown as Record<string, any>;
  orphan.records[0].canonicalPass = 'neither';

  const result = validateGoldFreezeManifest(orphan);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ029'), 'canonicalDecision must be null');
  assert.ok(hasIssue(result, 'FRZ034'), 'it may not be included');
});

test('freeze: rewriting a human decision after the freeze is detected', () => {
  const manifest = build();

  const rewritten = new Map(DECISION_LINES);
  rewritten.set('src-b', JSON.stringify({ source_id: 'src-b', decision: 'rejected', reviewer_id: 'anas' }));

  const result = validateGoldFreezeManifest(manifest, { decisionLines: rewritten });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ051'));
  assert.match(
    result.issues.find((issue) => issue.code === 'FRZ051')?.message ?? '',
    /never rewritten/,
  );
});

test('freeze: deleting a frozen human decision is detected', () => {
  const manifest = build();
  const missing = new Map(DECISION_LINES);
  missing.delete('src-c');

  const result = validateGoldFreezeManifest(manifest, { decisionLines: missing });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ050'));
});

test('freeze: editing the manifest after it is sealed breaks the records checksum', () => {
  const manifest = clone(build());
  manifest.records[0].firstPassDecision = 'rejected';

  const result = validateGoldFreezeManifest(manifest, { decisionLines: DECISION_LINES });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ033'));
});

test('freeze: a source needing re-annotation is excluded with a stated reason', () => {
  const adjudications = [
    adjudication({
      sourceQueueId: 'src-a',
      dimension: 'date_time',
      classification: 'tooling_defect',
      defectId: 'CAL-002',
      requiresReannotation: true,
    }),
  ];

  const manifest = build(adjudications);
  const excluded = manifest.records.find((record) => record.sourceQueueId === 'src-a');

  assert.equal(excluded?.excluded, true);
  assert.match(excluded?.exclusionReason ?? '', /date_time defect CAL-002/);
  assert.equal(manifest.includedCount, 2);
  assert.equal(manifest.excludedCount, 1);
});

test('freeze: a decision settled at one dimension is still excluded if another is defective', () => {
  const adjudications = [
    adjudication({
      sourceQueueId: 'src-a',
      dimension: 'decision',
      classification: 'policy_shift',
      firstPassPolicy: '1.0.0',
      secondPassPolicy: '2.0.0',
      canonicalPass: 'second',
      requiresReannotation: false,
    }),
    adjudication({
      sourceQueueId: 'src-a',
      dimension: 'date_time',
      classification: 'tooling_defect',
      defectId: 'CAL-002',
      requiresReannotation: true,
    }),
  ];

  const manifest = build(adjudications, undefined, [decision('src-a', 'rejected')]);
  const record = manifest.records.find((r) => r.sourceQueueId === 'src-a');
  assert.equal(record?.canonicalPass, 'second', 'the decision adjudication still applies');
  assert.equal(record?.canonicalDecision, 'rejected');
  assert.equal(record?.excluded, true, 'the per-item defect still blocks the freeze');
});

test('freeze: an excluded record must state why', () => {
  const manifest = clone(build());
  manifest.records[0].excluded = true;
  manifest.records[0].exclusionReason = null;
  manifest.includedCount = 2;
  manifest.excludedCount = 1;

  const result = validateGoldFreezeManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ026'));
});

test('freeze: a failing gate cannot authorize a freeze', () => {
  const failing = evaluateConsistencyGate({
    reportId: 'failing-gate',
    createdAt: '2026-07-31T00:00:00.000Z',
    inputs: [],
    pairs: buildDecisionPairs(
      SOURCES.map((id) => decision(id, 'accepted')),
      SOURCES.map((id) => decision(id, 'rejected')),
      SOURCES,
    ),
    adjudications: [],
    perItemAnnotations: [perItem('src-a'), perItem('src-a')],
  });

  assert.equal(failing.status, 'fail');
  assert.throws(() => build([], failing), /consistency gate .* status is fail/);

  const manifest = build();
  const result = validateGoldFreezeManifest(manifest, { gateReport: failing });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ041'));
});

test('freeze: a freeze must cite the gate report it claims', () => {
  const manifest = build();
  const other = passingGate();
  const mismatched = { ...other, reportId: 'different-gate' };

  const result = validateGoldFreezeManifest(manifest, { gateReport: mismatched });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ040'));
});

test('freeze: freezing never starts training', () => {
  const manifest = build();
  assert.equal(manifest.trainingStarted, false);

  const tampered = clone(manifest) as unknown as Record<string, unknown>;
  tampered.trainingStarted = true;

  const result = validateGoldFreezeManifest(tampered);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'FRZ012'));
});

test('freeze: an active freeze may not claim a successor, a superseded one must', () => {
  const active = clone(build()) as unknown as Record<string, unknown>;
  active.supersededBy = 'capture-gold-freeze-v2';
  assert.ok(hasIssue(validateGoldFreezeManifest(active), 'FRZ014'));

  const superseded = clone(build()) as unknown as Record<string, unknown>;
  superseded.state = 'superseded';
  assert.ok(hasIssue(validateGoldFreezeManifest(superseded), 'FRZ013'));
});

test('freeze: the last per-item annotation of a source is the canonical one', () => {
  const first = perItem('src-a');
  const second = clone(perItem('src-a'));
  second.items[1].target = { ...second.items[1].target, title: 'Corrected title' };

  const manifest = buildGoldFreezeManifest({
    freezeId: 'test-freeze',
    version: '1.0.0',
    frozenAt: '2026-07-31T00:00:00.000Z',
    frozenBy: 'model-data track',
    authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/5',
    policyVersion: '2.1.0',
    gateReport: passingGate(),
    inputs: [],
    decisions: SOURCES.map((id) => decision(id, 'accepted')),
    decisionLines: DECISION_LINES,
    adjudications: [],
    perItemAnnotations: [first, second],
  });

  const record = manifest.records.find((r) => r.sourceQueueId === 'src-a');
  assert.equal(record?.perItemAnnotationIndex, 1, 'the append-only file resolves last-wins');
});
