/**
 * Sprint-wide structural guards on `lib/planning/**`.
 *
 * Each track carries its own boundary test, and each can only speak for its own
 * directory. The rules here are the ones *between* tracks, and they are owned by
 * the merge for the reason Sprint 05 gave the policy-freeze test to the merge: a
 * check owned by the thing it checks is not a check. #31 asserting that #31 does
 * not import #29's validator is exactly the assertion #31 would quietly relax
 * the day it wanted to.
 *
 * Three claims here are what make the cross-track comparison meaningful rather
 * than circular:
 *
 *  1. #31's oracle does not reach #29's validator. The two decide the same
 *     question — which static codes apply to a set of constraints — and
 *     `planningCrossTrack` asserts they agree. If either could reach the other,
 *     that test would be comparing a thing with itself and would pass no matter
 *     how wrong both were.
 *  2. #31's oracle does not reach #30's scheduler, for the same reason applied
 *     to the feasibility question.
 *  3. #30's scheduler does not reach #29's validator. The scheduler is allowed
 *     to reach the *normalizer* — materialising a wall-clock window against real
 *     dates is arithmetic, and Sprint 06's lesson is that a second copy of
 *     arithmetic is a gap, not a check. The validator is a judgement, and that
 *     is the distinction this file exists to hold.
 *
 * A fourth guard pins the whole module clock-free, because determinism is
 * issue #30's acceptance criterion and a single `Date.now()` anywhere under
 * `lib/planning/` would break it in a way no behavioural test in any track
 * would reliably catch.
 *
 * Matching is on the *resolved repo path*, never on the specifier text. Sprint
 * 06 recorded why: a pattern anchored on `decomposition/(proposal|evaluation)`
 * never saw an import spelled `../proposal/...`, and so went on reporting a
 * clean separation across the very edge it existed to forbid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const planningDir = join(repoRoot, 'lib', 'planning');

const constraintsDir = join(planningDir, 'constraints');
const schedulerDir = join(planningDir, 'scheduler');
const evaluationDir = join(planningDir, 'evaluation');
const sharedDir = join(planningDir, 'shared');

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
] as const;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect-only imports bind no name but still run the module, which is
    // enough to drag a judgement in.
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
 * Written after this file's own clock scan failed on `scheduler.ts`, whose
 * header explains — in prose, correctly — why a planner must never call
 * `Date.now()`. A raw-text scan cannot tell an explanation from a violation,
 * and the cheapest way to make it pass would have been to delete the
 * explanation. That is the wrong direction, and #29's boundary test had already
 * reached the same conclusion for the same reason.
 *
 * The guard is not weakened: a call in code is still a call, and the test below
 * proves the stripper leaves real code alone.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Repo-relative paths reachable from `roots`, excluding the roots themselves. */
function reachablePaths(roots: readonly string[]): string[] {
  return Array.from(importClosure(roots).keys())
    .filter((file) => !roots.includes(file))
    .map(relative)
    .sort();
}

/* ── The guards are never vacuous ────────────────────────────────── */

test('all three track directories exist and are scanned', () => {
  // Without this, every closure below would walk an empty root set and pass by
  // finding nothing — the failure mode where a renamed directory turns a suite
  // of structural guards into a suite of tautologies.
  for (const [label, directory, expected] of [
    ['#29 constraints', constraintsDir, ['normalize.ts', 'validator.ts']],
    ['#30 scheduler', schedulerDir, ['scheduler.ts']],
    ['#31 evaluation', evaluationDir, ['oracle.ts', 'scenarios.ts', 'metrics.ts']],
    ['base shared', sharedDir, ['time.ts']],
  ] as const) {
    const files = sourceFiles(directory).map(relative);
    assert.ok(files.length > 0, `${label}: no source files found under ${relative(directory)}`);
    for (const name of expected) {
      assert.ok(files.some((file) => file.endsWith(`/${name}`)), `${label}: expected ${name}`);
    }
  }
});

test('the closure walks past the first hop, so it is not a direct-import check in disguise', () => {
  const roots = sourceFiles(schedulerDir);
  const closure = importClosure(roots);
  const directlyImported = new Set(
    roots.flatMap((file) => importSpecifiers(readFileSync(file, 'utf8'))
      .map((specifier) => resolveLocal(file, specifier))
      .filter((resolved): resolved is string => resolved !== null)),
  );
  assert.ok(
    Array.from(closure.keys()).some((file) => !roots.includes(file) && !directlyImported.has(file)),
    'expected the closure to reach at least one module more than one hop away',
  );
});

/* ── The cross-track judgement bans ──────────────────────────────── */

test('#31 oracle reaches neither #29 validator nor #30 scheduler', () => {
  // The oracle is the independent second reading of feasibility. An import in
  // either direction would make planningCrossTrack compare a thing with itself.
  const reached = reachablePaths([join(evaluationDir, 'oracle.ts')]);
  for (const file of reached) {
    assert.equal(
      /^lib\/planning\/constraints\/validator\.ts$/.test(file),
      false,
      `the oracle reaches ${file}; it must decide feasibility independently of #29`,
    );
    assert.equal(
      /^lib\/planning\/scheduler\//.test(file),
      false,
      `the oracle reaches ${file}; it must not consult the scheduler it is used to check`,
    );
  }
});

test('#30 scheduler reaches #29 normalizer but never #29 validator', () => {
  // The permitted edge and the forbidden one, asserted together — separating
  // them invites a future change that removes the arithmetic import and adds
  // the judgement import while each test still passes on its own terms.
  const reached = reachablePaths(sourceFiles(schedulerDir));
  for (const file of reached) {
    assert.equal(
      /^lib\/planning\/constraints\/validator\.ts$/.test(file),
      false,
      `the scheduler reaches ${file}; the static judgement belongs to #29 and #31, not to placement`,
    );
    assert.equal(
      /^lib\/planning\/evaluation\//.test(file),
      false,
      `the scheduler reaches ${file}; evaluation depends on the scheduler, never the reverse`,
    );
  }
});

test('#29 constraints reaches neither sibling track', () => {
  // #29 is the upstream of both. An edge outward would be a cycle at merge.
  const reached = reachablePaths(sourceFiles(constraintsDir));
  for (const file of reached) {
    assert.equal(
      /^lib\/planning\/(scheduler|evaluation)\//.test(file),
      false,
      `${file} is reachable from #29; constraints are upstream of both siblings`,
    );
  }
});

test('the shared time primitives stay a leaf: they reach no track at all', () => {
  // Every track imports shared/time. If shared/time imported a track back, the
  // cycle would put one track's code in every other track's closure and quietly
  // defeat every ban above.
  const reached = reachablePaths(sourceFiles(sharedDir));
  for (const file of reached) {
    assert.equal(
      /^lib\/planning\/(constraints|scheduler|evaluation)\//.test(file),
      false,
      `${file} is reachable from lib/planning/shared; the shared primitives must stay a leaf`,
    );
  }
});

/* ── Whole-module guards ─────────────────────────────────────────── */

test('nothing under lib/planning reaches a writer, a route handler, or a UI surface', () => {
  const roots = [constraintsDir, schedulerDir, evaluationDir, sharedDir].flatMap(sourceFiles);
  const closure = importClosure(roots);
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const basename = specifier.split('/').pop() as string;
      assert.equal(
        (FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename),
        false,
        `${relative(file)} reaches writer module "${specifier}"; planning proposes and must never persist`,
      );
      assert.equal(
        /(^|\/)(app\/api|app\/\(|mobile|components)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; planning is a leaf the API depends on, not the reverse`,
      );
    }
  }
});

test('no module under lib/planning reads an ambient clock or a random source', () => {
  // Issue #30's "same inputs and config produce the same plan" is only testable
  // if there is no other input. `new Date(x)` is fine — parsing a supplied
  // instant is not reading a clock — so the pattern below deliberately matches
  // only the zero-argument form.
  const roots = [constraintsDir, schedulerDir, evaluationDir, sharedDir].flatMap(sourceFiles);
  assert.ok(roots.length > 0, 'no planning sources were scanned');

  for (const file of roots) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/Date\.now\s*\(/, 'must not call Date.now(); a plan does not depend on when it was computed'],
      [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock; every instant comes from the input'],
      [/Math\.random\s*\(/, 'must not use Math.random(); a generator must be seeded to be replayable'],
      [/randomUUID/, 'must not mint ids; two runs of the same input must agree on every id'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('the clock scan still recognises a real clock, so stripping comments did not disarm it', () => {
  // A negative-only assertion passes against a regex that matches nothing, and
  // it passes just as well against a stripper that ate the whole file. Both
  // halves are pinned: the patterns still match real calls, and the stripper
  // still leaves real calls standing while removing prose about them.
  const patterns = [
    /Date\.now\s*\(/,
    /new\s+Date\s*\(\s*\)/,
    /Math\.random\s*\(/,
    /randomUUID/,
  ];
  const samples = [
    'const at = Date.now();',
    'const at = new Date();',
    'const r = Math.random();',
    'const id = randomUUID();',
  ];
  for (let index = 0; index < samples.length; index += 1) {
    assert.equal(patterns[index].test(samples[index]), true, `pattern ${index} no longer matches its own sample`);
    assert.equal(
      patterns[index].test(stripComments(samples[index])),
      true,
      `stripComments removed real code for pattern ${index}`,
    );
  }
  // And the case that motivated the stripper: prose naming the forbidden call.
  assert.equal(
    /Date\.now\s*\(/.test(stripComments('/** never call Date.now() here */\nconst x = 1;')),
    false,
    'a comment explaining the rule must not read as a violation of it',
  );
});
