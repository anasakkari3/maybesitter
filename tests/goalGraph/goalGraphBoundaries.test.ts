/**
 * Structural guards on the goal execution graph, read from the source (#526).
 *
 * Four claims here are not behavioural, and each would fail in production
 * rather than in a suite:
 *
 *  1. Generation has no writer in reach. The isolation test proves it does not
 *     write *today*; this proves it could not, by walking the import closure
 *     of `lib/goalGraph/**` and refusing anything that can persist canonical
 *     state. The convenience call that breaks the criterion is a one-line
 *     import, and it would be added in good faith.
 *  2. A graph node never reaches `schedulePlan`. #526 says so in as many
 *     words; only materialized Commitments and Habit occurrences become
 *     planning demand.
 *  3. No node carries a date field. "No invented deadlines" is easiest to keep
 *     by having nowhere to put one, so the field lists of every node kind are
 *     pinned and the source is scanned for the names a deadline would arrive
 *     under.
 *  4. Linked nodes carry an id and nothing else, which is #526's "do not
 *     duplicate canonical Commitment/Habit state inside graph nodes". The
 *     natural next commit is a denormalised `title` for the list screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOAL_GRAPH_GENERATION_POLICY,
  type GoalNode,
} from '../../src/contracts/v1/goalGraphContracts.ts';
import { generateGoalExecutionGraph } from '../../lib/goalGraph/generateGoalGraph.ts';
import { NOW, seedGoal } from './goalGraphSupport.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const graphDir = join(repoRoot, 'lib', 'goalGraph');
const contractPath = join(repoRoot, 'src', 'contracts', 'v1', 'goalGraphContracts.ts');

function ownFiles(): string[] {
  return [
    ...readdirSync(graphDir).filter((entry) => entry.endsWith('.ts')).sort()
      .map((entry) => join(graphDir, entry)),
    contractPath,
  ];
}

/** Source with comments stripped, so prose about a rule is not the rule. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ]) {
    let match = pattern.exec(source);
    while (match !== null) {
      found.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return found;
}

/**
 * Every local module `lib/goalGraph/**` can reach, directly or otherwise.
 *
 * A closure rather than a direct-import check, following
 * `tests/feedback/feedbackBoundaries.test.ts`: the writer reached through one
 * innocent-looking intermediate is exactly what a direct check misses.
 */
function importClosure(): string[] {
  const seen = new Set<string>();
  const queue = ownFiles();
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of importSpecifiers(readFileSync(path, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(path), specifier).replace(/\.ts$/, '');
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        try {
          readFileSync(candidate, 'utf8');
          queue.push(candidate);
          break;
        } catch {
          // Not this shape; try the next.
        }
      }
    }
  }
  return Array.from(seen).sort();
}

test('nothing generation can reach is able to write canonical state', () => {
  /** Modules that persist a commitment, a habit, a plan or a reminder. */
  const FORBIDDEN = [
    'services/commandService',
    'services/mobile/participantState',
    'deterministicStateGateway',
    'habits/habitStore',
    'services/mobile/seedService',
    'services/planService',
    'services/reminders',
    'planning/scheduler',
    'domain/stateMachine',
  ];
  const closure = importClosure();
  // The walk must actually have walked, or an empty closure passes everything.
  assert.ok(closure.length >= ownFiles().length + 3, `closure looks truncated:\n${closure.join('\n')}`);
  for (const path of closure) {
    for (const forbidden of FORBIDDEN) {
      assert.ok(
        !path.includes(forbidden),
        `lib/goalGraph reaches ${path.replace(repoRoot, '.')} via ${forbidden}`,
      );
    }
  }
});

test('a graph node never reaches the planner', () => {
  for (const path of ownFiles()) {
    const code = codeOnly(path);
    assert.ok(!code.includes('schedulePlan'), `${path.replace(repoRoot, '.')} names schedulePlan`);
    for (const specifier of importSpecifiers(readFileSync(path, 'utf8'))) {
      assert.ok(
        !specifier.includes('planning/scheduler'),
        `${path.replace(repoRoot, '.')} imports ${specifier}`,
      );
    }
  }
  assert.equal(GOAL_GRAPH_GENERATION_POLICY.reachesScheduler, false);
});

test('no node kind has anywhere to put a date', () => {
  // The names a deadline would plausibly arrive under. `statedTiming` and
  // `generatedAt` are the two time-shaped fields this contract has, and both
  // are exempt by name rather than by pattern so that adding a third has to be
  // a deliberate edit to this list.
  const FORBIDDEN = /\b(dueAt|deadlineAt|dueDate|deadline|startAt|startsAt|endsAt|scheduledFor|remindAt|targetDate|completeBy)\b/;
  for (const path of ownFiles()) {
    const match = FORBIDDEN.exec(codeOnly(path));
    assert.equal(match, null, `${path.replace(repoRoot, '.')} names "${match?.[0]}" — #526 forbids invented deadlines`);
  }
  // And nothing reads a clock: generatedAt is the caller's instant.
  for (const path of ownFiles()) {
    const code = codeOnly(path);
    assert.ok(!code.includes('Date.now'), `${path.replace(repoRoot, '.')} reads the clock`);
    assert.ok(!code.includes('new Date('), `${path.replace(repoRoot, '.')} builds a date`);
  }
  assert.equal(GOAL_GRAPH_GENERATION_POLICY.resolvesTiming, false);
});

test('a linked node carries a reference and nothing else', () => {
  const commitment: GoalNode = {
    nodeId: 'n1', kind: 'linked_commitment', status: 'confirmed', commitmentId: 'commitment-1',
  };
  const habit: GoalNode = {
    nodeId: 'n2', kind: 'linked_habit', status: 'confirmed', habitId: 'habit-1',
  };
  assert.deepEqual(Object.keys(commitment).sort(), ['commitmentId', 'kind', 'nodeId', 'status']);
  assert.deepEqual(Object.keys(habit).sort(), ['habitId', 'kind', 'nodeId', 'status']);
});

test('the node shapes generation produces are exactly these fields', async () => {
  const { goal } = await seedGoal();
  const { graph } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });

  const checkpoint = graph.nodes.find((node) => node.kind === 'checkpoint');
  assert.deepEqual(Object.keys(checkpoint ?? {}).sort(), ['kind', 'nodeId', 'statedTiming', 'status', 'title']);

  const stepNode = graph.nodes.find((node) => node.kind === 'decomposition_step_proposal');
  assert.deepEqual(Object.keys(stepNode ?? {}).sort(), [
    'inferred',
    'kind',
    'nodeId',
    'sourceSpans',
    'statedOwner',
    'statedTiming',
    'status',
    'stepId',
    'title',
  ]);

  assert.deepEqual(Object.keys(graph).sort(), [
    'edges',
    'generatedAt',
    'generation',
    'goalMemoryId',
    'graphId',
    'language',
    'nodes',
    'provenance',
    'schema',
    'scopeId',
    'version',
  ]);
});

test('the generation policy says what this slice does, as data', () => {
  assert.deepEqual({ ...GOAL_GRAPH_GENERATION_POLICY }, {
    readonly: true,
    writesCanonicalState: false,
    persists: false,
    resolvesTiming: false,
    reachesScheduler: false,
  });
});
