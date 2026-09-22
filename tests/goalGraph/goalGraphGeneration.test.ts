/**
 * What generation produces, and what it refuses to produce (#526, slice 1).
 *
 * The two claims with teeth here are determinism and "no invented deadlines".
 *
 * Determinism is not decoration: #526 puts deterministic validation between
 * generation and the user, and regeneration has to be diffable against the
 * graph somebody is already looking at. A uuid or a clock anywhere in the id
 * derivation would pass every shape assertion below and make both impossible,
 * so the ids are compared across runs rather than merely checked for presence.
 *
 * "No invented deadlines" is tested in the two directions it can fail. A
 * timing the goal text really contains must survive verbatim — the failure
 * there is silent truncation, or worse, resolution to a date. A timing the
 * text does not contain must stop the proposal, which it does through the
 * decomposition engine's own `INVENTED_TIMING`, because that is the rule this
 * module calls rather than one of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_GRAPH_SCHEMA_VERSION,
  type DecompositionStepNode,
} from '../../src/contracts/v1/goalGraphContracts.ts';
import {
  GoalGraphGenerationError,
  generateGoalExecutionGraph,
} from '../../lib/goalGraph/generateGoalGraph.ts';
import {
  LATER,
  NOW,
  OWNER,
  MODEL_ENABLED,
  seedGoal,
  step,
  stubProvider,
} from './goalGraphSupport.ts';

test('a goal becomes its own steps plus one checkpoint, and nothing else', async () => {
  const { goal } = await seedGoal();
  const { graph, violations } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });

  assert.deepEqual(violations, []);
  assert.equal(graph.schema, GOAL_GRAPH_SCHEMA_VERSION);
  assert.equal(graph.goalMemoryId, goal.id);
  assert.equal(graph.scopeId, OWNER);
  assert.equal(graph.generation, 1);
  assert.equal(graph.generatedAt, NOW);
  assert.equal(graph.language, 'en');

  const kinds = graph.nodes.map((node) => node.kind);
  assert.deepEqual(kinds.filter((kind) => kind === 'checkpoint').length, 1);
  assert.deepEqual(kinds.filter((kind) => kind === 'decomposition_step_proposal').length, 2);
  // No milestone. Nothing in this slice is entitled to invent a stage, and a
  // milestone appearing here is that happening.
  assert.deepEqual(kinds.filter((kind) => kind === 'milestone_proposal'), []);

  // Every step contributes to the checkpoint, and the engine's own ordering
  // edge survives with its kind intact.
  const checkpoint = graph.nodes.find((node) => node.kind === 'checkpoint');
  assert.equal(
    graph.edges.filter((edge) => edge.kind === 'contributes_to' && edge.toNodeId === checkpoint?.nodeId).length,
    2,
  );
  const ordering = graph.edges.filter((edge) => edge.kind === 'depends_on');
  assert.equal(ordering.length, 1);
  assert.equal(ordering[0].kind === 'depends_on' && ordering[0].dependencyKind, 'temporal');
});

test('the step nodes are the engine’s steps, copied rather than re-read', async () => {
  const { goal } = await seedGoal();
  const { graph } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });
  const steps = graph.nodes.filter(
    (node): node is DecompositionStepNode => node.kind === 'decomposition_step_proposal');

  for (const node of steps) {
    // The span still selects exactly the title, which is the engine's own
    // invariant — a graph that re-derived spans would be the first thing to
    // break it, and it would break silently.
    const merged = node.sourceSpans.map((span) => goal.content.slice(span.start, span.end)).join(' ');
    assert.equal(merged, node.title, `${node.nodeId} carries a span that no longer selects its title`);
    assert.equal(node.inferred, false);
  }
  assert.deepEqual(steps.map((node) => node.stepId), ['s1', 's2']);
});

test('two runs of the same goal produce the same graph, ids and all', async () => {
  const { goal } = await seedGoal();
  const first = await generateGoalExecutionGraph({ goal, generatedAt: NOW });
  const second = await generateGoalExecutionGraph({ goal, generatedAt: NOW });

  assert.deepEqual(second.graph, first.graph);
  // And a later clock changes only the instant the caller handed in — not one
  // id, not one edge. A uuid or a `Date.now()` in the derivation fails here.
  const third = await generateGoalExecutionGraph({ goal, generatedAt: LATER });
  assert.deepEqual({ ...third.graph, generatedAt: NOW }, first.graph);
});

test('a different generation is a different graph, deterministically', async () => {
  const { goal } = await seedGoal();
  const first = await generateGoalExecutionGraph({ goal, generatedAt: NOW });
  const second = await generateGoalExecutionGraph({ goal, generatedAt: NOW, generation: 2 });
  const secondAgain = await generateGoalExecutionGraph({ goal, generatedAt: NOW, generation: 2 });

  assert.notEqual(second.graph.graphId, first.graph.graphId);
  assert.deepEqual(secondAgain.graph, second.graph);
  assert.ok(second.graph.nodes.every((node) => node.nodeId.startsWith('g2.')));
});

test('a stated timing the goal really contains survives verbatim and unresolved', async () => {
  const text = 'Finish the thesis: draft the chapter by December, then submit it';
  const { goal } = await seedGoal(text);
  const { graph, violations } = await generateGoalExecutionGraph({
    goal,
    generatedAt: NOW,
  }, {
    controls: MODEL_ENABLED,
    modelProvider: stubProvider({
      confidence: 1,
      steps: [
        step(text, 's1', 'draft the chapter by December', { statedTiming: 'by December' }),
        step(text, 's2', 'submit it', { dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' }] }),
      ],
    }),
  });

  assert.deepEqual(violations, []);
  const drafted = graph.nodes.find(
    (node): node is DecompositionStepNode => node.kind === 'decomposition_step_proposal' && node.stepId === 's1');
  assert.equal(drafted?.statedTiming, 'by December');
  // Verbatim means verbatim: the words, not a date derived from them.
  assert.ok(text.includes(drafted?.statedTiming ?? ''));
  assert.equal(JSON.stringify(graph).includes('2026-12'), false, 'a month was resolved into a date');
});

/**
 * The other direction of "no invented deadlines", and the one that matters.
 *
 * A provider helpfully adds "by 15 December" to a goal that says no such
 * thing. The assertion is deliberately about the *graph* rather than about
 * which branch the engine took: whatever happens next — the model output is
 * refused, the rules detector produces a different and valid split, the goal
 * comes back atomic — no node may carry a timing the goal text does not
 * contain. Asserting the branch instead would make this test pass for a build
 * where the fallback happened to be disabled.
 */
test('a stated timing the goal does not contain never reaches the graph', async () => {
  const text = 'Finish the thesis: draft the chapter, then submit it';
  const { goal } = await seedGoal(text);
  const { graph, violations } = await generateGoalExecutionGraph({
    goal,
    generatedAt: NOW,
  }, {
    controls: MODEL_ENABLED,
    modelProvider: stubProvider({
      confidence: 1,
      steps: [
        step(text, 's1', 'draft the chapter', { statedTiming: 'by 15 December' }),
        step(text, 's2', 'submit it'),
      ],
    }),
  });

  assert.deepEqual(violations, [], 'the graph is well formed; the decomposition is what was refused');
  for (const node of graph.nodes) {
    const timing = 'statedTiming' in node ? node.statedTiming : null;
    assert.ok(
      timing === null || text.includes(timing),
      `${node.nodeId} carries a timing the goal never stated: ${String(timing)}`,
    );
  }
  assert.equal(JSON.stringify(graph).includes('15 December'), false);
  // The refusal is recorded rather than swallowed: the engine says it fell
  // back, and why, so an operator can tell this from a rules-only build.
  assert.equal(graph.provenance.decomposition.fallbackUsed, true);
  assert.match(
    graph.provenance.decomposition.fallbackUsed
      ? graph.provenance.decomposition.fallbackReason
      : '',
    /invalid/i,
  );
});

test('a goal the engine cannot split is one checkpoint that says why', async () => {
  const { goal } = await seedGoal('Learn Spanish');
  const { graph, violations } = await generateGoalExecutionGraph({ goal, generatedAt: NOW });

  assert.deepEqual(violations, []);
  assert.deepEqual(graph.nodes.map((node) => node.kind), ['checkpoint']);
  assert.equal(graph.provenance.decompositionOutcome, 'atomic');
  assert.equal(graph.provenance.atomicReason, 'not_decomposable');
  assert.deepEqual(graph.edges, []);
});

test('the graph carries the goal’s own language and its own script', async () => {
  const arabic = 'أجهّز المشروع: أبني الصفحة ثم أضبط الدفع';
  const { goal } = await seedGoal(arabic, { language: 'ar' });
  const { graph, violations } = await generateGoalExecutionGraph({
    goal,
    generatedAt: NOW,
  }, {
    controls: MODEL_ENABLED,
    modelProvider: stubProvider({
      confidence: 1,
      steps: [
        step(arabic, 's1', 'أبني الصفحة'),
        step(arabic, 's2', 'أضبط الدفع', { dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' }] }),
      ],
    }),
  });

  assert.deepEqual(violations, []);
  assert.equal(graph.language, 'ar');
  const titles = graph.nodes
    .filter((node): node is DecompositionStepNode => node.kind === 'decomposition_step_proposal')
    .map((node) => node.title);
  // The point is that nothing reordered or normalised the text on the way
  // through: an RTL title that arrived reversed would still be a string.
  assert.deepEqual(titles, ['أبني الصفحة', 'أضبط الدفع']);
  const checkpoint = graph.nodes.find((node) => node.kind === 'checkpoint');
  assert.equal(checkpoint?.kind === 'checkpoint' && checkpoint.title, arabic);
});

test('a memory that is not a live confirmed goal is refused, not projected', async () => {
  const { goal } = await seedGoal();
  await assert.rejects(
    () => generateGoalExecutionGraph({ goal: { ...goal, kind: 'fact' }, generatedAt: NOW }),
    /is a fact, not a goal/,
  );
  await assert.rejects(
    () => generateGoalExecutionGraph({ goal: { ...goal, status: 'revoked' }, generatedAt: NOW }),
    /is revoked/,
  );
  await assert.rejects(
    () => generateGoalExecutionGraph({ goal: { ...goal, content: '   ' }, generatedAt: NOW }),
    /has no text to read/,
  );
  await assert.rejects(
    () => generateGoalExecutionGraph({ goal, generatedAt: NOW, generation: 0 }),
    GoalGraphGenerationError,
  );
});
