/**
 * The goal routes with a model behind them, end to end (CL3).
 *
 *   POST /api/mobile/goals/{goalId}/execution/generate
 *   POST /api/mobile/goals/{goalId}/execution/confirm
 *   GET  /api/mobile/goals/{goalId}/execution
 *   POST /api/mobile/goals/{goalId}/execution/regenerate
 *
 * Everything runs except the network. `@google/genai` — the last hop, which
 * `geminiProvider.ts` reaches by `await import()` — is replaced by a stub that
 * answers with what Gemini really returned for the UAT goal (recorded by
 * `scripts/verify-goal-steps-live.ts`). The route, the auth, the consent gate,
 * the cost guard, the provider's own response handling, the validator, the
 * proposal store and the canonical commitment and habit writers are all real,
 * and `gemini` is chosen by the environment, not by this file.
 *
 * The first test is the literal repro and needs no model at all: on the base
 * this lane started from, the UAT goal generated a lone checkpoint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { COMMITMENTS, GOAL_GRAPH_PROPOSALS, userCol } from '../../lib/storage/paths.ts';
import { setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { resetProviderForTests } from '../../src/extraction/llm/index.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as executionGet } from '../../src/app/api/mobile/goals/[goalId]/execution/route.ts';
import { POST as generatePost } from '../../src/app/api/mobile/goals/[goalId]/execution/generate/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/goals/[goalId]/execution/confirm/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/goals/[goalId]/execution/regenerate/route.ts';
import { RECORDED_GOAL_STEPS_G1, RECORDED_GOAL_STEPS_G2, UAT_GOAL, seedGoal } from './goalGraphSupport.ts';

const baseUrl = 'http://127.0.0.1:4321';
const USER = uidFor('GoalModelRouteUser');

const GENAI_STUB_URL = 'maybesitter-goal-steps:google-genai';
const GENAI_STUB_SOURCE = `
export class GoogleGenAI {
  constructor(options) { this.options = options; }
  get models() {
    return { generateContent: async (input) => globalThis.__goalStepsVertexGenerate(input) };
  }
}
`;
type VertexInput = { model: string; contents: unknown; config: Record<string, unknown> };
type Globals = typeof globalThis & { __goalStepsVertexGenerate?: (input: VertexInput) => Promise<unknown> };

interface Harness {
  readonly goalId: string;
  readonly calls: VertexInput[];
  readonly teardown: () => void;
}

async function setup(consent: 'granted' | 'declined' | null, answers: readonly string[] = []): Promise<Harness> {
  setStorageForTests(createMemoryStorage());
  const auth: FakeAuthControls = installFakeAuth();
  const { goal } = await seedGoal(UAT_GOAL, { scopeId: USER, language: 'ar', storage: getStorage() });
  if (consent) await setAiConsent(USER, { state: consent, version: AI_CONSENT_VERSION });

  const calls: VertexInput[] = [];
  (globalThis as Globals).__goalStepsVertexGenerate = async (input) => {
    calls.push(input);
    return {
      text: answers[Math.min(calls.length - 1, answers.length - 1)],
      modelVersion: 'gemini-2.5-flash',
      usageMetadata: { promptTokenCount: 388, candidatesTokenCount: 132 },
    };
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@google/genai') return { url: GENAI_STUB_URL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === GENAI_STUB_URL) return { format: 'module', source: GENAI_STUB_SOURCE, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  const previous = {
    provider: process.env.MAYBESITTER_LLM_PROVIDER,
    location: process.env.MAYBESITTER_VERTEX_LOCATION,
  };
  if (consent !== null) {
    process.env.MAYBESITTER_LLM_PROVIDER = 'gemini';
    process.env.MAYBESITTER_VERTEX_LOCATION = 'europe-west1';
  }
  resetProviderForTests();
  return {
    goalId: goal.id,
    calls,
    teardown: () => {
      hooks.deregister();
      delete (globalThis as Globals).__goalStepsVertexGenerate;
      if (previous.provider === undefined) delete process.env.MAYBESITTER_LLM_PROVIDER;
      else process.env.MAYBESITTER_LLM_PROVIDER = previous.provider;
      if (previous.location === undefined) delete process.env.MAYBESITTER_VERTEX_LOCATION;
      else process.env.MAYBESITTER_VERTEX_LOCATION = previous.location;
      resetProviderForTests();
      auth.restore();
      resetStorageForTests();
    },
  };
}

function req(path: string, body?: unknown, method = 'POST'): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(USER)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const context = (goalId: string) => ({ params: Promise.resolve({ goalId }) });

type Node = { nodeId: string; kind: string; title?: string; suggestedAs?: string; suggestedWhen?: string };

async function body(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function proposals(graph: { nodes: Node[] }): Node[] {
  return graph.nodes.filter((node) => node.kind === 'decomposition_step_proposal');
}

test('the UAT goal, generated with no model configured, offers steps rather than an empty proposal', async (t) => {
  const { goalId, calls, teardown } = await setup(null);
  t.after(teardown);

  const response = await generatePost(req(`/api/mobile/goals/${goalId}/execution/generate`, {}), context(goalId));
  assert.equal(response.status, 200);
  const { graph } = await body(response);
  const steps = proposals(graph);
  assert.ok(steps.length >= 2, `the goal generated ${graph.nodes.map((node: Node) => node.kind).join(',')}`);
  assert.match(steps[0].title ?? '', /أطلق تطبيقي على المتجر/);
  assert.equal(calls.length, 0);
});

test('with AI consent: generate → confirm (commitment + habit) → progress → regenerate, on the recorded Gemini answer', async (t) => {
  const { goalId, calls, teardown } = await setup('granted', [RECORDED_GOAL_STEPS_G1, RECORDED_GOAL_STEPS_G2]);
  t.after(teardown);

  const generated = await body(await generatePost(req(`/api/mobile/goals/${goalId}/execution/generate`, {}), context(goalId)));
  assert.equal(calls.length, 1, 'the goal never reached the model');
  assert.equal(generated.graph.provenance.stepSource, 'model');
  const steps = proposals(generated.graph);
  assert.deepEqual(steps.map((node) => node.title), [
    'حدد ميزات التطبيق الأساسية',
    'صمم واجهة المستخدم الأولية',
    'اكتب الكود الأساسي للتطبيق',
    'اختبر وظائف التطبيق الرئيسية',
    'جهز وصف التطبيق والصور',
  ]);
  assert.equal(steps[0].suggestedAs, 'commitment');
  assert.equal(steps[0].suggestedWhen, 'today');
  // The goal went to the model as content, never as instruction.
  const systemInstruction = String((calls[0].config as { systemInstruction?: unknown }).systemInstruction ?? '');
  assert.equal(systemInstruction.includes(UAT_GOAL), false);
  assert.ok(JSON.stringify(calls[0].contents).includes(UAT_GOAL));
  assert.equal((await getStorage().list(userCol(USER, GOAL_GRAPH_PROPOSALS))).length, 1);
  assert.deepEqual(await getStorage().list(userCol(USER, COMMITMENTS)), [], 'generate wrote a commitment');

  const confirmResponse = await confirmPost(req(`/api/mobile/goals/${goalId}/execution/confirm`, {
    generation: 1,
    selections: [
      { nodeId: steps[0].nodeId, as: 'commitment' },
      {
        nodeId: steps[1].nodeId,
        as: 'habit',
        habit: {
          cadence: { kind: 'weekly_count', count: 3 },
          durationMinutes: 30,
          preferredWindows: [],
          minimumOccurrences: 3,
          maximumOccurrences: 3,
          flexibility: 'flexible',
          recoveryPolicy: 'skip',
        },
      },
    ],
  }), context(goalId));
  assert.equal(confirmResponse.status, 200);
  const confirmed = await body(confirmResponse);
  assert.deepEqual(confirmed.refused, [], 'confirm could not find the steps the user reviewed');
  assert.equal(confirmed.created.length, 2);
  assert.equal(calls.length, 1, 'confirm asked the model again');
  const commitmentId = confirmed.created.find((link: { entityKind: string }) => link.entityKind === 'commitment').entityId;
  const state = await getParticipantStateSnapshot(USER);
  assert.equal(state.commitments[commitmentId]?.title, 'حدد ميزات التطبيق الأساسية');
  assert.equal(state.commitments[commitmentId]?.status, 'active');

  const execution = await body(await executionGet(
    req(`/api/mobile/goals/${goalId}/execution?generation=1&fromLocalDate=2026-09-21&toLocalDate=2026-09-27`, undefined, 'GET'),
    context(goalId),
  ));
  assert.equal(execution.progress.confirmedCount, 2);
  assert.deepEqual(
    execution.graph.nodes.filter((node: Node) => node.kind.startsWith('linked_')).map((node: Node) => node.kind).sort(),
    ['linked_commitment', 'linked_habit'],
  );
  assert.equal(calls.length, 1, 'the execution read asked the model');

  const regenerated = await body(await regeneratePost(
    req(`/api/mobile/goals/${goalId}/execution/regenerate`, { fromGeneration: 1 }),
    context(goalId),
  ));
  assert.equal(calls.length, 2);
  assert.equal(regenerated.graph.generation, 2);
  assert.equal(proposals(regenerated.graph)[0].title, 'راجع متطلبات المتجر الفنية');
  assert.equal(
    regenerated.graph.nodes.filter((node: Node) => node.kind.startsWith('linked_')).length,
    2,
    'regenerate lost the work the user already confirmed',
  );
});

test('without AI consent the goal never reaches the model, and the steps are the template', async (t) => {
  const { goalId, calls, teardown } = await setup('declined', [RECORDED_GOAL_STEPS_G1]);
  t.after(teardown);

  const { graph } = await body(await generatePost(req(`/api/mobile/goals/${goalId}/execution/generate`, {}), context(goalId)));
  assert.equal(calls.length, 0, 'a declined account had its goal sent to a model');
  assert.equal(graph.provenance.stepSource, 'template');
  assert.equal(graph.provenance.stepSourceReason, 'consent_required');
  assert.ok(proposals(graph).length >= 2);
});
