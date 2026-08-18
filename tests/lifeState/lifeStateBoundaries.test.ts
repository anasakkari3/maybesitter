/**
 * Source-scanning boundary tests for lib/lifeState/**.
 *
 * Two acceptance criteria of issue #9 are structural rather than behavioural, so
 * they are checked by reading the source rather than by running it — following
 * the pattern in tests/contract/intelligenceModuleBoundaries.test.ts:
 *
 *  1. No model-generated value becomes canonical state. The projection is a read
 *     model; it must reach no writer. Checked over the whole import closure, not
 *     just direct imports, because a single hop (agendaService imports
 *     commandService) is enough to drag a writer in.
 *
 *  2. The projection never reads the system clock. `computedAt` comes from
 *     `input.now`, and a stray `Date.now()` would silently destroy replayability
 *     without failing any behavioural test that happens to run fast enough.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const lifeStateDir = join(repoRoot, 'lib', 'lifeState');

/** Modules that write canonical user state, or reach persistence directly. */
const FORBIDDEN_MODULE_BASENAMES = ['commandService', 'deterministicStateGateway', 'dataStore'] as const;

function lifeStateSourceFiles(): string[] {
  return readdirSync(lifeStateDir)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(lifeStateDir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
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

/** Every repo file reachable from lib/lifeState/**, mapped to its own imports. */
function importClosure(): Map<string, string[]> {
  const closure = new Map<string, string[]>();
  const queue = lifeStateSourceFiles();

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

test('lib/lifeState exists and is scanned, so these guards are never vacuous', () => {
  const files = lifeStateSourceFiles();
  assert.ok(files.length > 0, 'expected at least one source file under lib/lifeState');
  assert.ok(
    files.some((file) => file.endsWith('lifeStateProjection.ts')),
    'expected lifeStateProjection.ts to be part of the scanned surface'
  );
});

test('the life-state projection imports no writer module, directly or transitively', () => {
  const closure = importClosure();
  assert.ok(closure.size >= lifeStateSourceFiles().length, 'import closure should cover every scanned file');

  for (const entry of Array.from(closure.entries())) {
    const [file, specifiers] = entry;
    for (const specifier of specifiers) {
      assert.equal(
        isForbidden(specifier),
        false,
        `${file.slice(repoRoot.length + 1)} reaches writer module "${specifier}"; the projection must stay a read model`
      );
    }
  }
});

test('the life-state projection never reads the system clock', () => {
  for (const file of lifeStateSourceFiles()) {
    const source = readFileSync(file, 'utf8');
    const relative = file.slice(repoRoot.length + 1);

    assert.equal(/Date\.now\s*\(/.test(source), false, `${relative} must not call Date.now(); use LifeStateInput.now`);
    assert.equal(
      /new\s+Date\s*\(\s*\)/.test(source),
      false,
      `${relative} must not call new Date() with no argument; use LifeStateInput.now`
    );
    assert.equal(/Math\.random\s*\(/.test(source), false, `${relative} must not use Math.random(); the projection is deterministic`);
    assert.equal(/randomUUID/.test(source), false, `${relative} must not mint random ids; the projection is deterministic`);
  }
});
