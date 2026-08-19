/**
 * Structural guards on `lib/safety/**`.
 *
 * Modelled on `tests/recommendation/recommendationBoundaries.test.ts`, and the
 * central rule is Sprint 09's own: **the gateway may not import the thing it
 * guards.** Sprint 05 gave the policy-freeze test to the merge because a check
 * owned by the thing it checks is not a check, and the same argument applies one
 * level up — a safety module that imports `lib/coaching/**` inherits coaching's
 * idea of what a claim is and then agrees with it by construction. The seam is
 * defined over `SafetyCandidate`, a shape any producer can conform to, precisely
 * so that this ban costs nothing.
 *
 * The same ban covers `lib/services/**`. The shipped product validators
 * (`responseEngine/validation.ts`, `pressureService.ts`, `personalityService.ts`)
 * enforce part of this policy at product scope, and a merge-owned cross-track
 * test compares the two on the same inputs. An import in either direction would
 * make that comparison compare a thing with itself, and it would pass no matter
 * how wrong both were. That is the recorded cost of the duplicated shame lexicon
 * in `lib/safety/lexicon.ts`, and it is the reason the duplication is the right
 * trade rather than laziness.
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
const moduleDir = join(repoRoot, 'lib', 'safety');

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
] as const;

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
 * carries no runtime coupling and cannot make a cross-track comparison
 * circular. The distinction is drawn here rather than inside the ban so that a
 * *value* import of the same module still fails — proved in both directions
 * below. Relaxing a guard because it fired is otherwise how guards die.
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
 * is to delete the explanation — so the rule and its guard end up in opposition.
 *
 * The stripper is proved in **both** directions below. The second direction is
 * the one that matters and is the reason this is a scan for calls and never a
 * scan for imports: a real violation hidden inside a commented-out line is
 * *removed* by the stripper, so a commented-out import would read as absent.
 * This file's import checks therefore run on unstripped source, where a
 * commented-out import reads as present — the conservative error in that
 * direction.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ── Never vacuous ───────────────────────────────────────────────── */

test('the safety module exists and every surface of it is scanned', () => {
  // A guard over an empty file list passes by finding nothing. Naming the files
  // means a rename that emptied the scan fails here instead of silently
  // disarming every assertion below it.
  const files = sourceFilesUnder(moduleDir).map(relative);
  assert.ok(files.length > 0, `no sources under ${relative(moduleDir)}`);
  for (const expected of [
    'lib/safety/gateway.ts',
    'lib/safety/preValidator.ts',
    'lib/safety/postValidator.ts',
    'lib/safety/lexicon.ts',
    'lib/safety/findings.ts',
  ]) {
    assert.ok(files.includes(expected), `expected ${expected} to be scanned; found ${files.join(', ')}`);
  }
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

/* ── The seam rule ───────────────────────────────────────────────── */

test('a type-only edge is erased, but a value edge still registers', () => {
  const typeOnly = "import type { SafetyCandidate } from '../../src/contracts/v1/safetyContracts';";
  const valueImport = "import { SAFETY_LIMITS } from '../../src/contracts/v1/safetyContracts';";
  assert.deepEqual(runtimeImportSpecifiers(typeOnly), [], 'a type-only import must not register as a runtime edge');
  assert.deepEqual(
    runtimeImportSpecifiers(valueImport),
    ['../../src/contracts/v1/safetyContracts'],
    'a value import must still register, or the bans below are unenforceable',
  );
});

test('the safety module never reaches the coaching module it guards', () => {
  // The load-bearing rule of this sprint. #38 conforms to `SafetyCandidate`; the
  // arrow runs from the guarded module to the guard and never back. This is
  // written against the *whole closure* and against specifier text as well as
  // resolved paths, because `lib/coaching/**` may not exist yet in this
  // worktree — a resolved-path check alone would pass vacuously today and stop
  // being written by the time it would not.
  const closure = importClosure(sourceFilesUnder(moduleDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    assert.equal(
      /(^|\/)coaching\//.test(relative(file)) || /coachingContracts/i.test(relative(file)),
      false,
      `${relative(file)} is reachable from lib/safety; the gateway must not import the module it guards`,
    );
    for (const specifier of specifiers) {
      assert.equal(
        /(^|\/|\.)coaching(\/|Contracts)/i.test(specifier),
        false,
        `${relative(file)} imports "${specifier}"; a gateway that imports the module it guards is not an independent check`,
      );
    }
  }
});

test('the safety module never reaches the shipped product validators either', () => {
  // `lib/services/responseEngine/validation.ts`, `pressureService.ts` and
  // `personalityService.ts` enforce part of this policy at product scope, and a
  // merge-owned cross-track test compares the two on the same inputs. An import
  // in either direction would make that comparison compare a thing with itself.
  const closure = importClosure(sourceFilesUnder(moduleDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    assert.equal(
      relative(file).startsWith('lib/services/'),
      false,
      `${relative(file)} is reachable from lib/safety; the gateway and the product validator must stay separable`,
    );
    for (const specifier of specifiers) {
      assert.equal(
        /(^|\/)(services)\//.test(specifier) || /(pressureService|personalityService|responseEngine)/.test(specifier),
        false,
        `${relative(file)} imports "${specifier}"; the two implementations must remain independent readers`,
      );
    }
  }
});

test('the product validators do not reach the safety module either', () => {
  // The reverse edge. Banned from this side too, because a cycle would be
  // reported by the test above as nothing at all — the closure would simply
  // include both and neither pattern would fire on the direction that exists.
  const productFiles = [
    join(repoRoot, 'lib', 'services', 'responseEngine', 'validation.ts'),
    join(repoRoot, 'lib', 'services', 'pressureService.ts'),
    join(repoRoot, 'lib', 'services', 'personalityService.ts'),
  ].filter(existsSync);
  assert.equal(productFiles.length, 3, 'the product validators were not found; this guard would be vacuous');

  for (const file of Array.from(importClosure(productFiles).keys())) {
    assert.equal(
      relative(file).startsWith('lib/safety/'),
      false,
      `${relative(file)} is reachable from the product validators; the dependency must not run either way`,
    );
  }
});

test('if the coaching module exists, it does not import lib/safety internals', () => {
  // Conditional, and it says so rather than pretending. #38 runs in parallel and
  // may not have landed in this worktree. What it *must* depend on is the
  // contract — `safetyContracts` — never `lib/safety/**`: conforming to a shape
  // is the seam, and reaching into the guard's implementation is not.
  const coachingDir = join(repoRoot, 'lib', 'coaching');
  const coachingFiles = sourceFilesUnder(coachingDir);
  if (coachingFiles.length === 0) return;
  for (const entry of Array.from(importClosure(coachingFiles).entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const resolved = resolveLocal(file, specifier);
      assert.equal(
        resolved !== null && relative(resolved).startsWith('lib/safety/'),
        false,
        `${relative(file)} imports "${specifier}"; conform to safetyContracts, not to the gateway's internals`,
      );
    }
  }
});

/* ── Whole-module guards ─────────────────────────────────────────── */

test('nothing under lib/safety reaches a writer, a route handler, or a UI surface', () => {
  const closure = importClosure(sourceFilesUnder(moduleDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const basename = specifier.split('/').pop() as string;
      assert.equal(
        (FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename),
        false,
        `${relative(file)} reaches writer module "${specifier}"; the gateway decides and must never persist`,
      );
      assert.equal(
        /(^|\/)(app\/api|app\/\(|mobile|components)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; the module is a leaf the API depends on, not the reverse`,
      );
    }
  }
});

test('no module under lib/safety reads an ambient clock or a random source', () => {
  const files = sourceFilesUnder(moduleDir);
  assert.ok(files.length > 0, 'no sources were scanned');
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/Date\.now\s*\(/, 'must not call Date.now(); a safety verdict does not depend on when it was computed'],
      [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock; every instant comes from the input'],
      [/Math\.random\s*\(/, 'must not use Math.random(); a red-team result must be replayable'],
      [/randomUUID/, 'must not mint ids; two runs of one request must agree'],
      [/performance\.now\s*\(/, 'must not read a monotonic clock either; it is still a clock'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('no module under lib/safety orders by locale', () => {
  // Sprint 08 opened by fixing four `localeCompare` tie-breaks in the pilot
  // selector, where the host's default locale decided which commitment a user
  // was shown. `compareByCodePoint` in lib/planning/shared/compare.ts is the
  // repo's comparator; this module needs none, and needing none is not a reason
  // to leave the rule unstated.
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.equal(
      /localeCompare|new\s+Intl\.Collator/.test(source),
      false,
      `${relative(file)} orders by locale; use compareByCodePoint from lib/planning/shared/compare.ts`,
    );
  }
});

test('the call scans still recognise a real call, so stripping comments did not disarm them', () => {
  // Direction one. A negative-only assertion passes against a regex that matches
  // nothing, and just as well against a stripper that ate the file.
  const cases: ReadonlyArray<readonly [RegExp, string]> = [
    [/Date\.now\s*\(/, 'const at = Date.now();'],
    [/new\s+Date\s*\(\s*\)/, 'const at = new Date();'],
    [/Math\.random\s*\(/, 'const r = Math.random();'],
    [/randomUUID/, 'const id = randomUUID();'],
    [/performance\.now\s*\(/, 'const t = performance.now();'],
    [/localeCompare/, 'a.localeCompare(b);'],
  ];
  for (const [pattern, sample] of cases) {
    assert.equal(pattern.test(sample), true, `pattern no longer matches its own sample: ${sample}`);
    assert.equal(pattern.test(stripComments(sample)), true, `stripComments removed real code: ${sample}`);
  }
});

test('a comment explaining a rule does not read as a violation of it', () => {
  // Direction two, block and line form. This file's own module headers say
  // "no `Date.now()`" in prose; without the stripper the cheapest way to green
  // the scan would be to delete the explanation.
  assert.equal(
    /Date\.now\s*\(/.test(stripComments('/** never call Date.now() here */\nconst x = 1;')),
    false,
  );
  assert.equal(/Math\.random\s*\(/.test(stripComments('// Math.random() is banned\nconst x = 1;')), false);
  assert.equal(
    /localeCompare/.test(stripComments('/*\n * localeCompare depends on ICU data.\n */\nconst x = 1;')),
    false,
  );
});

test('the stripper also removes a real violation hidden in a comment, which is why it is not used for imports', () => {
  // Direction three, and the silent one. `stripComments` cannot tell a disabled
  // line from an explanatory one, so a commented-out call *is* removed — which
  // is correct for a call scan (a commented-out call does not run) and would be
  // wrong for an import scan, where a commented-out import is a re-enabling away
  // from being real. Pinning it here is what stops a future edit from reusing
  // the stripper on the import checks above.
  const disabled = '// const at = Date.now();\nconst x = 1;';
  assert.equal(/Date\.now\s*\(/.test(disabled), true, 'the raw source does contain the text');
  assert.equal(/Date\.now\s*\(/.test(stripComments(disabled)), false, 'and the stripper removes it');

  const disabledImport = "// import { pressureService } from '../services/pressureService';";
  assert.deepEqual(
    runtimeImportSpecifiers(disabledImport),
    ['../services/pressureService'],
    'the import scans must run on unstripped source, so a commented-out import still fails',
  );
});

test('every declared export of the module is reachable through its index', () => {
  // A module whose entry point does not export its own surface invites callers
  // to deep-import, and a deep import is an edge no boundary test was written
  // against.
  const index = readFileSync(join(moduleDir, 'index.ts'), 'utf8');
  for (const expected of ['evaluateSafetyGate', 'validateSafetyRequest', 'validateSafetyCandidate']) {
    assert.ok(index.includes(expected), `lib/safety/index.ts does not re-export ${expected}`);
  }
});
