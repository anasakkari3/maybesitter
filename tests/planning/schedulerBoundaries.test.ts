/**
 * Structural guards on lib/planning/scheduler/**, checked by reading the source
 * rather than by running it.
 *
 * The walker is `tests/decomposition/boundaryImportClosure.test.ts`'s, copied
 * deliberately: that test's closure walk caught a writer reached through a
 * single intermediate module that a direct-import check had been happily
 * missing, and every guard below has the same shape of hole. A first-hop check
 * on this module would report a clean separation while `scheduler.ts` imported
 * one helper that imported the thing it must not reach.
 *
 * Four claims are structural here:
 *
 *  1. **The scheduler reaches no writer and no route.** A plan is a proposal
 *     about time and is never canonical user state
 *     (`PLANNING_PERSISTENCE_POLICY.planCanPersist: false`). A module that
 *     *could* write is one refactor away from writing, and "it doesn't today"
 *     is not a property anyone can maintain.
 *  2. **The scheduler reaches nothing under `lib/planning/evaluation/`.** #31's
 *     oracle is the independent second reading of the feasibility vocabulary.
 *     An import in either direction would make the sprint's cross-track
 *     comparison compare a thing with itself — the Sprint 02 failure, where 91
 *     tests passed while three modules disagreed.
 *  3. **The scheduler imports #29's normalizer and never #29's validator.** The
 *     sprint design permits exactly one of those: materialising a window is
 *     arithmetic and a second copy is a gap, while validating constraints is a
 *     judgement and a second copy is a check.
 *  4. **No ambient clock, anywhere in the closure.** Not `Date.now()`, not a
 *     no-argument `new Date()`, not `Math.random()`, not `randomUUID`. This is
 *     the one determinism property no behavioural test can catch: a scheduler
 *     that read a clock would still agree with itself twice in the same
 *     millisecond, and `schedulerDeterminism.test.ts` would stay green while
 *     every plan drifted between runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const schedulerDir = join(repoRoot, 'lib', 'planning', 'scheduler');

/** Modules that write canonical user state or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
  'stateMachine',
  'captureBoundaryService',
  'decompositionBoundaryService',
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
 * Every pattern check below runs over this rather than over the raw file. The
 * house rule in this repo is that a comment explains *why* a decision is
 * structural — so the modules being checked here explain, in prose, that they
 * must not call `Date.now()`, and a raw scan reports each of those sentences as
 * the violation it was written to prevent. A guard that fails on its own
 * documentation is a guard someone eventually deletes rather than satisfies.
 *
 * It is a lexical strip, not a parse: a `//` inside a string literal would be
 * treated as a comment. That is acceptable here because the patterns are all
 * identifiers, and code that hid `Date.now()` inside a string could not call it
 * anyway.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ── Non-vacuity ────────────────────────────────────────────────── */

test('the scheduler directory exists and is scanned, so these guards are never vacuous', () => {
  const files = sourceFiles(schedulerDir).map(relative);
  for (const expected of ['digest.ts', 'diff.ts', 'index.ts', 'scheduler.ts']) {
    assert.ok(
      files.some((file) => file.endsWith(expected)),
      `expected ${expected} in the scheduler surface; a renamed file would silently empty every check below`,
    );
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

/* ── Writers, routes, surfaces ──────────────────────────────────── */

test('the scheduler reaches no writer module, directly or transitively', () => {
  const closure = importClosure(sourceFiles(schedulerDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        isForbidden(specifier),
        false,
        `${relative(file)} reaches writer module "${specifier}"; a plan is a proposal and must never persist`,
      );
    }
  }
});

test('the scheduler reaches no route handler, mobile app, or UI surface', () => {
  const closure = importClosure(sourceFiles(schedulerDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        /(^|\/)(app\/api|app\/\(|mobile|components|pages)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; planning is a leaf the API depends on, not the reverse`,
      );
    }
  }
});

test('the scheduler reaches nothing under lib/planning/evaluation', () => {
  const closure = importClosure(sourceFiles(schedulerDir));
  for (const file of Array.from(closure.keys())) {
    assert.equal(
      relative(file).startsWith('lib/planning/evaluation/'),
      false,
      `${relative(file)} is reachable from the scheduler; #31's oracle is the independent second `
        + 'reading of feasibility, and an import would make the cross-track test compare a thing with itself',
    );
  }
});

test('the scheduler may reach #29 normalizer but never #29 validator', () => {
  // Matched on the *resolved* repo path rather than on the specifier text: this
  // module would spell the import `../constraints/normalize`, and a pattern
  // anchored on `planning/constraints` would never see it — reporting a clean
  // separation across the very edge it exists to police.
  const closure = importClosure(sourceFiles(schedulerDir));
  const constraintFiles = Array.from(closure.keys())
    .map(relative)
    .filter((file) => file.startsWith('lib/planning/constraints/'))
    .sort();

  for (const file of constraintFiles) {
    assert.ok(
      /^lib\/planning\/constraints\/normalize\.ts$/.test(file),
      `${file} is reachable from the scheduler; only #29's normalizer may cross this line, `
        + 'because materialising a window is arithmetic while validating constraints is a judgement',
    );
  }
});

/* ── No ambient clock ───────────────────────────────────────────── */

const CLOCK_PATTERNS = [
  [/Date\.now\s*\(/, 'must not call Date.now(); every instant in a plan comes from the input'],
  [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock'],
  [/Math\.random\s*\(/, 'must not use Math.random(); a plan is inspectable only if it is deterministic'],
  [/randomUUID/, 'must not mint ids; a plan that minted one would differ from its own replay'],
  [/performance\.now\s*\(/, 'must not read a monotonic clock either'],
] as const;

test('nothing reachable from the scheduler reads an ambient clock or a random source', () => {
  const closure = importClosure(sourceFiles(schedulerDir));
  for (const file of Array.from(closure.keys())) {
    const source = code(file);
    for (const [pattern, why] of CLOCK_PATTERNS) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('the scheduler\'s own files construct no Date at all, not even a pure one', () => {
  // Stricter than the closure rule above, and deliberately so. `new Date(ms)`
  // is a pure conversion and `lib/planning/shared/time.ts` uses it correctly;
  // but the difference between that and `new Date()` is one character, and this
  // directory has no need for either. Forbidding the constructor outright means
  // the guard never has to be right about which spelling it is looking at.
  for (const file of sourceFiles(schedulerDir)) {
    assert.equal(
      /new\s+Date\s*\(/.test(code(file)),
      false,
      `${relative(file)} constructs a Date; convert instants through lib/planning/shared/time instead`,
    );
  }
});

test('the digest is a sha256 over a canonical string, and nothing here logs', () => {
  const digest = code(join(schedulerDir, 'digest.ts'));
  assert.match(digest, /createHash\('sha256'\)/, 'inputDigest must be a hash, not a serialisation');
  assert.equal(
    // The one legitimate `JSON.stringify` in that file takes a primitive. These
    // names are the records — stringifying any of them would put the call
    // site's key insertion order into the digest.
    /JSON\.stringify\(\s*(constraints|config|item|window|event|effort|dependency|entries|horizon|interval)\b/.test(digest),
    false,
    'the canonical form must not stringify a record whose key order depends on insertion',
  );
  for (const file of sourceFiles(schedulerDir)) {
    assert.equal(
      /console\.(log|info|warn|error)/.test(code(file)),
      false,
      `${relative(file)} logs; a log line is the one audit channel with no allowlist, and a `
        + 'planning request carries the user\'s own titles',
    );
  }
});
