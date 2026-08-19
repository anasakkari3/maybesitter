/**
 * Shape and vocabulary guards on `src/contracts/v1/recommendationContracts.ts`
 * (Sprint 08, issue #33).
 *
 * A contract file's tests cannot check behaviour, because there is barely any.
 * What they can check is the three things that go quietly wrong in a contract
 * three tracks share:
 *
 *  1. **A frozen list drifting from the type it mirrors.** `TRUSTED_SOURCE_KINDS`
 *     and friends exist so a runtime consumer can iterate what a type declares.
 *     The day the two disagree, every test that iterates the array still passes —
 *     it just silently covers less. The exhaustiveness here is enforced twice:
 *     at compile time by the `_…Covered` aliases (a missing member is a `tsc`
 *     error) and at runtime by asserting the arrays are frozen and duplicate-free,
 *     because a `satisfies` clause is satisfied by a *subset* and would not
 *     notice a member going missing on its own.
 *  2. **Boundary arithmetic that is right in the middle and wrong at the edge.**
 *     `bandForConfidence` is checked exactly at both thresholds and on either
 *     side of the valid range, because "roughly a third" and ">= 0.34" differ
 *     only at one input and that input is the one a fixture never uses.
 *  3. **A registration that silently covers nothing.** See the last block: a
 *     test file that exists and is not registered contributes zero signal and
 *     reports as a clean suite.
 *
 * The acceptance criterion this file carries is **"alternatives preserve user
 * control"**, in its structural half: the offer has no field that means "the
 * recommendation" on its own, and the checker rejects the four ways an offer can
 * look like a choice without being one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextStepDecision } from '../../src/contracts/v1/nextStepContracts.ts';
import {
  CONFIDENCE_BAND_THRESHOLDS,
  DEFAULT_RECOMMENDATION_TTL_MINUTES,
  EVIDENCE_GRAPH_DEFECT_CODES,
  EXCLUSION_REASON_CODES,
  LIFE_STATE_SOURCE_FIELDS,
  RECOMMENDATION_CONTRACT_VERSION,
  RECOMMENDATION_INPUT_POLICY,
  RECOMMENDATION_OPTION_POLICY,
  RECOMMENDATION_ORDERING_KEYS,
  RECOMMENDATION_PERSISTENCE_POLICY,
  RECOMMENDATION_SCHEMA_VERSION,
  RECOMMENDATION_DECISION_DEFECT_CODES,
  RECOMMENDATION_DECISION_VERDICTS,
  RECOMMENDATION_STRUCTURE_DEFECT_CODES,
  RECOMMENDED_ACTION_KINDS,
  REASON_CODE_PARTITIONS,
  STALENESS_REASON_CODES,
  SUPPORT_REASON_CODES,
  TRUSTED_SOURCE_KINDS,
  WITHHOLDING_REASON_CODES,
  actionKey,
  bandForConfidence,
  checkRecommendation,
  isKnownActionKind,
  checkRecommendationDecision,
  offeredOptions,
  summarizeOptionSet,
} from '../../src/contracts/v1/recommendationContracts.ts';
import type {
  Confidence,
  EvidenceNode,
  OfferedRecommendation,
  OptionSet,
  RecommendationDecision,
  RecommendationDecisionVerdict,
  RecommendationOption,
  RecommendationReasonCode,
  RecommendedAction,
  SupportReason,
} from '../../src/contracts/v1/recommendationContracts.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

/* ── fixtures ─────────────────────────────────────────────────────── */

function observed(nodeId: string, fingerprint = `fp-${nodeId}`): EvidenceNode {
  return {
    kind: 'observed',
    nodeId,
    source: { kind: 'commitment', commitmentId: 'c1', field: 'due_at' },
    claim: { kind: 'category', value: 'overdue' },
    observedAt: '2026-08-19T09:00:00.000Z',
    valueFingerprint: fingerprint,
  };
}

function support(nodeId: string): readonly [SupportReason, ...SupportReason[]] {
  return [{ code: 'OVERDUE', supportedBy: [nodeId], detail: 'the stated deadline has passed' }];
}

function confidence(value: number, nodeId: string): Confidence {
  const band = bandForConfidence(value);
  assert.notEqual(band, null, 'fixture confidence must be in range');
  return { value, band: band as Confidence['band'], basis: [nodeId] };
}

function option(index: number, commitmentId: string, nodeId: string, value = 0.8): RecommendationOption {
  return {
    optionIndex: index,
    action: { kind: 'do_now', commitmentId },
    support: support(nodeId),
    confidence: confidence(value, nodeId),
  };
}

function offered(options: OptionSet, nodes: readonly EvidenceNode[]): OfferedRecommendation {
  return {
    version: RECOMMENDATION_CONTRACT_VERSION,
    schema: RECOMMENDATION_SCHEMA_VERSION,
    recommendationId: 'rec-1',
    scopeId: 'scope-1',
    validity: { basisAt: '2026-08-19T10:00:00.000Z', expiresAt: '2026-08-19T11:00:00.000Z' },
    evidence: { nodes },
    inputDigest: 'digest-1',
    outcome: 'offered',
    options,
  };
}

/* ── versions ─────────────────────────────────────────────────────── */

test('contract: the schema version is namespaced and the contract version tracks the module version', () => {
  assert.equal(RECOMMENDATION_SCHEMA_VERSION, 'recommendation-v1');
  assert.equal(RECOMMENDATION_CONTRACT_VERSION, 'v1');
});

/* ── frozen vocabularies ──────────────────────────────────────────── */

const VOCABULARIES: readonly (readonly [string, readonly string[]])[] = [
  ['LIFE_STATE_SOURCE_FIELDS', LIFE_STATE_SOURCE_FIELDS],
  ['TRUSTED_SOURCE_KINDS', TRUSTED_SOURCE_KINDS],
  ['RECOMMENDED_ACTION_KINDS', RECOMMENDED_ACTION_KINDS],
  ['SUPPORT_REASON_CODES', SUPPORT_REASON_CODES],
  ['EXCLUSION_REASON_CODES', EXCLUSION_REASON_CODES],
  ['WITHHOLDING_REASON_CODES', WITHHOLDING_REASON_CODES],
  ['EVIDENCE_GRAPH_DEFECT_CODES', EVIDENCE_GRAPH_DEFECT_CODES],
  ['RECOMMENDATION_STRUCTURE_DEFECT_CODES', RECOMMENDATION_STRUCTURE_DEFECT_CODES],
  ['STALENESS_REASON_CODES', STALENESS_REASON_CODES],
  ['RECOMMENDATION_DECISION_DEFECT_CODES', RECOMMENDATION_DECISION_DEFECT_CODES],
  ['RECOMMENDATION_DECISION_VERDICTS', RECOMMENDATION_DECISION_VERDICTS],
];

test('contract: every exported vocabulary is frozen and duplicate-free', () => {
  for (const [name, values] of VOCABULARIES) {
    assert.equal(Object.isFrozen(values), true, `${name} must be frozen`);
    assert.equal(new Set(values).size, values.length, `${name} must not repeat a member`);
    assert.ok(values.length > 0, `${name} must not be empty`);
    for (const value of values) {
      assert.equal(typeof value, 'string', `${name} members must be strings`);
      assert.notEqual(value.trim(), '', `${name} must not carry a blank member`);
    }
  }
});

test('contract: the life-state source fields are exactly the projected views', () => {
  // Derived from `LifeState` by a mapped type, so this asserts the four
  // projections and — by exclusion — that the projection's own metadata
  // (`version`, `scopeId`, `computedAt`, `inputDigest`) is not addressable as
  // evidence. Naming `computedAt` as a source would let a recommendation cite
  // the run that produced it as though it were an observation about the user.
  assert.deepEqual(LIFE_STATE_SOURCE_FIELDS.slice(), [
    'commitments',
    'availability',
    'load',
    'recentOutcomes',
  ]);
});

/* ── reason-code partitions ───────────────────────────────────────── */

/**
 * Compile-time exhaustiveness: a reason code that belongs to no partition is a
 * `tsc` error here rather than a code no runtime consumer can classify.
 * A runtime assertion cannot establish this — the only list of "all codes" it
 * could iterate is one written by hand, which is the thing being checked.
 */
const ALL_PARTITIONED = [
  ...SUPPORT_REASON_CODES,
  ...EXCLUSION_REASON_CODES,
  ...WITHHOLDING_REASON_CODES,
] as const;
type _EveryReasonCodeIsPartitioned =
  Exclude<RecommendationReasonCode, (typeof ALL_PARTITIONED)[number]> extends never ? true : never;
const _everyReasonCodeIsPartitioned: _EveryReasonCodeIsPartitioned = true;

test('contract: every reason code belongs to at least one partition', () => {
  assert.equal(_everyReasonCodeIsPartitioned, true);
  const union = new Set<string>(ALL_PARTITIONED);
  assert.equal(
    union.size,
    SUPPORT_REASON_CODES.length + EXCLUSION_REASON_CODES.length + WITHHOLDING_REASON_CODES.length - 1,
    'exactly one code is expected to appear in two partitions',
  );
});

test('contract: the partitions overlap only where the contract says they do', () => {
  // Documented in `WithholdingReasonCode`: INSUFFICIENT_EVIDENCE is legitimately
  // both "this candidate is unsupported" and "nothing was supported". Pinned so
  // that a future contributor who "tidies" the overlap away has to argue with a
  // test rather than with a comment — and so that any *other* overlap appearing
  // later fails here, since an accidental one means two positions have started
  // meaning the same thing.
  // Iterating the frozen arrays rather than the Sets: `target` is es5 here, so
  // `for…of` over a Set needs downlevelIteration, and the arrays are the source
  // of truth anyway.
  const exclusion = new Set<string>(EXCLUSION_REASON_CODES);
  const withholding = new Set<string>(WITHHOLDING_REASON_CODES);

  const overlaps = EXCLUSION_REASON_CODES.filter((code) => withholding.has(code));
  assert.deepEqual(overlaps.slice(), ['INSUFFICIENT_EVIDENCE']);

  for (const code of SUPPORT_REASON_CODES) {
    assert.equal(exclusion.has(code), false, `${code} must not be both support and exclusion`);
    assert.equal(withholding.has(code), false, `${code} must not be both support and withholding`);
  }
});

test('contract: REASON_CODE_PARTITIONS exposes the same three arrays by name', () => {
  assert.equal(Object.isFrozen(REASON_CODE_PARTITIONS), true);
  assert.equal(REASON_CODE_PARTITIONS.support, SUPPORT_REASON_CODES);
  assert.equal(REASON_CODE_PARTITIONS.exclusion, EXCLUSION_REASON_CODES);
  assert.equal(REASON_CODE_PARTITIONS.withholding, WITHHOLDING_REASON_CODES);
});

test('contract: the exclusion vocabulary covers the pilot baseline exclusions plus losing a comparison', () => {
  // The pilot's `BaselineScore.exclusionReason` is
  // 'not_confirmed' | 'closed' | 'invalid_time' | null. All three must have a
  // module-scope counterpart or #34 would have to invent one, which is the
  // divergence this shared vocabulary exists to prevent.
  for (const code of ['NOT_CONFIRMED', 'ALREADY_CLOSED', 'INVALID_SOURCE_TIME'] as const) {
    assert.ok(EXCLUSION_REASON_CODES.includes(code), `${code} must exist for the pilot's exclusion`);
  }
  // The pilot has no code for this and drops such candidates silently.
  assert.ok(EXCLUSION_REASON_CODES.includes('LOWER_RANKED'));
  assert.ok(EXCLUSION_REASON_CODES.includes('OPTION_CAP_REACHED'));
});

/* ── confidence banding ───────────────────────────────────────────── */

test('contract: bandForConfidence is exact at both thresholds', () => {
  assert.equal(bandForConfidence(CONFIDENCE_BAND_THRESHOLDS.medium), 'medium');
  assert.equal(bandForConfidence(CONFIDENCE_BAND_THRESHOLDS.high), 'high');
  // One ULP below each bound must fall to the band underneath. A ">" rather
  // than ">=" in the implementation passes every round-numbered fixture and
  // fails only here.
  assert.equal(bandForConfidence(CONFIDENCE_BAND_THRESHOLDS.medium - Number.EPSILON), 'low');
  assert.equal(bandForConfidence(CONFIDENCE_BAND_THRESHOLDS.high - Number.EPSILON), 'medium');
  assert.equal(bandForConfidence(0), 'low');
  assert.equal(bandForConfidence(1), 'high');
});

test('contract: bandForConfidence reports rather than repairs an unusable value', () => {
  // The clamp is the dangerous repair: `NaN >= 0.67` is false, so a clamping
  // implementation returns 'low' and a broken number is presented to the user as
  // a measured judgement of low confidence.
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.0001, 1.0001]) {
    assert.equal(bandForConfidence(value), null, `${value} must not band`);
  }
});

/* ── actions ──────────────────────────────────────────────────────── */

test('contract: actionKey separates every action kind and every payload difference', () => {
  const actions: readonly RecommendedAction[] = [
    { kind: 'do_now', commitmentId: 'c1' },
    { kind: 'do_now', commitmentId: 'c2' },
    { kind: 'schedule', commitmentId: 'c1', slot: { startsAt: '2026-08-19T10:00:00.000Z', endsAt: '2026-08-19T11:00:00.000Z' } },
    { kind: 'schedule', commitmentId: 'c1', slot: { startsAt: '2026-08-19T10:00:00.000Z', endsAt: '2026-08-19T12:00:00.000Z' } },
    { kind: 'decompose', commitmentId: 'c1', proposalId: 'p1' },
    { kind: 'decompose', commitmentId: 'c1', proposalId: 'p2' },
    { kind: 'defer', commitmentId: 'c1', until: '2026-08-20T10:00:00.000Z' },
    { kind: 'defer', commitmentId: 'c1', until: '2026-08-21T10:00:00.000Z' },
  ];
  const keys = actions.map(actionKey);
  assert.equal(new Set(keys).size, actions.length, 'every distinct action needs a distinct key');
  assert.equal(actionKey(actions[0]), actionKey({ kind: 'do_now', commitmentId: 'c1' }));
  // Segments are length-prefixed (`6:do_now|…`) rather than `:`-joined, so the
  // kind is matched as a whole segment. See the injectivity test below for why
  // the plain join had to go.
  for (const kind of RECOMMENDED_ACTION_KINDS) {
    assert.ok(keys.some((key) => key.startsWith(`${kind.length}:${kind}|`)), `${kind} must be represented`);
  }
});

/* ── alternatives preserve user control ───────────────────────────── */

test('contract: no option set exposes a field that means "the recommendation" on its own', () => {
  // Decision 2. `{ primary, alternatives }` renders correctly when
  // `alternatives` is dropped, which is exactly what makes dropping it
  // invisible. There is no such field to drop here.
  const nodes = [observed('n1')];
  const sets: readonly OptionSet[] = [
    { kind: 'choice', options: [option(0, 'c1', 'n1'), option(1, 'c2', 'n1')], excluded: [] },
    {
      kind: 'sole_survivor',
      option: option(0, 'c1', 'n1'),
      excluded: [{ action: { kind: 'do_now', commitmentId: 'c9' }, exclusion: [{ code: 'LOWER_RANKED', supportedBy: ['n1'], detail: 'ranked below the offered option' }] }],
    },
    { kind: 'only_candidate', option: option(0, 'c1', 'n1'), attested: ['n1'] },
  ];
  for (const set of sets) {
    for (const forbidden of ['primary', 'primaryStep', 'recommended', 'top']) {
      assert.equal(forbidden in set, false, `${set.kind} must not carry a '${forbidden}' field`);
    }
    // Reading the lead is only possible through a value that also states how
    // alone it is and what else was on the table.
    const summary = summarizeOptionSet(set);
    assert.equal(summary.soleness, set.kind);
    assert.ok(summary.lead);
    assert.ok(Array.isArray(summary.excluded));
    assert.equal(checkRecommendation(offered(set, nodes)).length, 0, `${set.kind} fixture must be clean`);
  }
});

test('contract: summarizeOptionSet hands over every alternative, by identity', () => {
  // **The assertion that was missing, and its absence let a real mutation live.**
  // The old check was `assert.ok(Array.isArray(summary.alternatives))`, which
  // passes on `[]` — so a `summarizeOptionSet` mutated to drop the alternatives
  // for a `choice` kept all eighty tests green. `alternatives` is the *only*
  // path by which a caller receives anything but the lead, so an assertion on
  // its type rather than its contents leaves the third acceptance criterion
  // unguarded on the one function that delivers it.
  //
  // Asserted by identity, not by length: a mutation returning a same-length
  // array of the wrong options, or the lead repeated, passes a count.
  const nodes = [observed('n1')];
  const second = option(1, 'c2', 'n1', 0.5);
  const third = option(2, 'c3', 'n1', 0.2);
  const set: OptionSet = { kind: 'choice', options: [option(0, 'c1', 'n1'), second, third], excluded: [] };

  const summary = summarizeOptionSet(set);
  assert.equal(summary.alternatives.length, 2);
  assert.equal(summary.alternatives[0], second, 'the first alternative must be the second option, by identity');
  assert.equal(summary.alternatives[1], third, 'the second alternative must be the third option, by identity');
  assert.equal(summary.lead, set.options[0]);
  // And the round trip: lead plus alternatives must reconstruct the offer.
  assert.deepEqual([summary.lead, ...summary.alternatives], set.options.slice());
  assert.deepEqual(offeredOptions(set).slice(), set.options.slice());
});

test('contract: an unrecognised option set yields no lead and says so', () => {
  // It used to fall through to the `only_candidate` branch and return
  // `lead: undefined` under `soleness: 'only_candidate'` — telling a renderer
  // "this is the only thing on your plate" about an offer it had failed to
  // parse. Version skew between #34 and #35 is the documented reason this runs
  // at both ends, so an unrecognised kind is the expected arrival, not an
  // exotic one.
  const summary = summarizeOptionSet({ kind: 'mystery' } as unknown as OptionSet);
  assert.equal(summary.lead, null);
  assert.equal(summary.soleness, 'unknown');
  assert.deepEqual(summary.alternatives.slice(), []);
  assert.deepEqual(offeredOptions({ kind: 'mystery' } as unknown as OptionSet).slice(), []);
});

test('contract: actionKey is injective across delimiter-bearing identifiers', () => {
  // Ids are caller-chosen free strings, so a `:` inside one is not hypothetical.
  // A plain join made a `schedule` of commitment `a:b` at `S` identical to a
  // `schedule` of commitment `a` at `b:S`, and the collision surfaced as a
  // DUPLICATE_OPTION_ACTION reported against two genuinely different actions.
  const left = actionKey({ kind: 'schedule', commitmentId: 'a:b', slot: { startsAt: 'S', endsAt: 'E' } });
  const right = actionKey({ kind: 'schedule', commitmentId: 'a', slot: { startsAt: 'b:S', endsAt: 'E' } });
  assert.notEqual(left, right, 'a delimiter inside an id must not merge two actions');

  const seen = new Set<string>();
  const ids = ['a', 'a:b', 'a|b', '1:a', '', '::'];
  for (const commitmentId of ids) {
    for (const startsAt of ids) {
      seen.add(actionKey({ kind: 'schedule', commitmentId, slot: { startsAt, endsAt: 'E' } }));
    }
  }
  assert.equal(seen.size, ids.length * ids.length, 'every distinct pair must produce a distinct key');
});

/**
 * Values an action can arrive as at an untrusted boundary. Shaped so that the
 * type-collapsing pairs sit next to each other: `42`/`'42'`, `true`/`'true'`,
 * `{}`/`[]`, `[1]`/`{ '0': 1 }`, `null`/`'null'`.
 */
const UNUSABLE_ACTIONS: readonly unknown[] = [
  null,
  undefined,
  'null',
  42,
  '42',
  true,
  'true',
  {},
  [],
  [1],
  { 0: 1 },
  { kind: 'teleport', commitmentId: 'c1' },
  { kind: 'teleport', commitmentId: 'c2' },
  { kind: null },
  { commitmentId: 'c1' },
];

test('contract: actionKey is total over every shape an action can arrive as', () => {
  // `action.kind` on `null` raised a TypeError out of a function whose whole job
  // is to produce a key, so every caller had to know it was unsafe — #35 was
  // carrying a local guard for exactly this. `throwOnlyWhenNoCodeApplies` is
  // true, and `UNKNOWN_ACTION_KIND` is the code that applies.
  for (const action of UNUSABLE_ACTIONS) {
    assert.doesNotThrow(() => actionKey(action as RecommendedAction), `actionKey threw on ${String(action)}`);
    assert.equal(typeof actionKey(action as RecommendedAction), 'string', `no key for ${String(action)}`);
    assert.equal(isKnownActionKind(action as RecommendedAction), false, `${String(action)} must not read as a known kind`);
  }
});

test('contract: no two unusable actions share a key', () => {
  // The collision trap, and it was not hypothetical: before the type tag, four
  // pairs already collided — 42/'42', true/'true', {}/[] and [1]/{'0':1} — and
  // each collision is a fabricated DUPLICATE_OPTION_ACTION. Guarding the null
  // throw alone would have added a fifth, null/'null', while looking like a pure
  // safety fix.
  const keys = UNUSABLE_ACTIONS.map((action) => actionKey(action as RecommendedAction));
  const seen = new Map<string, unknown>();
  for (let index = 0; index < keys.length; index += 1) {
    const clash = seen.get(keys[index]);
    assert.equal(
      clash,
      undefined,
      `${String(UNUSABLE_ACTIONS[index])} and ${String(clash)} share a key, which fabricates a duplicate`,
    );
    seen.set(keys[index], UNUSABLE_ACTIONS[index]);
  }
  assert.equal(seen.size, UNUSABLE_ACTIONS.length);
  // Equal values must still agree, or the key is not a key.
  assert.equal(actionKey({ kind: 'teleport', commitmentId: 'c1' } as unknown as RecommendedAction), keys[11]);
});

test('contract: an unusable action never collides with a well-formed one', () => {
  const real = [
    actionKey({ kind: 'do_now', commitmentId: 'c1' }),
    actionKey({ kind: 'defer', commitmentId: 'c1', until: '2026-08-20T10:00:00.000Z' }),
  ];
  for (const action of UNUSABLE_ACTIONS) {
    assert.equal(real.includes(actionKey(action as RecommendedAction)), false, String(action));
  }
});

test('contract: a lone offered option always carries an account of why it is alone', () => {
  const nodes = [observed('n1')];
  const sole: OptionSet = {
    kind: 'sole_survivor',
    option: option(0, 'c1', 'n1'),
    excluded: [{ action: { kind: 'do_now', commitmentId: 'c2' }, exclusion: [{ code: 'ALREADY_CLOSED', supportedBy: ['n1'], detail: 'the commitment is in a terminal status' }] }],
  };
  const only: OptionSet = { kind: 'only_candidate', option: option(0, 'c1', 'n1'), attested: ['n1'] };

  assert.equal(offeredOptions(sole).length, 1);
  assert.ok(summarizeOptionSet(sole).excluded.length > 0, 'sole_survivor must say what was excluded');
  assert.equal(offeredOptions(only).length, 1);
  assert.ok(only.attested.length > 0, 'only_candidate must attest that nothing else existed');

  // The two are not interchangeable: "the only thing that survived filtering"
  // and "the only thing on your plate" are different claims about the user's
  // life, and the summary keeps them distinguishable downstream.
  assert.notEqual(summarizeOptionSet(sole).soleness, summarizeOptionSet(only).soleness);
  void checkRecommendation(offered(sole, nodes));
});

test('contract: a choice carries at least the policy minimum and never more than the cap', () => {
  const nodes = [observed('n1')];
  const choice: OptionSet = {
    kind: 'choice',
    options: [option(0, 'c1', 'n1'), option(1, 'c2', 'n1')],
    excluded: [],
  };
  assert.ok(offeredOptions(choice).length >= RECOMMENDATION_OPTION_POLICY.minOptionsForChoice);
  assert.equal(RECOMMENDATION_OPTION_POLICY.minOptionsForChoice, 2);
  assert.equal(checkRecommendation(offered(choice, nodes)).length, 0);

  const overCap: OptionSet = {
    kind: 'choice',
    options: [option(0, 'c1', 'n1'), option(1, 'c2', 'n1'), option(2, 'c3', 'n1'), option(3, 'c4', 'n1')],
    excluded: [],
  };
  const codes = checkRecommendation(offered(overCap, nodes)).map((defect) => defect.code);
  assert.deepEqual(codes, ['OPTION_CAP_EXCEEDED']);
});

test('contract: an offer cannot fake a choice', () => {
  const nodes = [observed('n1')];
  // Two rows on screen, one outcome. Every cardinality check this offer could
  // face is satisfied; only comparing the actions catches it.
  const duplicated: OptionSet = {
    kind: 'choice',
    options: [option(0, 'c1', 'n1'), option(1, 'c1', 'n1')],
    excluded: [],
  };
  const codes = checkRecommendation(offered(duplicated, nodes)).map((defect) => defect.code);
  assert.deepEqual(codes, ['DUPLICATE_OPTION_ACTION']);
});

test('contract: an offer cannot both state and deny one action', () => {
  const nodes = [observed('n1')];
  const contradictory: OptionSet = {
    kind: 'choice',
    options: [option(0, 'c1', 'n1'), option(1, 'c2', 'n1')],
    excluded: [{ action: { kind: 'do_now', commitmentId: 'c2' }, exclusion: [{ code: 'LOWER_RANKED', supportedBy: ['n1'], detail: 'ranked below the offered options' }] }],
  };
  const defects = checkRecommendation(offered(contradictory, nodes));
  assert.deepEqual(defects.map((defect) => defect.code), ['EXCLUDED_OPTION_ALSO_OFFERED']);
  assert.equal(defects[0].optionIndex, 1, 'the finding must point at the offered position');
});

test('contract: an option index that has drifted from its position is a defect', () => {
  const nodes = [observed('n1')];
  // A decision targets an option by index precisely so no identifier has to
  // appear in a payload; a drifted index silently retargets the user's accept.
  const drifted: OptionSet = {
    kind: 'choice',
    options: [option(0, 'c1', 'n1'), { ...option(1, 'c2', 'n1'), optionIndex: 5 }],
    excluded: [],
  };
  const defects = checkRecommendation(offered(drifted, nodes));
  assert.deepEqual(defects.map((defect) => defect.code), ['OPTION_INDEX_MISMATCH']);
  assert.equal(defects[0].optionIndex, 1);
});

test('contract: a stored confidence band that disagrees with its value is a defect', () => {
  const nodes = [observed('n1')];
  const mismatched: OptionSet = {
    kind: 'choice',
    options: [
      option(0, 'c1', 'n1'),
      { ...option(1, 'c2', 'n1'), confidence: { value: 0.1, band: 'high', basis: ['n1'] } },
    ],
    excluded: [],
  };
  const defects = checkRecommendation(offered(mismatched, nodes));
  assert.deepEqual(defects.map((defect) => defect.code), ['CONFIDENCE_BAND_MISMATCH']);

  const outOfRange: OptionSet = {
    kind: 'choice',
    options: [
      option(0, 'c1', 'n1'),
      { ...option(1, 'c2', 'n1'), confidence: { value: Number.NaN, band: 'low', basis: ['n1'] } },
    ],
    excluded: [],
  };
  assert.deepEqual(
    checkRecommendation(offered(outOfRange, nodes)).map((defect) => defect.code),
    ['CONFIDENCE_OUT_OF_RANGE'],
  );
});

/* ── decisions, and the relation to the pilot ─────────────────────── */

/**
 * The superset claim, checked by the compiler in both directions.
 *
 * `RecommendationDecisionVerdict` must accept exactly the pilot's five verdicts:
 * narrower and #35 could not express a decision the shipped surface already
 * takes; wider and a verdict would exist that the pilot's aggregation has never
 * seen. The *difference* between the two contracts is `optionIndex`, not the
 * verb set, and pinning the verb set here is what keeps that true.
 */
type _VerdictsAreTheSameSet =
  Exclude<RecommendationDecisionVerdict, NextStepDecision> extends never
    ? (Exclude<NextStepDecision, RecommendationDecisionVerdict> extends never ? true : never)
    : never;
const _verdictsAreTheSameSet: _VerdictsAreTheSameSet = true;

test('contract: a decision targets one option, which is what makes alternatives actionable', () => {
  assert.equal(_verdictsAreTheSameSet, true);
  const accepted: RecommendationDecision = {
    version: RECOMMENDATION_CONTRACT_VERSION,
    recommendationId: 'rec-1',
    optionIndex: 2,
    verdict: 'accept',
    decidedAt: '2026-08-19T10:30:00.000Z',
  };
  assert.equal(accepted.optionIndex, 2);
  // Accepting option #2 *is* choosing an alternative. A separate
  // `choose_alternative` verdict would give one user act two spellings.
  const verdicts: readonly RecommendationDecisionVerdict[] = ['accept', 'edit', 'defer', 'dismiss', 'done'];
  assert.equal(verdicts.includes('accept' as RecommendationDecisionVerdict), true);
  assert.equal((verdicts as readonly string[]).includes('choose_alternative'), false);

  const dismissedWhole: RecommendationDecision = {
    version: RECOMMENDATION_CONTRACT_VERSION,
    recommendationId: 'rec-1',
    optionIndex: null,
    verdict: 'dismiss',
    decidedAt: '2026-08-19T10:30:00.000Z',
  };
  assert.equal(dismissedWhole.optionIndex, null);
});

/* ── policy ───────────────────────────────────────────────────────── */

test('contract: the persistence policy states the module boundary this repo holds everywhere', () => {
  assert.equal(Object.isFrozen(RECOMMENDATION_PERSISTENCE_POLICY), true);
  assert.deepEqual({ ...RECOMMENDATION_PERSISTENCE_POLICY }, {
    recommendationCanPersist: false,
    confirmationRequired: true,
    adapterOwnsCanonicalWrites: true,
    rawInputInAudit: false,
    originalCommitmentRemainsCanonical: true,
    noAmbientClock: true,
    everyClaimIsSourced: true,
    staleRecommendationIsNotOfferable: true,
  });
});

test('contract: the input policy carries the report-dont-throw rule plus this module’s own clause', () => {
  assert.equal(Object.isFrozen(RECOMMENDATION_INPUT_POLICY), true);
  assert.equal(RECOMMENDATION_INPUT_POLICY.reportWhatTheTaxonomyNames, true);
  assert.equal(RECOMMENDATION_INPUT_POLICY.throwOnlyWhenNoCodeApplies, true);
  assert.equal(RECOMMENDATION_INPUT_POLICY.digestAfterStaticPass, true);
  // The clause that is not a restatement: it decides which way an absence
  // resolves, and the comfortable direction is the wrong one.
  assert.equal(RECOMMENDATION_INPUT_POLICY.unverifiableSourceIsStale, true);
});

test('contract: the ordering keys are a total order ending in a unique key', () => {
  assert.equal(Object.isFrozen(RECOMMENDATION_ORDERING_KEYS), true);
  assert.deepEqual(RECOMMENDATION_ORDERING_KEYS.slice(), [
    '-confidence',
    '-priority',
    'earliestDeadline',
    'commitmentId',
  ]);
  assert.equal(
    RECOMMENDATION_ORDERING_KEYS[RECOMMENDATION_ORDERING_KEYS.length - 1],
    'commitmentId',
    'the last key must be unique within a scope or the order is not total',
  );
});

test('contract: the option cap and the default TTL are stated as data', () => {
  assert.equal(Object.isFrozen(RECOMMENDATION_OPTION_POLICY), true);
  assert.equal(RECOMMENDATION_OPTION_POLICY.maxOptions, 3);
  assert.equal(typeof DEFAULT_RECOMMENDATION_TTL_MINUTES, 'number');
  assert.ok(DEFAULT_RECOMMENDATION_TTL_MINUTES > 0);
});

/* ── layering ─────────────────────────────────────────────────────── */

/**
 * Comments are stripped before the import scan, and that is not tidiness.
 *
 * The first draft of this test matched `from ['"]…['"]` over the raw source and
 * failed on the prose `distinguish "nothing to do" from "everything was
 * filtered out"` inside a doc comment — a false positive. The same scanner run
 * against a file whose only `lib/` import sat inside a commented-out line would
 * have produced the mirror-image false *negative*, and that direction is silent.
 * This is the hazard `tests/decomposition/proposalBoundaries.test.ts` records:
 * a scanner that sees the wrong text reports a perfectly clean closure.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('contract: the comment stripper is checked before it is trusted', () => {
  assert.equal(stripComments('a /* from "x" */ b').includes('from'), false);
  assert.equal(stripComments('a // import x from "lib/y"\nb').includes('import'), false);
  assert.equal(stripComments("import { a } from './b';").includes("from './b'"), true);
});

test('contract: the contract imports no implementation, only other contracts', () => {
  // A contract that reaches into `lib/` inverts the layering every other
  // contract in this repo holds, and it would put one track's implementation
  // into every other track's import closure. Matching on the specifier is
  // sufficient here only because a contract has no relative path that could
  // reach `lib/` without spelling it.
  const source = stripComments(
    readFileSync(join(repoRoot, 'src', 'contracts', 'v1', 'recommendationContracts.ts'), 'utf8'),
  );
  const specifiers = Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g)).map((match) => match[1]);
  assert.ok(specifiers.length >= 3, 'the scan must actually see the imports');
  assert.ok(specifiers.includes('./moduleContracts'), 'the scan must see a known import');
  for (const specifier of specifiers) {
    assert.equal(/(^|\/)lib\//.test(specifier), false, `must not import implementation: ${specifier}`);
    assert.equal(specifier.startsWith('./'), true, `contracts import only sibling contracts: ${specifier}`);
  }
  // The pilot is deliberately not imported: this module must not inherit a
  // shipped wire format as a data contract.
  assert.equal(/nextStep/.test(source), false, 'the module must not depend on the pilot surface');
});

/* ── registration ─────────────────────────────────────────────────── */

/**
 * The sprint's coverage guard, owned here until integration moves it into the
 * merge-owned cross-track file.
 *
 * Measured on this runner, and the nuance matters: `node --test` given a list
 * where *some* files exist and one does not runs the ones that exist, prints
 * nothing about the missing one, and **exits 0**. Only when every named file is
 * missing does it fail loudly. So a single typo'd path in `package.json` — or a
 * test file written and never registered — removes coverage with no signal at
 * all, which is precisely the failure this asserts against.
 *
 * The two directions are asserted asymmetrically, on purpose. "Every file on
 * disk is registered" can be enforced fully today. "Every registered path
 * exists" cannot: nine of the twelve names belong to tracks still in flight, so
 * they are allowed to be absent — but only if they are one of the twelve names
 * agreed for this sprint, which still catches a typo. At integration, when all
 * twelve exist, the allowance is inert and can be tightened to a plain
 * existence check.
 */
const SPRINT_08_TEST_FILES: readonly string[] = [
  'tests/recommendation/contractSchema.test.ts',
  'tests/recommendation/evidenceGraph.test.ts',
  'tests/recommendation/expiryRules.test.ts',
  'tests/recommendation/selectorCandidates.test.ts',
  'tests/recommendation/selectorPolicy.test.ts',
  'tests/recommendation/selectorDeterminism.test.ts',
  'tests/recommendation/selectorBoundaries.test.ts',
  'tests/recommendation/reviewContract.test.ts',
  'tests/recommendation/reviewAccessibility.test.ts',
  'tests/recommendation/reviewApi.test.ts',
  'tests/recommendation/recommendationCrossTrack.test.ts',
  'tests/recommendation/recommendationBoundaries.test.ts',
];

function scriptPaths(script: string): readonly string[] {
  return script.split(/\s+/).filter((token) => token.startsWith('tests/recommendation/'));
}

test('registration: package.json registers every agreed Sprint 08 test file', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.ok(manifest.scripts['test:sprint08'], 'test:sprint08 must exist beside test:sprint07');

  const inSprintScript = scriptPaths(manifest.scripts['test:sprint08']);
  const inFullScript = scriptPaths(manifest.scripts.test);

  assert.deepEqual(inSprintScript.slice(), SPRINT_08_TEST_FILES.slice());
  assert.deepEqual(
    inFullScript.slice().sort(),
    SPRINT_08_TEST_FILES.slice().sort(),
    'the full suite must register the same set as the sprint script',
  );
  assert.equal(new Set(inFullScript).size, inFullScript.length, 'no path may be registered twice');
});

test('registration: every recommendation test file on disk is registered', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const registered = new Set(scriptPaths(manifest.scripts.test));
  const onDisk = readdirSync(join(repoRoot, 'tests', 'recommendation'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `tests/recommendation/${name}`);

  assert.ok(onDisk.length > 0, 'the scan must actually see this directory');
  for (const file of onDisk) {
    assert.equal(registered.has(file), true, `${file} exists but no script runs it`);
  }
});

test('registration: a registered path that does not exist is one of the agreed names', () => {
  const agreed = new Set(SPRINT_08_TEST_FILES);
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const file of scriptPaths(manifest.scripts.test)) {
    if (existsSync(join(repoRoot, file))) continue;
    assert.equal(agreed.has(file), true, `${file} is registered, absent, and not an agreed Sprint 08 name`);
  }
  // The three this issue owns are not allowed to be absent.
  for (const file of SPRINT_08_TEST_FILES.slice(0, 3)) {
    assert.equal(existsSync(join(repoRoot, file)), true, `${file} is owned by #33 and must exist`);
  }
});

/* ── decisions are checked, not merely argued about ───────────────── */

/**
 * The contract argued at length that a drifted `optionIndex` "silently retargets
 * a user's accept onto a different action", made that a defect of the *offer*,
 * and then shipped nothing that checked a decision at all. An argument about why
 * a field is dangerous, with no check on the field, reads as a guarantee and is
 * not one.
 */
function offerOf(count: number): OfferedRecommendation {
  const nodes = [observed('n1')];
  const options = [option(0, 'c1', 'n1'), option(1, 'c2', 'n1', 0.5), option(2, 'c3', 'n1', 0.2)].slice(0, count);
  const set: OptionSet =
    count >= 2
      ? { kind: 'choice', options: options as [RecommendationOption, RecommendationOption, ...RecommendationOption[]], excluded: [] }
      : { kind: 'only_candidate', option: options[0], attested: ['n1'] };
  return offered(set, nodes);
}

function decision(overrides: Partial<RecommendationDecision>): RecommendationDecision {
  return {
    version: RECOMMENDATION_CONTRACT_VERSION,
    recommendationId: 'rec-1',
    optionIndex: 0,
    verdict: 'accept',
    decidedAt: '2026-08-19T10:30:00.000Z',
    ...overrides,
  };
}

test('decision: a well-formed acceptance of an alternative is clean', () => {
  assert.deepEqual(checkRecommendationDecision(offerOf(3), decision({ optionIndex: 2 })).slice(), []);
});

test('decision: an index outside the offer is reported', () => {
  for (const optionIndex of [3, -1, 1.5, Number.NaN]) {
    const defects = checkRecommendationDecision(offerOf(3), decision({ optionIndex }));
    assert.deepEqual(defects.map((defect) => defect.code), ['DECISION_TARGETS_UNKNOWN_OPTION'], `index ${optionIndex}`);
  }
});

test('decision: a decision naming a different offer is reported', () => {
  const defects = checkRecommendationDecision(offerOf(2), decision({ recommendationId: 'rec-other' }));
  assert.deepEqual(defects.map((defect) => defect.code), ['DECISION_RECOMMENDATION_MISMATCH']);
  // The worst available outcome is a real user act recorded against an action
  // they never saw, so the id must not be echoed into the message either.
  assert.equal(defects[0].detail.includes('rec-other'), false);
});

test('decision: a verdict that applies to one option must name one', () => {
  for (const verdict of ['accept', 'edit', 'defer', 'done'] as const) {
    const defects = checkRecommendationDecision(
      offerOf(2),
      decision({ optionIndex: null, verdict, editedTitle: 'rewritten' }),
    );
    assert.ok(defects.some((defect) => defect.code === 'DECISION_TARGET_REQUIRED'), verdict);
  }
  // Dismissing the whole offer is the one verdict that legitimately targets none.
  assert.deepEqual(checkRecommendationDecision(offerOf(2), decision({ optionIndex: null, verdict: 'dismiss' })).slice(), []);
});

test('decision: an edit with no replacement title is reported', () => {
  for (const editedTitle of [undefined, '', '   ']) {
    const defects = checkRecommendationDecision(offerOf(2), decision({ verdict: 'edit', editedTitle }));
    assert.deepEqual(defects.map((defect) => defect.code), ['DECISION_EDIT_WITHOUT_TITLE'], String(editedTitle));
  }
  assert.deepEqual(checkRecommendationDecision(offerOf(2), decision({ verdict: 'edit', editedTitle: 'rewritten' })).slice(), []);
});

test('decision: a verdict on a withheld offer is reported', () => {
  const nodes = [observed('n1')];
  const withheld = {
    ...offered({ kind: 'only_candidate', option: option(0, 'c1', 'n1'), attested: ['n1'] }, nodes),
    outcome: 'withheld',
    reasons: [{ code: 'NO_ELIGIBLE_CANDIDATE', supportedBy: ['n1'], detail: 'the scope holds no open commitment' }],
  } as unknown as OfferedRecommendation;
  assert.deepEqual(
    checkRecommendationDecision(withheld, decision({ optionIndex: 0 })).map((defect) => defect.code),
    ['DECISION_TARGETS_WITHHELD'],
  );
  assert.deepEqual(checkRecommendationDecision(withheld, decision({ optionIndex: null, verdict: 'dismiss' })).slice(), []);
});

test('decision: an unrecognised verdict is reported, not thrown on', () => {
  const defects = checkRecommendationDecision(offerOf(2), decision({ verdict: 'annihilate' as RecommendationDecisionVerdict }));
  assert.deepEqual(defects.map((defect) => defect.code), ['DECISION_UNKNOWN_VERDICT']);
});

test('decision: no malformed pair makes the decision checker throw', () => {
  const pairs: readonly (readonly [unknown, unknown])[] = [
    [undefined, decision({})],
    [offerOf(2), undefined],
    [null, null],
    [{ ...offerOf(2), options: undefined }, decision({})],
    [offerOf(2), { verdict: 'accept' }],
  ];
  for (const [rec, dec] of pairs) {
    assert.doesNotThrow(() =>
      checkRecommendationDecision(rec as OfferedRecommendation, dec as RecommendationDecision),
    );
  }
});

test('decision: the verdict vocabulary is the pilot’s, exposed as data', () => {
  assert.deepEqual(RECOMMENDATION_DECISION_VERDICTS.slice(), ['accept', 'edit', 'defer', 'dismiss', 'done']);
  assert.equal((RECOMMENDATION_DECISION_VERDICTS as readonly string[]).includes('choose_alternative'), false);
});
