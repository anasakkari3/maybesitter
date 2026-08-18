/**
 * Structural guards on lib/decomposition/**, checked by reading the source
 * rather than running it — following tests/feedback/feedbackBoundaries.test.ts,
 * whose closure walk caught a writer reached through a single intermediate
 * module that a direct-import check had been happily missing.
 *
 * Three claims are structural rather than behavioural here:
 *
 *  1. The engine reaches no writer. It is a pure function from a sentence to a
 *     proposal; if it could reach the adapter it could write, and "it doesn't
 *     today" is not a property anyone can maintain.
 *  2. Nothing under lib/decomposition reaches a route handler or the mobile
 *     app. These modules are leaves the API may depend on, never the reverse.
 *  3. #27 imports neither of its sibling Sprint 06 tracks. The three were built
 *     in parallel against one contract; an import between them would be a
 *     coupling nobody reviewed, and it would only surface at merge.
 *
 * A fourth check pins engine determinism: given the same sentence it must
 * return the same spans, which a clock or a random id would silently break
 * without failing any behavioural test in this suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const engineDir = join(repoRoot, 'lib', 'decomposition', 'engine');
const boundaryDir = join(repoRoot, 'lib', 'decomposition', 'boundary');

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

test('both directories exist and are scanned, so these guards are never vacuous', () => {
  const engine = sourceFiles(engineDir).map(relative);
  const boundary = sourceFiles(boundaryDir).map(relative);
  for (const expected of ['rulesDetector.ts', 'validator.ts', 'modelProvider.ts', 'index.ts']) {
    assert.ok(engine.some((file) => file.endsWith(expected)), `expected ${expected} in the engine surface`);
  }
  for (const expected of ['decompositionBoundaryService.ts', 'persistenceAdapter.ts', 'index.ts']) {
    assert.ok(boundary.some((file) => file.endsWith(expected)), `expected ${expected} in the boundary surface`);
  }
});

test('the closure walks past the first hop, so it is not a direct-import check in disguise', () => {
  const roots = sourceFiles(engineDir).concat(sourceFiles(boundaryDir));
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

test('the engine reaches no writer module, directly or transitively', () => {
  const closure = importClosure(sourceFiles(engineDir));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        isForbidden(specifier),
        false,
        `${relative(file)} reaches writer module "${specifier}"; the engine proposes and must never persist`,
      );
    }
  }
});

test('the engine cannot reach the adapter, because it cannot reach the boundary at all', () => {
  const closure = importClosure(sourceFiles(engineDir));
  for (const file of Array.from(closure.keys())) {
    assert.equal(
      relative(file).startsWith('lib/decomposition/boundary/'),
      false,
      `${relative(file)} is reachable from the engine; the dependency runs boundary -> engine only`,
    );
  }
});

test('nothing under lib/decomposition reaches a route handler, the mobile app, or a UI surface', () => {
  const closure = importClosure(sourceFiles(engineDir).concat(sourceFiles(boundaryDir)));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        /(^|\/)(app\/api|app\/\(|mobile|components)\//.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; these modules are leaves the API depends on, not the reverse`,
      );
    }
  }
});

test('#27 imports neither sibling Sprint 06 track', () => {
  const closure = importClosure(sourceFiles(engineDir).concat(sourceFiles(boundaryDir)));
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        /decomposition\/(proposal|evaluation)/.test(specifier),
        false,
        `${relative(file)} reaches "${specifier}"; the three Sprint 06 tracks coordinate through contracts only`,
      );
    }
  }
});

test('the engine reads no clock and no random source, so the same sentence yields the same spans', () => {
  for (const file of sourceFiles(engineDir)) {
    const source = readFileSync(file, 'utf8');
    for (const [pattern, why] of [
      [/Date\.now\s*\(/, 'must not call Date.now(); a span does not depend on when it was computed'],
      [/new\s+Date\s*\(/, 'must not construct a Date; resolving a stated time is Capture\'s job'],
      [/Math\.random\s*\(/, 'must not use Math.random(); the detector is inspectable only if it is deterministic'],
      [/randomUUID/, 'must not mint ids; step ids are derived from position so two runs agree'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('the boundary hashes its input and never logs it', () => {
  const service = readFileSync(join(boundaryDir, 'decompositionBoundaryService.ts'), 'utf8');
  assert.match(service, /createHash\('sha256'\)/, 'the audit envelope must carry a hash of the input');
  assert.equal(
    /console\.(log|info|warn|error)/.test(service),
    false,
    'the boundary must not log; a log line is the one audit channel with no allowlist',
  );
});
