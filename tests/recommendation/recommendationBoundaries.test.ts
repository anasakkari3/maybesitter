/**
 * Sprint-wide structural guards on `lib/recommendation/**`.
 *
 * Each track carries its own boundary test and each can only speak for its own
 * directory. The rules here are the ones *between* tracks, and they are owned by
 * the merge for the reason Sprint 05 gave the policy-freeze test to the merge: a
 * check owned by the thing it checks is not a check.
 *
 * Sprint 08 has a shape the previous sprints did not: a **pilot implementation
 * of the same mechanism already ships**. `lib/services/nextStepBaseline.ts`,
 * `nextStepReviewService.ts`, `nextStepArms.ts` and `src/components/NextStepReview.tsx`
 * already select and present a next step. Sprint 06's recorded lesson is that
 * two complete implementations of one mechanism cost four review rounds, each
 * finding a defect already fixed on the other side. So the central rule below is
 * not about layering — it is that the module and the pilot must stay *separable*,
 * because a cross-track comparison between them is only meaningful while neither
 * can reach the other.
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
const moduleDir = join(repoRoot, 'lib', 'recommendation');

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
 * `import type { X } from '…'` is erased by the compiler: the emitted JS
 * contains no import statement at all. Verified on this diff — the only
 * `nextStep` string left in the emitted `reviewContract.js` is inside a
 * comment. A type-only edge therefore cannot make the cross-track comparison
 * circular, which is the property the pilot ban exists to protect.
 *
 * The distinction is drawn here rather than in the ban itself so that a *value*
 * import of the same module still fails — see the test that proves both
 * directions. Relaxing a guard because it fired is otherwise how guards die.
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
 * is to delete the explanation. #33 hit the mirror image of this on its own
 * import scanner, where prose inside a doc comment read as an import.
 *
 * The stripper is proved in both directions below. The silent direction — a
 * real violation hidden inside a commented-out line — is the one that matters,
 * and it is why this is a scan for calls only and never a scan for imports.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ── Never vacuous ───────────────────────────────────────────────── */

test('the recommendation module exists and every track surface is scanned', () => {
  // A guard over an empty file list passes by finding nothing. Naming the
  // directories means a rename that emptied the scan fails here instead of
  // silently disarming every assertion below it.
  const files = sourceFilesUnder(moduleDir).map(relative);
  assert.ok(files.length > 0, `no sources under ${relative(moduleDir)}`);
  for (const expected of ['lib/recommendation/selector/', 'lib/recommendation/review/']) {
    assert.ok(
      files.some((file) => file.startsWith(expected)),
      `expected a track surface under ${expected}; found ${files.join(', ')}`,
    );
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

/* ── The separability rule ───────────────────────────────────────── */

test('a type-only edge is erased, but a value edge to the pilot still fails', () => {
  // Both directions, because this guard was narrowed at integration after it
  // fired on `import type { NextStepLocale }` — an edge that carries no runtime
  // coupling and exists to pin that the two locale sets cannot drift, which is
  // a cross-track property worth having rather than one worth banning.
  const typeOnly = "import type { NextStepLocale } from '../../src/contracts/v1/nextStepContracts';";
  const valueImport = "import { NEXT_STEP_PRODUCT_POLICY } from '../../src/contracts/v1/nextStepContracts';";
  assert.deepEqual(runtimeImportSpecifiers(typeOnly), [], 'a type-only import must not register as a runtime edge');
  assert.deepEqual(
    runtimeImportSpecifiers(valueImport),
    ['../../src/contracts/v1/nextStepContracts'],
    'a value import must still register, or the ban below is unenforceable',
  );
});

test('the recommendation module never reaches the pilot next-step implementation at runtime', () => {
  // The load-bearing rule of this sprint. The pilot is an independent
  // implementation of the same judgement, and the cross-track test compares the
  // two. An import in either direction would make that comparison compare a
  // thing with itself, and it would pass no matter how wrong both were.
  const closure = importClosure(sourceFilesUnder(moduleDir));
  for (const file of Array.from(closure.keys())) {
    const name = relative(file);
    assert.equal(
      /nextStep/i.test(name),
      false,
      `${name} is reachable from lib/recommendation; the module and the pilot must stay separable`,
    );
  }
});

test('the pilot does not reach the recommendation module either', () => {
  // The reverse edge. Banned from this side too, because a cycle would be
  // reported by the test above as nothing at all — the closure would simply
  // include both and neither pattern would fire on the direction that exists.
  const pilotFiles = [
    join(repoRoot, 'lib', 'services', 'nextStepBaseline.ts'),
    join(repoRoot, 'lib', 'services', 'nextStepReviewService.ts'),
    join(repoRoot, 'lib', 'services', 'nextStepLiveService.ts'),
    join(repoRoot, 'lib', 'experiments', 'nextStepArms.ts'),
  ].filter(existsSync);
  assert.ok(pilotFiles.length >= 3, 'the pilot files were not found; this guard would be vacuous');

  for (const file of Array.from(importClosure(pilotFiles).keys())) {
    assert.equal(
      relative(file).startsWith('lib/recommendation/'),
      false,
      `${relative(file)} is reachable from the pilot; the dependency must not run either way`,
    );
  }
});

/* ── Whole-module guards ─────────────────────────────────────────── */

test('nothing under lib/recommendation reaches a writer, a route handler, or a UI surface', () => {
  const closure = importClosure(sourceFilesUnder(moduleDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const basename = specifier.split('/').pop() as string;
      assert.equal(
        (FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename),
        false,
        `${relative(file)} reaches writer module "${specifier}"; recommendation proposes and must never persist`,
      );
      assert.equal(
        /(^|\/)(app\/api|app\/\(|mobile|components)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; the module is a leaf the API depends on, not the reverse`,
      );
    }
  }
});

test('no module under lib/recommendation reads an ambient clock or a random source', () => {
  const files = sourceFilesUnder(moduleDir);
  assert.ok(files.length > 0, 'no sources were scanned');
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/Date\.now\s*\(/, 'must not call Date.now(); a recommendation does not depend on when it was computed'],
      [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock; every instant comes from the input'],
      [/Math\.random\s*\(/, 'must not use Math.random(); selection must be replayable'],
      [/randomUUID/, 'must not mint ids; two runs of one request must agree'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('no module under lib/recommendation orders by locale', () => {
  // Sprint 08 opened by fixing four `localeCompare` tie-breaks in the pilot
  // selector, where the host's default locale decided which commitment a user
  // was shown. The rule is stated in five modules now; this keeps the sixth
  // from being written.
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
  // A negative-only assertion passes against a regex that matches nothing, and
  // just as well against a stripper that ate the file. Both halves are pinned.
  const cases: ReadonlyArray<readonly [RegExp, string]> = [
    [/Date\.now\s*\(/, 'const at = Date.now();'],
    [/new\s+Date\s*\(\s*\)/, 'const at = new Date();'],
    [/Math\.random\s*\(/, 'const r = Math.random();'],
    [/randomUUID/, 'const id = randomUUID();'],
    [/localeCompare/, 'a.localeCompare(b);'],
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
});
