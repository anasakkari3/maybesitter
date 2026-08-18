/**
 * Source-scanning boundary tests for lib/feedback/**.
 *
 * Two of issue #13's acceptance criteria are structural rather than
 * behavioural, so they are checked by reading the source rather than by running
 * it — following tests/lifeState/lifeStateBoundaries.test.ts:
 *
 *  1. Events never silently edit commitments. A feedback record observes what
 *     the user did; it must reach no writer of what the user has. Checked over
 *     the whole import closure, not just direct imports, because a single hop
 *     (agendaService imports commandService) is enough to drag a writer in.
 *     behaviorFeedbackService is forbidden alongside the canonical writers: it
 *     exports the helpers that increment and clear the legacy counters, so
 *     lib/feedback takes its reader by injection instead.
 *
 *  2. Actor, source and both timestamps are present. "Present" means
 *     non-optional in the type, which no runtime test can observe, so the
 *     contract's own declaration is read here.
 *
 * A third check pins determinism: an append derives its id and idempotency key
 * from its inputs alone, so a stray clock or random source would silently make
 * "the same behaviour resolves to the same record" untrue without failing any
 * behavioural test that happens to run fast enough.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const feedbackDir = join(repoRoot, 'lib', 'feedback');
const contractFile = join(repoRoot, 'src', 'contracts', 'v1', 'feedbackContracts.ts');

/**
 * Modules that write canonical user state, reach persistence directly, or
 * mutate the legacy counters.
 */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'behaviorFeedbackService',
] as const;

function feedbackSourceFiles(): string[] {
  return readdirSync(feedbackDir)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(feedbackDir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect-only imports (`import 'x';`) bind no name but still run the
    // module. The sibling scanner in tests/lifeState/lifeStateBoundaries.test.ts
    // has no pattern for them, so a writer pulled in this way walks straight
    // through; verified by mutating an intermediate module and watching the
    // check stay green.
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

/** Every repo file reachable from lib/feedback/**, mapped to its own imports. */
function importClosure(): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = feedbackSourceFiles();

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

test('lib/feedback exists and is scanned, so these guards are never vacuous', () => {
  const files = feedbackSourceFiles();
  assert.ok(files.length > 0, 'expected at least one source file under lib/feedback');
  for (const expected of ['feedbackEventStore.ts', 'baselineMigration.ts']) {
    assert.ok(
      files.some((file) => file.endsWith(expected)),
      `expected ${expected} to be part of the scanned surface`,
    );
  }
});

test('the feedback log imports no writer module, directly or transitively', () => {
  const closure = importClosure();
  const scanned = feedbackSourceFiles();
  assert.ok(closure.size >= scanned.length, 'import closure should cover every scanned file');

  // The closure must actually walk past the first hop, otherwise this test
  // would silently degrade into a direct-import check — which is exactly what a
  // writer reached through one intermediate module would slip past.
  const directlyImported = new Set(
    scanned.flatMap((file) => importSpecifiers(readFileSync(file, 'utf8'))
      .map((specifier) => resolveLocal(file, specifier))
      .filter((resolved): resolved is string => resolved !== null)),
  );
  assert.ok(
    Array.from(closure.keys()).some((file) => !scanned.includes(file) && !directlyImported.has(file)),
    'expected the closure to reach at least one module more than one hop away',
  );

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        isForbidden(specifier),
        false,
        `${file.slice(repoRoot.length + 1)} reaches writer module "${specifier}"; `
          + 'a feedback event observes behaviour and must never edit the commitment it describes',
      );
    }
  }
});

test('the feedback log reaches no route handler, UI, or sibling feature store', () => {
  const closure = importClosure();
  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const relative = file.slice(repoRoot.length + 1);
      assert.equal(
        /(^|\/)(app\/api|mobile)\//.test(specifier),
        false,
        `${relative} reaches "${specifier}"; the store is a leaf the API depends on, not the reverse`,
      );
    }
  }
});

test('the feedback log never reads the system clock or a random source', () => {
  for (const file of feedbackSourceFiles()) {
    const source = readFileSync(file, 'utf8');
    const relative = file.slice(repoRoot.length + 1);

    assert.equal(
      /Date\.now\s*\(/.test(source),
      false,
      `${relative} must not call Date.now(); every timestamp is a parameter`,
    );
    assert.equal(
      /new\s+Date\s*\(\s*\)/.test(source),
      false,
      `${relative} must not call new Date() with no argument; every timestamp is a parameter`,
    );
    assert.equal(
      /Math\.random\s*\(/.test(source),
      false,
      `${relative} must not use Math.random(); an append is reproducible from its input`,
    );
    assert.equal(
      /randomUUID/.test(source),
      false,
      `${relative} must not mint random ids; the record id is derived, which is what makes a retry land on the same record`,
    );
  }
});

test('the contract declares actor, source and both timestamps as non-optional', () => {
  const source = readFileSync(contractFile, 'utf8');
  const event = /export interface FeedbackEvent \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(event, 'expected to find the FeedbackEvent declaration');

  for (const field of ['actor', 'source', 'occurredAt', 'recordedAt', 'scopeId', 'subjectId', 'outcome']) {
    assert.match(
      event[1],
      new RegExp(`readonly ${field}:`),
      `FeedbackEvent.${field} must be declared non-optional; an event that cannot say who acted, `
        + 'through what, or when is not attributable',
    );
    assert.equal(
      new RegExp(`readonly ${field}\\?:`).test(event[1]),
      false,
      `FeedbackEvent.${field} must not be optional`,
    );
  }
  // revokedAt is the one optional field, and deliberately so: its absence is
  // what distinguishes an uncorrected event from a corrected one.
  assert.match(event[1], /readonly revokedAt\?:/);
});

test('the append input excludes every server-assigned field', () => {
  const source = readFileSync(contractFile, 'utf8');
  const input = /export interface AppendFeedbackEventInput \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(input, 'expected to find the AppendFeedbackEventInput declaration');

  for (const field of ['id', 'version', 'recordedAt', 'idempotencyKey', 'revokedAt']) {
    assert.equal(
      new RegExp(`readonly ${field}[?]?:`).test(input[1]),
      false,
      `AppendFeedbackEventInput must not accept ${field}; it is assigned by the store`,
    );
  }
  assert.match(
    input[1],
    /Exclude<FeedbackSource, 'migration_baseline'>/,
    'a caller must not be able to append an event sourced from the migration baseline',
  );
});
