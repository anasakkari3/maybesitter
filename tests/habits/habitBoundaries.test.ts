/**
 * Structural guards on the habit domain, checked by reading the source (#520).
 *
 * Three of the issue's acceptance criteria are not behavioural, and a
 * behavioural test for any of them would pass for the wrong reason:
 *
 *  1. "No streak/penalty behaviour." There is no input that makes a streak
 *     field appear; the way one arrives is somebody adding it in good faith,
 *     next sprint, to a product that then tells people they broke a chain. So
 *     the field lists of `HabitDefinition` and `HabitOccurrence` are pinned
 *     exactly, and the source is scanned for the vocabulary with its comments
 *     removed — because this file's own prose says "no streak" repeatedly, and
 *     a scan that could not tell the two apart would be unusable and get
 *     deleted.
 *  2. "Goal text alone never creates a Habit." Asserted as an import closure:
 *     nothing under lib/habits can reach the extractor, a model client, or the
 *     memory module, and no function here takes free text.
 *  3. This lane does not call the scheduler. #520 says the adapter owns the
 *     translation from an occurrence to a PlanningItem, and an import from
 *     here into `lib/planning/scheduler` would be that boundary quietly
 *     dissolving at merge time.
 *
 * A fourth check pins zone-independence at the source level: the civil-date
 * arithmetic may use `Date.UTC` and `getUTC*` and nothing else, which is the
 * property the DST tests depend on and cannot themselves demonstrate in a
 * single process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHabitDefinition, parseHabitDefinitionInput } from '../../src/contracts/v1/habitContracts.ts';
import { materializeHabitOccurrences } from '../../lib/habits/materialize.ts';
import { MARCH_MONDAY, NOW, habitInput } from './habitSupport.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const habitsDir = join(repoRoot, 'lib', 'habits');
const contractPath = join(repoRoot, 'src', 'contracts', 'v1', 'habitContracts.ts');

function domainFiles(): string[] {
  return [
    ...readdirSync(habitsDir).filter((entry) => entry.endsWith('.ts')).sort()
      .map((entry) => join(habitsDir, entry)),
    contractPath,
  ];
}

/** The source with every comment removed, so prose about a rule is not the rule. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the domain carries no streak, penalty or score of any kind', () => {
  // Every word a shaming feature would need a field for. `skip` is absent
  // deliberately: a skipped date is a fact, and the contract's own state.
  const FORBIDDEN = /\b(streak|penalt|guilt|shame|shaming|willpower|discipline|consecutive|chain|adherence|compliance|backslid)\w*/i;
  for (const path of domainFiles()) {
    const code = codeOnly(path);
    const match = FORBIDDEN.exec(code);
    assert.equal(
      match,
      null,
      `${path.replace(repoRoot, '.')} names "${match?.[0]}" outside a comment — #520 forbids streak and penalty behaviour`,
    );
  }
});

test('the two canonical shapes hold exactly the fields #520 named', () => {
  const definition = buildHabitDefinition('habit-1', parseHabitDefinitionInput(habitInput()), NOW);
  assert.deepEqual(Object.keys(definition).sort(), [
    'cadence',
    'confirmation',
    'createdAt',
    'durationMinutes',
    'flexibility',
    'habitId',
    'maximumOccurrences',
    'minimumOccurrences',
    'preferredWindows',
    'recoveryPolicy',
    'schemaVersion',
    'scopeId',
    'source',
    'status',
    'title',
    'updatedAt',
  ]);

  const [occurrence] = materializeHabitOccurrences(definition, {
    fromLocalDate: MARCH_MONDAY,
    toLocalDate: '2026-03-08',
  }).occurrences;
  assert.deepEqual(Object.keys(occurrence).sort(), [
    'durationMinutes',
    'habitId',
    'localDate',
    'occurrenceId',
    'ordinal',
    'recoveredFromOccurrenceId',
    'state',
  ]);
});

test('nothing under lib/habits can reach a model, the extractor or the memory module', () => {
  const FORBIDDEN_IMPORTS = [
    'lib/llm',
    '../llm',
    'lib/memory',
    '../memory',
    'src/extraction',
    '../../src/extraction',
    '@google/genai',
    'lib/services/mobile',
    '../services',
  ];
  for (const path of domainFiles()) {
    for (const specifier of importSpecifiers(readFileSync(path, 'utf8'))) {
      for (const forbidden of FORBIDDEN_IMPORTS) {
        assert.ok(
          !specifier.includes(forbidden),
          `${path.replace(repoRoot, '.')} imports ${specifier}: a habit must not be reachable from text`,
        );
      }
    }
  }
});

test('the domain never calls the scheduler — the adapter owns that translation', () => {
  for (const path of domainFiles()) {
    const source = readFileSync(path, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      assert.ok(
        !specifier.includes('planning/scheduler'),
        `${path.replace(repoRoot, '.')} imports ${specifier}`,
      );
    }
    assert.ok(!codeOnly(path).includes('schedulePlan'), `${path.replace(repoRoot, '.')} names schedulePlan`);
  }
});

test('no exported function takes free text and returns something storable', () => {
  // The convenience helper somebody will want to add. Reading for the shape
  // rather than the name: a parameter called `text`, `sentence`, `utterance`
  // or `goalText` anywhere in this directory is that helper arriving.
  for (const path of domainFiles()) {
    const match = /\b(?:text|sentence|utterance|goalText|transcript|rawInput)\s*:\s*string/i
      .exec(codeOnly(path));
    assert.equal(
      match,
      null,
      `${path.replace(repoRoot, '.')} takes free text (${match?.[0]}) — a Habit is created from a confirmation, never a sentence`,
    );
  }
});

test('civil-date arithmetic touches no local-time API', () => {
  const code = codeOnly(join(habitsDir, 'civilDate.ts'));
  // Both halves matter. The forbidden list is what a zone-dependent rewrite
  // would reach for; the required list is what the current implementation uses,
  // so a rewrite that dropped `Date.UTC` for something clever fails here too.
  for (const forbidden of [
    'getFullYear()', 'getMonth()', 'getDate()', 'getDay()', 'getHours()',
    'Date.now', 'Intl.', 'toLocaleDateString', 'setDate(',
  ]) {
    assert.ok(!code.includes(forbidden), `civilDate.ts uses ${forbidden}, which reads the process timezone`);
  }
  for (const required of ['Date.UTC(', 'getUTCFullYear()', 'getUTCMonth()', 'getUTCDate()']) {
    assert.ok(code.includes(required), `civilDate.ts no longer uses ${required}`);
  }
  // And nothing in the domain reads an ambient clock, for the reason the
  // planner does not: it would make the output different on every run.
  for (const path of domainFiles()) {
    assert.ok(!codeOnly(path).includes('Date.now'), `${path.replace(repoRoot, '.')} reads the clock`);
  }
});

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
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
