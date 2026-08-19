/**
 * Candidate generation and the hard filters (Sprint 08, issue #34).
 *
 * Three claims are under test here and each has a failure mode that no
 * behavioural assertion elsewhere would catch.
 *
 *  1. **Every claim is sourced.** Not "the graph has nodes", which is satisfied
 *     by any graph, but the property `recommendationContracts` decision 1 makes
 *     structural: `checkEvidenceGraph` accepts the graph, and
 *     `resolveEvidenceRoots` returns a non-empty list of *observations* for
 *     every node in it. Those two together are the theorem; asserting either one
 *     alone leaves the other half unchecked.
 *
 *  2. **Hard constraints cannot be bypassed.** The strong form is not "an
 *     excluded candidate is not offered" — that is one assertion about one
 *     input. It is that an excluded candidate never becomes an option at all, so
 *     there is no list it sits in from which a high score could recover it. The
 *     test drives it with a candidate whose priority score is the highest in the
 *     request.
 *
 *  3. **This module and the shipped pilot agree about who is excluded.** A
 *     merge-owned cross-track test will compare the two, and Sprint 07's lesson
 *     is that the comparison has to be at `(subject, code)` granularity — its
 *     own cross-track test compared deduplicated code *names*, reported perfect
 *     agreement, and missed a disagreement on 38% of inputs. So the comparison
 *     below is over `(commitmentId, code)` pairs across a generated matrix, not
 *     over a set of codes and not over a hand-picked table.
 *
 * The pilot is imported read-only. Nothing in `lib/recommendation/**` imports it
 * — `selectorBoundaries.test.ts` forbids that, because a module that could read
 * the pilot's verdict would make this comparison compare a thing with itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  RecommendationInputError,
  currentFingerprints,
  generateCandidates,
  hardExclusionCodes,
  selectRecommendation,
  type CommitmentSnapshot,
  type RecommendationSelectorInput,
} from '../../lib/recommendation/index.ts';
import {
  checkEvidenceGraph,
  checkRecommendation,
  evaluateRecommendationStaleness,
  offeredOptions,
  resolveEvidenceRoots,
  summarizeOptionSet,
} from '../../src/contracts/v1/recommendationContracts.ts';
import type { Field, LifeState } from '../../src/contracts/v1/lifeStateContracts.ts';
import type { PriorityScore } from '../../src/contracts/v1/priorityContracts.ts';
import type { Plan } from '../../src/contracts/v1/planningContracts.ts';
// Read-only, and only from the test. See the header.
import {
  scoreBaselineCandidate,
  type BaselineCandidate,
} from '../../lib/services/nextStepBaseline.ts';

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

function lifeState(openCount = 3): LifeState {
  return {
    version: 'life-state-v1',
    scopeId: 'scope-1',
    computedAt: COMPUTED_AT,
    inputDigest: 'life-state-digest',
    commitments: knownField({
      countsByStatus: { active: openCount },
      openCount,
      overdueCount: 1,
      openCommitmentIds: [],
      overdueCommitmentIds: [],
    }),
    availability: unknownField(),
    load: knownField({
      totalUrgencyScore: 12,
      openCount,
      overdueCount: 1,
      dueSoonCount: 1,
      band: 'moderate',
    }),
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

function score(commitmentId: string, total: number, reasonCodes: PriorityScore['reasonCodes'] = []): PriorityScore {
  return {
    version: 'priority-v1',
    commitmentId,
    total,
    components: [{ code: 'reason_base', points: total, evidence: null }],
    reasonCodes,
    policyVersion: 'policy-v1',
  };
}

function plan(scheduled: readonly { itemId: string; startsAt: string; endsAt: string }[]): Plan {
  return {
    version: 'v1',
    schema: 'planning-v1',
    scopeId: 'scope-1',
    horizon: { startsAt: NOW, endsAt: '2026-08-20T00:00:00.000Z' },
    scheduled: scheduled.map((row) => ({
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

/* ── The graph is sourced all the way down ───────────────────────── */

test('the evidence graph a run produces is structurally sound', () => {
  const input = request({
    commitments: [
      commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
      commitment('c-bravo', { dueAt: '2026-08-19T17:00:00.000Z', planItemId: 'item-bravo' }),
      commitment('c-charlie', { confirmedAt: null }),
      commitment('c-delta', { status: 'completed' }),
      commitment('c-echo', { dueAt: 'not-a-date' }),
    ],
    priorityScores: [score('c-alpha', 800, ['OVERDUE', 'REPEATEDLY_DELAYED'])],
    plan: plan([{ itemId: 'item-bravo', startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' }]),
  });

  const set = generateCandidates(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  assert.deepEqual(checkEvidenceGraph(set.evidence), []);
  assert.ok(set.evidence.nodes.length > 0, 'the graph must not be vacuously sound by being empty');

  // Decision 1 as a theorem rather than a convention: every node, observed or
  // derived, resolves to at least one observation of trusted state.
  for (const node of set.evidence.nodes) {
    const roots = resolveEvidenceRoots(set.evidence, node.nodeId);
    assert.ok(roots !== null && roots.length > 0, `node ${node.nodeId} resolves to no observation`);
    for (const root of roots as readonly { kind: string; valueFingerprint: string }[]) {
      assert.equal(root.kind, 'observed');
      assert.ok(root.valueFingerprint.trim().length > 0, 'an observation carries a blank fingerprint');
    }
  }
});

test('an evidence node id carries no readable commitment id', () => {
  const input = request({
    commitments: [commitment('call-dr.cohen-about-the-biopsy', { dueAt: '2026-08-18T09:00:00.000Z' })],
  });
  const set = generateCandidates(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  for (const node of set.evidence.nodes) {
    assert.equal(
      node.nodeId.includes('call-dr'),
      false,
      `node id ${node.nodeId} carries the caller's commitment id`,
    );
  }
  // And it is still sensitive to it: two different ids give different handles.
  const other = generateCandidates(
    request({ commitments: [commitment('call-dr.cohen-about-the-scan', { dueAt: '2026-08-18T09:00:00.000Z' })] }),
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  );
  assert.notDeepEqual(
    set.evidence.nodes.map((node) => node.nodeId),
    other.evidence.nodes.map((node) => node.nodeId),
  );
});

/* ── Candidate generation reads Priority and Planning ────────────── */

test('a planned slot becomes a schedule action and a priority score becomes a rank node', () => {
  const input = request({
    commitments: [
      commitment('c-alpha', {
        dueAt: '2026-08-19T13:30:00.000Z',
        planItemId: 'item-alpha',
        importance: 'high',
      }),
    ],
    priorityScores: [score('c-alpha', 640, ['REPEATEDLY_DELAYED'])],
    plan: plan([{ itemId: 'item-alpha', startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' }]),
  });

  const set = generateCandidates(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  const candidate = set.candidates[0];
  assert.notEqual(candidate.evidence.rankNodeId, null, 'the priority score produced no rank node');
  assert.notEqual(candidate.evidence.slotNodeId, null, 'the plan slot produced no observation');
  assert.notEqual(candidate.evidence.slotImminentNodeId, null, 'a slot one hour out is imminent');
  assert.equal(candidate.evidence.effortMinutes, 10);

  const selection = selectRecommendation(input);
  assert.deepEqual(selection.defects, []);
  assert.equal(selection.recommendation.outcome, 'offered');
  if (selection.recommendation.outcome !== 'offered') return;
  const kinds = offeredOptions(selection.recommendation.options).map((option) => option.action.kind);
  assert.ok(kinds.indexOf('schedule') !== -1, `expected a schedule action, saw ${kinds.join(',')}`);
});

test('a decomposition proposal replaces the do_now action rather than competing with it', () => {
  const withProposal = selectRecommendation(
    request({
      commitments: [
        commitment('c-alpha', {
          dueAt: '2026-08-18T09:00:00.000Z',
          decompositionProposalId: 'prop-1',
          decompositionStepId: 'step-1',
        }),
      ],
    }),
  );
  const withoutProposal = selectRecommendation(
    request({ commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z' })] }),
  );
  const kindsOf = (selection: typeof withProposal): string[] =>
    selection.recommendation.outcome === 'offered'
      ? offeredOptions(selection.recommendation.options).map((option) => option.action.kind)
      : [];
  assert.deepEqual(kindsOf(withProposal), ['decompose']);
  assert.deepEqual(kindsOf(withoutProposal), ['do_now']);
});

test('this module proposes no defer action, because it has no policy for the instant one needs', () => {
  const selection = selectRecommendation(
    request({
      commitments: [
        commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
        commitment('c-bravo', { dueAt: '2026-08-19T13:00:00.000Z', importance: 'high' }),
      ],
    }),
  );
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  const summary = summarizeOptionSet(selection.recommendation.options);
  for (const option of offeredOptions(selection.recommendation.options)) {
    assert.notEqual(option.action.kind, 'defer');
  }
  for (const excludedOption of summary.excluded) {
    assert.notEqual(excludedOption.action.kind, 'defer');
  }
});

/* ── Hard constraints ────────────────────────────────────────────── */

test('a hard-excluded candidate never becomes an option, whatever it scores', () => {
  // The highest priority in the request, and closed. If exclusion were a
  // downweighting rather than a filter, this is the input that would reveal it.
  const input = request({
    commitments: [
      commitment('c-closed', { status: 'completed', dueAt: '2026-08-01T09:00:00.000Z', importance: 'high' }),
      commitment('c-open', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
    ],
    priorityScores: [score('c-closed', 999), score('c-open', 1)],
  });

  const selection = selectRecommendation(input);
  assert.deepEqual(selection.defects, []);
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  for (const option of offeredOptions(selection.recommendation.options)) {
    assert.notEqual(option.action.commitmentId, 'c-closed');
  }
  const summary = summarizeOptionSet(selection.recommendation.options);
  const excludedCodes = summary.excluded
    .filter((row) => row.action.commitmentId === 'c-closed')
    .flatMap((row) => row.exclusion.map((reason) => reason.code));
  assert.deepEqual(excludedCodes, ['ALREADY_CLOSED']);
});

test('the four hard-constraint codes are emitted in the pilot-comparable precedence order', () => {
  // `BLOCKED_BY_DEPENDENCY` is absent here even though two blockers were passed:
  // the candidate is archived, and "waiting on a prerequisite" borrows its whole
  // meaning from the commitment still being live. One defect, one code.
  const codes = hardExclusionCodes(
    commitment('c-x', { confirmedAt: null, status: 'archived' }),
    null,
    2,
  );
  assert.deepEqual(codes, ['NOT_CONFIRMED', 'ALREADY_CLOSED']);

  // Nothing wider is suppressed: an unconfirmed *open* commitment really is
  // also blocked, and both have to change before it can be offered.
  assert.deepEqual(
    hardExclusionCodes(commitment('c-w', { confirmedAt: null, status: 'active' }), null, 2),
    ['NOT_CONFIRMED', 'BLOCKED_BY_DEPENDENCY'],
  );

  const withInvalidTime = hardExclusionCodes(commitment('c-y', { dueAt: 'nope' }), null, 0);
  assert.deepEqual(withInvalidTime, ['INVALID_SOURCE_TIME']);

  // Position 0 is the slot the pilot's single nullable field maps onto, so the
  // stricter code must never be able to take it.
  const blockedAndUnconfirmed = hardExclusionCodes(commitment('c-z', { confirmedAt: null }), 0, 1);
  assert.equal(blockedAndUnconfirmed[0], 'NOT_CONFIRMED');
});

test('a blocker naming nothing in this request does not block, because no observation of it exists', () => {
  const input = request({
    commitments: [
      commitment('c-alpha', {
        dueAt: '2026-08-18T09:00:00.000Z',
        blockedByCommitmentIds: ['c-not-supplied'],
      }),
    ],
  });
  const set = generateCandidates(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  assert.deepEqual(set.candidates[0].hardExclusions, []);
  assert.equal(set.candidates[0].evidence.blockedNodeId, null);

  // Supply the blocker and it blocks — and the exclusion cites the blocker's
  // own status observation rather than asserting the block unsourced.
  const supplied = generateCandidates(
    request({
      commitments: [
        commitment('c-alpha', {
          dueAt: '2026-08-18T09:00:00.000Z',
          blockedByCommitmentIds: ['c-blocker'],
        }),
        commitment('c-blocker'),
      ],
    }),
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  );
  const alpha = supplied.candidates.filter((row) => row.commitmentId === 'c-alpha')[0];
  assert.deepEqual(alpha.hardExclusions, ['BLOCKED_BY_DEPENDENCY']);
  assert.notEqual(alpha.evidence.blockedNodeId, null);

  // A closed blocker has stopped blocking.
  const finished = generateCandidates(
    request({
      commitments: [
        commitment('c-alpha', {
          dueAt: '2026-08-18T09:00:00.000Z',
          blockedByCommitmentIds: ['c-blocker'],
        }),
        commitment('c-blocker', { status: 'completed' }),
      ],
    }),
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  );
  assert.deepEqual(
    finished.candidates.filter((row) => row.commitmentId === 'c-alpha')[0].hardExclusions,
    [],
  );
});

/* ── Agreement with the shipped pilot ────────────────────────────── */

const PILOT_CODE_BY_REASON = {
  not_confirmed: 'NOT_CONFIRMED',
  closed: 'ALREADY_CLOSED',
  invalid_time: 'INVALID_SOURCE_TIME',
} as const;

test('hard-constraint exclusions agree with the pilot, compared as (commitmentId, code) pairs', () => {
  // A generated matrix rather than a hand-built divergence table. Sprint 07's
  // recorded corollary is that a table tests the shapes its author thought of;
  // the fuzzer found three the 44-case table missed.
  const statuses = [
    'draft',
    'needs_clarification',
    'pending_confirmation',
    'active',
    'deferred',
    'missed',
    'completed',
    'dropped',
    'archived',
  ] as const;
  const confirmations = [null, '2026-08-18T09:00:00.000Z'];
  const dues = [null, '', '2026-08-18T09:00:00.000Z', 'not-a-date'];
  const reminds = [null, '2026-08-20T09:00:00.000Z', 'also-not-a-date'];

  const snapshots: CommitmentSnapshot[] = [];
  let serial = 0;
  for (const status of statuses) {
    for (const confirmedAt of confirmations) {
      for (const dueAt of dues) {
        for (const remindAt of reminds) {
          serial += 1;
          snapshots.push(
            commitment(`c-${String(serial).padStart(4, '0')}`, {
              status,
              confirmedAt,
              dueAt,
              remindAt,
            }),
          );
        }
      }
    }
  }
  assert.equal(snapshots.length, 9 * 2 * 4 * 3);

  const set = generateCandidates(
    request({ commitments: snapshots }),
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  );

  const mine: string[] = [];
  const pilot: string[] = [];
  const nowDate = new Date(NOW);
  for (const candidate of set.candidates) {
    // No candidate in this matrix has a blocker, so every code this module
    // emits is one the pilot has a spelling for. That is what makes the
    // comparison exhaustive rather than filtered.
    assert.equal(candidate.hardExclusions.indexOf('BLOCKED_BY_DEPENDENCY'), -1);
    if (candidate.hardExclusions.length > 0) {
      mine.push(`${candidate.commitmentId}|${candidate.hardExclusions[0]}`);
    }

    const snapshot = candidate.snapshot;
    const baselineCandidate: BaselineCandidate = {
      commitmentId: snapshot.commitmentId,
      title: `title of ${snapshot.commitmentId}`,
      confirmed: snapshot.confirmedAt !== null,
      status: snapshot.status,
      dueAt: snapshot.dueAt,
      remindAt: snapshot.remindAt,
      importance: snapshot.importance,
      explicitEffortMinutes: null,
    };
    const baseline = scoreBaselineCandidate(baselineCandidate, nowDate);
    if (baseline.exclusionReason !== null) {
      pilot.push(`${snapshot.commitmentId}|${PILOT_CODE_BY_REASON[baseline.exclusionReason]}`);
    }

    // And the eligibility verdicts themselves agree, not only the top code.
    assert.equal(
      candidate.hardExclusions.length === 0,
      baseline.eligible,
      `eligibility disagrees for ${snapshot.commitmentId}`,
    );
  }

  assert.ok(mine.length > 0, 'the comparison found nothing to compare');
  assert.deepEqual(mine.slice().sort(), pilot.slice().sort());
});

/* ── Fingerprints and re-verification ────────────────────────────── */

test('a recommendation re-verified against its own inputs is fresh, and moves when a source moves', () => {
  const input = request({
    commitments: [
      commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
      commitment('c-bravo', { dueAt: '2026-08-19T14:00:00.000Z' }),
    ],
  });
  const selection = selectRecommendation(input);
  assert.deepEqual(selection.defects, []);

  const fresh = evaluateRecommendationStaleness({
    recommendation: selection.recommendation,
    now: '2026-08-19T12:30:00.000Z',
    currentFingerprints: currentFingerprints(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
  });
  assert.deepEqual(fresh, { fresh: true });

  const moved: RecommendationSelectorInput = {
    ...input,
    commitments: [
      commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'low' }),
      commitment('c-bravo', { dueAt: '2026-08-19T14:00:00.000Z' }),
    ],
  };
  const stale = evaluateRecommendationStaleness({
    recommendation: selection.recommendation,
    now: '2026-08-19T12:30:00.000Z',
    currentFingerprints: currentFingerprints(moved, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
  });
  assert.equal(stale.fresh, false);
  if (stale.fresh) return;
  assert.deepEqual(stale.reasons.map((reason) => reason.code), ['SOURCE_CHANGED']);
});

test('an unverifiable source fails closed rather than reading as unchanged', () => {
  const input = request({ commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z' })] });
  const selection = selectRecommendation(input);
  const verdict = evaluateRecommendationStaleness({
    recommendation: selection.recommendation,
    now: '2026-08-19T12:30:00.000Z',
    currentFingerprints: {},
  });
  assert.equal(verdict.fresh, false);
  if (verdict.fresh) return;
  for (const reason of verdict.reasons) assert.equal(reason.code, 'SOURCE_UNVERIFIABLE');
});

test('expiry is exclusive and computed from the supplied now, never from a clock', () => {
  const selection = selectRecommendation(
    request({ commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z' })] }),
  );
  const validity = selection.recommendation.validity;
  assert.equal(validity.basisAt, NOW);
  assert.equal(validity.expiresAt, '2026-08-19T13:00:00.000Z');

  const fingerprints = currentFingerprints(
    request({ commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z' })] }),
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  );
  const atExpiry = evaluateRecommendationStaleness({
    recommendation: selection.recommendation,
    now: validity.expiresAt,
    currentFingerprints: fingerprints,
  });
  assert.equal(atExpiry.fresh, false, 'the bound is exclusive: at expiresAt it is stale');
  const justBefore = evaluateRecommendationStaleness({
    recommendation: selection.recommendation,
    now: '2026-08-19T12:59:59.999Z',
    currentFingerprints: fingerprints,
  });
  assert.deepEqual(justBefore, { fresh: true });
});

/* ── Report, don't throw — and the three exceptions ──────────────── */

test('a malformed source time is reported as an exclusion rather than thrown', () => {
  const selection = selectRecommendation(
    request({
      commitments: [
        commitment('c-broken', { dueAt: 'the day after tomorrow-ish' }),
        commitment('c-good', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
      ],
    }),
  );
  assert.deepEqual(selection.defects, []);
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  const summary = summarizeOptionSet(selection.recommendation.options);
  const codes = summary.excluded
    .filter((row) => row.action.commitmentId === 'c-broken')
    .flatMap((row) => row.exclusion.map((reason) => reason.code));
  assert.deepEqual(codes, ['INVALID_SOURCE_TIME']);
});

test('a non-finite priority total is carried as read rather than repaired', () => {
  const input = request({
    commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' })],
    priorityScores: [score('c-alpha', Number.NaN)],
  });
  const selection = selectRecommendation(input);
  assert.deepEqual(selection.defects, []);
  assert.equal(selection.recommendation.outcome, 'offered');
  const priorityNode = selection.recommendation.evidence.nodes.filter(
    (node) => node.kind === 'observed' && node.source.kind === 'priority_score',
  )[0];
  assert.ok(priorityNode !== undefined);
  assert.deepEqual(priorityNode.claim, { kind: 'quantity', value: Number.NaN, unit: 'points' });
});

test('the three conditions the taxonomy cannot describe are refused, and only those', () => {
  assert.throws(
    () => selectRecommendation(request({ now: 'not-an-instant' })),
    (error: unknown) =>
      error instanceof RecommendationInputError && error.field === 'now',
  );
  assert.throws(
    () =>
      selectRecommendation(
        request({ commitments: [commitment('c-alpha'), commitment('c-alpha')] }),
      ),
    (error: unknown) =>
      error instanceof RecommendationInputError && error.field === 'commitments',
  );
  assert.throws(
    () =>
      selectRecommendation(
        request({
          commitments: [commitment('c-alpha')],
          priorityScores: [score('c-alpha', 1), score('c-alpha', 2)],
        }),
      ),
    (error: unknown) =>
      error instanceof RecommendationInputError && error.field === 'priorityScores',
  );

  // And a blank scope id is *not* refused: the policy is narrow on purpose.
  assert.doesNotThrow(() =>
    selectRecommendation(request({ scopeId: '', commitments: [commitment('c-alpha')] })),
  );
});

/* ── The producer runs the consumer's check ──────────────────────── */

test('every outcome this module can produce passes the contract checker', () => {
  const cases: RecommendationSelectorInput[] = [
    request(),
    request({ commitments: [commitment('c-alpha', { confirmedAt: null })] }),
    request({ commitments: [commitment('c-alpha')] }),
    request({ commitments: [commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z' })] }),
    request({
      commitments: [
        commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
        commitment('c-bravo', { dueAt: '2026-08-19T13:00:00.000Z', importance: 'high' }),
        commitment('c-charlie', { dueAt: '2026-08-21T13:00:00.000Z', importance: 'high' }),
        commitment('c-delta', { status: 'dropped' }),
      ],
      priorityScores: [score('c-alpha', 900, ['REPEATEDLY_DELAYED'])],
      plan: plan([
        { itemId: 'item-bravo', startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' },
      ]),
    }),
  ];
  const seen = new Set<string>();
  for (const input of cases) {
    const selection = selectRecommendation(input);
    assert.deepEqual(
      checkRecommendation(selection.recommendation),
      [],
      'the contract checker found a defect in this module\'s own output',
    );
    assert.deepEqual(selection.defects, []);
    seen.add(
      selection.recommendation.outcome === 'withheld'
        ? `withheld:${selection.recommendation.reasons[0].code}`
        : `offered:${selection.recommendation.options.kind}`,
    );
  }
  // The sweep is not vacuous: it covered more than one outcome shape.
  assert.ok(seen.size >= 4, `expected several outcome shapes, saw ${Array.from(seen).sort().join(', ')}`);
});

/* ── The untyped boundary ────────────────────────────────────────── */

test('an absent optional field is read as absent, not as a present value', () => {
  // `=== null` is a strict test and a missing key is `undefined`. A payload with
  // no `confirmedAt` key used to be *offered*, with the graph asserting
  // `ELIGIBLE_FROM_CONFIRMATION: {flag: true}` positively and the `confirmed_at`
  // observation carrying `{kind: 'instant'}` with no `value` — a shape
  // `EvidenceClaim` does not admit — while `checkRecommendation` reported zero
  // defects, because none of that is a condition its taxonomy names.
  const missingKey = {
    commitmentId: 'c-x',
    status: 'active',
    dueAt: '2026-08-18T09:00:00.000Z',
    remindAt: null,
    importance: 'high',
    blockedByCommitmentIds: [],
    planItemId: null,
    decompositionProposalId: null,
    decompositionStepId: null,
  } as unknown as CommitmentSnapshot;

  const set = generateCandidates(request({ commitments: [missingKey] }), DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  assert.deepEqual(set.candidates[0].hardExclusions, ['NOT_CONFIRMED']);

  const selection = selectRecommendation(request({ commitments: [missingKey] }));
  assert.deepEqual(selection.defects, []);
  assert.equal(selection.recommendation.outcome, 'withheld');

  const eligible = selection.recommendation.evidence.nodes.filter(
    (node) => node.kind === 'derived' && node.rule === 'ELIGIBLE_FROM_CONFIRMATION',
  )[0];
  assert.deepEqual(eligible.claim, { kind: 'flag', value: false });

  const observed = selection.recommendation.evidence.nodes.filter(
    (node) => node.kind === 'observed' && node.source.kind === 'commitment' && node.source.field === 'confirmed_at',
  )[0];
  assert.deepEqual(observed.claim, { kind: 'absent', reason: 'NO_DATA' });
});

test('a commitment with no usable id or an unknown status is refused, not guessed at', () => {
  for (const broken of [
    { commitmentId: '   ' },
    { commitmentId: undefined },
    { status: 'somewhere_else' },
  ] as unknown as Partial<CommitmentSnapshot>[]) {
    assert.throws(
      () => selectRecommendation(request({ commitments: [{ ...commitment('c-a'), ...broken }] })),
      (error: unknown) =>
        error instanceof RecommendationInputError && error.field === 'commitments',
      `expected a classified refusal for ${JSON.stringify(broken)}`,
    );
  }
});

test('an unusable config value is refused by name rather than as a raw error', () => {
  const good = request({ commitments: [commitment('c-a', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' })] });
  for (const override of [
    { ttlMinutes: Number.NaN },
    { ttlMinutes: Number.POSITIVE_INFINITY },
    { ttlMinutes: 0 },
    { ttlMinutes: -120 },
    { ttlMinutes: 1e15 },
    { dueSoonHours: Number.NaN },
    { planSlotImminentMinutes: -1 },
    { maxInputAgeMinutes: Number.NaN },
  ]) {
    assert.throws(
      () => selectRecommendation(good, { ...DEFAULT_RECOMMENDATION_SELECTOR_CONFIG, ...override }),
      (error: unknown) => error instanceof RecommendationInputError && error.field === 'config',
      `expected a classified refusal for ${JSON.stringify(override)}`,
    );
  }
  // `-120` in particular used to produce a recommendation valid at no instant at
  // all with zero reported defects: `EXPIRY_NOT_AFTER_BASIS` is a staleness code,
  // so `checkRecommendation` cannot see it.
});

test('an instant with no explicit offset is refused, and that is a stated divergence from the pilot', () => {
  // #33's `INSTANT_PATTERN` requires `Z` or `±HH:MM` before `Date.parse` is
  // reached, because an offset-less date-time is host-local. The same request
  // used to produce OVERDUE/0.9 under TZ=UTC and DUE_SOON/0.7 under
  // TZ=America/Los_Angeles with an identical inputDigest.
  const set = generateCandidates(
    request({ commitments: [commitment('c-a', { dueAt: '2026-08-19T11:00:00' })] }),
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  );
  assert.deepEqual(set.candidates[0].hardExclusions, ['INVALID_SOURCE_TIME']);

  // The pilot accepts it — bare `Date.parse` — so this is the one class where
  // the two readings differ, and it differs in the safe direction.
  const baseline = scoreBaselineCandidate(
    {
      commitmentId: 'c-a',
      title: 'title',
      confirmed: true,
      status: 'active',
      dueAt: '2026-08-19T11:00:00',
      remindAt: null,
      importance: null,
      explicitEffortMinutes: null,
    },
    new Date(NOW),
  );
  assert.equal(baseline.exclusionReason, null, 'the pilot is expected to accept it; that is the divergence');

  // A malformed `now` is refused outright rather than silently host-local.
  assert.throws(
    () => selectRecommendation(request({ now: '2026-08-19T12:00:00' })),
    (error: unknown) => error instanceof RecommendationInputError && error.field === 'now',
  );
});

test('a blocker this request did not supply leaves an absent observation behind', () => {
  // The rule is unchanged — an unsupplied blocker cannot block, because
  // `BLOCKED_BY_DEPENDENCY` would have to cite an observation that does not
  // exist — but the drop is now visible instead of living only in a comment.
  const input = request({
    commitments: [
      commitment('c-alpha', {
        dueAt: '2026-08-18T09:00:00.000Z',
        importance: 'high',
        blockedByCommitmentIds: ['c-not-supplied', 'c-also-missing', 'c-not-supplied'],
      }),
    ],
  });
  const set = generateCandidates(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  const candidate = set.candidates[0];
  assert.deepEqual(candidate.hardExclusions, []);
  assert.deepEqual(candidate.unresolvedBlockerIds, ['c-also-missing', 'c-not-supplied']);
  assert.equal(candidate.evidence.unresolvedBlockerNodeIds.length, 2, 'a repeated id is one observation');

  for (const nodeId of candidate.evidence.unresolvedBlockerNodeIds) {
    const node = set.evidence.nodes.filter((row) => row.nodeId === nodeId)[0];
    assert.equal(node.kind, 'observed');
    assert.deepEqual(node.claim, { kind: 'absent', reason: 'NO_DATA' });
    assert.equal(node.source.kind, 'commitment');
  }
  assert.deepEqual(checkEvidenceGraph(set.evidence), []);
  // And it survives into the emitted recommendation, so an audit record shows it.
  const selection = selectRecommendation(input);
  assert.deepEqual(selection.defects, []);
  const carried = selection.recommendation.evidence.nodes.filter(
    (node) => candidate.evidence.unresolvedBlockerNodeIds.indexOf(node.nodeId) !== -1,
  );
  assert.equal(carried.length, 2);
});
