import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTELLIGENCE_MODULES } from '../../src/contracts/v1/moduleContracts.ts';
import { envToken } from '../../src/contracts/v1/runtimeControls.ts';

// .env.example is the one list operators copy from. These checks keep it
// honest in both directions: nothing documented that the code never reads, and
// nothing the code reads that is undocumented unless it is deliberately left out.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_DIRS = ['lib', 'src', 'scripts', 'infra'];
const SOURCE_FILE = /\.(ts|tsx|mjs|js|sh)$/;

// Read through a suffix, not a literal name (lib/release/m5aControls.ts).
const SUFFIX_FAMILIES = ['CALENDAR_CHOICE', 'EMAIL_SOURCES'];

// Deliberately not in .env.example. The platform or the framework sets these,
// or a boot check refuses them (lib/runtime/runtimeConfig.ts).
const NOT_DOCUMENTED = new Set([
  'MAYBESITTER_DEV_AUTH', // refused on Cloud Run; there is no supported development bypass
]);

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      out.push(...sourceFiles(path));
    } else if (SOURCE_FILE.test(entry) && !/\.test\.[a-z]+$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const sources = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

const documented = readFileSync(join(ROOT, '.env.example'), 'utf8')
  .split('\n')
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter((name): name is string => Boolean(name));

// A variable the code reads by name: `env.NAME`, `process.env.NAME`, or a quoted literal.
function literalReads(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/(?:process\.env\.|\benv\.|['"`])([A-Z][A-Z0-9_]*[A-Z0-9])\b/g)) {
    names.add(match[1]!);
  }
  return names;
}

const dynamic = new Set<string>();
for (const module of INTELLIGENCE_MODULES) {
  dynamic.add(`MAYBESITTER_FEATURE_${envToken(module)}`);
  dynamic.add(`MAYBESITTER_KILL_SWITCH_${envToken(module)}`);
}
for (const suffix of SUFFIX_FAMILIES) {
  dynamic.add(`MAYBESITTER_FEATURE_${suffix}`);
  dynamic.add(`MAYBESITTER_KILL_SWITCH_${suffix}`);
}

test('every documented variable is read by the code', () => {
  const stale = documented.filter((name) => {
    if (dynamic.has(name)) return false;
    const token = new RegExp(`\\b${name}\\b`);
    return !token.test(sources);
  });
  assert.deepEqual(
    stale,
    [],
    '.env.example documents variables the code never reads (a misnamed or retired switch does nothing)',
  );
});

test('every MAYBESITTER_ variable the code reads is documented', () => {
  const documentedSet = new Set(documented);
  const undocumented = [...literalReads(sources)]
    .filter((name) => name.startsWith('MAYBESITTER_'))
    .filter((name) => !documentedSet.has(name) && !dynamic.has(name) && !NOT_DOCUMENTED.has(name))
    .sort();
  assert.deepEqual(
    undocumented,
    [],
    'the code reads these MAYBESITTER_ variables but .env.example does not document them',
  );
});

test('the documented module switches use the names the code derives', () => {
  for (const module of INTELLIGENCE_MODULES) {
    const token = envToken(module);
    assert.ok(!token.includes('__'), `${module} produced a malformed token ${token}`);
  }
  assert.equal(envToken('recommendation'), 'RECOMMENDATION');
  assert.equal(envToken('goalPlan'), 'GOAL_PLAN');
});
