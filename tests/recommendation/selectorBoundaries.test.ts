/**
 * Structural guards on `lib/recommendation/**` (Sprint 08, issue #34).
 *
 * These are the claims no behavioural test can make, because each is about what
 * the module *could* do rather than what it does on one input.
 *
 *  1. **Nothing here reaches a writer, a route handler, the mobile app, or a UI
 *     surface.** A recommendation is a proposal
 *     (`RECOMMENDATION_PERSISTENCE_POLICY.recommendationCanPersist: false`), and
 *     this module is a leaf the API depends on rather than the reverse.
 *
 *  2. **Nothing here reads an ambient clock or a random source.** Determinism is
 *     the headline criterion and a single `Date.now()` would break it in a way
 *     no behavioural test would reliably catch — a determinism test that ran
 *     twice in the same millisecond would pass.
 *
 *  3. **Nothing here calls `localeCompare`.** Its result depends on the
 *     runtime's ICU data and default locale, so an offer's order — and therefore
 *     every `optionIndex` a `RecommendationDecision` targets — would change with
 *     `LANG`. The pilot uses it twice; that is a known pre-existing defect being
 *     fixed elsewhere, not a precedent.
 *
 *  4. **Nothing here reaches the pilot.** `selectorCandidates.test.ts` compares
 *     this module's hard-constraint exclusions against
 *     `nextStepBaseline.ts`'s. If either could reach the other, that comparison
 *     would be comparing a thing with itself and would pass no matter how wrong
 *     both were — the reason `tests/planning/planningBoundaries.test.ts` bans
 *     the oracle from reaching the validator.
 *
 *  5. **The dependency on `lib/planning/shared` runs one way.** This module
 *     imports the repo's single copies of string ordering and instant
 *     arithmetic; nothing under `lib/planning/**` may import back, or a Sprint 07
 *     revert landing after this one would have two directions to look in.
 *
 * Matching is on the **resolved repo path**, never on the specifier text.
 * Sprint 06 recorded why: a pattern anchored on
 * `decomposition/(proposal|evaluation)` never saw an import spelled
 * `../proposal/...`, and went on reporting a clean separation across the very
 * edge it existed to forbid.
 *
 * The last test in this file is the one that catches the leak Sprint 07 actually
 * shipped: a caller-chosen identifier reaching a human-readable string. A test
 * that only checked titles were absent passed straight over a detail reading
 * `working window call-dr.cohen-about-the-biopsy`, so this one drives
 * distinctive ids through every code path and scans every string the output
 * carries, `detail` and otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  selectRecommendation,
  type CommitmentSnapshot,
  type RecommendationSelectorConfig,
  type RecommendationSelectorInput,
} from '../../lib/recommendation/index.ts';
import type { Field, LifeState } from '../../src/contracts/v1/lifeStateContracts.ts';
import type { Plan } from '../../src/contracts/v1/planningContracts.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const recommendationDir = join(repoRoot, 'lib', 'recommendation');
const planningDir = join(repoRoot, 'lib', 'planning');

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
] as const;

function sourceFiles(directory: string, recurse = false): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (recurse) found.push(...sourceFiles(path, true));
      continue;
    }
    if (entry.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect-only imports bind no name but still run the module, which is
    // enough to drag a writer into the closure.
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || null;
}

/** Every repo file reachable from `roots`, mapped to its own import specifiers. */
function importClosure(roots: readonly string[]): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = roots.slice();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (closure.has(file)) continue;
    const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
    closure.set(file, specifiers);
    for (const specifier of specifiers) {
      const resolved = resolveLocal(file, specifier);
      if (resolved && !closure.has(resolved)) queue.push(resolved);
    }
  }
  return closure;
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

/**
 * Source with comments removed, for the scans that look for forbidden *calls*.
 *
 * Necessary here for the same reason it was in `lib/planning`: this module's
 * headers explain — in prose, correctly — why a selector must never call
 * `Date.now()`, and a raw-text scan cannot tell an explanation from a violation.
 * The cheapest way to make such a scan pass would be to delete the explanation,
 * which is the wrong direction.
 *
 * The guard is not weakened, and both directions are proved below: the patterns
 * still match real calls after stripping, and prose naming a forbidden call does
 * not read as one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function reachablePaths(roots: readonly string[]): string[] {
  return Array.from(importClosure(roots).keys())
    .filter((file) => !roots.includes(file))
    .map(relative)
    .sort();
}

const RECOMMENDATION_ROOTS = sourceFiles(recommendationDir, true);

/* ── The guards are never vacuous ────────────────────────────────── */

test('the module directory exists and its files are the ones being scanned', () => {
  // Without this, every closure below would walk an empty root set and pass by
  // finding nothing — the failure mode where a renamed directory turns a suite
  // of structural guards into a suite of tautologies.
  const files = RECOMMENDATION_ROOTS.map(relative);
  assert.ok(files.length > 0, 'no source files found under lib/recommendation');
  for (const expected of [
    'lib/recommendation/index.ts',
    'lib/recommendation/selector/candidates.ts',
    'lib/recommendation/selector/policy.ts',
    'lib/recommendation/selector/select.ts',
  ]) {
    assert.ok(files.indexOf(expected) !== -1, `expected ${expected} to be scanned`);
  }
});

test('the closure walks past the first hop, so it is not a direct-import check in disguise', () => {
  const roots = [join(recommendationDir, 'index.ts')];
  const closure = importClosure(roots);
  const directlyImported = new Set(
    roots.flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .map((specifier) => resolveLocal(file, specifier))
        .filter((resolved): resolved is string => resolved !== null),
    ),
  );
  assert.ok(
    Array.from(closure.keys()).some((file) => !roots.includes(file) && !directlyImported.has(file)),
    'expected the closure to reach at least one module more than one hop away',
  );
});

/* ── Layer bans ──────────────────────────────────────────────────── */

test('nothing under lib/recommendation reaches a writer, a route handler, the mobile app, or a UI surface', () => {
  const closure = importClosure(RECOMMENDATION_ROOTS);
  assert.ok(closure.size > 0, 'nothing was scanned');
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const basename = specifier.split('/').pop() as string;
      assert.equal(
        (FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename),
        false,
        `${relative(file)} reaches writer module "${specifier}"; a recommendation proposes and must never persist`,
      );
      assert.equal(
        /(^|\/)(app\/api|app\/\(|mobile|components)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; recommendation is a leaf the API depends on, not the reverse`,
      );
    }
  }
  // And on resolved paths, which is what catches a relative spelling the
  // specifier patterns above would not recognise.
  for (const file of reachablePaths(RECOMMENDATION_ROOTS)) {
    assert.equal(
      /^src\/(app|components)\//.test(file),
      false,
      `${file} is reachable from lib/recommendation; it is a UI or route surface`,
    );
    assert.equal(
      /^mobile\//.test(file),
      false,
      `${file} is reachable from lib/recommendation; the mobile app is downstream`,
    );
  }
});

test('nothing under lib/recommendation reaches the shipped next-step pilot', () => {
  // The cross-track comparison in selectorCandidates.test.ts is only meaningful
  // if the two readings are independent.
  for (const file of reachablePaths(RECOMMENDATION_ROOTS)) {
    assert.equal(
      /(^|\/)nextStep/.test(file),
      false,
      `${file} is reachable from lib/recommendation; the module version must decide eligibility independently of the pilot`,
    );
    assert.equal(
      /^lib\/services\//.test(file),
      false,
      `${file} is reachable from lib/recommendation; lib/services is the product layer`,
    );
  }
});

test('the permitted edge into lib/planning/shared exists, and nothing wider does', () => {
  // Asserted together with the ban, because separating them invites a change
  // that drops the shared import and adds a judgement import while each test
  // still passes on its own terms.
  const reached = reachablePaths(RECOMMENDATION_ROOTS);
  assert.ok(
    reached.indexOf('lib/planning/shared/compare.ts') !== -1,
    'the single copy of the repo\'s string ordering is no longer imported; check for a local comparator',
  );
  for (const file of reached) {
    if (!/^lib\/planning\//.test(file)) continue;
    assert.match(
      file,
      /^lib\/planning\/shared\//,
      `${file} is reachable from lib/recommendation; only the shared leaf may be imported, never a planning judgement`,
    );
  }
});

test('the dependency on lib/planning runs one way: planning never reaches recommendation', () => {
  const planningRoots = sourceFiles(planningDir, true);
  assert.ok(planningRoots.length > 0, 'no planning sources were scanned');
  for (const file of reachablePaths(planningRoots)) {
    assert.equal(
      /^lib\/recommendation\//.test(file),
      false,
      `${file} is reachable from lib/planning; the edge must run only from recommendation to planning`,
    );
  }
});

/* ── No ambient clock, no random source, no localeCompare ────────── */

const FORBIDDEN_CALLS: readonly (readonly [RegExp, string])[] = [
  [/Date\.now\s*\(/, 'must not call Date.now(); every instant comes from the input'],
  [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock'],
  [/Math\.random\s*\(/, 'must not use Math.random(); a selector must be replayable'],
  [/randomUUID/, 'must not mint ids; two runs of the same input must agree on every field'],
  [/\.localeCompare\s*\(/, 'must not use localeCompare; use compareByCodePoint from lib/planning/shared/compare'],
];

test('no module under lib/recommendation reads an ambient clock, a random source, or a locale collator', () => {
  assert.ok(RECOMMENDATION_ROOTS.length > 0, 'no recommendation sources were scanned');
  for (const file of RECOMMENDATION_ROOTS) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of FORBIDDEN_CALLS) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('the scan still recognises a real call, so stripping comments did not disarm it', () => {
  // A negative-only assertion passes against a regex that matches nothing, and
  // just as well against a stripper that ate the whole file. Both halves are
  // pinned: the patterns still match real calls after stripping, and prose about
  // them does not read as a violation.
  const samples = [
    'const at = Date.now();',
    'const at = new Date();',
    'const r = Math.random();',
    'const id = randomUUID();',
    'const order = left.localeCompare(right);',
  ];
  assert.equal(samples.length, FORBIDDEN_CALLS.length);
  for (let index = 0; index < samples.length; index += 1) {
    const [pattern] = FORBIDDEN_CALLS[index];
    assert.equal(pattern.test(samples[index]), true, `pattern ${index} no longer matches its own sample`);
    assert.equal(
      pattern.test(stripComments(samples[index])),
      true,
      `stripComments removed real code for pattern ${index}`,
    );
  }

  // The other direction: a comment explaining the rule must not read as a
  // violation of it — in both comment syntaxes, since the stripper handles them
  // with two different expressions.
  for (const prose of [
    '/** never call Date.now() here */\nconst x = 1;',
    '// we do not use Math.random() in this module\nconst x = 1;',
    '/* localeCompare is banned; see compare.ts */\nconst x = 2;',
    'const x = 1; // randomUUID would break replay',
  ]) {
    const stripped = stripComments(prose);
    for (const [pattern] of FORBIDDEN_CALLS) {
      assert.equal(pattern.test(stripped), false, `prose read as a violation: ${JSON.stringify(prose)}`);
    }
    assert.match(stripped, /const x = \d/, 'the stripper removed the code beside the comment');
  }

  // And the stripper does not eat a URL's `//`, which would delete real code
  // after it. This is why the line-comment pattern is anchored on a non-colon.
  assert.match(stripComments("const url = 'https://example.test'; const y = 3;"), /const y = 3/);
});

/* ── The identifier leak ─────────────────────────────────────────── */

const LEAKY_IDS = Object.freeze({
  scopeId: 'scope-ZZLEAKSCOPE',
  recommendationId: 'rec-ZZLEAKREC',
  alpha: 'call-dr.cohen-about-the-biopsy',
  bravo: 'ZZLEAKBRAVO-tell-the-school',
  charlie: 'ZZLEAKCHARLIE',
  delta: 'ZZLEAKDELTA',
  planItem: 'ZZLEAKPLANITEM',
  proposal: 'ZZLEAKPROPOSAL',
  step: 'ZZLEAKSTEP',
  planDigest: 'ZZLEAKPLANDIGEST',
  policyVersion: 'ZZLEAKPOLICY',
});

const COMPUTED_AT = '2026-08-19T11:30:00.000Z';
const NOW = '2026-08-19T12:00:00.000Z';

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

function leakyLifeState(): LifeState {
  return {
    version: 'life-state-v1',
    scopeId: LEAKY_IDS.scopeId,
    computedAt: COMPUTED_AT,
    inputDigest: 'ZZLEAKLIFEDIGEST',
    commitments: knownField({
      countsByStatus: { active: 4 },
      openCount: 4,
      overdueCount: 2,
      openCommitmentIds: [LEAKY_IDS.alpha],
      overdueCommitmentIds: [LEAKY_IDS.alpha],
    }),
    availability: unknownField(),
    load: knownField({ totalUrgencyScore: 5, openCount: 4, overdueCount: 2, dueSoonCount: 1, band: 'moderate' }),
    recentOutcomes: unknownField(),
  };
}

function snapshot(
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

/**
 * Every string in a value, with the fields the contract *gives* ids their own
 * home removed first.
 *
 * `RecommendedAction.commitmentId`, `TrustedSource.commitmentId` and their
 * siblings are typed fields a consumer that must not display them can drop, and
 * the contract says so explicitly. What the rule forbids is an id in a *message*
 * — so those keys are pruned and everything else is scanned, which is the
 * opposite of a scan that only looks at `detail` and therefore only finds the
 * leaks it went looking for.
 */
const ID_BEARING_KEYS = new Set([
  'commitmentId',
  'recommendationId',
  'scopeId',
  'proposalId',
  'stepId',
  'itemId',
  'nodeId',
  'planDigest',
  'policyVersion',
  'inputDigest',
  'supportedBy',
  'basis',
  'attested',
  'derivedFrom',
]);

function humanReadableStrings(value: unknown, key: string | null, found: string[]): string[] {
  if (typeof value === 'string') {
    if (key === null || !ID_BEARING_KEYS.has(key)) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) humanReadableStrings(entry, key, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.entries(value as Record<string, unknown>)) {
      if (ID_BEARING_KEYS.has(entry[0])) continue;
      humanReadableStrings(entry[1], entry[0], found);
    }
  }
  return found;
}

function leakyRequests(): readonly RecommendationSelectorInput[] {
  const plan: Plan = {
    version: 'v1',
    schema: 'planning-v1',
    scopeId: LEAKY_IDS.scopeId,
    horizon: { startsAt: NOW, endsAt: '2026-08-20T00:00:00.000Z' },
    scheduled: [
      {
        itemId: LEAKY_IDS.planItem,
        interval: { startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' },
        reservedInterval: { startsAt: '2026-08-19T13:00:00.000Z', endsAt: '2026-08-19T13:10:00.000Z' },
      },
    ],
    unscheduled: [],
    constraintReasons: [],
    inputDigest: LEAKY_IDS.planDigest,
  };
  const base: RecommendationSelectorInput = {
    scopeId: LEAKY_IDS.scopeId,
    recommendationId: LEAKY_IDS.recommendationId,
    now: NOW,
    lifeState: leakyLifeState(),
    commitments: [],
    priorityScores: [],
    plan: null,
  };
  const rich: CommitmentSnapshot[] = [
    snapshot(LEAKY_IDS.alpha, { dueAt: '2026-08-18T09:00:00.000Z', importance: 'high' }),
    snapshot(LEAKY_IDS.bravo, {
      dueAt: '2026-08-19T13:00:00.000Z',
      importance: 'high',
      planItemId: LEAKY_IDS.planItem,
    }),
    snapshot(LEAKY_IDS.charlie, {
      dueAt: '2026-08-19T20:00:00.000Z',
      importance: 'high',
      decompositionProposalId: LEAKY_IDS.proposal,
      decompositionStepId: LEAKY_IDS.step,
    }),
    snapshot(LEAKY_IDS.delta, {
      confirmedAt: null,
      dueAt: 'not-a-date',
      blockedByCommitmentIds: [LEAKY_IDS.alpha],
    }),
  ];
  return [
    // offered, with exclusions of every kind the pipeline can produce
    {
      ...base,
      commitments: rich,
      plan,
      priorityScores: [
        {
          version: 'priority-v1',
          commitmentId: LEAKY_IDS.alpha,
          total: 700,
          components: [],
          reasonCodes: ['REPEATEDLY_DELAYED'],
          policyVersion: LEAKY_IDS.policyVersion,
        },
      ],
    },
    // offered without a plan, so the schedule branch is not the only one covered
    { ...base, commitments: rich },
    // withheld: nothing to consider
    base,
    // withheld: everything hard-excluded
    { ...base, commitments: [snapshot(LEAKY_IDS.alpha, { confirmedAt: null })] },
    // withheld: eligible but unsupported
    { ...base, commitments: [snapshot(LEAKY_IDS.alpha)] },
    // withheld: input stale
    { ...base, now: '2026-08-30T12:00:00.000Z', commitments: rich },
    // `MODULE_DISABLED` arrives through the second config in the test below.
  ];
}

test('no caller-chosen identifier reaches any human-readable string in the output', () => {
  const requests = leakyRequests();
  const configs: RecommendationSelectorConfig[] = [
    DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
    { ...DEFAULT_RECOMMENDATION_SELECTOR_CONFIG, enabled: false },
  ];
  const ids = Object.values(LEAKY_IDS);
  let scanned = 0;
  const outcomes = new Set<string>();

  for (const input of requests) {
    for (const config of configs) {
      const selection = selectRecommendation(input, config);
      assert.deepEqual(selection.defects, [], 'the module produced a structurally invalid recommendation');
      outcomes.add(
        selection.recommendation.outcome === 'withheld'
          ? `withheld:${selection.recommendation.reasons[0].code}`
          : `offered:${selection.recommendation.options.kind}`,
      );
      const strings = humanReadableStrings(selection.recommendation, null, []);
      assert.ok(strings.length > 0, 'nothing was scanned');
      scanned += strings.length;
      for (const text of strings) {
        for (const id of ids) {
          assert.equal(
            text.indexOf(id),
            -1,
            `a caller-chosen identifier reached a human-readable string: ${JSON.stringify(text)}`,
          );
        }
      }
    }
  }

  assert.ok(scanned > 50, `the scan covered only ${scanned} strings; it is not exercising the pipeline`);
  assert.ok(
    outcomes.size >= 4,
    `expected several outcome shapes, saw ${Array.from(outcomes).sort().join(', ')}`,
  );
});

test('the leak scan would catch a leak, so its silence means something', () => {
  // The negative assertion above is worthless if `humanReadableStrings` returned
  // nothing useful, or if the pruning of id-bearing keys had grown wide enough
  // to prune the message fields too. Both are pinned here.
  const planted = {
    outcome: 'offered',
    options: {
      kind: 'sole_survivor',
      option: {
        optionIndex: 0,
        action: { kind: 'do_now', commitmentId: LEAKY_IDS.alpha },
        support: [{ code: 'OVERDUE', supportedBy: ['n-1'], detail: `about ${LEAKY_IDS.alpha}` }],
      },
    },
  };
  const strings = humanReadableStrings(planted, null, []);
  assert.ok(
    strings.some((text) => text.indexOf(LEAKY_IDS.alpha) !== -1),
    'the scanner no longer sees a planted leak in a detail string',
  );
  // And it does not see the id where the contract puts it on purpose.
  assert.equal(
    strings.some((text) => text === LEAKY_IDS.alpha),
    false,
    'the scanner is reading typed id fields, which the contract exempts',
  );
});

test('every detail string names a candidate by index rather than by id', () => {
  const selection = selectRecommendation(leakyRequests()[0]);
  if (selection.recommendation.outcome !== 'offered') {
    assert.fail('expected an offer');
    return;
  }
  const details = humanReadableStrings(selection.recommendation, null, []).filter((text) =>
    /candidate #\d/.test(text),
  );
  assert.ok(details.length > 0, 'no detail names a candidate by index');
});

/* ── Output size is stated rather than discovered downstream ─────── */

test('the evidence graph stays linear in the candidate count', () => {
  // `resolveBlockers` used `open.indexOf` inside its loop, which made it
  // quadratic per candidate and cubic over a dense request. The size of the
  // output is also a real property for #35's review surface to budget for, so
  // it is pinned here rather than found there.
  const build = (count: number): { nodes: number; bytes: number } => {
    const commitments: CommitmentSnapshot[] = [];
    for (let index = 0; index < count; index += 1) {
      commitments.push(
        snapshot(`c-${String(index).padStart(4, '0')}`, {
          dueAt: '2026-08-18T09:00:00.000Z',
          importance: 'high',
        }),
      );
    }
    const selection = selectRecommendation({
      scopeId: 'scope-1',
      recommendationId: 'rec-1',
      now: NOW,
      lifeState: leakyLifeState(),
      commitments,
      priorityScores: [],
      plan: null,
    });
    return {
      nodes: selection.recommendation.evidence.nodes.length,
      bytes: JSON.stringify(selection.recommendation).length,
    };
  };
  const small = build(50);
  const large = build(200);
  // Linear, not quadratic: quadrupling the input must not multiply the graph by
  // sixteen. The slack allows for the fixed scope-level nodes.
  assert.ok(
    large.nodes < small.nodes * 5,
    `graph grew super-linearly: ${small.nodes} nodes at 50, ${large.nodes} at 200`,
  );
  assert.ok(
    large.bytes < small.bytes * 5,
    `payload grew super-linearly: ${small.bytes} bytes at 50, ${large.bytes} at 200`,
  );
  // And the documented order of magnitude in lib/recommendation/index.ts is real.
  assert.ok(large.bytes > 100_000, 'the size note in index.ts overstates the payload');
  assert.ok(large.bytes < 900_000, 'the payload exceeds the size stated in index.ts');
});

test('a dense blocker graph completes without quadratic blow-up', () => {
  // Every candidate blocked by every earlier one: the shape that turned
  // `open.indexOf` cubic.
  const commitments: CommitmentSnapshot[] = [];
  for (let index = 0; index < 120; index += 1) {
    const blockedBy: string[] = [];
    for (let edge = 0; edge < index; edge += 1) blockedBy.push(`c-${String(edge).padStart(4, '0')}`);
    commitments.push(
      snapshot(`c-${String(index).padStart(4, '0')}`, {
        dueAt: '2026-08-18T09:00:00.000Z',
        importance: 'high',
        blockedByCommitmentIds: blockedBy,
      }),
    );
  }
  const selection = selectRecommendation({
    scopeId: 'scope-1',
    recommendationId: 'rec-1',
    now: NOW,
    lifeState: leakyLifeState(),
    commitments,
    priorityScores: [],
    plan: null,
  });
  assert.deepEqual(selection.defects, []);
  assert.equal(selection.consideredCount, 120);
});
