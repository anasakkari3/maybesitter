/**
 * The bound, and the diversity and risk policies (Sprint 08, issue #34).
 *
 * "A small set of next actions" is a claim about a bound, so the bound is what
 * this file is about — and the assertions are written so that they fail if the
 * bound stops being *data*. A test that hard-coded `3` would keep passing
 * against a selector that had drifted from
 * `RECOMMENDATION_OPTION_POLICY.maxOptions`, which is the one thing the
 * contract exports that constant to prevent, so every cap assertion here reads
 * the constant.
 *
 * The risk policy is the acceptance criterion "the selector returns no
 * recommendation when evidence is insufficient", and it has two halves that a
 * single test would conflate: a candidate with *no* support, and a candidate
 * with support too weak to lead. Both are exercised, and both are checked to
 * produce a **withheld** recommendation carrying a stated reason with its own
 * evidence — not an offered recommendation with an empty list, which is
 * unconstructible, and not a thrown error, which a caller cannot render.
 *
 * There is also a coverage sweep. Every `SupportReasonCode` the contract names
 * must have a weight here, and every code this module can emit must be one the
 * contract names. A future code added to `recommendationContracts.ts` fails this
 * file rather than being silently unweighted by the one module that is supposed
 * to emit it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  RECOMMENDATION_CONFIDENCE_SATURATION,
  RECOMMENDATION_CONFIDENCE_WEIGHTS,
  RECOMMENDATION_DIVERSITY_POLICY,
  RECOMMENDATION_RISK_POLICY,
  applyDiversityPolicy,
  applyRiskPolicy,
  compareOptionCandidates,
  confidenceFor,
  rankOptionCandidates,
  selectRecommendation,
  type CommitmentSnapshot,
  type OptionCandidate,
  type RecommendationSelectorConfig,
  type RecommendationSelectorInput,
} from '../../lib/recommendation/index.ts';
import {
  CONFIDENCE_BAND_THRESHOLDS,
  EXCLUSION_REASON_CODES,
  RECOMMENDATION_OPTION_POLICY,
  RECOMMENDATION_ORDERING_KEYS,
  SUPPORT_REASON_CODES,
  actionKey,
  bandForConfidence,
  checkRecommendation,
  offeredOptions,
  summarizeOptionSet,
  type ExclusionReasonCode,
  type SupportReasonCode,
} from '../../src/contracts/v1/recommendationContracts.ts';
import type { Field, LifeState } from '../../src/contracts/v1/lifeStateContracts.ts';
import type { PriorityScore } from '../../src/contracts/v1/priorityContracts.ts';
import type { Plan } from '../../src/contracts/v1/planningContracts.ts';

const NOW = '2026-08-19T12:00:00.000Z';
const COMPUTED_AT = '2026-08-19T11:30:00.000Z';

function knownField<T>(value: T): Field<T> {
  return {
    known: true,
    value,
    provenance: { source: 'domain_state', derivedFrom: COMPUTED_AT, computedAt: COMPUTED_AT },
  };
}

function unknownField<T>(): Field<T> {
  return {
    known: false,
    reason: 'NO_DATA',
    provenance: { source: 'absent', derivedFrom: null, computedAt: COMPUTED_AT },
  };
}

function lifeState(): LifeState {
  return {
    version: 'life-state-v1',
    scopeId: 'scope-1',
    computedAt: COMPUTED_AT,
    inputDigest: 'life-state-digest',
    commitments: knownField({
      countsByStatus: { active: 4 },
      openCount: 4,
      overdueCount: 1,
      openCommitmentIds: [],
      overdueCommitmentIds: [],
    }),
    availability: unknownField(),
    load: knownField({ totalUrgencyScore: 9, openCount: 4, overdueCount: 1, dueSoonCount: 2, band: 'moderate' }),
    recentOutcomes: unknownField(),
  };
}

function commitment(
  commitmentId: string,
  overrides: Partial<CommitmentSnapshot> = {},
): CommitmentSnapshot {
  return {
    commitmentId,
    status: 'active',
    confirmedAt: '2026-08-18T09:00:00.000Z',
    dueAt: null,
    remindAt: null,
    importance: null,
    blockedByCommitmentIds: [],
    planItemId: null,
    decompositionProposalId: null,
    decompositionStepId: null,
    ...overrides,
  };
}

function plan(rows: readonly { itemId: string; startsAt: string; endsAt: string }[]): Plan {
  return {
    version: 'v1',
    schema: 'planning-v1',
    scopeId: 'scope-1',
    horizon: { startsAt: NOW, endsAt: '2026-08-20T00:00:00.000Z' },
    scheduled: rows.map((row) => ({
      itemId: row.itemId,
      interval: { startsAt: row.startsAt, endsAt: row.endsAt },
      reservedInterval: { startsAt: row.startsAt, endsAt: row.endsAt },
    })),
    unscheduled: [],
    constraintReasons: [],
    inputDigest: 'plan-digest-1',
  };
}

function request(overrides: Partial<RecommendationSelectorInput> = {}): RecommendationSelectorInput {
  return {
    scopeId: 'scope-1',
    recommendationId: 'rec-1',
    now: NOW,
    lifeState: lifeState(),
    commitments: [],
    priorityScores: [],
    plan: null,
    ...overrides,
  };
}

function optionCandidate(overrides: Partial<OptionCandidate> = {}): OptionCandidate {
  return {
    canonicalIndex: 0,
    commitmentId: 'c-alpha',
    action: { kind: 'do_now', commitmentId: 'c-alpha' },
    supportCodes: ['OVERDUE'],
    confidence: 0.6,
    priority: 100,
    earliestDeadlineMs: Date.parse('2026-08-18T09:00:00.000Z'),
    ...overrides,
  };
}

/* ── The bound is data, and it holds ─────────────────────────────── */

test('the cap is the contract\'s constant, not a literal in the selector', () => {
  assert.equal(RECOMMENDATION_DIVERSITY_POLICY.maxOptions, RECOMMENDATION_OPTION_POLICY.maxOptions);
  assert.equal(
    RECOMMENDATION_DIVERSITY_POLICY.minOptionsForChoice,
    RECOMMENDATION_OPTION_POLICY.minOptionsForChoice,
  );
  assert.equal(RECOMMENDATION_RISK_POLICY.minLeadConfidence, CONFIDENCE_BAND_THRESHOLDS.medium);
});

test('an offer never exceeds the cap, however many strong candidates there are', () => {
  const commitments: CommitmentSnapshot[] = [];
  const rows: { itemId: string; startsAt: string; endsAt: string }[] = [];
  for (let index = 0; index < 12; index += 1) {
    const id = `c-${String(index).padStart(2, '0')}`;
    commitments.push(
      commitment(id, {
        dueAt: '2026-08-18T09:00:00.000Z',
        importance: 'high',
        planItemId: `item-${index}`,
      }),
    );
    rows.push({
      itemId: `item-${index}`,
      startsAt: '2026-08-19T13:00:00.000Z',
      endsAt: '2026-08-19T13:10:00.000Z',
    });
  }
  const selection = selectRecommendation(request({ commitments, plan: plan(rows) }));
  assert.deepEqual(selection.defects, []);
  assert.equal(selection.recommendation.outcome, 'offered');
  if (selection.recommendation.outcome !== 'offered') return;
  const offered = offeredOptions(selection.recommendation.options);
  assert.equal(offered.length, RECOMMENDATION_OPTION_POLICY.maxOptions);
  // And `checkRecommendation` agrees, which is the reviewer's half of the check.
  assert.deepEqual(checkRecommendation(selection.recommendation), []);
  // Every one of the twelve is accounted for: offered, or excluded with a cause.
  const summary = summarizeOptionSet(selection.recommendation.options);
  const named = new Set<string>();
  for (const option of offered) named.add(option.action.commitmentId);
  for (const row of summary.excluded) named.add(row.action.commitmentId);
  assert.equal(named.size, 12);
});

test('the offer is capped by action-kind variety before it is capped by size', () => {
  // Three equally strong candidates and no plan, so every action is `do_now`.
  // Two is the answer, not three: three of one verb is a list, and
  // `maxOptionsPerActionKind` is what says so.
  const selection = selectRecommendation(
    request({
      commitments: [
        commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
        commitment('c-bravo', { dueAt: '2026-08-18T10:00:00.000Z', importance: 'high' }),
        commitment('c-charlie', { dueAt: '2026-08-18T11:00:00.000Z', importance: 'high' }),
      ],
    }),
  );
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  const offered = offeredOptions(selection.recommendation.options);
  assert.equal(offered.length, RECOMMENDATION_DIVERSITY_POLICY.maxOptionsPerActionKind);
  for (const option of offered) assert.equal(option.action.kind, 'do_now');

  const summary = summarizeOptionSet(selection.recommendation.options);
  const codes = summary.excluded.flatMap((row) => row.exclusion.map((reason) => reason.code));
  assert.deepEqual(codes, ['LOWER_RANKED']);
});

test('two actions on one commitment are never both offered', () => {
  // `do_now` and `schedule` on the same commitment pass every structural check
  // in `checkRecommendation` — the actions genuinely differ — and are still one
  // decision wearing two hats.
  const selection = selectRecommendation(
    request({
      commitments: [
        commitment('c-alpha', {
          dueAt: '2026-08-19T12:30:00.000Z',
          importance: 'high',
          planItemId: 'item-alpha',
        }),
      ],
      plan: plan([
        { itemId: 'item-alpha', startsAt: '2026-08-19T12:30:00.000Z', endsAt: '2026-08-19T12:40:00.000Z' },
      ]),
    }),
  );
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  const offered = offeredOptions(selection.recommendation.options);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].action.kind, 'schedule', 'the slot-backed action carries more support');

  const summary = summarizeOptionSet(selection.recommendation.options);
  const rejected = summary.excluded.filter((row) => row.action.kind === 'do_now');
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0].exclusion.map((reason) => reason.code), ['LOWER_RANKED']);
});

test('a quota rejection and a cap rejection carry different codes', () => {
  const quota = applyDiversityPolicy([
    optionCandidate({ commitmentId: 'c-a', action: { kind: 'do_now', commitmentId: 'c-a' } }),
    optionCandidate({
      commitmentId: 'c-a',
      action: { kind: 'schedule', commitmentId: 'c-a', slot: { startsAt: NOW, endsAt: '2026-08-19T12:30:00.000Z' } },
    }),
  ]);
  assert.deepEqual(quota.rejected.map((row) => row.code), ['LOWER_RANKED']);

  // Distinct commitments and distinct kinds, so only the size cap can bind.
  const capped = applyDiversityPolicy([
    optionCandidate({ commitmentId: 'c-a', action: { kind: 'do_now', commitmentId: 'c-a' } }),
    optionCandidate({ commitmentId: 'c-b', action: { kind: 'do_now', commitmentId: 'c-b' } }),
    optionCandidate({
      commitmentId: 'c-c',
      action: { kind: 'schedule', commitmentId: 'c-c', slot: { startsAt: NOW, endsAt: '2026-08-19T12:30:00.000Z' } },
    }),
    optionCandidate({
      commitmentId: 'c-d',
      action: { kind: 'decompose', commitmentId: 'c-d', proposalId: 'p-1' },
    }),
  ]);
  assert.equal(capped.offered.length, RECOMMENDATION_OPTION_POLICY.maxOptions);
  assert.deepEqual(capped.rejected.map((row) => row.code), ['OPTION_CAP_REACHED']);
});

/* ── Risk: when the module offers nothing ────────────────────────── */

test('an eligible candidate with no supporting evidence is not offered, and the run withholds', () => {
  // Confirmed, open, no deadline, no importance, no plan, no priority: nothing
  // to say about it at all. The pilot would offer this one; see the policy
  // header on why the strictness runs in one direction.
  const selection = selectRecommendation(request({ commitments: [commitment('c-alpha')] }));
  assert.deepEqual(selection.defects, []);
  assert.equal(selection.recommendation.outcome, 'withheld');
  if (selection.recommendation.outcome !== 'withheld') return;
  assert.deepEqual(selection.recommendation.reasons.map((reason) => reason.code), [
    'INSUFFICIENT_EVIDENCE',
  ]);
  // A refusal is a claim, so it rests on evidence like any other.
  assert.ok(selection.recommendation.reasons[0].supportedBy.length > 0);
  const cited = selection.recommendation.reasons[0].supportedBy[0];
  assert.ok(
    selection.recommendation.evidence.nodes.some((node) => node.nodeId === cited),
    'the withholding reason cites a node that is not in its own graph',
  );
});

test('being the only eligible candidate is a reason to offer and not a reason to be confident', () => {
  assert.equal(RECOMMENDATION_CONFIDENCE_WEIGHTS.ONLY_ELIGIBLE_ACTION, 0);
  assert.equal(confidenceFor(['ONLY_ELIGIBLE_ACTION']), 0);
  // So a scope whose single candidate has nothing else going for it withholds
  // rather than presenting thinness as certainty.
  const selection = selectRecommendation(request({ commitments: [commitment('c-only')] }));
  assert.equal(selection.recommendation.outcome, 'withheld');
});

test('a candidate supported only by a weak signal falls under the offer floor', () => {
  // A ten-minute planned slot and nothing else: QUICK_WIN alone is 0.1, under
  // the 0.2 offer floor.
  assert.ok(
    confidenceFor(['QUICK_WIN']) < RECOMMENDATION_RISK_POLICY.minOfferConfidence,
    'the fixture no longer exercises the offer floor',
  );
  const outcome = applyRiskPolicy([
    optionCandidate({ supportCodes: ['QUICK_WIN'], confidence: confidenceFor(['QUICK_WIN']) }),
  ]);
  assert.deepEqual(outcome.offered, []);
  assert.deepEqual(outcome.rejected.map((row) => row.code), ['INSUFFICIENT_EVIDENCE']);
});

test('a lead that does not clear the lead floor withholds the whole offer', () => {
  // `DUE_SOON` alone is 0.4 and clears both floors; a single `REPEATEDLY_DELAYED`
  // is 0.2 — over the offer floor, under the lead floor — so an offer whose best
  // option is that is withheld rather than shortened.
  const weak = confidenceFor(['REPEATEDLY_DELAYED']);
  assert.ok(weak >= RECOMMENDATION_RISK_POLICY.minOfferConfidence);
  assert.ok(weak < RECOMMENDATION_RISK_POLICY.minLeadConfidence);

  const selection = selectRecommendation(
    request({
      commitments: [commitment('c-alpha'), commitment('c-bravo')],
      priorityScores: [
        {
          version: 'priority-v1',
          commitmentId: 'c-alpha',
          total: 300,
          components: [],
          reasonCodes: ['REPEATEDLY_DELAYED'],
          policyVersion: 'policy-v1',
        } satisfies PriorityScore,
      ],
    }),
  );
  assert.equal(selection.recommendation.outcome, 'withheld');
  if (selection.recommendation.outcome !== 'withheld') return;
  assert.deepEqual(selection.recommendation.reasons.map((reason) => reason.code), [
    'INSUFFICIENT_EVIDENCE',
  ]);
});

test('a disabled module and an empty scope withhold under different codes', () => {
  const disabled: RecommendationSelectorConfig = {
    ...DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
    enabled: false,
  };
  const off = selectRecommendation(
    request({ commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z' })] }),
    disabled,
  );
  assert.equal(off.recommendation.outcome, 'withheld');
  if (off.recommendation.outcome === 'withheld') {
    assert.deepEqual(off.recommendation.reasons.map((reason) => reason.code), ['MODULE_DISABLED']);
  }

  const empty = selectRecommendation(request({ commitments: [] }));
  if (empty.recommendation.outcome === 'withheld') {
    assert.deepEqual(empty.recommendation.reasons.map((reason) => reason.code), [
      'NO_ELIGIBLE_CANDIDATE',
    ]);
  } else {
    assert.fail('expected a withheld recommendation');
  }

  const allExcluded = selectRecommendation(
    request({ commitments: [commitment('c-alpha', { confirmedAt: null }), commitment('c-bravo', { status: 'dropped' })] }),
  );
  if (allExcluded.recommendation.outcome === 'withheld') {
    assert.deepEqual(allExcluded.recommendation.reasons.map((reason) => reason.code), [
      'ALL_CANDIDATES_EXCLUDED',
    ]);
  } else {
    assert.fail('expected a withheld recommendation');
  }
});

test('a projection older than the input window withholds under INPUT_STALE, not INSUFFICIENT_EVIDENCE', () => {
  const stale = selectRecommendation(
    request({
      now: '2026-08-25T12:00:00.000Z',
      commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' })],
    }),
  );
  assert.equal(stale.recommendation.outcome, 'withheld');
  if (stale.recommendation.outcome !== 'withheld') return;
  assert.deepEqual(stale.recommendation.reasons.map((reason) => reason.code), ['INPUT_STALE']);

  // A projection computed *after* the evaluation instant is equally refused: a
  // run judged against a state it had not yet seen is a replay or a clock defect.
  const fromTheFuture = selectRecommendation(
    request({
      now: '2026-08-19T11:00:00.000Z',
      commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' })],
    }),
  );
  if (fromTheFuture.recommendation.outcome === 'withheld') {
    assert.deepEqual(fromTheFuture.recommendation.reasons.map((reason) => reason.code), ['INPUT_STALE']);
  } else {
    assert.fail('expected a withheld recommendation');
  }
});

/* ── The confidence formula ──────────────────────────────────────── */

test('every support code the contract names carries a weight, and no weight is invented', () => {
  const weighted = Object.keys(RECOMMENDATION_CONFIDENCE_WEIGHTS).sort();
  assert.deepEqual(weighted, SUPPORT_REASON_CODES.slice().sort());
  for (const code of SUPPORT_REASON_CODES) {
    const weight = RECOMMENDATION_CONFIDENCE_WEIGHTS[code as SupportReasonCode];
    assert.ok(Number.isFinite(weight) && weight >= 0, `${code} carries an unusable weight`);
  }
});

test('confidence is bounded in 0..1 over every subset of the support codes', () => {
  // Every subset, not a sample: there are only 2^8 of them, and the bound is the
  // property `bandForConfidence` returns null outside.
  const codes = SUPPORT_REASON_CODES;
  for (let mask = 0; mask < 1 << codes.length; mask += 1) {
    const subset: SupportReasonCode[] = [];
    for (let bit = 0; bit < codes.length; bit += 1) {
      if (mask & (1 << bit)) subset.push(codes[bit] as SupportReasonCode);
    }
    const value = confidenceFor(subset);
    assert.ok(value >= 0 && value <= 1, `subset ${subset.join('+')} produced ${value}`);
    assert.notEqual(bandForConfidence(value), null, `subset ${subset.join('+')} has no band`);
  }
  // The saturation is reachable, so the upper bound is not vacuous.
  assert.equal(confidenceFor(codes.slice() as SupportReasonCode[]), 1);
  assert.ok(RECOMMENDATION_CONFIDENCE_SATURATION > 0);
});

test('a repeated support code buys no extra confidence', () => {
  assert.equal(confidenceFor(['OVERDUE', 'OVERDUE', 'OVERDUE']), confidenceFor(['OVERDUE']));
});

test('every offered option\'s band is the one its value maps to', () => {
  const selection = selectRecommendation(
    request({
      commitments: [
        commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
        commitment('c-bravo', { dueAt: '2026-08-19T14:00:00.000Z', importance: 'high' }),
      ],
    }),
  );
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  for (const option of offeredOptions(selection.recommendation.options)) {
    assert.equal(option.confidence.band, bandForConfidence(option.confidence.value));
    assert.ok(option.confidence.basis.length > 0);
    assert.ok(option.support.length >= RECOMMENDATION_RISK_POLICY.minSupportReasons);
  }
});

/* ── The order is the contract's ─────────────────────────────────── */

test('ranking walks the contract\'s ordering keys, and the appended keys make it total', () => {
  assert.deepEqual(RECOMMENDATION_ORDERING_KEYS.slice(), [
    '-confidence',
    '-priority',
    'earliestDeadline',
    'commitmentId',
  ]);

  const higherConfidence = optionCandidate({ commitmentId: 'c-z', confidence: 0.9, priority: 1 });
  const lowerConfidence = optionCandidate({ commitmentId: 'c-a', confidence: 0.5, priority: 999 });
  assert.ok(compareOptionCandidates(higherConfidence, lowerConfidence) < 0, '-confidence leads');

  const higherPriority = optionCandidate({ commitmentId: 'c-z', confidence: 0.5, priority: 900 });
  const lowerPriority = optionCandidate({ commitmentId: 'c-a', confidence: 0.5, priority: 100 });
  assert.ok(compareOptionCandidates(higherPriority, lowerPriority) < 0, '-priority breaks confidence ties');

  const earlier = optionCandidate({ commitmentId: 'c-z', priority: 100, earliestDeadlineMs: 10 });
  const later = optionCandidate({ commitmentId: 'c-a', priority: 100, earliestDeadlineMs: 20 });
  assert.ok(compareOptionCandidates(earlier, later) < 0, 'earliestDeadline breaks priority ties');

  const noDeadline = optionCandidate({ commitmentId: 'c-a', priority: 100, earliestDeadlineMs: null });
  assert.ok(compareOptionCandidates(later, noDeadline) < 0, 'a missing deadline is not an early one');

  const alpha = optionCandidate({ commitmentId: 'c-a', action: { kind: 'do_now', commitmentId: 'c-a' } });
  const zulu = optionCandidate({ commitmentId: 'c-z', action: { kind: 'do_now', commitmentId: 'c-z' } });
  assert.ok(compareOptionCandidates(alpha, zulu) < 0, 'commitmentId breaks deadline ties');

  // The case the contract's four keys cannot decide: two actions on one
  // commitment, tied on everything the contract names.
  const doNow = optionCandidate({ action: { kind: 'do_now', commitmentId: 'c-alpha' } });
  const schedule = optionCandidate({
    action: { kind: 'schedule', commitmentId: 'c-alpha', slot: { startsAt: NOW, endsAt: '2026-08-19T12:30:00.000Z' } },
  });
  assert.notEqual(compareOptionCandidates(doNow, schedule), 0, 'the order is not total over actions');
  assert.equal(
    compareOptionCandidates(doNow, schedule) + compareOptionCandidates(schedule, doNow),
    0,
    'the comparator is not antisymmetric',
  );
});

test('a missing priority is not a low priority', () => {
  const withScore = optionCandidate({ commitmentId: 'c-a', confidence: 0.5, priority: -50 });
  const withoutScore = optionCandidate({ commitmentId: 'c-b', confidence: 0.5, priority: null });
  assert.ok(compareOptionCandidates(withScore, withoutScore) < 0);

  // And a non-finite score is treated as no signal rather than as a comparison
  // that returns NaN, which would put the sort into implementation-defined
  // behaviour.
  const broken = optionCandidate({ commitmentId: 'c-c', confidence: 0.5, priority: Number.NaN });
  assert.ok(compareOptionCandidates(withScore, broken) < 0);
  assert.equal(
    rankOptionCandidates([broken, withoutScore, withScore])[0].commitmentId,
    'c-a',
  );
});

/* ── UNBLOCKS_DEPENDENTS claims something specific ───────────────── */

test('a dependent that is not actually waiting does not count as unblocked', () => {
  // Adding a *completed* commitment that names the candidate as its blocker used
  // to buy that candidate 1.5 weight, carrying it from 0.3 to 0.6 over the lead
  // floor, and put "this is the open prerequisite of another item" in front of a
  // user about an item that was finished and waiting for nothing. A withheld
  // verdict became an offer on the strength of a false claim.
  const blocker = commitment('c-blocker', { importance: 'high' });
  const alone = selectRecommendation(request({ commitments: [blocker] }));
  assert.equal(alone.recommendation.outcome, 'withheld');

  for (const [label, dependent] of [
    ['completed', commitment('c-dep', { status: 'completed', blockedByCommitmentIds: ['c-blocker'] })],
    ['unconfirmed', commitment('c-dep', { confirmedAt: null, blockedByCommitmentIds: ['c-blocker'] })],
    ['invalid time', commitment('c-dep', { dueAt: 'nope', blockedByCommitmentIds: ['c-blocker'] })],
  ] as const) {
    const selection = selectRecommendation(request({ commitments: [blocker, dependent] }));
    assert.equal(
      selection.recommendation.outcome,
      'withheld',
      `a ${label} dependent must not make its blocker offerable`,
    );
  }

  // And the claim is still made when it is true: a dependent whose *only*
  // obstacle is the block really is unblocked by finishing this one.
  const genuine = selectRecommendation(
    request({
      commitments: [blocker, commitment('c-dep', { blockedByCommitmentIds: ['c-blocker'] })],
    }),
  );
  assert.equal(genuine.recommendation.outcome, 'offered');
  if (genuine.recommendation.outcome !== 'offered') return;
  const option = offeredOptions(genuine.recommendation.options)[0];
  assert.ok(
    option.support.map((reason) => reason.code).indexOf('UNBLOCKS_DEPENDENTS') !== -1,
    'the reason must still be emitted where it is true',
  );
});

/* ── Claims about absence read the projection's `known` flag ─────── */

test('an unknown commitments projection withholds rather than attesting to absence', () => {
  // `only_candidate.attested` means "there was genuinely nothing else". It used
  // to cite `n-scope-commitments` without reading `known`, so against an unknown
  // projection it rested on an `{kind: 'absent'}` node — absence of knowledge
  // presented as evidence of absence — and that falsified this module's own
  // reason for requiring `lifeState` at all.
  const unknownProjection: LifeState = { ...lifeState(), commitments: unknownField() };
  const selection = selectRecommendation(
    request({
      lifeState: unknownProjection,
      commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' })],
    }),
  );
  assert.deepEqual(selection.defects, []);
  assert.equal(selection.recommendation.outcome, 'withheld');
  if (selection.recommendation.outcome !== 'withheld') return;
  assert.deepEqual(selection.recommendation.reasons.map((reason) => reason.code), ['INSUFFICIENT_EVIDENCE']);

  // With a known projection the same request is an offer, so the guard is not
  // simply refusing everything.
  const known = selectRecommendation(
    request({ commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' })] }),
  );
  assert.equal(known.recommendation.outcome, 'offered');
  if (known.recommendation.outcome !== 'offered') return;
  assert.equal(known.recommendation.options.kind, 'only_candidate');
  if (known.recommendation.options.kind !== 'only_candidate') return;
  const attested = known.recommendation.options.attested[0];
  const node = known.recommendation.evidence.nodes.filter((row) => row.nodeId === attested)[0];
  assert.equal(node.kind, 'observed');
  assert.equal(node.claim.kind, 'quantity', 'the attestation must rest on a known count, not on an absent field');
});

/* ── The pipeline order is pinned, not incidental ────────────────── */

test('a weak alternative beside a strong lead is excluded, never both offered and excluded', () => {
  // The risk gate has to run *before* diversity. Running diversity over the
  // unfiltered ranking instead lets a candidate the risk gate rejected be
  // offered as well, so the same action appears in both lists —
  // `EXCLUDED_OPTION_ALSO_OFFERED`. No test covered the ordering, so that
  // mutation stayed green.
  const selection = selectRecommendation(
    request({
      commitments: [
        commitment('c-strong', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
        // Eligible, but supported by nothing: the risk gate's business.
        commitment('c-weak'),
      ],
    }),
  );
  assert.deepEqual(selection.defects, [], 'the contract checker found a defect in this module\'s own output');
  assert.equal(selection.recommendation.outcome, 'offered');
  if (selection.recommendation.outcome !== 'offered') return;

  const offeredKeys = offeredOptions(selection.recommendation.options).map((option) => option.action.commitmentId);
  const summary = summarizeOptionSet(selection.recommendation.options);
  const excludedKeys = summary.excluded.map((row) => row.action.commitmentId);
  assert.deepEqual(offeredKeys, ['c-strong']);
  assert.ok(excludedKeys.indexOf('c-weak') !== -1);
  for (const key of offeredKeys) {
    assert.equal(excludedKeys.indexOf(key), -1, 'an action is both offered and excluded');
  }
});

test('the support-count guard does not trust the confidence number beside it', () => {
  // Under the current weights a zero-support candidate scores zero and would
  // fail the offer floor anyway, so deleting this branch left every test green.
  // It is not redundant: `applyRiskPolicy` is exported, and it must refuse a row
  // whose `confidence` is not a function of its own codes — `support` is a
  // non-empty tuple and its non-emptiness cannot depend on a weight staying
  // positive.
  const inconsistent = optionCandidate({ supportCodes: [], confidence: 0.95 });
  const outcome = applyRiskPolicy([inconsistent]);
  assert.deepEqual(outcome.offered, []);
  assert.deepEqual(outcome.rejected.map((row) => row.code), ['INSUFFICIENT_EVIDENCE']);
  assert.ok(RECOMMENDATION_RISK_POLICY.minSupportReasons >= 1);
});

test('being the only eligible candidate is claimed only when it is true', () => {
  const two = selectRecommendation(
    request({
      commitments: [
        commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
        commitment('c-bravo', { dueAt: '2026-08-18T10:00:00.000Z', importance: 'high' }),
      ],
    }),
  );
  if (two.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  for (const option of offeredOptions(two.recommendation.options)) {
    assert.equal(
      option.support.map((reason) => reason.code).indexOf('ONLY_ELIGIBLE_ACTION'),
      -1,
      'the module claimed sole eligibility with two eligible candidates',
    );
  }

  const one = selectRecommendation(
    request({
      commitments: [
        commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
        commitment('c-closed', { status: 'completed' }),
      ],
    }),
  );
  if (one.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  assert.ok(
    offeredOptions(one.recommendation.options)[0].support
      .map((reason) => reason.code)
      .indexOf('ONLY_ELIGIBLE_ACTION') !== -1,
  );
});

/* ── Which exclusion codes this module can actually emit ─────────── */

/**
 * Stated rather than derived, so that adding a contract code is a decision
 * someone records. An earlier note claimed the support-weight sweep covered
 * this; it does not, and two codes sat structurally unemittable with nothing
 * failing.
 */
const EMITTABLE_EXCLUSION_CODES: readonly ExclusionReasonCode[] = [
  'NOT_CONFIRMED',
  'ALREADY_CLOSED',
  'INVALID_SOURCE_TIME',
  'BLOCKED_BY_DEPENDENCY',
  'INSUFFICIENT_EVIDENCE',
  'LOWER_RANKED',
  'OPTION_CAP_REACHED',
];

/** Not emittable, deliberately: this module is handed a Plan, not windows. */
const UNEMITTABLE_EXCLUSION_CODES: readonly ExclusionReasonCode[] = [
  'NO_PLANNED_SLOT',
  'OUTSIDE_WORKING_WINDOW',
];

test('the two exclusion-code lists together cover the contract exactly', () => {
  assert.deepEqual(
    EMITTABLE_EXCLUSION_CODES.concat(UNEMITTABLE_EXCLUSION_CODES).slice().sort(),
    EXCLUSION_REASON_CODES.slice().sort(),
  );
});

test('every code this module claims it can emit is actually reachable', () => {
  const seen = new Set<string>();
  const record = (selection: ReturnType<typeof selectRecommendation>): void => {
    if (selection.recommendation.outcome !== 'offered') return;
    for (const row of summarizeOptionSet(selection.recommendation.options).excluded) {
      for (const reason of row.exclusion) seen.add(reason.code);
    }
  };

  record(selectRecommendation(request({
    commitments: [
      commitment('c-good', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
      commitment('c-unconfirmed', { confirmedAt: null }),
      commitment('c-closed', { status: 'completed' }),
      commitment('c-badtime', { dueAt: 'not-a-date' }),
      commitment('c-weak'),
      commitment('c-blocked', { blockedByCommitmentIds: ['c-good'] }),
    ],
  })));

  const many: CommitmentSnapshot[] = [];
  const rows: { itemId: string; startsAt: string; endsAt: string }[] = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `c-${String(index).padStart(2, '0')}`;
    many.push(commitment(id, { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high', planItemId: `item-${index}` }));
    rows.push({ itemId: `item-${index}`, startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' });
  }
  record(selectRecommendation(request({ commitments: many, plan: plan(rows) })));

  for (const code of EMITTABLE_EXCLUSION_CODES) {
    assert.ok(seen.has(code), `${code} is listed as emittable but was never produced`);
  }
  for (const code of UNEMITTABLE_EXCLUSION_CODES) {
    assert.equal(seen.has(code), false, `${code} is listed as unemittable but was produced`);
  }
});

/* ── Each appended ordering key earns its place ──────────────────── */

test('each appended ordering key is load-bearing on its own', () => {
  // Deleting either key alone left the suite green, and only deleting both
  // failed — the shape where a second check looks like defence in depth and is
  // really an untested branch plus a hole in the first check's coverage. Each is
  // now pinned by a pair that ties on everything before it and differs only in
  // the key under test.
  const slot = { startsAt: NOW, endsAt: '2026-08-19T12:30:00.000Z' };

  // Kind rank alone: same commitment, different kinds, chosen so that
  // `actionKey` orders them the *other* way. #33's `actionKey` is
  // length-prefixed, so `defer` encodes as `"5:defer|…"` and sorts below
  // `do_now`'s `"6:do_now|…"` — while `RECOMMENDED_ACTION_KINDS` ranks `defer`
  // last. Only the kind rank can produce the answer below, so deleting it
  // flips this assertion instead of leaving the suite green.
  const doNow = optionCandidate({ action: { kind: 'do_now', commitmentId: 'c-alpha' } });
  const defer = optionCandidate({
    action: { kind: 'defer', commitmentId: 'c-alpha', until: '2026-08-20T09:00:00.000Z' },
  });
  assert.ok(compareOptionCandidates(doNow, defer) < 0, 'the action-kind rank is not deciding');
  assert.ok(
    actionKey(doNow.action) > actionKey(defer.action),
    'the fixture no longer isolates the kind rank from the actionKey tie-break',
  );

  // actionKey alone: same commitment, same kind, different slots — the kind rank
  // ties and nothing before it separates them.
  const early = optionCandidate({ action: { kind: 'schedule', commitmentId: 'c-alpha', slot } });
  const late = optionCandidate({
    action: { kind: 'schedule', commitmentId: 'c-alpha', slot: { startsAt: '2026-08-19T14:00:00.000Z', endsAt: '2026-08-19T14:30:00.000Z' } },
  });
  assert.notEqual(compareOptionCandidates(early, late), 0, 'the actionKey tie-break is not deciding');
  assert.equal(compareOptionCandidates(early, late) + compareOptionCandidates(late, early), 0);
});
