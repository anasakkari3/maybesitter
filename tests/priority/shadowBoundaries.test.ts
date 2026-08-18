/**
 * Source-scanning boundary tests for lib/priority/shadow/** (Sprint 05, #23).
 *
 * The acceptance criterion is that shadow output *cannot* affect persistence or
 * UI — not that it currently does not. A behavioural test cannot show that:
 * it can only show that the writes it happened to look for did not happen. So
 * this file reads the source instead, and walks the **transitive** import
 * closure, because one hop is enough to drag a writer in (`agendaService`
 * imports `commandService`; anything importing `agendaService` reaches
 * persistence without ever naming it).
 *
 * The scanner is modelled on tests/lifeState/lifeStateBoundaries.test.ts,
 * including its Sprint 03 fix: a bare `import 'x';` binds no name, so it has no
 * `from` clause and a `from ['"]...['"]` pattern misses it entirely — while the
 * module still executes in full. That gap was real in this repo, so the pattern
 * for it is here and `scanner:` below tests the scanner itself against a
 * synthetic source rather than trusting that it works.
 *
 * The strongest guard is the last one: nothing in the closure may reach the
 * filesystem or the network at all. Shadow comparison returns a value. It has
 * no write path to return through, and that is checked rather than asserted in
 * a comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const shadowDir = join(repoRoot, 'lib', 'priority', 'shadow');
const shadowCli = join(repoRoot, 'scripts', 'priority-shadow-run.ts');

/** Modules that write canonical user state, or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = [
  'commandService',
  'deterministicStateGateway',
  'dataStore',
  'agendaService',
  'agendaActionService',
] as const;

/** Every store in the repo exposes at least one write; none of them belongs here. */
const FORBIDDEN_BASENAME_PATTERNS = [/Store$/] as const;

/** UI surfaces, and the frameworks that only a UI surface needs. */
const FORBIDDEN_UI_SPECIFIER_PATTERNS = [
  /\.tsx$/,
  /(^|\/)src\/components(\/|$)/,
  /(^|\/)src\/app(\/|$)/,
  /(^|\/)src\/context(\/|$)/,
  /^react($|\/|-)/,
  /^next($|\/)/,
] as const;

/** I/O of any kind. A pure comparison needs none of it. */
const FORBIDDEN_IO_SPECIFIERS = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'http', 'node:http', 'https', 'node:https', 'net', 'node:net'] as const;

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFilesUnder(full);
      return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
    })
    .sort();
}

/**
 * Every import specifier in a source, in all four spellings.
 *
 * Exported shape kept identical to the life-state scanner so the two cannot
 * drift into disagreeing about what an import is.
 */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect-only `import 'x';` binds no name and so has no `from` clause,
    // yet it executes the module in full. Sprint 03 found this exact gap in the
    // repo's scanner. The whitespace after `import` keeps this from matching
    // `import('x')`, which the pattern above already covers.
    /import\s+['"]([^'"]+)['"]/g,
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

/**
 * Source with its comments removed.
 *
 * The content bans below are about what the code *does*, and this file's own
 * modules explain in prose why they do not call `Math.random()` or read the
 * clock. Scanning the raw text would flag those explanations, and the cheapest
 * way to make such a scanner green is to delete the comment that explains the
 * rule — so the scanner would be actively pushing the code in the wrong
 * direction. Comments are therefore stripped first, and only real code is
 * checked.
 *
 * The line-comment pattern keeps the character before `//`, so a `https://`
 * inside a string literal is not mistaken for the start of a comment.
 */
function strippedSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.ts$/, ''));
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

function basenameOf(specifier: string): string {
  const segments = specifier.split('/');
  return (segments[segments.length - 1] || '').replace(/\.tsx?$/, '');
}

function writerReason(specifier: string): string | null {
  const basename = basenameOf(specifier);
  if ((FORBIDDEN_MODULE_BASENAMES as readonly string[]).includes(basename)) return 'writes canonical user state';
  if (FORBIDDEN_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) return 'is a store with a write path';
  return null;
}

function uiReason(specifier: string): string | null {
  return FORBIDDEN_UI_SPECIFIER_PATTERNS.some((pattern) => pattern.test(specifier)) ? 'is a UI surface' : null;
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

/* ── The scanner itself ───────────────────────────────────────────── */

test('scanner: a bare side-effect import is seen, not silently skipped', () => {
  // The regression this whole file is shaped around. A scanner that misses
  // `import 'x';` reports a clean closure for a module that executes a writer
  // on load — a green test for the exact failure it exists to prevent.
  const source = [
    "import '../../services/commandService';",
    "import   \"../../../src/server/dataStore\";",
    "import { thing } from './thing';",
    "const lazy = await import('./lazy');",
    "const legacy = require('./legacy');",
  ].join('\n');

  const found = importSpecifiers(source);

  assert.ok(found.includes('../../services/commandService'), 'bare single-quoted side-effect import must be found');
  assert.ok(found.includes('../../../src/server/dataStore'), 'bare double-quoted side-effect import must be found');
  assert.ok(found.includes('./thing'), 'named import must be found');
  assert.ok(found.includes('./lazy'), 'dynamic import must be found');
  assert.ok(found.includes('./legacy'), 'require must be found');
});

test('scanner: a side-effect import of a writer is classified as forbidden', () => {
  for (const specifier of importSpecifiers("import '../../services/commandService';")) {
    assert.notEqual(writerReason(specifier), null, `${specifier} must be recognised as a writer`);
  }
});

test('scanner: the shadow module exists and is scanned, so these guards are never vacuous', () => {
  const files = sourceFilesUnder(shadowDir);
  assert.ok(files.length > 0, 'expected at least one source file under lib/priority/shadow');
  assert.ok(
    files.some((file) => file.endsWith('shadowComparison.ts')),
    'expected shadowComparison.ts to be part of the scanned surface',
  );
  assert.ok(existsSync(shadowCli), 'expected the shadow CLI at scripts/priority-shadow-run.ts');
});

/* ── The guarantees ───────────────────────────────────────────────── */

test('shadow comparison imports no writer module, directly or transitively', () => {
  const roots = sourceFilesUnder(shadowDir);
  const closure = importClosure(roots);
  assert.ok(closure.size >= roots.length, 'import closure should cover every scanned file');

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const reason = writerReason(specifier);
      assert.equal(
        reason,
        null,
        `${relative(file)} reaches "${specifier}", which ${reason}; shadow comparison returns a value and must have no write path`,
      );
    }
  }
});

test('shadow comparison imports no UI surface, directly or transitively', () => {
  const closure = importClosure(sourceFilesUnder(shadowDir));

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(uiReason(specifier), null, `${relative(file)} reaches UI surface "${specifier}"`);
    }
  }
});

test('shadow comparison reaches no filesystem or network primitive at all', () => {
  // The sharpest form of the criterion. Even a writer the ban list has never
  // heard of needs I/O to persist anything, and there is none in the closure.
  const closure = importClosure(sourceFilesUnder(shadowDir));

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        (FORBIDDEN_IO_SPECIFIERS as readonly string[]).includes(specifier),
        false,
        `${relative(file)} imports "${specifier}"; the comparison must return a value, not write one`,
      );
    }
  }

  for (const file of sourceFilesUnder(shadowDir)) {
    const source = strippedSource(file);
    assert.equal(/\bfetch\s*\(/.test(source), false, `${relative(file)} must not call fetch()`);
    assert.equal(/\bprocess\.env\b/.test(source), false, `${relative(file)} must not read process.env`);
    assert.equal(/\bglobalThis\b/.test(source), false, `${relative(file)} must not reach into globalThis`);
  }
});

test('shadow comparison is deterministic at the source level: no clock, no randomness', () => {
  // A repo-wide test already forbids the clock under lib/priority; randomness is
  // added here because an unseeded sampler would make a sampled run
  // unreproducible while every count-based assertion still passed.
  for (const file of sourceFilesUnder(shadowDir)) {
    const source = strippedSource(file);
    const name = relative(file);
    assert.equal(/\bDate\.now\s*\(/.test(source), false, `${name} must not call Date.now()`);
    assert.equal(/\bnew\s+Date\s*\(/.test(source), false, `${name} must not construct a Date`);
    assert.equal(/\bMath\.random\s*\(/.test(source), false, `${name} must not use Math.random(); sampling is seeded`);
    assert.equal(/\brandomUUID\b/.test(source), false, `${name} must not mint random ids`);
    assert.equal(/\bperformance\.now\s*\(/.test(source), false, `${name} must not call performance.now()`);
  }
});

test('the shadow CLI writes only its own report, and reaches no writer module', () => {
  // The CLI is allowed the filesystem — it exists to emit a report artifact,
  // exactly as scripts/priority-agreement-run.ts does. It is not allowed a
  // writer: a report run must not be able to change what it is reporting on.
  const closure = importClosure([shadowCli]);

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      const reason = writerReason(specifier);
      assert.equal(reason, null, `${relative(file)} reaches "${specifier}", which ${reason}`);
      assert.equal(uiReason(specifier), null, `${relative(file)} reaches UI surface "${specifier}"`);
    }
  }

  const source = readFileSync(shadowCli, 'utf8');
  const writeTargets = Array.from(source.matchAll(/writeFileSync\(\s*([A-Za-z0-9_]+)/g)).map((match) => match[1]);
  assert.ok(writeTargets.length > 0, 'expected the CLI to write at least one report file');
  assert.match(source, /docs['"]?\s*,\s*['"]quality['"]\s*,\s*['"]reports['"]/, 'reports must land under docs/quality/reports');
});
