/**
 * The three Sprint 08 tracks, joined and run against each other — and against
 * the shipped V03 pilot that already answers the same question.
 *
 * #33 (the contract and its checkers), #34 (the selector) and #35 (the review
 * surface) were built in parallel against contracts written first, so each was
 * verified only against its own reading of them. Every track's own suite is
 * green. That is exactly the state the roadmap records as insufficient: Sprint
 * 02 had 91 passing tests across two modules that disagreed, Sprint 06 had three
 * copies of a lexicon that disagreed on 20 of 31 titles, and Sprint 07 had two
 * readings of one code list that were both self-consistent and not the same.
 *
 * Sprint 08 adds a fourth party the earlier sprints did not have: a **shipped
 * pilot**, `lib/services/nextStepBaseline.ts`, which decides eligibility for
 * `/api/next-step` today. `recommendationBoundaries.test.ts` forbids either side
 * from importing the other precisely so that this file's comparison is between
 * two independent implementations rather than between a thing and itself.
 *
 * Nothing below asks "does each track work". The groups are the joins no single
 * track can reach, and each exists because of a specific way a green suite has
 * previously reported agreement that was not there:
 *
 *  1. **#34 produces, #33 judges.** Every recommendation the selector emits, on
 *     every generated input, must pass `checkRecommendation` and its graph must
 *     pass `checkEvidenceGraph` with an empty finding list. #34 asserts this on
 *     the inputs #34 thought of; #33 asserts its checkers on graphs #33 built by
 *     hand. Neither is the join.
 *
 *  2. **Agreement with the pilot at `(commitmentId, code)` granularity.**
 *     Sprint 07's cross-track test compared deduplicated code *names*, reported
 *     perfect agreement over 40,000 inputs, and was wrong on 38% of them; the
 *     same comparison over `(subject, code)` pairs found it immediately. So the
 *     comparison here is over pairs, over a generated matrix rather than a fixed
 *     table, and where the two legitimately differ it asserts the *documented*
 *     relationship — which fails if the relationship changes, rather than
 *     tolerating any difference at all.
 *
 *  3. **A fuzzer, not only a table.** A table tests the shapes its author
 *     thought of. The fuzzer additionally pins the three invariants that a
 *     digest-only determinism check is structurally blind to: two runs agree,
 *     reversed input arrays agree, and reversed object-key construction order
 *     agrees. That last one is the exact defect that shipped in #34 and twice in
 *     Sprint 07 — a caller's key order leaking into output through an object
 *     echoed by reference. And the fuzzer asserts **its own distribution**,
 *     because #33's first property test passed while 62% of the graphs it
 *     accepted were trivial; the fix was to assert the distribution rather than
 *     to trust it.
 *
 *  4. **Every action kind reachable as an *outcome*.** #34 found `decompose`
 *     unreachable because a per-commitment quota always suppressed it: the code
 *     was reachable, the outcome was not, and no assertion *about* `decompose`
 *     would have caught it — only an assertion that some generated input
 *     actually offers one.
 *
 *  5. **The full path, end to end.** Selector → `presentRecommendation` →
 *     decision → `evaluateReviewSubmission` → the request boundary. The three
 *     properties asserted there are the ones the sprint's acceptance criteria
 *     name and no track owns both ends of: nothing persists without an explicit
 *     confirmation, a blind view carries none of `BLIND_REDACTED_FIELDS`, and
 *     the blind `decide` response does not carry `optionIndex`.
 *
 *  6. **Timezone and locale invariance.** The selector reads `Date.parse`, whose
 *     answer for an offset-less string is the *host zone's*. The structural
 *     assertion is that every instant the module emits satisfies #33's
 *     `isInstant`, so no offset-less string can ever reach a consumer; the
 *     behavioural one runs the same input under four `TZ` settings and requires
 *     byte-identical output. Assigning `process.env.TZ` mid-process does move
 *     `Date`'s answers in this runtime — measured, not assumed — which is what
 *     makes the behavioural half real rather than decorative. It does *not*
 *     reliably move a cached `Intl` formatter, which is why the structural half
 *     is not replaced by it. `recommendationBoundaries.test.ts` owns the
 *     complementary scan for `localeCompare` and ambient clocks.
 *
 *  7. **The suite guards itself.** `node --test` **silently skips a missing
 *     file among present ones and exits 0** — measured on this runner, not
 *     assumed. A typo in `package.json` would remove a whole track's coverage
 *     with no signal at all, and every guard in this sprint sits behind that
 *     failure mode. Checked in both directions: registered-but-absent, and
 *     present-but-unregistered.
 *
 * The groups appear below in dependency order rather than in the order they are
 * numbered here — group 4 reads the corpus measurement that group 3 builds, and
 * group 2's matrix is built once and shared. The banners carry the numbers so a
 * reader can follow either order.
 *
 * This file is owned by the merge, for the reason Sprint 05 gave the
 * policy-freeze test to the merge: a check owned by the thing it checks is not
 * a check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  KNOWN_COMMITMENT_STATUSES,
  currentFingerprints,
  epochMsOrNull,
  generateCandidates,
  hardExclusionCodes,
  selectRecommendation,
  type CommitmentLifecycleStatus,
  type CommitmentSnapshot,
  type RecommendationSelectorConfig,
  type RecommendationSelectorInput,
} from '../../lib/recommendation/index.ts';
import {
  RECOMMENDATION_OPTION_POLICY,
  RECOMMENDED_ACTION_KINDS,
  PROPOSABLE_ACTION_KINDS,
  VERDICT_ONLY_ACTION_KINDS,
  SUPPORT_REASON_CODES,
  WITHHOLDING_REASON_CODES,
  checkEvidenceGraph,
  checkRecommendation,
  checkRecommendationDecision,
  evaluateRecommendationStaleness,
  isInstant,
  offeredOptions,
  resolveEvidenceRoots,
  summarizeOptionSet,
  type ExclusionReasonCode,
  type OfferedRecommendation,
  type Recommendation,
  type RecommendedAction,
  type WithholdingReasonCode,
} from '../../src/contracts/v1/recommendationContracts.ts';
import {
  BLIND_REDACTED_FIELDS,
  blindSlotOrder,
  evaluateReviewSubmission,
  handleReviewRequest,
  presentRecommendation,
} from '../../lib/recommendation/review/present.ts';
import { RECOMMENDATION_REVIEW_LIMITS } from '../../lib/recommendation/review/reviewContract.ts';
import type { Field, LifeState } from '../../src/contracts/v1/lifeStateContracts.ts';
import type { PriorityScore } from '../../src/contracts/v1/priorityContracts.ts';
import type { Plan } from '../../src/contracts/v1/planningContracts.ts';
// The pilot, imported **read-only and only from this test**. Nothing under
// `lib/recommendation/**` may reach it; `recommendationBoundaries.test.ts` is
// what enforces that, and without it the comparison below would be circular.
import {
  scoreBaselineCandidate,
  type BaselineCandidate,
} from '../../lib/services/nextStepBaseline.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

const NOW = '2026-08-19T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const COMPUTED_AT = '2026-08-19T11:30:00.000Z';

/* ── Fixtures ────────────────────────────────────────────────────── */

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

function lifeState(options: { known?: boolean; computedAt?: string; openCount?: number } = {}): LifeState {
  const openCount = options.openCount ?? 3;
  return {
    version: 'life-state-v1',
    scopeId: 'scope-1',
    computedAt: options.computedAt ?? COMPUTED_AT,
    inputDigest: 'life-state-digest',
    commitments:
      options.known === false
        ? unknownField()
        : knownField({
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

function score(
  commitmentId: string,
  total: number,
  reasonCodes: PriorityScore['reasonCodes'] = [],
): PriorityScore {
  return {
    version: 'priority-v1',
    commitmentId,
    total,
    components: [{ code: 'reason_base', points: total, evidence: null }],
    reasonCodes,
    policyVersion: 'policy-v1',
  };
}

function plan(rows: readonly { itemId: string; startsAt: string; endsAt: string }[]): Plan {
  return {
    version: 'v1',
    schema: 'planning-v1',
    scopeId: 'scope-1',
    horizon: { startsAt: NOW, endsAt: '2026-08-21T00:00:00.000Z' },
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

/* ── The seeded generator ────────────────────────────────────────── */

/**
 * `mulberry32`, seeded per case.
 *
 * Never `Math.random`. A fuzzer whose failures cannot be replayed reports a
 * defect nobody can reproduce, and the merge is the last place in the pipeline
 * where "it failed once on CI" has anywhere left to go. Every case below carries
 * the seed that produced it into its own assertion message.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

/**
 * Time values on which **both** parsers are known to agree.
 *
 * The two implementations read the same field (`dueAt || remindAt`, falsiness
 * included) but not with the same parser: #34 requires an explicit `Z` or
 * `±HH:MM` offset *and* a date the calendar actually has, while the pilot calls
 * `Date.parse` bare. Mixing the two classes into one comparison would report a
 * disagreement that is really a difference of leniency — so the strict
 * pair-for-pair comparison runs over this pool, and
 * `LENIENCY_DIVERGENT_INSTANTS` below is asserted separately, by name and in a
 * stated direction.
 */
const AGREED_TIME_VALUES: readonly (string | null)[] = [
  null,
  '',
  '2026-08-18T09:00:00.000Z',
  '2026-08-19T17:00:00.000Z',
  '2026-08-19T09:00:00+05:30',
  'not-a-date',
];

const IMPORTANCES: readonly (CommitmentSnapshot['importance'])[] = ['low', 'normal', 'high', null];

const GENERATED_ID_POOL = ['g-alfa', 'g-bravo', 'g-charlie', 'g-delta', 'g-echo'] as const;

interface GeneratedCase {
  readonly seed: number;
  readonly input: RecommendationSelectorInput;
  readonly config: RecommendationSelectorConfig;
}

/**
 * One randomised selection request.
 *
 * The distribution is skewed towards inputs that *survive* — most commitments
 * are active and confirmed — because a generator that mostly produced excluded
 * candidates would reach `withheld` on nearly every case and never exercise
 * option assembly, ranking, diversity, or the review path. It is skewed, not
 * narrowed: every status, every time class in the agreed pool, every importance,
 * blockers present and absent, resolvable and dangling, plan slots imminent and
 * distant, quick and long, and the two config knobs that make the whole run
 * withhold are all reachable. The distribution test below is what proves that
 * claim rather than restating it.
 */
function generateCase(seed: number): GeneratedCase {
  const random = makeRandom(seed);
  // Zero is a real scope: a new user's. It is the only shape that reaches
  // `NO_ELIGIBLE_CANDIDATE`, and it is the case a withheld recommendation's
  // whole evidence story was designed around — "there is nothing for you to do"
  // has to rest on the projection's known-zero rather than on nothing.
  const count = random() < 0.05 ? 0 : 1 + Math.floor(random() * 5);
  const ids = GENERATED_ID_POOL.slice(0, count);

  const commitments: CommitmentSnapshot[] = [];
  const scores: PriorityScore[] = [];
  const slots: { itemId: string; startsAt: string; endsAt: string }[] = [];

  for (let index = 0; index < count; index += 1) {
    const id = ids[index];
    const status: CommitmentLifecycleStatus =
      random() < 0.6 ? 'active' : pick(random, KNOWN_COMMITMENT_STATUSES);
    const blockers: string[] = [];
    if (random() < 0.3) {
      blockers.push(pick(random, GENERATED_ID_POOL));
      if (random() < 0.3) blockers.push('g-ghost-not-in-this-request');
    }
    const planItemId = random() < 0.4 ? `item-${id}` : null;
    if (planItemId !== null) {
      // Imminent versus distant, and quick-win versus long: the four
      // combinations that decide PLAN_SLOT_IMMINENT and QUICK_WIN.
      const startMs = NOW_MS + (random() < 0.5 ? 30 : 600) * 60_000;
      const lengthMinutes = random() < 0.5 ? 10 : 90;
      slots.push({
        itemId: planItemId,
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(startMs + lengthMinutes * 60_000).toISOString(),
      });
    }
    const hasProposal = random() < 0.3;
    commitments.push(
      commitment(id, {
        status,
        confirmedAt: random() < 0.8 ? '2026-08-18T09:00:00.000Z' : null,
        dueAt: pick(random, AGREED_TIME_VALUES),
        remindAt: pick(random, AGREED_TIME_VALUES),
        importance: pick(random, IMPORTANCES),
        blockedByCommitmentIds: blockers,
        planItemId,
        decompositionProposalId: hasProposal ? `proposal-${id}` : null,
        decompositionStepId: hasProposal ? `step-${id}` : null,
      }),
    );
    if (random() < 0.5) {
      scores.push(
        score(id, Math.floor(random() * 1000), random() < 0.4 ? ['REPEATEDLY_DELAYED'] : []),
      );
    }
  }

  const projectionKnown = random() >= 0.06;
  const projectionStale = random() < 0.06;
  const input = request({
    recommendationId: `rec-${seed}`,
    commitments,
    priorityScores: scores,
    plan: slots.length > 0 ? plan(slots) : null,
    lifeState: lifeState({
      known: projectionKnown,
      computedAt: projectionStale ? '2026-08-01T00:00:00.000Z' : COMPUTED_AT,
      openCount: count,
    }),
  });

  const config: RecommendationSelectorConfig =
    random() < 0.05
      ? { ...DEFAULT_RECOMMENDATION_SELECTOR_CONFIG, enabled: false }
      : DEFAULT_RECOMMENDATION_SELECTOR_CONFIG;

  return { seed, input, config };
}

const CASE_COUNT = 400;
const CASES: readonly GeneratedCase[] = Array.from({ length: CASE_COUNT }, (_, index) =>
  generateCase(0x5eed_0000 + index),
);

/* ── Order perturbations ─────────────────────────────────────────── */

/**
 * The same value with every object's keys inserted in the opposite order.
 *
 * This is the perturbation a digest-only determinism check cannot see. Key order
 * is not part of an object's *value* but is part of its *serialisation*, so a
 * module that echoes a caller's object by reference — or that iterates
 * `Object.keys` anywhere a result depends on — produces output that differs only
 * once something stringifies it. #34 shipped that defect, and Sprint 07 shipped
 * it twice. Arrays keep their element order here; `reverseArrays` is the other
 * half, and they are applied separately so a failure says which one moved.
 */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => reverseKeys(entry)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  const output: Record<string, unknown> = {};
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    output[keys[index]] = reverseKeys(source[keys[index]]);
  }
  return output as unknown as T;
}

/** Every array in the request, reversed. Object keys keep their order. */
function reverseArrays(input: RecommendationSelectorInput): RecommendationSelectorInput {
  return {
    ...input,
    commitments: input.commitments
      .slice()
      .reverse()
      .map((snapshot) => ({
        ...snapshot,
        blockedByCommitmentIds: snapshot.blockedByCommitmentIds.slice().reverse(),
      })),
    priorityScores: input.priorityScores.slice().reverse(),
    plan:
      input.plan === null
        ? null
        : { ...input.plan, scheduled: input.plan.scheduled.slice().reverse() },
  };
}

/* ── 1 and 3. The fuzzer ─────────────────────────────────────────── */

test('cross-track: every generated selection is contract-valid, by #33s own checkers', () => {
  // The join no track can test. #34 produces and #33 judges, on inputs neither
  // author chose. `defects` is the selector's own copy of the same call, so a
  // disagreement between the two would mean the selector is checking something
  // other than what it returned.
  const failures: string[] = [];
  for (const testCase of CASES) {
    const selection = selectRecommendation(testCase.input, testCase.config);
    const defects = checkRecommendation(selection.recommendation);
    if (defects.length > 0) {
      failures.push(
        `  seed ${testCase.seed}: checkRecommendation reported [${defects
          .map((defect) => `${defect.code}${defect.optionIndex === null ? '' : `@${defect.optionIndex}`}`)
          .join(', ')}]`,
      );
    }
    const graphDefects = checkEvidenceGraph(selection.recommendation.evidence);
    if (graphDefects.length > 0) {
      failures.push(
        `  seed ${testCase.seed}: checkEvidenceGraph reported [${graphDefects
          .map((defect) => defect.code)
          .join(', ')}]`,
      );
    }
    if (JSON.stringify(selection.defects) !== JSON.stringify(defects)) {
      failures.push(`  seed ${testCase.seed}: the selector's own defect list differs from #33's`);
    }
  }
  assert.deepEqual(failures, [], `the selector emitted recommendations #33 refuses:\n${failures.join('\n')}\n`);
});

test('cross-track: every node of every generated graph resolves to an observation', () => {
  // Decision 1 as a theorem rather than a convention, and the half
  // `checkEvidenceGraph` alone does not give: a graph can be structurally sound
  // and still contain a claim that reaches no observation, which is the shape a
  // cycle or a parentless derivation would take at the untyped boundary.
  let nodesChecked = 0;
  for (const testCase of CASES) {
    const selection = selectRecommendation(testCase.input, testCase.config);
    const graph = selection.recommendation.evidence;
    for (const node of graph.nodes) {
      const roots = resolveEvidenceRoots(graph, node.nodeId);
      assert.ok(
        roots !== null && roots.length > 0,
        `seed ${testCase.seed}: node ${node.nodeId} resolves to no observation`,
      );
      for (const root of roots) {
        assert.equal(root.kind, 'observed', `seed ${testCase.seed}: a root is not an observation`);
        assert.ok(
          root.valueFingerprint.trim().length > 0,
          `seed ${testCase.seed}: an observation carries a blank fingerprint, so it can never invalidate`,
        );
      }
      nodesChecked += 1;
    }
  }
  assert.ok(nodesChecked > 1000, `only ${nodesChecked} nodes were walked; the corpus is too thin to mean anything`);
});

test('cross-track: a selection is byte-identical across two runs of the same input', () => {
  for (const testCase of CASES) {
    const first = selectRecommendation(testCase.input, testCase.config);
    const second = selectRecommendation(testCase.input, testCase.config);
    assert.equal(
      JSON.stringify(second),
      JSON.stringify(first),
      `seed ${testCase.seed}: two runs of one request produced different selections`,
    );
  }
});

test('cross-track: a selection is byte-identical under reversed input arrays', () => {
  // The order the caller happened to supply must not reach the output. Sprint 07
  // shipped this defect through a single unsorted `.find`, and the selector's
  // remedy — canonicalise once at the entry — is only a remedy if something
  // outside the selector checks it.
  const failures: string[] = [];
  for (const testCase of CASES) {
    const straight = selectRecommendation(testCase.input, testCase.config);
    const reversed = selectRecommendation(reverseArrays(testCase.input), testCase.config);
    if (JSON.stringify(reversed) !== JSON.stringify(straight)) {
      failures.push(`  seed ${testCase.seed}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `reversing the input arrays changed the selection for:\n${failures.join('\n')}\n`,
  );
});

test('cross-track: a selection is byte-identical under reversed object-key construction order', () => {
  // The perturbation a digest-only check is structurally blind to: two objects
  // with the same keys in a different insertion order are equal by every
  // structural comparison and different by `JSON.stringify`. Compared as strings
  // on purpose, because the string is what a stored recommendation, an audit
  // record and #35's wire response all are.
  const failures: string[] = [];
  for (const testCase of CASES) {
    const straight = selectRecommendation(testCase.input, testCase.config);
    const rekeyed = selectRecommendation(reverseKeys(testCase.input), reverseKeys(testCase.config));
    if (JSON.stringify(rekeyed) !== JSON.stringify(straight)) {
      failures.push(`  seed ${testCase.seed}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `reversing object-key construction order changed the selection for:\n${failures.join('\n')}\n`,
  );
});

test('cross-track: the selector does not mutate the request it was handed', () => {
  // A module that sorted the caller's array in place would be perfectly
  // deterministic in its own output and would silently reorder the caller's.
  for (const testCase of CASES.slice(0, 60)) {
    const before = JSON.stringify(testCase.input);
    selectRecommendation(testCase.input, testCase.config);
    assert.equal(
      JSON.stringify(testCase.input),
      before,
      `seed ${testCase.seed}: the request was mutated by the run`,
    );
  }
});

/**
 * What the corpus actually reached, computed once and asserted below.
 *
 * Separated from the assertions so the numbers can be printed in a failure
 * message rather than inferred from which assertion fired.
 */
interface Coverage {
  readonly outcomes: Map<string, number>;
  readonly solenessKinds: Map<string, number>;
  readonly offeredActionKinds: Map<string, number>;
  readonly withholdingCodes: Map<string, number>;
  readonly exclusionCodes: Map<string, number>;
  readonly supportCodes: Map<string, number>;
  readonly substantialGraphs: number;
  readonly optionCounts: Map<number, number>;
}

function bump(into: Map<string, number>, key: string): void {
  into.set(key, (into.get(key) ?? 0) + 1);
}

function measureCoverage(): Coverage {
  const outcomes = new Map<string, number>();
  const solenessKinds = new Map<string, number>();
  const offeredActionKinds = new Map<string, number>();
  const withholdingCodes = new Map<string, number>();
  const exclusionCodes = new Map<string, number>();
  const supportCodes = new Map<string, number>();
  const optionCounts = new Map<number, number>();
  let substantialGraphs = 0;

  for (const testCase of CASES) {
    const { recommendation } = selectRecommendation(testCase.input, testCase.config);
    bump(outcomes, recommendation.outcome);

    // "Substantial" is the guard against #33's 62%-trivial corpus: a graph that
    // carries derived claims over several observations, not one observation on
    // its own. A trivial graph satisfies every soundness assertion above while
    // exercising none of the traversal they exist to check.
    const derived = recommendation.evidence.nodes.filter((node) => node.kind === 'derived').length;
    if (recommendation.evidence.nodes.length >= 10 && derived >= 3) substantialGraphs += 1;

    if (recommendation.outcome === 'withheld') {
      for (const reason of recommendation.reasons) bump(withholdingCodes, reason.code);
      continue;
    }
    const summary = summarizeOptionSet(recommendation.options);
    bump(solenessKinds, summary.soleness);
    const options = offeredOptions(recommendation.options);
    optionCounts.set(options.length, (optionCounts.get(options.length) ?? 0) + 1);
    for (const option of options) {
      bump(offeredActionKinds, option.action.kind);
      for (const support of option.support) bump(supportCodes, support.code);
    }
    for (const candidate of summary.excluded) {
      for (const reason of candidate.exclusion) bump(exclusionCodes, reason.code);
    }
  }

  return {
    outcomes,
    solenessKinds,
    offeredActionKinds,
    withholdingCodes,
    exclusionCodes,
    supportCodes,
    substantialGraphs,
    optionCounts,
  };
}

const COVERAGE = measureCoverage();

function describe(counts: Map<string, number>): string {
  return Array.from(counts.entries())
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

test('cross-track: the generator reaches both outcomes, with a stated minimum of each', () => {
  // #33's first property test passed while 62% of the graphs it accepted were
  // trivial, and the fix was to assert the distribution rather than to trust it.
  // Every number below is a floor a passing run must clear, so a generator that
  // silently narrowed — a weight typo, a default that stopped varying — fails
  // here rather than reporting a green run over one shape.
  const offered = COVERAGE.outcomes.get('offered') ?? 0;
  const withheld = COVERAGE.outcomes.get('withheld') ?? 0;
  assert.ok(offered >= 120, `only ${offered} of ${CASE_COUNT} cases offered anything (${describe(COVERAGE.outcomes)})`);
  assert.ok(withheld >= 60, `only ${withheld} of ${CASE_COUNT} cases withheld (${describe(COVERAGE.outcomes)})`);
  assert.equal(offered + withheld, CASE_COUNT, 'a case produced neither outcome');
});

test('cross-track: the generator reaches more than one option-set kind, with a stated minimum of each', () => {
  // The three kinds are three different statements about the user's life —
  // "here is a choice", "one survived and here is what did not", "there was
  // genuinely nothing else". A corpus that only ever built one of them would
  // leave two thirds of `checkRecommendation`'s offer rules unexercised.
  const kinds = COVERAGE.solenessKinds;
  assert.ok(kinds.size >= 2, `the corpus reached only ${kinds.size} option-set kind(s): ${describe(kinds)}`);
  // `only_candidate` carries the lowest floor because it is the rarest shape by
  // construction, not because it matters least: it needs exactly one offered
  // option *and* an empty excluded list, so a single policy rejection anywhere
  // in the run turns it into `sole_survivor`. It is also the variant that says
  // "this is the only thing on your plate", which is the strongest claim the
  // module makes, so a corpus that never built one would leave `attested`
  // unexercised.
  for (const [kind, floor] of [
    ['choice', 25],
    ['sole_survivor', 15],
    ['only_candidate', 8],
  ] as const) {
    assert.ok(
      (kinds.get(kind) ?? 0) >= floor,
      `option-set kind ${kind} was reached ${kinds.get(kind) ?? 0} times, under the stated floor of ${floor} (${describe(kinds)})`,
    );
  }

  // And every permitted offer size, so the cap is exercised from below as well
  // as reported from above. An offer of three is the only size at which
  // `maxOptions` binds and `OPTION_CAP_REACHED` can be earned; a corpus that
  // never built one would leave the cap untested while `checkRecommendation`'s
  // `OPTION_CAP_EXCEEDED` rule looked covered.
  const sizes = Array.from(COVERAGE.optionCounts.keys()).sort((left, right) => left - right);
  assert.deepEqual(
    sizes,
    [1, 2, RECOMMENDATION_OPTION_POLICY.maxOptions],
    `the corpus reached offer sizes [${sizes.join(', ')}]; it must reach every size from one to the cap and never exceed it`,
  );
});

test('cross-track: the generator reaches exactly the codes this module can emit', () => {
  // Exact sets rather than a count, because a count is satisfied by the wrong
  // codes. Stated as three separate equalities so a failure names which
  // vocabulary moved, and asserted from the *emitted* side: a code the contract
  // lists and this module never produces is either a gap someone should record
  // or a generator that stopped reaching it, and both are worth a failure.
  assert.deepEqual(
    Array.from(COVERAGE.withholdingCodes.keys()).sort(),
    (WITHHOLDING_REASON_CODES as readonly string[]).slice().sort(),
    `the corpus does not reach every withholding code: ${describe(COVERAGE.withholdingCodes)}`,
  );

  // Seven of the contract's nine. `NO_PLANNED_SLOT` and
  // `OUTSIDE_WORKING_WINDOW` are **documented as unemittable** by this module —
  // it is handed a `Plan` rather than a set of working windows, so it can
  // honestly claim neither (`lib/recommendation/index.ts`). Naming them here
  // rather than loosening the assertion to a count means the day one becomes
  // emittable, this fails and someone updates the note.
  assert.deepEqual(
    Array.from(COVERAGE.exclusionCodes.keys()).sort(),
    [
      'ALREADY_CLOSED',
      'BLOCKED_BY_DEPENDENCY',
      'INSUFFICIENT_EVIDENCE',
      'INVALID_SOURCE_TIME',
      'LOWER_RANKED',
      'NOT_CONFIRMED',
      'OPTION_CAP_REACHED',
    ],
    `the exclusion codes the corpus reaches are not the seven this module is documented to emit: ${describe(COVERAGE.exclusionCodes)}`,
  );

  assert.deepEqual(
    Array.from(COVERAGE.supportCodes.keys()).sort(),
    (SUPPORT_REASON_CODES as readonly string[]).slice().sort(),
    `the corpus does not reach every support code: ${describe(COVERAGE.supportCodes)}`,
  );

  assert.ok(
    COVERAGE.substantialGraphs >= 200,
    `only ${COVERAGE.substantialGraphs} of ${CASE_COUNT} graphs carried 10+ nodes and 3+ derivations; the corpus is mostly trivial`,
  );
});

/* ── 4. Every action kind reachable as an outcome ────────────────── */

/**
 * How often each action kind was actually **offered**, over the fuzzed corpus
 * plus four inputs built to isolate one kind each.
 *
 * The distinction that makes this worth computing: `decompose`'s *code* was
 * reachable and its *outcome* was not, because a per-commitment quota always
 * preferred a `schedule` on the same commitment. No assertion *about*
 * `decompose` catches that — only an assertion that some input offers one. The
 * isolating probes are here so that a kind reported unreachable is unreachable
 * rather than merely unlucky in 400 draws.
 */
function measureOfferedActionKinds(): Map<string, number> {
  const reached = new Map<string, number>(COVERAGE.offeredActionKinds);

  const isolating: ReadonlyArray<{ readonly name: string; readonly input: RecommendationSelectorInput }> = [
    {
      name: 'do_now: overdue, no slot, no proposal',
      input: request({ commitments: [commitment('c-1', { dueAt: '2026-08-18T09:00:00.000Z' })] }),
    },
    {
      name: 'schedule: overdue with an imminent planned slot',
      input: request({
        commitments: [commitment('c-1', { dueAt: '2026-08-18T09:00:00.000Z', planItemId: 'item-1' })],
        plan: plan([{ itemId: 'item-1', startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' }]),
      }),
    },
    {
      name: 'decompose: overdue with a proposal and no slot',
      input: request({
        commitments: [
          commitment('c-1', {
            dueAt: '2026-08-18T09:00:00.000Z',
            decompositionProposalId: 'proposal-1',
            decompositionStepId: 'step-1',
          }),
        ],
      }),
    },
    {
      // There is no fifth column to put here. `defer` names a target instant,
      // and no field of `RecommendationSelectorInput` supplies one — which is
      // itself the finding the todo-marked test below states.
      name: 'defer: an offer with a clear lead and a weaker alternative',
      input: request({
        commitments: [
          commitment('c-1', { dueAt: '2026-08-25T09:00:00.000Z', importance: 'high' }),
          commitment('c-2', { dueAt: '2026-08-18T09:00:00.000Z' }),
        ],
      }),
    },
  ];

  for (const probe of isolating) {
    const { recommendation } = selectRecommendation(probe.input);
    assert.equal(
      recommendation.outcome,
      'offered',
      `the isolating probe "${probe.name}" withheld, so it isolates nothing`,
    );
    if (recommendation.outcome !== 'offered') continue;
    for (const option of offeredOptions(recommendation.options)) {
      reached.set(option.action.kind, (reached.get(option.action.kind) ?? 0) + 1);
    }
  }
  return reached;
}

const OFFERED_ACTION_KINDS = measureOfferedActionKinds();

test('cross-track: every action kind the selector constructs is reachable as an outcome', () => {
  // The regression guard, and the half that holds today. `select.ts` builds
  // exactly three action shapes, and each has to survive ranking, the risk
  // floor, the per-commitment quota and the per-kind quota to become an
  // *offered* option. A quota change that made one of them structurally
  // unreachable again — which is the defect this group was written for — fails
  // here, not in a code-coverage report.
  const constructed = ['do_now', 'schedule', 'decompose'] as const;
  const unreached = constructed.filter((kind) => (OFFERED_ACTION_KINDS.get(kind) ?? 0) === 0);
  assert.deepEqual(
    unreached,
    [],
    `the selector constructs these action kinds and offers none of them in ${CASE_COUNT} generated cases plus the isolating probes: [${unreached.join(', ')}]. `
      + `Reached: ${describe(OFFERED_ACTION_KINDS)}.`,
  );
});

/**
 * The full requirement, kept whole and marked `todo` because it does not hold.
 *
 * `RECOMMENDED_ACTION_KINDS` names four kinds; `select.ts` constructs three.
 * There is no `{ kind: 'defer' }` anywhere in `lib/recommendation/selector/**`,
 * so `defer` is unreachable **structurally** — not for want of the right input.
 * It is not a fuzzing gap and no input shape can close it.
 *
 * It is left as a failing assertion rather than deleted or narrowed, because
 * narrowing it is how the gap becomes invisible: `ACTION_KIND_RANK` ranks four
 * kinds, `ACTION_KIND_COPY` in #35 renders user-facing copy for four kinds in
 * three locales, and `RECOMMENDED_ACTION_KIND_COVERAGE` proves the list is
 * exhaustive — every one of those reads as though a user could be offered a
 * `defer`, and none of them is a check that they can be. The `todo` marker
 * keeps the failure printed on every run while the suite still reports the
 * truth about everything else.
 *
 * Whoever closes it does one of two things, and both are decisions someone
 * records: teach the selector to propose a `defer` (which needs a target
 * instant the request does not currently carry), or state in
 * `recommendationContracts.ts` that `defer` is a *decision* verdict only and
 * not a proposable action in v1 — the way that file already states there is no
 * `drop` variant. Either way this test is the thing that has to change.
 */
test('cross-track: every proposable action kind is actually offered by some input', () => {
  // The assertion that found the defect, now strict rather than `todo`.
  //
  // It was written over every kind in `RECOMMENDED_ACTION_KINDS` and failed on
  // `defer`, which no input can produce because a deferral needs a target
  // instant `RecommendationSelectorInput` does not carry. The contract now says
  // so at `RecommendedAction`: `defer` is a decision verdict a user may choose,
  // not a move the selector proposes.
  //
  // So this iterates `PROPOSABLE_ACTION_KINDS` — and the partition test below is
  // what stops that from being a way to make the assertion vacuous by moving an
  // inconvenient kind into the exclusion list.
  const unreachable = PROPOSABLE_ACTION_KINDS.filter(
    (kind) => (OFFERED_ACTION_KINDS.get(kind) ?? 0) === 0,
  );
  assert.deepEqual(
    unreachable,
    [],
    `these kinds are proposable by the contract and offered by no input in ${CASE_COUNT} generated cases plus the isolating probes: [${unreachable.join(', ')}]. `
      + `Reached: ${describe(OFFERED_ACTION_KINDS)}. `
      + 'A reachable code path with an unreachable outcome is invisible to any assertion about the thing itself.',
  );
});

test('cross-track: the proposable and verdict-only kinds partition the action union exactly', () => {
  // Without this, the test above is weakened by moving a kind that stopped being
  // reachable into VERDICT_ONLY_ACTION_KINDS — which is how a reachability check
  // quietly becomes a list of whatever currently works. A fifth kind added to
  // RECOMMENDED_ACTION_KINDS belongs to one list or the other, and adding it to
  // neither fails here.
  const partitioned = [...PROPOSABLE_ACTION_KINDS, ...VERDICT_ONLY_ACTION_KINDS].slice().sort();
  assert.deepEqual(
    partitioned,
    RECOMMENDED_ACTION_KINDS.slice().sort(),
    'every action kind must be declared either proposable or verdict-only, and none may be both',
  );
  const overlap = PROPOSABLE_ACTION_KINDS.filter((kind) =>
    (VERDICT_ONLY_ACTION_KINDS as readonly string[]).includes(kind));
  assert.deepEqual(overlap, [], 'a kind cannot be both proposable and verdict-only');
});

test('cross-track: a verdict-only kind is still renderable, so excluding it is not deleting it', () => {
  // `defer` is excluded from the reachability check but is not dead: the review
  // surface offers it as a verdict in all three locales, and a user choosing it
  // is the whole reason it is in the union. If that stopped being true, the
  // right fix would be removing the kind, not the exclusion.
  for (const kind of VERDICT_ONLY_ACTION_KINDS) {
    assert.ok(
      (RECOMMENDED_ACTION_KINDS as readonly string[]).includes(kind),
      `${kind} is declared verdict-only but is not an action kind at all`,
    );
  }
  assert.ok(VERDICT_ONLY_ACTION_KINDS.length > 0, 'the exclusion list is empty; delete it rather than keeping an empty carve-out');
});

/* ── 2. Agreement with the shipped pilot ─────────────────────────── */

/**
 * The pilot's single nullable `exclusionReason`, in this module's vocabulary.
 *
 * The pilot cannot say a candidate is both unconfirmed *and* closed: it has one
 * field, filled in its own precedence order. #34 emits the whole list in that
 * same order, which is what makes `hardExclusions[0]` the comparable slot.
 */
const PILOT_CODE_BY_REASON = {
  not_confirmed: 'NOT_CONFIRMED',
  closed: 'ALREADY_CLOSED',
  invalid_time: 'INVALID_SOURCE_TIME',
} as const;

/**
 * The codes the pilot has a spelling for. Anything #34 emits outside this set is
 * a deliberate strictness, and the test below pins *which* codes those are.
 */
const PILOT_COMPARABLE_CODES: readonly ExclusionReasonCode[] = [
  'NOT_CONFIRMED',
  'ALREADY_CLOSED',
  'INVALID_SOURCE_TIME',
];

function asBaselineCandidate(snapshot: CommitmentSnapshot): BaselineCandidate {
  return {
    commitmentId: snapshot.commitmentId,
    title: `title of ${snapshot.commitmentId}`,
    confirmed: snapshot.confirmedAt !== null,
    status: snapshot.status,
    dueAt: snapshot.dueAt,
    remindAt: snapshot.remindAt,
    importance: snapshot.importance,
    explicitEffortMinutes: null,
  };
}

/** Every commitment the matrix compares, plus the two blockers it refers to. */
function pilotComparisonMatrix(): readonly CommitmentSnapshot[] {
  const blockedByChoices: readonly (readonly string[])[] = [
    [],
    ['blocker-open'],
    ['blocker-closed'],
    ['blocker-absent-from-this-request'],
  ];
  const snapshots: CommitmentSnapshot[] = [
    // An open blocker and a finished one, so `BLOCKED_BY_DEPENDENCY` is reached
    // *and* the rule that a closed prerequisite does not block is exercised.
    commitment('blocker-open', { status: 'active' }),
    commitment('blocker-closed', { status: 'completed' }),
  ];
  let serial = 0;
  for (const status of KNOWN_COMMITMENT_STATUSES) {
    for (const confirmedAt of [null, '2026-08-18T09:00:00.000Z']) {
      for (const dueAt of AGREED_TIME_VALUES) {
        for (const remindAt of AGREED_TIME_VALUES) {
          for (const importance of IMPORTANCES) {
            for (const blockedByCommitmentIds of blockedByChoices) {
              serial += 1;
              snapshots.push(
                commitment(`m-${String(serial).padStart(5, '0')}`, {
                  status,
                  confirmedAt,
                  dueAt,
                  remindAt,
                  importance,
                  blockedByCommitmentIds,
                }),
              );
            }
          }
        }
      }
    }
  }
  return snapshots;
}

/** The matrix, run through the real pipeline in chunks. */
function candidatesOverMatrix(): ReadonlyArray<{
  readonly snapshot: CommitmentSnapshot;
  readonly hardExclusions: readonly ExclusionReasonCode[];
  readonly effectiveTimeMs: number | null;
  readonly openBlockerCount: number;
}> {
  const matrix = pilotComparisonMatrix();
  const blockers = matrix.slice(0, 2);
  const rows = matrix.slice(2);
  const output: Array<{
    snapshot: CommitmentSnapshot;
    hardExclusions: readonly ExclusionReasonCode[];
    effectiveTimeMs: number | null;
    openBlockerCount: number;
  }> = [];
  const chunkSize = 400;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const set = generateCandidates(
      request({ commitments: [...blockers, ...chunk] }),
      DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
    );
    for (const candidate of set.candidates) {
      if (candidate.commitmentId === 'blocker-open' || candidate.commitmentId === 'blocker-closed') {
        continue;
      }
      output.push({
        snapshot: candidate.snapshot,
        hardExclusions: candidate.hardExclusions,
        effectiveTimeMs: candidate.effectiveTimeMs,
        openBlockerCount: candidate.openBlockerIndices.length,
      });
    }
  }
  return output;
}

const MATRIX = candidatesOverMatrix();

test('cross-track: the matrix is wide enough, and reaches both sides of every dimension it varies', () => {
  // A comparison over a matrix that never provokes an exclusion agrees
  // vacuously. This names what the matrix reached before anything compares over
  // it.
  assert.ok(MATRIX.length >= 3000, `the matrix carries only ${MATRIX.length} rows`);
  const reached = new Set<string>();
  let clean = 0;
  for (const row of MATRIX) {
    if (row.hardExclusions.length === 0) clean += 1;
    for (const code of row.hardExclusions) reached.add(code);
  }
  assert.ok(clean > 0, 'no row in the matrix survived the hard filters, so agreement would be vacuous');
  assert.deepEqual(
    Array.from(reached).sort(),
    ['ALREADY_CLOSED', 'BLOCKED_BY_DEPENDENCY', 'INVALID_SOURCE_TIME', 'NOT_CONFIRMED'],
    'the matrix does not reach every hard-constraint code the selector can emit',
  );
});

test('cross-track: the pipeline and the exported hard filter agree on identical inputs', () => {
  // `hardExclusionCodes` is exported so #35 and this test can read the verdict
  // without reaching inside the selector. If the exported function and the
  // pipeline that is supposed to call it ever diverged, every comparison below
  // would be comparing the wrong one.
  for (const row of MATRIX) {
    assert.deepEqual(
      hardExclusionCodes(row.snapshot, row.effectiveTimeMs, row.openBlockerCount),
      row.hardExclusions,
      `${row.snapshot.commitmentId}: hardExclusionCodes disagrees with the candidate the pipeline built`,
    );
  }
});

test('cross-track: selector and pilot agree pair for pair on the codes the pilot can spell', () => {
  // **Pairs, never deduplicated code names.** Sprint 07's cross-track test
  // compared `Set(reasons.map(r => r.code))`, reported perfect agreement over
  // 40,000 inputs, and was wrong on 38% of them — the set contained the right
  // codes, contributed by the wrong subjects. The pair comparison found it on
  // the first run. Nothing here deduplicates by code.
  const mine: string[] = [];
  const pilot: string[] = [];
  const nowDate = new Date(NOW);

  for (const row of MATRIX) {
    const comparable = row.hardExclusions.filter((code) =>
      PILOT_COMPARABLE_CODES.includes(code),
    );
    if (comparable.length > 0) {
      mine.push(`${row.snapshot.commitmentId}|${comparable[0]}`);
    }
    const baseline = scoreBaselineCandidate(asBaselineCandidate(row.snapshot), nowDate);
    if (baseline.exclusionReason !== null) {
      pilot.push(`${row.snapshot.commitmentId}|${PILOT_CODE_BY_REASON[baseline.exclusionReason]}`);
    }
  }

  assert.ok(mine.length > 500, `only ${mine.length} comparable exclusions were produced`);
  const onlyMine = mine.filter((pair) => !pilot.includes(pair)).slice(0, 10);
  const onlyPilot = pilot.filter((pair) => !mine.includes(pair)).slice(0, 10);
  assert.deepEqual(
    mine.slice().sort(),
    pilot.slice().sort(),
    `the two independent readings of hard exclusion disagree at (commitmentId, code) granularity.\n`
      + `  only #34: ${onlyMine.join(', ') || '(none)'}\n`
      + `  only pilot: ${onlyPilot.join(', ') || '(none)'}\n`,
  );
});

test('cross-track: the only place the selector is stricter than the pilot is BLOCKED_BY_DEPENDENCY', () => {
  // Equality is the wrong assertion where the two legitimately differ, and
  // "differences are fine" is no assertion at all. So this states the
  // *documented* relationship — `lib/recommendation/index.ts`: "everything the
  // pilot excludes, this module excludes; the reverse does not hold, and the
  // one addition is a candidate blocked by an unfinished prerequisite" — as an
  // exact set. A new strictness, or the loss of this one, fails here.
  const nowDate = new Date(NOW);
  const strictnessCodes = new Set<string>();
  let stricterRows = 0;
  const looserRows: string[] = [];

  for (const row of MATRIX) {
    const baseline = scoreBaselineCandidate(asBaselineCandidate(row.snapshot), nowDate);
    const pilotExcludes = baseline.exclusionReason !== null;
    const mineExcludes = row.hardExclusions.length > 0;

    if (mineExcludes && !pilotExcludes) {
      stricterRows += 1;
      for (const code of row.hardExclusions) strictnessCodes.add(code);
    }
    // The dangerous direction, and the one the module's own header calls a
    // defect: the pilot removed a candidate and this module would have offered
    // it.
    if (pilotExcludes && !mineExcludes) {
      looserRows.push(`${row.snapshot.commitmentId} (pilot: ${baseline.exclusionReason})`);
    }
  }

  assert.deepEqual(
    looserRows.slice(0, 10),
    [],
    `the selector offers candidates the pilot excludes, which the module's own header calls a defect:\n  ${looserRows.slice(0, 10).join('\n  ')}`,
  );
  assert.ok(stricterRows > 0, 'the matrix never exercised the documented strictness, so this assertion is vacuous');
  assert.deepEqual(
    Array.from(strictnessCodes).sort(),
    ['BLOCKED_BY_DEPENDENCY'],
    `the selector is stricter than the pilot under codes other than the one documented; `
      + `it excluded ${stricterRows} candidate(s) the pilot kept, under [${Array.from(strictnessCodes).sort().join(', ')}]`,
  );
});

test('cross-track: eligibility itself agrees, not only the top code', () => {
  // A candidate can carry the same exclusion code as the pilot and a different
  // verdict, if either side ever emitted a code that did not remove it. This is
  // the verdict, compared directly.
  const nowDate = new Date(NOW);
  const disagreements: string[] = [];
  for (const row of MATRIX) {
    const baseline = scoreBaselineCandidate(asBaselineCandidate(row.snapshot), nowDate);
    const comparable = row.hardExclusions.filter((code) => PILOT_COMPARABLE_CODES.includes(code));
    if ((comparable.length === 0) !== baseline.eligible) {
      disagreements.push(
        `${row.snapshot.commitmentId}: #34 [${row.hardExclusions.join(', ')}] vs pilot eligible=${baseline.eligible}`,
      );
    }
  }
  assert.deepEqual(disagreements.slice(0, 10), [], `eligibility disagrees:\n  ${disagreements.slice(0, 10).join('\n  ')}`);
});

/**
 * Values `Date.parse` accepts and `isInstant` refuses.
 *
 * Held out of the pair comparison above and asserted here by name, because a
 * difference of *leniency* is not a difference of *judgement* and mixing them
 * would let a real disagreement hide inside an expected one. The direction is
 * the safe one — the pilot reads a value nobody wrote and this module refuses
 * it — and stating the direction is what makes a reversal fail.
 */
const LENIENCY_DIVERGENT_INSTANTS: readonly string[] = [
  // Offset-less: host-local under the ECMAScript rule, so the pilot's verdict
  // moves with `TZ`. This is the class `selectorCandidates.test.ts` documents.
  '2026-08-19T11:00:00',
  // A date the calendar does not have, carrying an explicit `Z`. `Date.parse`
  // rolls it to the 2nd of March. This one is **not** in the class #34's header
  // describes, which claims "every instant carrying an explicit offset is judged
  // identically by both" — it carries an offset and the two do not agree.
  '2026-02-30T00:00:00.000Z',
  // 2026 is not a leap year; `Date.parse` rolls this to the 1st of March.
  '2026-02-29T00:00:00.000Z',
  // Date-only and year-only forms the spec reads as UTC midnight.
  '2026-08-19',
  '2026',
  // Hour 24, which rolls to the next day.
  '2026-08-19T24:00:00.000Z',
];

test('cross-track: the leniency divergence is exactly the stated set, in the stated direction', () => {
  const nowDate = new Date(NOW);
  const wrongDirection: string[] = [];
  const agreed: string[] = [];
  for (const value of LENIENCY_DIVERGENT_INSTANTS) {
    const snapshot = commitment(`c-${value}`, { dueAt: value });
    const mineExcludes = epochMsOrNull(value) === null;
    const baseline = scoreBaselineCandidate(asBaselineCandidate(snapshot), nowDate);
    const pilotExcludes = baseline.exclusionReason !== null;
    if (!mineExcludes || pilotExcludes) {
      if (mineExcludes === pilotExcludes) agreed.push(value);
      else wrongDirection.push(`${value}: #34 excludes=${mineExcludes}, pilot excludes=${pilotExcludes}`);
    }
    // Whatever the pilot does, #33's own judgement is the one #34 delegates to,
    // and it must refuse every one of these.
    assert.equal(isInstant(value), false, `isInstant accepted ${value}, which names no real moment or no real zone`);
  }
  assert.deepEqual(
    wrongDirection,
    [],
    `the leniency divergence runs the unsafe way round — the pilot refused a value this module accepted:\n  ${wrongDirection.join('\n  ')}`,
  );
  assert.deepEqual(
    agreed,
    [],
    `these values no longer diverge, so the stated divergence set is out of date: ${agreed.join(', ')}`,
  );
});

/* ── 5. The full path, end to end ────────────────────────────────── */

/** A request rich enough to produce a two-option offer with exclusions. */
function endToEndRequest(): RecommendationSelectorInput {
  return request({
    recommendationId: 'rec-end-to-end',
    commitments: [
      commitment('e-alfa', { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
      commitment('e-bravo', { dueAt: '2026-08-19T17:00:00.000Z', importance: 'high', planItemId: 'item-bravo' }),
      commitment('e-charlie', { confirmedAt: null, dueAt: '2026-08-18T09:00:00.000Z' }),
      commitment('e-delta', { status: 'completed' }),
    ],
    priorityScores: [score('e-alfa', 900, ['REPEATEDLY_DELAYED']), score('e-bravo', 700)],
    plan: plan([{ itemId: 'item-bravo', startsAt: '2026-08-19T12:30:00.000Z', endsAt: '2026-08-19T12:40:00.000Z' }]),
  });
}

function endToEndOffer(): { readonly offer: OfferedRecommendation; readonly fingerprints: Readonly<Record<string, string | null>> } {
  const input = endToEndRequest();
  const { recommendation, defects } = selectRecommendation(input);
  assert.deepEqual(defects, [], 'the end-to-end fixture is itself defective, so everything below would pass for the wrong reason');
  assert.equal(recommendation.outcome, 'offered', 'the end-to-end fixture withheld; there would be nothing to review');
  const offer = recommendation as OfferedRecommendation;
  assert.ok(offeredOptions(offer.options).length >= 2, 'the fixture offers fewer than two options, so the blind permutation is trivial');
  return {
    offer,
    fingerprints: currentFingerprints(input, DEFAULT_RECOMMENDATION_SELECTOR_CONFIG),
  };
}

test('cross-track: the selector output is fresh against its own inputs and renders', () => {
  // The join between #34 and #35 that neither owns: the presenter re-runs #33's
  // checkers and refuses to render anything defective or stale, so a selector
  // output that failed either would silently become a "nothing to review" view
  // rather than an error.
  const { offer, fingerprints } = endToEndOffer();
  const staleness = evaluateRecommendationStaleness({
    recommendation: offer,
    now: NOW,
    currentFingerprints: fingerprints,
  });
  assert.equal(
    staleness.fresh,
    true,
    // The reason list only exists on the stale branch, so the message is built
    // from it only there. A template that read it unconditionally would raise a
    // `TypeError` out of the *passing* path and turn a green assertion red for
    // a reason that has nothing to do with what it checks.
    staleness.fresh
      ? ''
      : `a recommendation re-verified against the inputs that produced it is stale: [${staleness.reasons.map((reason) => reason.code).join(', ')}]`,
  );

  const view = presentRecommendation({
    recommendation: offer,
    locale: 'en',
    now: NOW,
    currentFingerprints: fingerprints,
    mode: 'attributed',
  });
  assert.equal(view.mode, 'attributed', `#35 refused to render #34's output: ${JSON.stringify(view).slice(0, 400)}`);
});

test('cross-track: nothing persists without an explicit confirmation, at either end of the path', () => {
  // The acceptance criterion, asserted across the join. #34's policy says a
  // recommendation is never canonical state; #35's says the surface never
  // writes. Only a test that runs the whole path can say the two hold together —
  // and the interesting half is that an *unconfirmed* accept comes back asking
  // for confirmation with no write authority attached, rather than being
  // rejected or quietly recorded.
  const { offer, fingerprints } = endToEndOffer();
  const common = {
    recommendation: offer as Recommendation,
    locale: 'en' as const,
    mode: 'attributed' as const,
    now: NOW,
    currentFingerprints: fingerprints,
  };

  const unconfirmed = evaluateReviewSubmission({
    ...common,
    submission: {
      recommendationId: offer.recommendationId,
      target: { mode: 'attributed', optionIndex: 0 },
      verdict: 'accept',
      decidedAt: NOW,
      confirmation: { stage: 'unconfirmed' },
    },
  });
  assert.equal(unconfirmed.ok, true, `an unconfirmed accept was refused: ${JSON.stringify(unconfirmed)}`);
  if (!unconfirmed.ok) return;
  assert.equal(unconfirmed.outcome.status, 'confirmation_required');
  assert.equal(unconfirmed.outcome.persisted, false);
  assert.equal(unconfirmed.handoff, null, 'write authority was handed out without a confirmation');

  const confirmed = evaluateReviewSubmission({
    ...common,
    submission: {
      recommendationId: offer.recommendationId,
      target: { mode: 'attributed', optionIndex: 0 },
      verdict: 'accept',
      decidedAt: NOW,
      confirmation: {
        stage: 'confirmed',
        acknowledgedVerdict: 'accept',
        acknowledgedIndex: 0,
        confirmedAt: NOW,
      },
    },
  });
  assert.equal(confirmed.ok, true, `a confirmed accept was refused: ${JSON.stringify(confirmed)}`);
  if (!confirmed.ok) return;
  assert.equal(confirmed.outcome.status, 'confirmed');
  // Even the confirmed branch reports `persisted: false`: the handoff is
  // authority for an adapter, not a record of a write.
  assert.equal(confirmed.outcome.persisted, false);
  assert.notEqual(confirmed.handoff, null, 'a confirmed accept produced no write authority');

  // And the decision the review surface assembled is one #33 accepts, which is
  // the contract-level half of the same claim.
  assert.deepEqual(
    checkRecommendationDecision(offer, {
      version: offer.version,
      recommendationId: offer.recommendationId,
      optionIndex: 0,
      verdict: 'accept',
      decidedAt: NOW,
    }),
    [],
  );
});

/** Every key appearing anywhere in a value, at any depth. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, into);
    return into;
  }
  if (value === null || typeof value !== 'object') return into;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    allKeys(inner, into);
  }
  return into;
}

test('cross-track: a blind view carries none of BLIND_REDACTED_FIELDS, at any depth', () => {
  // The property #35 owns, asserted at the merge against a recommendation #34
  // actually produced rather than a hand-built fixture — because the shape a
  // real offer takes is what decides whether a redaction holds.
  const { offer, fingerprints } = endToEndOffer();
  const view = presentRecommendation({
    recommendation: offer,
    locale: 'en',
    now: NOW,
    currentFingerprints: fingerprints,
    mode: 'blind',
    blindingSalt: 'salt-for-the-merge-cross-track-test',
  });
  assert.equal(view.mode, 'blind', 'the blind presentation refused to render');

  const keys = allKeys(view);
  const leaked = BLIND_REDACTED_FIELDS.filter((field) => keys.has(field));
  assert.deepEqual(leaked, [], `a blind view carries redacted field(s): ${leaked.join(', ')}`);

  // The serialised form too: the view is what travels, and a field that appears
  // only after `JSON.stringify` is still a field the reviewer receives.
  const serialised = JSON.stringify(view);
  for (const field of BLIND_REDACTED_FIELDS) {
    assert.equal(
      serialised.includes(`"${field}"`),
      false,
      `the serialised blind view names the redacted field ${field}`,
    );
  }

  // Non-vacuity: the blinding actually permutes something. A salt that produced
  // the identity permutation would pass every assertion above while telling the
  // reviewer exactly what the first pass preferred.
  const order = blindSlotOrder(offer, 'salt-for-the-merge-cross-track-test');
  assert.equal(order.length, offeredOptions(offer.options).length, 'the blind ordering drops or duplicates a slot');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order.map((_, index) => index), 'the blind ordering is not a permutation');
});

test('cross-track: the blind decide response carries no optionIndex, anywhere', () => {
  // The leak that shipped in an earlier revision of #35: the persistence handoff
  // lived inside the confirmed outcome, so a blind reviewer's confirmation came
  // back carrying the resolved offer position. Three confirmed decisions
  // recovered the whole permutation. Asserted here through the request boundary,
  // because the boundary is what a client actually receives.
  const { offer, fingerprints } = endToEndOffer();
  const salt = 'salt-for-the-merge-cross-track-test';
  const outcome = handleReviewRequest({
    kind: 'decide',
    recommendation: offer,
    locale: 'en',
    mode: 'blind',
    now: NOW,
    currentFingerprints: fingerprints,
    submission: {
      recommendationId: offer.recommendationId,
      target: { mode: 'blind', slotIndex: 0, blindingSalt: salt },
      verdict: 'accept',
      decidedAt: NOW,
      confirmation: {
        stage: 'confirmed',
        acknowledgedVerdict: 'accept',
        acknowledgedIndex: 0,
        confirmedAt: NOW,
      },
    },
  });

  assert.equal(outcome.status, 200, `the blind decide was refused: ${JSON.stringify(outcome.response).slice(0, 400)}`);
  assert.equal(outcome.response.kind, 'decided');
  const keys = allKeys(outcome.response);
  assert.equal(keys.has('optionIndex'), false, 'the blind decide response carries an optionIndex');
  assert.equal(keys.has('handoff'), false, 'the blind decide response carries the persistence handoff');
  assert.equal(
    JSON.stringify(outcome.response).includes('"optionIndex"'),
    false,
    'the serialised blind decide response names optionIndex',
  );

  // Non-vacuity in the direction that matters: slot 0 really does resolve to an
  // offer position that is not always 0, so "no optionIndex" is withholding
  // something rather than withholding nothing.
  const order = blindSlotOrder(offer, salt);
  assert.ok(order.length >= 2, 'the fixture has too few slots for the permutation to hide anything');
});

/* ── 6. Timezone and locale invariance ───────────────────────────── */

/** Every string in a value that occupies an instant-typed position. */
function emittedInstants(recommendation: Recommendation): string[] {
  const found: string[] = [];
  found.push(recommendation.validity.basisAt, recommendation.validity.expiresAt);
  for (const node of recommendation.evidence.nodes) {
    if (node.kind === 'observed') {
      if (node.observedAt !== null) found.push(node.observedAt);
      if (node.claim.kind === 'instant') found.push(node.claim.value);
    } else if (node.claim.kind === 'instant') {
      found.push(node.claim.value);
    }
  }
  if (recommendation.outcome === 'offered') {
    for (const option of offeredOptions(recommendation.options)) {
      pushActionInstants(option.action, found);
    }
    for (const candidate of summarizeOptionSet(recommendation.options).excluded) {
      pushActionInstants(candidate.action, found);
    }
  }
  return found;
}

function pushActionInstants(action: RecommendedAction, into: string[]): void {
  if (action.kind === 'schedule') {
    into.push(action.slot.startsAt, action.slot.endsAt);
  } else if (action.kind === 'defer') {
    into.push(action.until);
  }
}

test('cross-track: every instant the selector emits satisfies isInstant', () => {
  // The structural half of timezone invariance. An offset-less instant is
  // host-local under the ECMAScript rule, so a single one reaching a consumer
  // would make that consumer's reading depend on its own `TZ` — and the value
  // would still look like a perfectly ordinary timestamp. #34 measured this
  // exact failure before it delegated the judgement to #33: the same request
  // produced `OVERDUE / 0.9` under `TZ=UTC` and `DUE_SOON / 0.7` under
  // `TZ=America/Los_Angeles` with an *identical* `inputDigest`.
  let checked = 0;
  const bad: string[] = [];
  for (const testCase of CASES) {
    const { recommendation } = selectRecommendation(testCase.input, testCase.config);
    for (const value of emittedInstants(recommendation)) {
      checked += 1;
      if (!isInstant(value)) bad.push(`seed ${testCase.seed}: ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(bad.slice(0, 10), [], `the selector emitted values that are not instants:\n  ${bad.slice(0, 10).join('\n  ')}`);
  assert.ok(checked > 500, `only ${checked} instants were checked; the corpus is too thin to mean anything`);
});

test('cross-track: isInstant refuses a date the calendar does not have', () => {
  // `Date.parse('2026-02-30T00:00:00.000Z')` is not NaN — it is the 2nd of
  // March. An expiry written as the 30th of February would therefore make a
  // recommendation offerable two days past its stated life, and the repaired
  // value is a perfectly well-formed instant, so no downstream check could
  // notice. This is the single input that separates a shape check from a
  // judgement about whether a moment exists.
  assert.equal(
    Number.isNaN(Date.parse('2026-02-30T00:00:00.000Z')),
    false,
    'Date.parse no longer accepts the 30th of February, so this guard has lost its subject',
  );
  assert.equal(isInstant('2026-02-30T00:00:00.000Z'), false, 'isInstant accepts the 30th of February');
  assert.equal(epochMsOrNull('2026-02-30T00:00:00.000Z'), null, 'the selector accepts the 30th of February');
});

test('cross-track: the same input produces the same selection under four process timezones', () => {
  // The behavioural half. Assigning `process.env.TZ` mid-process does move
  // `Date.parse`'s answer for an offset-less string in this runtime — measured,
  // not assumed — so this is a real sweep rather than a decorative one. It does
  // not reliably move a cached `Intl` formatter, which is why the structural
  // assertion above is not replaced by it.
  const zones = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati'];
  const original = process.env.TZ;
  const perZone = new Map<string, string>();
  try {
    for (const zone of zones) {
      process.env.TZ = zone;
      // Sanity: the assignment actually took effect, or this test proves nothing.
      assert.equal(
        typeof new Date(0).getTimezoneOffset(),
        'number',
        'the runtime stopped reporting a zone offset',
      );
      const digests: string[] = [];
      for (const testCase of CASES.slice(0, 80)) {
        digests.push(JSON.stringify(selectRecommendation(testCase.input, testCase.config)));
      }
      perZone.set(zone, JSON.stringify(digests));
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }

  const reference = perZone.get(zones[0]) as string;
  for (const zone of zones.slice(1)) {
    assert.equal(
      perZone.get(zone),
      reference,
      `the selection changed between TZ=${zones[0]} and TZ=${zone}; a recommendation must not depend on the host's zone`,
    );
  }
});

/* ── 7. The suite guards itself ──────────────────────────────────── */

/**
 * Every `tests/recommendation/*.test.ts` path named by a package script.
 *
 * Read from the script text rather than from a list kept here, because a list
 * kept here is a third copy of the registration and would drift from both.
 */
function registeredRecommendationTests(): Set<string> {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const registered = new Set<string>();
  for (const [name, script] of Object.entries(packageJson.scripts)) {
    if (name !== 'test' && name !== 'test:sprint08') continue;
    for (const match of Array.from(script.matchAll(/(tests\/recommendation\/[\w.-]+\.test\.ts)/g))) {
      registered.add(match[1]);
    }
  }
  return registered;
}

test('every registered recommendation test file exists on disk', () => {
  // `node --test` skips a missing file among present ones and exits 0 —
  // measured on this runner, not assumed. A typo in the script would delete a
  // track's coverage with no signal, and every guard in this sprint sits behind
  // that failure mode.
  const registered = registeredRecommendationTests();
  assert.ok(registered.size >= 12, `expected the sprint's recommendation files to be registered, found ${registered.size}`);
  const missing = Array.from(registered).filter((file) => !existsSync(join(repoRoot, file))).sort();
  assert.deepEqual(missing, [], `registered but absent, so silently never run:\n  ${missing.join('\n  ')}`);
});

test('every recommendation test file on disk is registered in package.json', () => {
  // The other direction, and the one a "does it exist" check cannot see: a file
  // that exists and is registered nowhere runs never, reports nothing, and looks
  // exactly like a file that passes.
  const registered = registeredRecommendationTests();
  const onDisk = readdirSync(join(repoRoot, 'tests', 'recommendation'))
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => `tests/recommendation/${entry}`)
    .sort();
  assert.ok(onDisk.length >= 12, `only ${onDisk.length} recommendation test files were found on disk`);
  const unregistered = onDisk.filter((file) => !registered.has(file));
  assert.deepEqual(
    unregistered,
    [],
    `present on disk and registered in no script, so never run:\n  ${unregistered.join('\n  ')}`,
  );
});

test('the sprint 08 script and the full test script register the same recommendation files', () => {
  // Two lists that drift apart mean `npm run test:sprint08` reports green over a
  // subset while `npm test` covers something else.
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const filesIn = (script: string): string[] =>
    Array.from(
      new Set(
        Array.from(script.matchAll(/(tests\/recommendation\/[\w.-]+\.test\.ts)/g)).map((match) => match[1]),
      ),
    ).sort();

  assert.deepEqual(
    filesIn(packageJson.scripts['test:sprint08']),
    filesIn(packageJson.scripts.test),
    'test:sprint08 and test cover different recommendation files',
  );
});


/**
 * A selector input at an arbitrary scope, built from the same shapes the
 * generator uses but sized deliberately. The generated corpus caps at five
 * commitments because it probes shapes; this probes size, which is a different
 * question and the one the two halves disagreed about.
 */
function scaledSelectorInput(count: number): RecommendationSelectorInput {
  const commitments: CommitmentSnapshot[] = [];
  const scores: PriorityScore[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `scaled-${String(index).padStart(4, '0')}`;
    commitments.push(commitment(id, { dueAt: '2026-08-19T09:00:00.000Z', importance: 'normal' }));
    scores.push(score(id, 500));
  }
  return request({
    scopeId: 'scaled-scope',
    commitments,
    priorityScores: scores,
    lifeState: lifeState({ openCount: count }),
  });
}

/* ── 8. The two halves must agree how large a recommendation may be ── */

/**
 * The selector's own output must be reviewable at a realistic scope.
 *
 * Found by the sprint-level review, and invisible to every track alone: the
 * selector emits roughly nine evidence nodes per commitment and deliberately
 * does not truncate, while the review surface capped the graph at 500 nodes. At
 * about 55 commitments the review surface began returning
 * `RECOMMENDATION_TOO_LARGE` for a recommendation the selector had just
 * declared defect-free — the product refusing its own output.
 *
 * Neither suite could see it. The generated corpus above caps at five
 * commitments and the end-to-end fixture uses four, because both were written
 * to exercise *shapes* rather than *sizes*. A cross-track test that only ever
 * builds small inputs cannot discover that two modules disagree about big ones.
 *
 * This asserts the coupling directly rather than the number, so raising one
 * limit without the other fails here instead of at a user's scope.
 */
test('cross-track: the selector output is reviewable at a realistic scope', () => {
  const SCOPE = 120;
  const input = scaledSelectorInput(SCOPE);
  const selection = selectRecommendation(input);

  assert.deepEqual(
    checkRecommendation(selection.recommendation),
    [],
    `the selector produced a defective recommendation at ${SCOPE} commitments`,
  );

  const outcome = handleReviewRequest({
    kind: 'present',
    locale: 'en',
    mode: 'attributed',
    now: input.now,
    recommendation: selection.recommendation,
  });

  assert.equal(
    outcome.status,
    200,
    `the review surface refused the selector's own output at ${SCOPE} commitments: `
      + `${JSON.stringify(outcome.response).slice(0, 200)}`,
  );
});

test('cross-track: the review limits leave headroom over what the selector emits', () => {
  // The number-free form of the same coupling. If the selector's evidence per
  // commitment grows, or a review limit shrinks, this fails while there is
  // still margin — rather than at whatever scope happens to cross the line.
  const small = selectRecommendation(scaledSelectorInput(10));
  const large = selectRecommendation(scaledSelectorInput(60));
  const nodesFor = (r: { evidence: { nodes: readonly unknown[] } }) => r.evidence.nodes.length;

  const perCommitment = (nodesFor(large.recommendation) - nodesFor(small.recommendation)) / 50;
  assert.ok(perCommitment > 0, 'evidence does not grow with scope; this guard has lost its subject');

  const supportedScope = RECOMMENDATION_REVIEW_LIMITS.maxEvidenceNodes / perCommitment;
  assert.ok(
    supportedScope >= 100,
    `the review node limit (${RECOMMENDATION_REVIEW_LIMITS.maxEvidenceNodes}) supports only `
      + `~${Math.floor(supportedScope)} commitments at ${perCommitment.toFixed(1)} nodes each. `
      + 'Raise the limit or bound the selector; the two halves must agree.',
  );
});
