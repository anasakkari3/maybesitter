/**
 * Structural guards on `lib/planning/constraints/`, checked by reading the
 * source rather than by running it.
 *
 * The walker is `tests/decomposition/boundaryImportClosure.test.ts`'s, and it is
 * copied rather than referenced for the reason that file gives about its own
 * ancestor: a closure walk caught a writer reached through a single intermediate
 * module that a direct-import check had been happily missing. A first-hop check
 * would pass here today and keep passing after someone adds one indirection, so
 * there is a test below whose only job is to prove the walk goes further than
 * one hop — a guard that has gone vacuous reports success just as loudly as one
 * that holds.
 *
 * Four claims, each structural rather than behavioural:
 *
 *  1. **This module reaches no writer and no persistence.** A planner offers a
 *     proposal about time; `PLANNING_PERSISTENCE_POLICY.planCanPersist` is
 *     false. "It does not write today" is not a property anyone can maintain by
 *     reading diffs.
 *  2. **It reaches no route handler, no UI and not the mobile app.** These
 *     modules are leaves the API may depend on, never the reverse.
 *  3. **It reaches neither sibling Sprint 07 track.** #30's scheduler and #31's
 *     evaluation are the two independent readings this track's validator is
 *     compared against by the merge-owned cross-track test. An import in either
 *     direction would make that comparison compare a thing with itself — the
 *     failure Sprint 02 and Sprint 06 each shipped once, where several green
 *     suites agreed because they were all reading the same code.
 *  4. **No ambient clock and no randomness.** The sprint design states this for
 *     all of `lib/planning/`: a planner that could read a clock produces a
 *     different plan on every run, and no determinism test could catch it,
 *     because every run would be internally consistent.
 *
 * The clock check is a source scan, so it deliberately covers the *closure*
 * rather than this directory alone — a helper one hop away calling `Date.now()`
 * would break determinism exactly as thoroughly as one calling it here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const constraintsDir = join(repoRoot, 'lib', 'planning', 'constraints');

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
  'persistenceAdapter',
] as const;

function sourceFiles(directory: string): string[] {
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
    // enough to drag a writer in.
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

function isForbidden(specifier: string): boolean {
  const segments = specifier.split('/');
  const basename = segments[segments.length - 1];
  return (FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename);
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

/**
 * Source with comments removed.
 *
 * A deliberate change from the Sprint 06 ancestor, which scanned raw text. That
 * version fails on a module whose header *explains* why it never calls
 * `Date.now()` — and the cheapest way to make such a failure go away is to
 * delete the explanation, which is the worst available outcome for a rule whose
 * whole value is that the next author understands it. `lib/planning/shared/time.ts`
 * is exactly that module and it is in this closure.
 *
 * This does not weaken the guard: a call in code is still a call, and the test
 * below proves the stripper leaves real code alone.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const roots = () => sourceFiles(constraintsDir);

/* ── The guards are not vacuous ──────────────────────────────────── */

test('the directory exists and carries the surface this track owns', () => {
  // A guard over an empty file list passes. Naming the files means a rename
  // that emptied the scan would fail here rather than silently disarm every
  // assertion below it.
  const files = roots().map(relative);
  for (const expected of ['normalize.ts', 'validator.ts', 'index.ts']) {
    assert.ok(
      files.some((file) => file.endsWith(expected)),
      `expected ${expected} in the constraints surface, found ${files.join(', ')}`,
    );
  }
});

test('the closure walks past the first hop, so it is not a direct-import check in disguise', () => {
  const closure = importClosure(roots());
  const directlyImported = new Set(
    roots().flatMap((file) => importSpecifiers(readFileSync(file, 'utf8'))
      .map((specifier) => resolveLocal(file, specifier))
      .filter((resolved): resolved is string => resolved !== null)),
  );
  assert.ok(
    Array.from(closure.keys()).some((file) => !roots().includes(file) && !directlyImported.has(file)),
    'expected the closure to reach at least one module more than one hop away',
  );
});

/* ── Where this module may not reach ─────────────────────────────── */

test('the constraint model reaches no writer module, directly or transitively', () => {
  const closure = importClosure(roots());
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        isForbidden(specifier),
        false,
        `${relative(file)} reaches writer module "${specifier}"; a plan is a proposal about time `
        + 'and is never canonical user state',
      );
    }
  }
});

test('it reaches no route handler, no UI surface and not the mobile app', () => {
  const closure = importClosure(roots());
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        /(^|\/)(app\/api|app\/\(|pages\/api|mobile|components)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; these modules are leaves the API depends on, `
        + 'not the reverse',
      );
    }
  }
});

test('it reaches neither sibling Sprint 07 track, so the cross-track comparison stays a comparison', () => {
  // Matched on the *resolved* repo path rather than on the specifier text. A
  // pattern anchored on `planning/(scheduler|evaluation)` would never see an
  // import spelled `../scheduler/...` from inside `lib/planning/`, so it would
  // go on reporting a clean separation across the very edge it exists to
  // forbid — the mistake the Sprint 06 version of this test recorded fixing.
  const closure = importClosure(roots());
  const siblings = Array.from(closure.keys())
    .map(relative)
    .filter((file) => /^lib\/planning\/(scheduler|evaluation)\//.test(file))
    .sort();

  assert.deepEqual(
    siblings,
    [],
    'the design permits #30 and #31 to import this normalizer, and permits nothing in the '
    + 'other direction',
  );
});

test('the only planning module it reaches is the shared time primitive', () => {
  // Stated as an allowlist rather than as a list of prohibitions, because a
  // prohibition list only forbids the directories someone thought of. `shared/`
  // is deliberately the one exception: the sprint design puts every
  // instant/wall-clock conversion there precisely so the three tracks share the
  // arithmetic instead of writing it three times.
  const closure = importClosure(roots());
  const planningModules = Array.from(closure.keys())
    .map(relative)
    .filter((file) => file.startsWith('lib/planning/') && !file.startsWith('lib/planning/constraints/'))
    .sort();

  assert.deepEqual(planningModules, ['lib/planning/shared/time.ts']);
});

test('it depends on exactly one product contract, the planning one', () => {
  // Filtered on the *resolved* repo path, not on the specifier text.
  // `planningContracts` spells its own dependency `./moduleContracts`, which
  // contains no directory segment at all — so a filter matching `contracts/` in
  // the specifier saw one contract where there are two, and would have gone on
  // reporting a clean single dependency however many siblings were added next
  // to it.
  // Restricted to what this track's own files import, rather than to the whole
  // closure. `planningContracts` imports the shared version constant from
  // `moduleContracts`, which in turn reaches the life-state and memory
  // contracts — so the transitive set names four contracts and would name more
  // as the base grows, none of it a fact about this module. What is a fact about
  // this module is which contract its own source reaches for, and there is
  // exactly one: reaching a second would mean it had grown an opinion about
  // some other module's shapes.
  const own = roots();
  const contracts = Array.from(new Set(
    own.flatMap((file) => importSpecifiers(readFileSync(file, 'utf8'))
      .map((specifier) => resolveLocal(file, specifier))
      .filter((resolved): resolved is string => resolved !== null)
      .map(relative)
      .filter((resolved) => resolved.startsWith('src/contracts/'))),
  )).sort();

  assert.deepEqual(contracts, ['src/contracts/v1/planningContracts.ts']);
});

/* ── No ambient clock ────────────────────────────────────────────── */

test('nothing in the closure reads a clock or a random source', () => {
  // `PLANNING_PERSISTENCE_POLICY.noAmbientClock`, enforced structurally. Every
  // instant must come from the input: a planner that could call `Date.now()`
  // would produce a different plan on every run, and no determinism test could
  // catch it, because each run would be internally consistent.
  //
  // `new Date(` is checked with an argument required, because
  // `new Date(epochMs)` is how an instant is formatted and is perfectly
  // deterministic; it is the *no-argument* form that reads the wall clock.
  const closure = importClosure(roots());
  for (const file of Array.from(closure.keys())) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/Date\.now\s*\(/, 'must not call Date.now(); every instant comes from the horizon or the input'],
      [/new\s+Date\s*\(\s*\)/, 'must not construct a Date with no argument; that is the wall clock'],
      [/Math\.random\s*\(/, 'must not use Math.random(); a plan is inspectable only if it is deterministic'],
      [/randomUUID/, 'must not mint ids; nothing here creates an identity'],
      [/performance\s*\.\s*now\s*\(/, 'must not read a monotonic clock either'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('the clock scan would fail if a clock were there, so the pattern list is not decorative', () => {
  // A negative-only assertion passes against a regex that matches nothing. This
  // proves each pattern still recognises the thing it forbids.
  const samples = [
    ['const at = Date.now();', /Date\.now\s*\(/],
    ['const at = new Date();', /new\s+Date\s*\(\s*\)/],
    ['const jitter = Math.random();', /Math\.random\s*\(/],
    ['const id = randomUUID();', /randomUUID/],
    ['const t = performance.now();', /performance\s*\.\s*now\s*\(/],
  ] as const;
  for (const [sample, pattern] of samples) {
    assert.equal(pattern.test(sample), true, `pattern no longer matches: ${sample}`);
  }
  // And the deterministic formatting form must stay allowed, or the guard would
  // force the module to reimplement `toInstant` to get past it.
  assert.equal(/new\s+Date\s*\(\s*\)/.test('return new Date(epochMs).toISOString();'), false);
});

test('stripping comments hides prose about a clock and hides nothing else', () => {
  // The stripper is the one place this file could silently stop checking
  // anything, so it is pinned in both directions.
  assert.equal(/Date\.now\s*\(/.test(stripComments('// never call Date.now() here')), false);
  assert.equal(/Date\.now\s*\(/.test(stripComments('/** never call Date.now() */')), false);
  assert.equal(/Date\.now\s*\(/.test(stripComments('const at = Date.now();')), true);
  assert.equal(
    /Math\.random\s*\(/.test(stripComments('const x = 1; // fine\nconst y = Math.random();')),
    true,
    'a comment must not swallow the line after it',
  );
});

test('nothing in the closure logs, mutates process state, or touches the filesystem', () => {
  // A log line is the one audit channel with no allowlist, and constraints
  // carry titles the user wrote. The other two would make a pure function's
  // result depend on where it ran.
  const closure = importClosure(roots());
  for (const file of Array.from(closure.keys())) {
    const source = readFileSync(file, 'utf8');
    for (const [pattern, why] of [
      [/console\s*\.\s*(log|info|warn|error|debug)\s*\(/, 'must not log; constraints carry user-written titles'],
      [/process\s*\.\s*env/, 'must not read the environment; config is an argument, not ambient'],
      [/from\s*['"]node:fs['"]/, 'must not touch the filesystem'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});
