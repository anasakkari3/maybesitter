/**
 * The goal "generate suggestions" chain against a real model (CL3).
 *
 * Opt-in, and inert without it:
 *
 *   MAYBESITTER_LIVE_GOAL_STEPS=1 MAYBESITTER_LLM_PROVIDER=gemini \
 *     MAYBESITTER_GCP_PROJECT=maybesitter-app MAYBESITTER_VERTEX_LOCATION=europe-west1 \
 *     MAYBESITTER_LLM_MODEL=gemini-2.5-flash \
 *     node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/verify-goal-steps-live.ts ["<goal>"]
 *
 * Runs the real service chain — consent gate, cost guard, Vertex, validator,
 * proposal store, confirm through the canonical commitment and habit
 * boundaries, derived progress, regenerate — over an in-memory store, for one
 * synthetic account that grants AI consent. It prints the goal and the steps,
 * because proving them to a person is what it is for; nothing on the
 * production path prints either. Two model calls per run (generate and
 * regenerate). Without the flag nothing is contacted and the exit code is 0.
 */
import { createMemoryStorage } from '../lib/storage/memoryAdapter.ts';
import { setStorageForTests } from '../lib/storage/index.ts';
import { createStorageRuntimeMemoryStore } from '../lib/runtimeMemory/runtimeMemoryStore.ts';
import { setAiConsent } from '../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../src/contracts/v1/consentContracts.ts';
import { shareLlmProvider } from '../lib/llm/shareProvider.ts';
import { createGoalStepModel } from '../lib/services/mobile/goalStepModel.ts';
import {
  confirmGoalGraphSelections,
  generateGoalGraph,
  readGoalExecutionState,
  regenerateGoalGraph,
} from '../lib/services/mobile/goalGraphService.ts';
import type { DecompositionStepNode, GoalExecutionGraph } from '../src/contracts/v1/goalGraphContracts.ts';

const UAT_GOAL = 'أطلق تطبيقي على المتجر قبل نهاية السنة';
const UID = 'live-goal-steps-user';

function steps(graph: GoalExecutionGraph): DecompositionStepNode[] {
  return graph.nodes.filter((node): node is DecompositionStepNode => node.kind === 'decomposition_step_proposal');
}

function show(label: string, graph: GoalExecutionGraph): void {
  console.log(`\n── ${label}: generation ${graph.generation}, stepSource=${graph.provenance.stepSource}, reason=${graph.provenance.stepSourceReason ?? 'none'}`);
  for (const node of graph.nodes) {
    if (node.kind === 'decomposition_step_proposal') {
      console.log(`  • ${node.title}   [${node.suggestedAs ?? '-'} / ${node.suggestedWhen ?? '-'}]  (${node.nodeId})`);
    } else if (node.kind === 'linked_commitment' || node.kind === 'linked_habit') {
      console.log(`  ✓ ${node.kind} ${node.kind === 'linked_commitment' ? node.commitmentId : node.habitId}  (${node.nodeId})`);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.MAYBESITTER_LIVE_GOAL_STEPS !== '1') {
    console.log('MAYBESITTER_LIVE_GOAL_STEPS is not 1; nothing contacted.');
    return;
  }
  const goalText = process.argv[2] ?? UAT_GOAL;
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  await setAiConsent(UID, { state: 'granted', version: AI_CONSENT_VERSION });
  const goal = await createStorageRuntimeMemoryStore(undefined, storage).put({
    scopeId: UID,
    kind: 'goal',
    content: goalText,
    language: 'ar',
    source: 'user_stated',
    confidence: 1,
    observedAt: new Date().toISOString(),
    provenance: { origin: 'manual', confirmedByUserAt: new Date().toISOString() },
  }, new Date().toISOString());
  console.log(`goal: ${goalText}`);

  // The production generator, wrapped only to print what Vertex returned.
  const gated = shareLlmProvider(UID, { purpose: 'goal_decomposition' });
  const goalStepModel = createGoalStepModel(UID, {
    generate: async (request) => {
      const response = await gated(request);
      console.log(`\n[vertex] model=${response.model} latencyMs=${response.latencyMs} tokens=${response.promptTokens}/${response.outputTokens}`);
      console.log(`[vertex] raw=${response.text}`);
      return response;
    },
  });
  const options = { storage, goalStepModel };

  const first = await generateGoalGraph(UID, goal.id, new Date().toISOString(), options);
  show('generate', first);
  const proposed = steps(first);
  if (proposed.length === 0) throw new Error('no steps were proposed');

  const commitmentNode = proposed.find((node) => node.suggestedAs !== 'habit') ?? proposed[0];
  const habitNode = proposed.find((node) => node.suggestedAs === 'habit' && node !== commitmentNode);
  const confirmed = await confirmGoalGraphSelections(UID, goal.id, new Date().toISOString(), {
    generation: first.generation,
    selections: [
      { nodeId: commitmentNode.nodeId, as: 'commitment' },
      ...(habitNode ? [{
        nodeId: habitNode.nodeId,
        as: 'habit' as const,
        habit: {
          cadence: { kind: 'weekly_count', count: 2 },
          durationMinutes: 30,
          preferredWindows: [],
          minimumOccurrences: 2,
          maximumOccurrences: 2,
          flexibility: 'flexible',
          recoveryPolicy: 'skip',
        },
      }] : []),
    ],
  }, options);
  console.log(`\n── confirm: created=${confirmed.created.length} (${confirmed.created.map((link) => link.entityKind).join(', ')}) replayed=${confirmed.replayed.length} refused=${confirmed.refused.map((item) => item.code).join(',') || 'none'}`);

  const state = await readGoalExecutionState(UID, goal.id, new Date().toISOString(), { ...options, generation: first.generation });
  console.log(`── progress: confirmedCount=${state.progress.confirmedCount} completedCount=${state.progress.completedCount}`);

  const second = await regenerateGoalGraph(UID, goal.id, new Date().toISOString(), first.generation, options);
  show('regenerate', second);
  const linked = second.nodes.filter((node) => node.kind === 'linked_commitment' || node.kind === 'linked_habit');
  console.log(`\n── regenerate kept ${linked.length} confirmed link(s); new proposals: ${steps(second).length}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
