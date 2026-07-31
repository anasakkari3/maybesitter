import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDecisionPairs,
  classificationCounts,
  policyNormalizedDecisionAgreement,
  rawDecisionAgreement,
  unadjudicatedDisagreements,
} from '../../lib/calibration/consistency.ts';
import { computePerItemAgreement, findRepeatAnnotations } from '../../lib/calibration/perItemAgreement.ts';
import {
  DEFAULT_GATE_THRESHOLDS,
  evaluateConsistencyGate,
  gateAuthorizesFreeze,
  gateAuthorizesTraining,
} from '../../lib/calibration/gate.ts';
import { wilsonInterval } from '../../lib/calibration/wilson.ts';
import { adjudication, clone, decision, perItem, target } from './calibrationFixtures.ts';

const BLIND = ['src-a', 'src-b', 'src-c', 'src-d'];

function pairs(secondDecisions: readonly string[]) {
  return buildDecisionPairs(
    BLIND.map((id) => decision(id, 'accepted')),
    BLIND.map((id, index) => decision(id, secondDecisions[index])),
    BLIND,
  );
}

function gate(overrides: Partial<Parameters<typeof evaluateConsistencyGate>[0]> = {}) {
  return evaluateConsistencyGate({
    reportId: 'test-gate',
    createdAt: '2026-07-31T00:00:00.000Z',
    inputs: [],
    pairs: pairs(['accepted', 'accepted', 'accepted', 'accepted']),
    adjudications: [],
    perItemAnnotations: [perItem('src-a'), perItem('src-a')],
    ...overrides,
  });
}

test('gate: raw agreement counts every blind item', () => {
  const result = rawDecisionAgreement(pairs(['accepted', 'rejected', 'accepted', 'edited']), 30);
  assert.equal(result.matches, 2);
  assert.equal(result.compared, 4);
  assert.equal(result.rate, 0.5);
  assert.equal(result.measurable, true);
});

test('gate: a policy_shift disagreement is excluded, not counted as agreement', () => {
  const withShift = pairs(['accepted', 'rejected', 'accepted', 'accepted']);
  const adjudications = [
    adjudication({
      sourceQueueId: 'src-b',
      classification: 'policy_shift',
      firstPassPolicy: '1.0.0',
      secondPassPolicy: '2.0.0',
      canonicalPass: 'second',
    }),
  ];

  const raw = rawDecisionAgreement(withShift, 30);
  const normalized = policyNormalizedDecisionAgreement(withShift, adjudications, 30);

  assert.equal(raw.rate, 0.75, 'raw penalises the reviewer for a guideline change');
  assert.equal(normalized.matches, 3);
  assert.equal(normalized.compared, 3, 'the policy-shift item leaves the denominator');
  assert.equal(normalized.rate, 1);
});

test('gate: reviewer_noise stays in the denominator and lowers the rate', () => {
  const withNoise = pairs(['accepted', 'edited', 'accepted', 'accepted']);
  const adjudications = [adjudication({ sourceQueueId: 'src-b', classification: 'reviewer_noise' })];

  const normalized = policyNormalizedDecisionAgreement(withNoise, adjudications, 30);
  assert.equal(normalized.matches, 3);
  assert.equal(normalized.compared, 4);
  assert.equal(normalized.rate, 0.75);
});

test('gate: an unadjudicated disagreement stays in the denominator and is reported', () => {
  const withGap = pairs(['accepted', 'rejected', 'accepted', 'accepted']);
  assert.deepEqual(unadjudicatedDisagreements(withGap, []), ['src-b']);

  const result = gate({ pairs: withGap });
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.includes('no adjudication')));
});

test('gate: classification counts split agreement from each disagreement class', () => {
  const mixed = pairs(['accepted', 'rejected', 'edited', 'accepted']);
  const counts = classificationCounts(mixed, [
    adjudication({ sourceQueueId: 'src-b', classification: 'policy_shift', firstPassPolicy: '1.0.0', secondPassPolicy: '2.0.0' }),
    adjudication({ sourceQueueId: 'src-c', classification: 'reviewer_noise' }),
  ]);

  assert.deepEqual(counts, { agreement: 2, policy_shift: 1, tooling_defect: 0, reviewer_noise: 1 });
});

test('gate: an unmeasurable dimension fails the gate instead of reporting null', () => {
  // A source annotated once yields no repeat, so the per-item dimensions have
  // nothing to compare. This is the defect that let the original instrument's
  // multi-commitment gate fail open.
  const result = gate({ perItemAnnotations: [perItem('src-a')] });

  assert.equal(result.status, 'fail');
  for (const dimension of ['commitment_count', 'boundary', 'slots', 'date_time']) {
    assert.ok(
      result.failures.some((failure) => failure.startsWith(`${dimension} agreement is unmeasurable`)),
      `${dimension} must fail loudly`,
    );
  }
  assert.ok(result.perItemAgreement.every((dimension) => dimension.rate === null));
});

test('gate: boundary agreement is measured from per-item Gold, not from the completion', () => {
  const moved = clone(perItem('src-a'));
  moved.items[1].startCodePoint = 15;

  const result = computePerItemAgreement([perItem('src-a'), moved], {
    underpoweredBelowComparisons: 30,
  });

  const boundary = result.dimensions.find((dimension) => dimension.dimension === 'boundary');
  assert.equal(boundary?.compared, 1);
  assert.equal(boundary?.rate, 0);
});

test('gate: commitment count disagreement is detected', () => {
  const single = clone(perItem('src-a'));
  single.itemCount = 1;
  single.items = [single.items[0]];

  const result = computePerItemAgreement([perItem('src-a'), single], {
    underpoweredBelowComparisons: 30,
  });

  assert.equal(result.dimensions.find((d) => d.dimension === 'commitment_count')?.rate, 0);
});

test('gate: an adjudicated date-time tooling defect is excluded from the rate and reported', () => {
  const invented = clone(perItem('src-a'));
  invented.items[1].target = target({ title: 'Send the report', dueAt: '2026-07-30T03:38:00-04:00' });

  const withoutAdjudication = computePerItemAgreement([invented, perItem('src-a')], {
    underpoweredBelowComparisons: 30,
  });
  assert.equal(withoutAdjudication.dimensions.find((d) => d.dimension === 'date_time')?.compared, 6);
  assert.ok((withoutAdjudication.dimensions.find((d) => d.dimension === 'date_time')?.rate ?? 1) < 1);

  const withAdjudication = computePerItemAgreement([invented, perItem('src-a')], {
    underpoweredBelowComparisons: 30,
    dateTimeDefectSourceIds: ['src-a'],
  });
  assert.equal(withAdjudication.excludedByDefect, 1);
  assert.equal(withAdjudication.dimensions.find((d) => d.dimension === 'date_time')?.compared, 5);
  assert.equal(withAdjudication.dimensions.find((d) => d.dimension === 'date_time')?.rate, 1);
});

test('gate: repeat annotations pair the first with the last, per source and reviewer', () => {
  const other = clone(perItem('src-a'));
  other.reviewerId = 'someone-else';

  const repeats = findRepeatAnnotations([perItem('src-a'), other, perItem('src-a'), perItem('src-b')]);
  assert.equal(repeats.length, 1, 'only same-source same-reviewer repeats compare');
  assert.equal(repeats[0].sourceQueueId, 'src-a');
  assert.equal(repeats[0].reviewerId, 'anas');
});

test('gate: a small sample passes provisionally, never finally', () => {
  const result = gate();
  assert.equal(result.status, 'pass_provisional');
  assert.ok(result.failures.length === 0);
  assert.ok(result.provisos.some((proviso) => proviso.includes('below the 30 needed')));
});

test('gate: a provisional pass authorizes a freeze but never training', () => {
  const provisional = gate();
  assert.equal(provisional.status, 'pass_provisional');
  assert.equal(gateAuthorizesFreeze(provisional), true);
  assert.equal(gateAuthorizesTraining(provisional), false);

  const failed = gate({ pairs: pairs(['accepted', 'rejected', 'accepted', 'accepted']) });
  assert.equal(failed.status, 'fail');
  assert.equal(gateAuthorizesFreeze(failed), false);
  assert.equal(gateAuthorizesTraining(failed), false);
});

test('gate: an item needing re-annotation is a proviso, not a silent pass', () => {
  const result = gate({
    adjudications: [adjudication({ sourceQueueId: 'src-a', requiresReannotation: true })],
  });

  assert.ok(result.provisos.some((proviso) => proviso.includes('need re-annotation')));
});

test('gate: agreement below the threshold fails', () => {
  const poor = pairs(['edited', 'edited', 'edited', 'accepted']);
  const result = gate({
    pairs: poor,
    adjudications: ['src-a', 'src-b', 'src-c'].map((id) =>
      adjudication({ sourceQueueId: id, classification: 'reviewer_noise' }),
    ),
  });

  assert.equal(result.status, 'fail');
  assert.ok(
    result.failures.some((failure) => failure.includes('policy-normalized decision agreement')),
  );
});

test('gate: thresholds are explicit and conservative', () => {
  assert.equal(DEFAULT_GATE_THRESHOLDS.minPolicyNormalizedDecisionAgreement, 0.85);
  assert.equal(DEFAULT_GATE_THRESHOLDS.underpoweredBelowComparisons, 30);
  assert.equal(DEFAULT_GATE_THRESHOLDS.requireEveryDisagreementAdjudicated, true);
});

test('wilson: intervals bracket the point estimate and widen as n shrinks', () => {
  const small = wilsonInterval(1, 1);
  const large = wilsonInterval(100, 100);
  assert.ok(small !== null && large !== null);
  assert.ok(small[0] < large[0], 'a single observation must not look certain');

  const half = wilsonInterval(5, 10);
  assert.ok(half !== null && half[0] < 0.5 && half[1] > 0.5);

  assert.equal(wilsonInterval(0, 0), null);
  assert.equal(wilsonInterval(3, 2), null);
});
