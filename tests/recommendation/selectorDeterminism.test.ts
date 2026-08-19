/**
 * Determinism, the input digest, and input immutability (Sprint 08, issue #34).
 *
 * "Same inputs and config produce the same recommendation" is the acceptance
 * criterion easiest to satisfy accidentally and hardest to satisfy honestly. Two
 * calls in one process, with the same array in the same order, agree for a
 * selector that iterates a `Map` and breaks ties by insertion order — and that
 * selector produces a different offer the moment a caller builds its request
 * from a different query. So the assertions here vary the things that must *not*
 * matter:
 *
 *  - the order of every input array, including `blockedByCommitmentIds`,
 *    `reasonCodes` and `Plan.scheduled`;
 *  - the order the object keys were written in at the call site;
 *  - which of two structurally identical requests was built first.
 *
 * Both of Sprint 07's shipped determinism defects had exactly these shapes: a
 * plan echoing a caller's object by reference so key order leaked into
 * serialisation, and a `dependsOn` array order leaking into output through a
 * single unsorted `.find`. Its own determinism tests missed both, because they
 * called twice with the same array.
 *
 * And they pin the thing that must matter: the digest changes when any
 * meaningful field changes. A digest that were merely stable would be perfectly
 * stable at the constant `"0"`, and every replay check built on it would pass
 * while comparing nothing.
 *
 * Arrays are reversed rather than shuffled. A random order would make a failure
 * here unreproducible, which is a poor property for the file whose subject is
 * reproducibility — and would also be a random source in the test for a module
 * whose whole claim is that there is no random source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  canonicalSelectorInput,
  currentFingerprints,
  selectRecommendation,
  selectorInputDigest,
  type CommitmentSnapshot,
  type RecommendationSelectorConfig,
  type RecommendationSelectorInput,
} from '../../lib/recommendation/index.ts';
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
      countsByStatus: { active: 6 },
      openCount: 6,
      overdueCount: 2,
      openCommitmentIds: [],
      overdueCommitmentIds: [],
    }),
    availability: unknownField(),
    load: knownField({ totalUrgencyScore: 20, openCount: 6, overdueCount: 2, dueSoonCount: 3, band: 'heavy' }),
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

const COMMITMENTS: readonly CommitmentSnapshot[] = [
  commitment('c-alpha', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
  commitment('c-bravo', { dueAt: '2026-08-19T14:00:00.000Z', planItemId: 'item-bravo' }),
  commitment('c-charlie', { dueAt: '2026-08-21T09:00:00.000Z', importance: 'high' }),
  commitment('c-delta', { confirmedAt: null, dueAt: '2026-08-18T09:00:00.000Z' }),
  commitment('c-echo', { status: 'completed' }),
  commitment('c-foxtrot', {
    dueAt: '2026-08-19T13:00:00.000Z',
    blockedByCommitmentIds: ['c-alpha', 'c-charlie', 'c-echo'],
  }),
];

const SCORES: readonly PriorityScore[] = [
  {
    version: 'priority-v1',
    commitmentId: 'c-alpha',
    total: 820,
    components: [{ code: 'reason_base', points: 820, evidence: null }],
    reasonCodes: ['OVERDUE', 'HIGH_IMPORTANCE', 'REPEATEDLY_DELAYED'],
    policyVersion: 'policy-v1',
  },
  {
    version: 'priority-v1',
    commitmentId: 'c-charlie',
    total: 410,
    components: [],
    reasonCodes: ['HIGH_IMPORTANCE'],
    policyVersion: 'policy-v1',
  },
];

const PLAN: Plan = {
  version: 'v1',
  schema: 'planning-v1',
  scopeId: 'scope-1',
  horizon: { startsAt: NOW, endsAt: '2026-08-20T00:00:00.000Z' },
  scheduled: [
    {
      itemId: 'item-bravo',
      interval: { startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' },
      reservedInterval: { startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' },
    },
    {
      itemId: 'item-zulu',
      interval: { startsAt: '2026-08-19T15:00:00.000Z', endsAt: '2026-08-19T16:00:00.000Z' },
      reservedInterval: { startsAt: '2026-08-19T15:00:00.000Z', endsAt: '2026-08-19T16:00:00.000Z' },
    },
  ],
  unscheduled: [],
  constraintReasons: [],
  inputDigest: 'plan-digest-1',
};

function request(overrides: Partial<RecommendationSelectorInput> = {}): RecommendationSelectorInput {
  return {
    scopeId: 'scope-1',
    recommendationId: 'rec-1',
    now: NOW,
    lifeState: lifeState(),
    commitments: COMMITMENTS.slice(),
    priorityScores: SCORES.slice(),
    plan: PLAN,
    ...overrides,
  };
}

function serialise(input: RecommendationSelectorInput, config?: RecommendationSelectorConfig): string {
  return JSON.stringify(selectRecommendation(input, config).recommendation);
}

/* ── The output does not depend on how the request was built ─────── */

test('two runs over the same request are byte-identical', () => {
  const input = request();
  assert.equal(serialise(input), serialise(input));
});

test('the request is not mutated by selecting from it', () => {
  const input = request();
  const before = JSON.stringify(input);
  selectRecommendation(input);
  selectRecommendation(input);
  assert.equal(JSON.stringify(input), before, 'the selector mutated the caller\'s request');
});

test('reversing every input array changes nothing about the recommendation', () => {
  const forward = request();
  const reversed = request({
    commitments: COMMITMENTS.slice()
      .reverse()
      .map((snapshot) => ({
        ...snapshot,
        blockedByCommitmentIds: snapshot.blockedByCommitmentIds.slice().reverse(),
      })),
    priorityScores: SCORES.slice()
      .reverse()
      .map((score) => ({ ...score, reasonCodes: score.reasonCodes.slice().reverse() })),
    plan: { ...PLAN, scheduled: PLAN.scheduled.slice().reverse() },
  });
  assert.equal(serialise(reversed), serialise(forward));
  assert.equal(
    selectorInputDigest(reversed, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
    selectorInputDigest(forward, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
  );
});

test('the recommendation does not depend on the order the object keys were written in', () => {
  // `JSON.stringify` emits keys in insertion order, so a module that echoed a
  // caller's object by reference into its output — or hashed one with
  // `JSON.stringify` — would differ here while every value stayed equal. That is
  // the exact defect Sprint 07 shipped.
  const forward = request();
  const backwardKeys: { -readonly [K in keyof RecommendationSelectorInput]: RecommendationSelectorInput[K] } = {
    plan: PLAN,
    priorityScores: SCORES.slice().map((score) => ({
      policyVersion: score.policyVersion,
      reasonCodes: score.reasonCodes,
      components: score.components,
      total: score.total,
      commitmentId: score.commitmentId,
      version: score.version,
    })),
    commitments: COMMITMENTS.slice().map((snapshot) => ({
      decompositionStepId: snapshot.decompositionStepId,
      decompositionProposalId: snapshot.decompositionProposalId,
      planItemId: snapshot.planItemId,
      blockedByCommitmentIds: snapshot.blockedByCommitmentIds,
      importance: snapshot.importance,
      remindAt: snapshot.remindAt,
      dueAt: snapshot.dueAt,
      confirmedAt: snapshot.confirmedAt,
      status: snapshot.status,
      commitmentId: snapshot.commitmentId,
    })),
    lifeState: lifeState(),
    now: NOW,
    recommendationId: 'rec-1',
    scopeId: 'scope-1',
  };
  // The plan is part of this, and it was the half that was missing. The earlier
  // version of this test rebuilt the keys of `commitments` and `priorityScores`
  // and passed `plan: PLAN` through untouched — so the one object the selector
  // stored by reference was the one object whose key order was never varied.
  backwardKeys.plan = {
    ...PLAN,
    scheduled: PLAN.scheduled.map((row) => ({
      reservedInterval: { endsAt: row.reservedInterval.endsAt, startsAt: row.reservedInterval.startsAt },
      interval: { endsAt: row.interval.endsAt, startsAt: row.interval.startsAt },
      itemId: row.itemId,
    })),
  };
  assert.equal(serialise(backwardKeys), serialise(forward));
  assert.equal(
    canonicalSelectorInput(backwardKeys, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
    canonicalSelectorInput(forward, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
  );
});

test('a candidate\'s blocker list order does not leak into the output', () => {
  // Sprint 07's second shipped defect verbatim: a `dependsOn` order reaching the
  // output through one unsorted lookup. The blocked node cites its blockers, so
  // the order would surface in `derivedFrom`.
  const blockers = ['c-alpha', 'c-charlie', 'c-echo'];
  const build = (order: readonly string[]): string =>
    JSON.stringify(
      selectRecommendation(
        request({
          commitments: COMMITMENTS.map((snapshot) =>
            snapshot.commitmentId === 'c-foxtrot'
              ? { ...snapshot, blockedByCommitmentIds: order.slice() }
              : snapshot,
          ),
        }),
      ).recommendation.evidence,
    );
  assert.equal(build(blockers.slice().reverse()), build(blockers));
  assert.equal(build([blockers[1], blockers[0], blockers[2]]), build(blockers));
});

test('a tie on every ordering key is broken by the canonical order, not by arrival', () => {
  // Two commitments identical in everything the order reads except their ids.
  const twin = (id: string): CommitmentSnapshot =>
    commitment(id, { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' });
  const forward = selectRecommendation(
    request({ commitments: [twin('c-aaa'), twin('c-bbb')], priorityScores: [], plan: null }),
  );
  const backward = selectRecommendation(
    request({ commitments: [twin('c-bbb'), twin('c-aaa')], priorityScores: [], plan: null }),
  );
  assert.equal(JSON.stringify(forward.recommendation), JSON.stringify(backward.recommendation));
  if (forward.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  const options = forward.recommendation.outcome === 'offered'
    && forward.recommendation.options.kind === 'choice'
    ? forward.recommendation.options.options
    : [];
  assert.deepEqual(options.map((option) => option.action.commitmentId), ['c-aaa', 'c-bbb']);
});

test('fingerprints are stable across runs and independent of input order', () => {
  const forward = currentFingerprints(request(), DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  const reversed = currentFingerprints(
    request({ commitments: COMMITMENTS.slice().reverse() }),
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  );
  assert.deepEqual(
    Object.keys(forward).sort().map((key) => `${key}=${forward[key]}`),
    Object.keys(reversed).sort().map((key) => `${key}=${reversed[key]}`),
  );
});

/* ── The digest ──────────────────────────────────────────────────── */

test('the digest is a hex sha256 and is stable across calls', () => {
  const input = request();
  const digest = selectorInputDigest(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, selectorInputDigest(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG));
  assert.equal(digest, selectRecommendation(input).recommendation.inputDigest);
});

test('the digest is versioned, so a change to the encoding cannot pass as a change to the input', () => {
  assert.match(
    canonicalSelectorInput(request(), DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
    /"digestVersion":"recommendation-digest-v1"/,
  );
});

test('the digest names the run\'s inputs, not the run', () => {
  // Two replays of one request must report the same inputs. Folding
  // `recommendationId` in would make that impossible and every equality check
  // built on the digest would pass vacuously by never matching.
  const first = selectorInputDigest(request({ recommendationId: 'rec-1' }), DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  const second = selectorInputDigest(request({ recommendationId: 'rec-2' }), DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  assert.equal(first, second);
});

test('every meaningful change to the request changes the digest', () => {
  const base = request();
  const baseDigest = selectorInputDigest(base, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  const variants: readonly [string, RecommendationSelectorInput][] = [
    ['scopeId', request({ scopeId: 'scope-2' })],
    ['now', request({ now: '2026-08-19T12:00:01.000Z' })],
    ['a commitment status', request({
      commitments: COMMITMENTS.map((row, index) => (index === 0 ? { ...row, status: 'deferred' } : row)),
    })],
    ['a due instant', request({
      commitments: COMMITMENTS.map((row, index) => (index === 0 ? { ...row, dueAt: '2026-08-18T09:00:01.000Z' } : row)),
    })],
    ['importance', request({
      commitments: COMMITMENTS.map((row, index) => (index === 1 ? { ...row, importance: 'low' } : row)),
    })],
    ['a blocker', request({
      commitments: COMMITMENTS.map((row, index) =>
        index === 5 ? { ...row, blockedByCommitmentIds: ['c-alpha'] } : row,
      ),
    })],
    ['a priority total', request({
      priorityScores: SCORES.map((row, index) => (index === 0 ? { ...row, total: 821 } : row)),
    })],
    ['a policy version', request({
      priorityScores: SCORES.map((row, index) => (index === 0 ? { ...row, policyVersion: 'policy-v2' } : row)),
    })],
    ['the plan digest', request({ plan: { ...PLAN, inputDigest: 'plan-digest-2' } })],
    ['a plan slot', request({
      plan: {
        ...PLAN,
        scheduled: PLAN.scheduled.map((row, index) =>
          index === 0
            ? { ...row, interval: { startsAt: '2026-08-19T13:05:00.000Z', endsAt: '2026-08-19T13:15:00.000Z' } }
            : row,
        ),
      },
    })],
    ['dropping the plan', request({ plan: null })],
    ['the projection\'s computedAt', request({
      lifeState: { ...lifeState(), computedAt: '2026-08-19T11:31:00.000Z' },
    })],
    ['the projection\'s load band', request({
      lifeState: {
        ...lifeState(),
        load: knownField({ totalUrgencyScore: 20, openCount: 6, overdueCount: 2, dueSoonCount: 3, band: 'light' }),
      },
    })],
    ['a dropped commitment', request({ commitments: COMMITMENTS.slice(1) })],
  ];
  const seen = new Map<string, string>([[baseDigest, 'base']]);
  for (const [label, variant] of variants) {
    const digest = selectorInputDigest(variant, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
    const collision = seen.get(digest);
    assert.equal(collision, undefined, `changing ${label} collided with ${String(collision)}`);
    seen.set(digest, label);
  }
});

test('every field of the config changes the digest', () => {
  const input = request();
  const baseDigest = selectorInputDigest(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  const overrides: readonly Partial<RecommendationSelectorConfig>[] = [
    { enabled: false },
    { dueTodayHours: 12 },
    { dueSoonHours: 72 },
    { planSlotImminentMinutes: 30 },
    { quickWinMaxMinutes: 30 },
    { ttlMinutes: 30 },
    { maxInputAgeMinutes: 60 },
  ];
  const seen = new Set<string>([baseDigest]);
  for (const override of overrides) {
    const digest = selectorInputDigest(input, {
      ...DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
      ...override,
    });
    assert.equal(seen.has(digest), false, `config field ${Object.keys(override)[0]} does not reach the digest`);
    seen.add(digest);
  }
  assert.equal(seen.size, overrides.length + 1);
});

test('a non-finite number is encoded distinguishably from an absent one', () => {
  const nan = request({
    priorityScores: SCORES.map((row, index) => (index === 0 ? { ...row, total: Number.NaN } : row)),
  });
  const infinity = request({
    priorityScores: SCORES.map((row, index) => (index === 0 ? { ...row, total: Number.POSITIVE_INFINITY } : row)),
  });
  const zero = request({
    priorityScores: SCORES.map((row, index) => (index === 0 ? { ...row, total: 0 } : row)),
  });
  const digests = [nan, infinity, zero].map((variant) =>
    selectorInputDigest(variant, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
  );
  assert.equal(new Set(digests).size, 3, 'NaN, Infinity and 0 must not hash alike');
  assert.match(
    canonicalSelectorInput(nan, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
    /"nonFinite":"NaN"/,
  );
});

test('changing the config changes the recommendation, and the recommendation says so through its digest', () => {
  const input = request();
  const wide = selectRecommendation(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG);
  const narrow = selectRecommendation(input, {
    ...DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
    dueSoonHours: 1,
    dueTodayHours: 1,
  });
  assert.notEqual(wide.recommendation.inputDigest, narrow.recommendation.inputDigest);
  assert.notEqual(JSON.stringify(wide.recommendation), JSON.stringify(narrow.recommendation));
});

/* ── The output shares no state with the request ─────────────────── */

test('a plan interval is copied by value, never aliased into the offer', () => {
  // Storing `placed.interval` by reference carried the caller's object all the
  // way into `RecommendedAction.slot`. Three consequences, all of which a
  // reversed-array test is blind to: key order leaked into
  // `JSON.stringify(recommendation)` while `inputDigest` stayed equal, because
  // the canonical encoder re-orders; any extra property the caller had hung on
  // the interval was copied verbatim into the output; and the output shared
  // mutable state with the input while the module claimed purity.
  const slot = { startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' };
  const input = request({
    commitments: [commitment('c-alpha', { dueAt: '2026-08-19T13:00:00.000Z', importance: 'high', planItemId: 'item-alpha' })],
    priorityScores: [],
    plan: {
      ...PLAN,
      scheduled: [{ itemId: 'item-alpha', interval: slot, reservedInterval: slot }],
    },
  });
  const selection = selectRecommendation(input);
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  const option = selection.recommendation.options.kind === 'choice'
    ? selection.recommendation.options.options[0]
    : selection.recommendation.options.option;
  assert.equal(option.action.kind, 'schedule');
  if (option.action.kind !== 'schedule') return;
  assert.notEqual(option.action.slot, slot, 'the offer aliases the caller\'s interval object');
  assert.deepEqual(option.action.slot, slot);
});

test('an extra property on a plan interval does not reach the output', () => {
  const leaky = {
    startsAt: '2026-08-19T13:00:00.000Z',
    endsAt: '2026-08-19T13:10:00.000Z',
    label: 'call-dr.cohen-about-the-biopsy',
  } as unknown as Plan['scheduled'][number]['interval'];
  const selection = selectRecommendation(
    request({
      commitments: [commitment('c-alpha', { dueAt: '2026-08-19T13:00:00.000Z', importance: 'high', planItemId: 'item-alpha' })],
      priorityScores: [],
      plan: { ...PLAN, scheduled: [{ itemId: 'item-alpha', interval: leaky, reservedInterval: leaky }] },
    }),
  );
  assert.equal(
    JSON.stringify(selection.recommendation).indexOf('call-dr.cohen'),
    -1,
    'a caller property on the interval was copied into the output',
  );
});

test('the plan interval key order changes nothing, and the digest agrees', () => {
  const build = (interval: Record<string, string>): RecommendationSelectorInput =>
    request({
      commitments: [commitment('c-alpha', { dueAt: '2026-08-19T13:00:00.000Z', importance: 'high', planItemId: 'item-alpha' })],
      priorityScores: [],
      plan: {
        ...PLAN,
        scheduled: [
          {
            itemId: 'item-alpha',
            interval: interval as unknown as Plan['scheduled'][number]['interval'],
            reservedInterval: interval as unknown as Plan['scheduled'][number]['interval'],
          },
        ],
      },
    });
  const forward = build({ startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' });
  const backward = build({ endsAt: '2026-08-19T13:10:00.000Z', startsAt: '2026-08-19T13:00:00.000Z' });
  // The digest already agreed before the fix — the canonical encoder re-orders —
  // which is exactly why the mismatch was invisible to a digest-only assertion.
  assert.equal(
    selectorInputDigest(forward, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
    selectorInputDigest(backward, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
  );
  assert.equal(serialise(backward), serialise(forward));
});
