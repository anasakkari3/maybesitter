/**
 * Structural guards on `lib/coaching/**` (Sprint 09, issue #38).
 *
 * Sprint 09 has the shape Sprint 08 had, and sharper: **a working
 * implementation of this issue's deliverables already ships**.
 * `lib/services/responseEngine/` is 1571 lines of response planner, intent
 * selector, realizer and validator, plus `personalityService.ts` for tone — the
 * deliverable names almost verbatim, at product scope, behind the assistant
 * turn a user sees today.
 *
 * Sprint 06's recorded lesson is that two complete implementations of one
 * mechanism cost four review rounds, each finding a defect already fixed on the
 * other side. Sprint 08's resolution held and is the one adopted here: build
 * the roadmap module *beside* the product surface and forbid a runtime edge in
 * either direction — because a cross-track comparison between them is only
 * meaningful while neither can reach the other. An import either way would make
 * that comparison compare a thing with itself, and it would pass no matter how
 * wrong both were.
 *
 * Matching is on the **resolved repo path**, never on specifier text. Sprint 06
 * recorded why: a pattern anchored on a directory name never saw the relative
 * spelling of the very import it forbade, and went on reporting a clean
 * separation across that edge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const moduleDir = join(repoRoot, 'lib', 'coaching');

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
] as const;

/** The shipped response engine, which this module must stay separable from. */
const PRODUCT_SURFACE_FILES = [
  join(repoRoot, 'lib', 'services', 'responseEngine', 'responsePlanning.ts'),
  join(repoRoot, 'lib', 'services', 'responseEngine', 'intentSelection.ts'),
  join(repoRoot, 'lib', 'services', 'responseEngine', 'realization.ts'),
  join(repoRoot, 'lib', 'services', 'responseEngine', 'validation.ts'),
  join(repoRoot, 'lib', 'services', 'personalityService.ts'),
];

function sourceFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFilesUnder(path));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path);
  }
  return found.sort();
}

/**
 * Specifiers that survive to runtime.
 *
 * `import type { X } from '…'` is erased by the compiler, so a type-only edge
 * cannot make the separation circular — which is the property the bans below
 * exist to protect. This module has exactly one such edge that matters:
 * `coachingContracts` imports `safetyContracts` type-only, so #39's verdict
 * vocabulary is adopted without a runtime dependency in either direction.
 *
 * The distinction is drawn here rather than inside the bans so that a *value*
 * import of the same module still fails, and both directions are proved below.
 * Relaxing a guard because it fired is otherwise how guards die.
 */
function runtimeImportSpecifiers(source: string): string[] {
  const withoutTypeOnly = source.replace(/\bimport\s+type\s[^;]*?from\s*['"][^'"]+['"]/g, ' ');
  return importSpecifiers(withoutTypeOnly);
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect-only imports bind no name but still run the module.
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

function importClosure(roots: readonly string[]): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = roots.slice();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (closure.has(file)) continue;
    const specifiers = runtimeImportSpecifiers(readFileSync(file, 'utf8'));
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
 * Source with comments removed, for scans that look for forbidden *calls*.
 *
 * Sprint 07's merge-owned guard failed on a module whose header explained, in
 * prose and correctly, why a planner must never call `Date.now()`. A raw scan
 * cannot tell an explanation from a violation, and the cheapest way to green it
 * is to delete the explanation — which is how a rule loses the comment that
 * says why it exists. This module's headers are full of such prose, so the
 * stripper is load-bearing rather than defensive.
 *
 * Proved in both directions below. The silent direction — a real violation
 * hidden inside a commented-out line — is the one that matters, and it is why
 * this is a scan for calls only and never a scan for imports.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ── Never vacuous ───────────────────────────────────────────────── */

test('the coaching module exists and every deliverable surface is scanned', () => {
  // A guard over an empty file list passes by finding nothing. Naming the
  // directories means a rename that emptied the scan fails here instead of
  // silently disarming every assertion below it.
  const files = sourceFilesUnder(moduleDir).map(relative);
  assert.ok(files.length > 0, `no sources under ${relative(moduleDir)}`);
  for (const expected of ['lib/coaching/planner/', 'lib/coaching/realizer/', 'lib/coaching/validator/']) {
    assert.ok(files.some((file) => file.startsWith(expected)), `expected a surface under ${expected}; found ${files.join(', ')}`);
  }
  assert.ok(existsSync(join(repoRoot, 'src', 'contracts', 'v1', 'coachingContracts.ts')), 'the contract is missing');
});

test('the product response engine is where this test thinks it is', () => {
  // Without this, every separation assertion below would pass against a moved
  // or renamed engine by scanning nothing.
  const present = PRODUCT_SURFACE_FILES.filter(existsSync);
  assert.equal(present.length, PRODUCT_SURFACE_FILES.length, `the shipped response engine was not found: ${PRODUCT_SURFACE_FILES.map(relative).join(', ')}`);
});

test('the closure walks past the first hop, so it is not a direct-import check in disguise', () => {
  const roots = sourceFilesUnder(moduleDir);
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

/* ── The separability rule ───────────────────────────────────────── */

test('a type-only edge is erased, but a value edge still registers', () => {
  const typeOnly = "import type { SafetyVerdict } from '../../src/contracts/v1/safetyContracts';";
  const valueImport = "import { SAFETY_LIMITS } from '../../src/contracts/v1/safetyContracts';";
  assert.deepEqual(runtimeImportSpecifiers(typeOnly), [], 'a type-only import must not register as a runtime edge');
  assert.deepEqual(
    runtimeImportSpecifiers(valueImport),
    ['../../src/contracts/v1/safetyContracts'],
    'a value import must still register, or every ban below is unenforceable',
  );
});

test('the coaching module never reaches the shipped response engine at runtime', () => {
  // The load-bearing rule of this track. The engine is an independent
  // implementation of the same four judgements at product scope, and the
  // merge-owned cross-track test compares the two.
  const closure = importClosure(sourceFilesUnder(moduleDir));
  for (const file of Array.from(closure.keys())) {
    const name = relative(file);
    assert.equal(
      name.startsWith('lib/services/'),
      false,
      `${name} is reachable from lib/coaching; the module and the product response engine must stay separable`,
    );
  }
});

test('the response engine does not reach the coaching module either', () => {
  // The reverse edge. Banned from this side too, because a cycle would be
  // reported by the test above as nothing at all — the closure would simply
  // include both and neither pattern would fire on the direction that exists.
  for (const file of Array.from(importClosure(PRODUCT_SURFACE_FILES).keys())) {
    assert.equal(
      relative(file).startsWith('lib/coaching/'),
      false,
      `${relative(file)} is reachable from the response engine; the dependency must not run either way`,
    );
  }
});

test('the coaching module never reaches the safety module, and #39 never reaches this one', () => {
  // #39 owns the gateway and its verdict vocabulary; this module conforms to it
  // through a type-only contract edge. A runtime edge either way would make the
  // gateway a dependency of the thing it gates, or the reverse.
  for (const file of Array.from(importClosure(sourceFilesUnder(moduleDir)).keys())) {
    assert.equal(relative(file).startsWith('lib/safety/'), false, `${relative(file)} is reachable from lib/coaching`);
  }
  const safetyFiles = sourceFilesUnder(join(repoRoot, 'lib', 'safety'));
  // #39's module has landed, so this half is no longer vacuous — and saying so
  // with a count is the difference between "nothing reaches coaching" and
  // "nothing was scanned". The suite exercises the two together in
  // `claimValidator.test.ts`, which is a test-level edge and not a module one.
  assert.ok(safetyFiles.length > 0, 'lib/safety was not found; this guard would pass by scanning nothing');
  for (const file of Array.from(importClosure(safetyFiles).keys())) {
    assert.equal(relative(file).startsWith('lib/coaching/'), false, `${relative(file)} is reachable from lib/safety`);
  }
});

test('no other sprint module reaches the coaching module', () => {
  // Coaching is a leaf: it consumes Sprint 08's output and nothing consumes it.
  // An edge from an earlier module would make a revert of this track a revert
  // of that one too.
  for (const sibling of ['recommendation', 'planning', 'priority', 'decomposition', 'lifeState', 'runtimeMemory']) {
    const dir = join(repoRoot, 'lib', sibling);
    for (const file of Array.from(importClosure(sourceFilesUnder(dir)).keys())) {
      assert.equal(
        relative(file).startsWith('lib/coaching/'),
        false,
        `${relative(file)} is reachable from lib/${sibling}; coaching must stay a leaf`,
      );
    }
  }
});

/* ── Whole-module guards ─────────────────────────────────────────── */

test('nothing under lib/coaching reaches a writer, a route handler, or a UI surface', () => {
  const closure = importClosure(sourceFilesUnder(moduleDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const basename = specifier.split('/').pop() as string;
      assert.equal(
        (FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename),
        false,
        `${relative(file)} reaches writer module "${specifier}"; coaching says words and must never persist`,
      );
      assert.equal(
        /(^|\/)(app\/api|app\/\(|mobile|components)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; the module is a leaf the API depends on, not the reverse`,
      );
    }
  }
});

test('no module under lib/coaching reads an ambient clock or a random source', () => {
  const files = sourceFilesUnder(moduleDir);
  assert.ok(files.length > 0, 'no sources were scanned');
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/Date\.now\s*\(/, 'must not call Date.now(); a coaching turn does not depend on when it was phrased'],
      [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock; every instant comes from the input'],
      [/Math\.random\s*\(/, 'must not use Math.random(); the shipped realizer does, and this one must be replayable'],
      [/randomUUID/, 'must not mint ids; two runs of one request must agree'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('no module under lib/coaching orders by locale', () => {
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.equal(
      /localeCompare|new\s+Intl\.Collator/.test(source),
      false,
      `${relative(file)} orders by locale; use compareByCodePoint from lib/planning/shared/compare.ts`,
    );
  }
});

test('no module under lib/coaching throws', () => {
  // `COACHING_INPUT_POLICY.reportWhatTheTaxonomyNames`. Sprint 07 shipped three
  // throws where the contract said report and Sprint 08 shipped five more; each
  // was invisible to a typed caller and immediate at the untyped boundary the
  // module existed to guard.
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/\bthrow\b/.test(source), false, `${relative(file)} throws; every named condition must come back as a defect`);
  }
});

test('no module under lib/coaching writes a second definition of an instant', () => {
  // `isInstant` is exported by `recommendationContracts` and re-exported by
  // #39's contract precisely so that three modules do not spell the
  // explicit-offset rule three ways. A local ISO pattern is how the third
  // spelling arrives.
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/\\d\{4\}\)?-/.test(source), false, `${relative(file)} appears to define its own instant pattern`);
    assert.equal(/Date\.parse\s*\(/.test(source), false, `${relative(file)} parses instants itself; call isInstant`);
  }
});

test('the call scans still recognise a real call, so stripping comments did not disarm them', () => {
  // A negative-only assertion passes against a regex that matches nothing, and
  // just as well against a stripper that ate the file. Both halves are pinned.
  const cases: ReadonlyArray<readonly [RegExp, string]> = [
    [/Date\.now\s*\(/, 'const at = Date.now();'],
    [/new\s+Date\s*\(\s*\)/, 'const at = new Date();'],
    [/Math\.random\s*\(/, 'const r = Math.random();'],
    [/randomUUID/, 'const id = randomUUID();'],
    [/localeCompare/, 'a.localeCompare(b);'],
    [/\bthrow\b/, 'throw new Error("nope");'],
    [/Date\.parse\s*\(/, 'const ms = Date.parse(value);'],
  ];
  for (const [pattern, sample] of cases) {
    assert.equal(pattern.test(sample), true, `pattern no longer matches its own sample: ${sample}`);
    assert.equal(pattern.test(stripComments(sample)), true, `stripComments removed real code: ${sample}`);
  }
  assert.equal(
    /Date\.now\s*\(/.test(stripComments('/** never call Date.now() here */\nconst x = 1;')),
    false,
    'a comment explaining the rule must not read as a violation of it',
  );
  assert.equal(
    /Math\.random\s*\(/.test(stripComments('// the engine uses Math.random() and this module must not\nconst x = 1;')),
    false,
    'a line comment explaining the rule must not read as a violation of it',
  );
  assert.equal(
    /Math\.random\s*\(/.test(stripComments('const x = 1;\n// const r = Math.random();\nconst r = Math.random();')),
    true,
    'a real call beside a commented-out one must still be seen',
  );
});

test('the import scan runs on raw source, so a commented-out import cannot hide one', () => {
  // The mirror image, and the reason the closure never strips comments: #33 hit
  // prose inside a doc comment reading as an import, and the fix that looks
  // obvious — strip comments first — makes a real import inside a
  // commented-out block invisible.
  const source = "// import { x } from './hidden';\nimport { y } from './real';";
  assert.deepEqual(importSpecifiers(source), ['./hidden', './real'], 'the import scan must over-report, never under-report');
});
