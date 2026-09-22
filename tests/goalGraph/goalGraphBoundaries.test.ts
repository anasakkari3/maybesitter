/**
 * Structural guards on the goal execution graph, read from the source (#526).
 *
 * Four claims here are not behavioural, and each would fail in production
 * rather than in a suite:
 *
 *  1. Generation has no writer in reach. The isolation test proves it does not
 *     write *today*; this proves it could not, by walking the import closure
 *     of the generation modules and refusing anything that can persist
 *     canonical state. The convenience call that breaks the criterion is a
 *     one-line import, and it would be added in good faith.
 *
 *     Slice 2 makes the file list matter. `confirmGoalGraph.ts` *must* be able
 *     to reach the commitment and habit boundaries — that is its whole job —
 *     so the closure below is generation's own, not the directory's. A test
 *     that widened to the directory when confirmation arrived would have had
 *     to drop the check entirely, which is how a guard becomes a comment.
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

/** Everything under lib/goalGraph, plus the contract. */
function ownFiles(): string[] {
  return [
    ...readdirSync(graphDir).filter((entry) => entry.endsWith('.ts')).sort()
      .map((entry) => join(graphDir, entry)),
    contractPath,
  ];
}

/**
 * The read-only half: what `generateGoalExecutionGraph` is built from.
 *
 * Named explicitly rather than derived by excluding the writers, so adding a
 * module to generation is a deliberate edit here and a module that quietly
 * joined the closure cannot slip in by not being on an exclusion list.
 */
function generationFiles(): string[] {
  return [
    join(graphDir, 'generateGoalGraph.ts'),
    join(graphDir, 'ids.ts'),
    join(graphDir, 'validateGoalGraph.ts'),
    contractPath,
  ];
}

/** The half that is allowed to write, and still not allowed to plan. */
function confirmationFiles(): string[] {
  return [
    join(graphDir, 'confirmGoalGraph.ts'),
    join(graphDir, 'deriveProgress.ts'),
    join(graphDir, 'linkStore.ts'),
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
function importClosure(roots: readonly string[] = ownFiles()): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
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
  const closure = importClosure(generationFiles());
  // The walk must actually have walked, or an empty closure passes everything.
  assert.ok(closure.length >= generationFiles().length + 3, `closure looks truncated:\n${closure.join('\n')}`);
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
  for (const path of generationFiles()) {
    const match = FORBIDDEN.exec(codeOnly(path));
    assert.equal(match, null, `${path.replace(repoRoot, '.')} names "${match?.[0]}" — #526 forbids invented deadlines`);
  }
  // Confirmation names the two fields, because the commitment mapper has them
  // — and sets both to null. A node's `statedTiming` is the source's own
  // unresolved words, and copying it into `dueAt` is the one move that would
  // turn "by December" into a date the user is then held to.
  const confirmationCode = codeOnly(join(graphDir, 'confirmGoalGraph.ts'));
  assert.match(confirmationCode, /dueAt:\s*null/);
  assert.match(confirmationCode, /remindAt:\s*null/);
  assert.equal(/statedTiming/.test(confirmationCode), false, 'confirmation reads a stated timing');
  // And nothing reads a clock: every instant is the caller's.
  for (const path of ownFiles()) {
    const code = codeOnly(path);
    assert.ok(!code.includes('Date.now'), `${path.replace(repoRoot, '.')} reads the clock`);
    assert.ok(!code.includes('new Date('), `${path.replace(repoRoot, '.')} builds a date`);
  }
  for (const path of confirmationFiles()) {
    // Nor does the writing half: `confirmedAt` and `derivedAt` are passed in,
    // so two runs of the same request are comparable and a test can pin them.
    assert.ok(!codeOnly(path).includes('Date.now'), `${path.replace(repoRoot, '.')} reads the clock`);
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

test('confirmation may write, but still never reaches the planner', () => {
  const closure = importClosure(confirmationFiles());
  assert.ok(closure.length >= confirmationFiles().length + 3, `closure looks truncated:\n${closure.join('\n')}`);
  for (const path of closure) {
    assert.ok(
      !path.includes('planning/scheduler'),
      `confirmation reaches ${path.replace(repoRoot, '.')}`,
    );
  }
  for (const path of confirmationFiles()) {
    assert.ok(!codeOnly(path).includes('schedulePlan'), `${path.replace(repoRoot, '.')} names schedulePlan`);
  }
});

test('confirmation creates entities through the existing boundaries, and no others', () => {
  const code = codeOnly(join(graphDir, 'confirmGoalGraph.ts'));
  // The two seams this repo already has. Naming them here means a third way to
  // create a commitment — a direct `storage.set` into the collection, a new
  // gateway — is a failing test rather than a review someone has to catch.
  for (const required of ['applyParticipantCommands', 'ConfirmCommitment', 'parseHabitDefinitionInput', 'createHabitWithOccurrences']) {
    assert.ok(code.includes(required), `confirmation no longer goes through ${required}`);
  }
  for (const forbidden of ['commitmentDocPath', 'writeDomainDiff', 'deterministicStateGateway', 'tx.set']) {
    assert.ok(!code.includes(forbidden), `confirmation writes a commitment its own way, via ${forbidden}`);
  }
});

test('unlinking cannot reach the canonical work it names', () => {
  // The #526 criterion is that removing a node does not delete a Commitment or
  // a Habit. `linkStore` is the module that removes links, and the guarantee
  // is that it has no import path to either — not that its delete happens to
  // address one document today.
  const closure = importClosure([join(graphDir, 'linkStore.ts')]);
  for (const path of closure) {
    for (const forbidden of ['participantState', 'habits/habitStore', 'commandService', 'domain/stateMachine']) {
      assert.ok(
        !path.includes(forbidden),
        `linkStore reaches ${path.replace(repoRoot, '.')}, so an unlink could cascade`,
      );
    }
  }
});

test('progress has no field a number could be written into', () => {
  const code = codeOnly(contractPath);
  // #526: "do not let the model set 73% complete". The structural half of that
  // is that there is nowhere to put 73.
  // Word-bounded, because `GOAL_GRAPH_GENERATION_POLICY` contains "ratio" and
  // a substring check would fail on a constant that is not a progress figure.
  for (const forbidden of [/\bpercent/i, /\bratio\b/i, /\bscore\b/i, /\bprogressValue\b/i, /\bcompletion\b/i]) {
    const match = forbidden.exec(code);
    assert.equal(match, null, `the contract names "${match?.[0]}" — progress is counted, never set`);
  }
  // And `deriveProgress` reads only: no store method that writes is in reach.
  const derive = codeOnly(join(graphDir, 'deriveProgress.ts'));
  for (const forbidden of ['.set(', '.create(', 'claim(', 'settle(', 'runTransaction']) {
    assert.equal(derive.includes(forbidden), false, `deriveProgress calls ${forbidden}`);
  }
});
