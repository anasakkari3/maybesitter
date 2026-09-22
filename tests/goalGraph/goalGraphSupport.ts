/**
 * Fixtures for the #526 goal execution graph tests.
 *
 * The goal is a real `RuntimeMemoryRecord` written through the real memory
 * store, not a hand-built object: the thing under test is "a goal that is
 * already stored changes nothing", and a fixture that never reached storage
 * could not be said to be stored.
 */
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/index.ts';
import type {
  MemoryLanguage,
  RuntimeMemoryRecord,
} from '../../src/contracts/v1/memoryContracts.ts';
import type {
  DecompositionModelDraft,
  DecompositionModelProvider,
} from '../../lib/decomposition/engine/modelProvider.ts';
import type { DecompositionStepProposal } from '../../src/contracts/v1/decompositionContracts.ts';
import { readRuntimeControls } from '../../src/contracts/v1/runtimeControls.ts';

export const NOW = '2026-09-22T09:00:00.000Z';
export const LATER = '2026-09-23T09:00:00.000Z';
export const OWNER = 'goalGraphOwner';
export const STRANGER = 'goalGraphStranger';

/**
 * A sentence the deterministic rules detector actually splits, so the default
 * fixture exercises the real engine rather than a stub. Verified against
 * `detectSteps`: two steps, the second temporally after the first.
 */
export const SPLITTABLE_GOAL =
  'Launch the side project: build the landing page, then set up payments, then announce it';

export interface SeededGoal {
  readonly storage: StorageAdapter;
  readonly goal: RuntimeMemoryRecord;
}

export async function seedGoal(
  content = SPLITTABLE_GOAL,
  options: { scopeId?: string; language?: MemoryLanguage; storage?: StorageAdapter } = {},
): Promise<SeededGoal> {
  const storage = options.storage ?? createMemoryStorage();
  const store = createStorageRuntimeMemoryStore(undefined, storage);
  const goal = await store.put({
    scopeId: options.scopeId ?? OWNER,
    kind: 'goal',
    content,
    language: options.language ?? 'en',
    source: 'user_stated',
    confidence: 1,
    observedAt: NOW,
    provenance: { origin: 'manual', confirmedByUserAt: NOW },
  }, NOW);
  return { storage, goal };
}

/** A span over `sourceText`, built from the text so it always round-trips. */
export function spanOf(sourceText: string, fragment: string) {
  const start = sourceText.indexOf(fragment);
  if (start < 0) throw new Error(`fixture bug: "${fragment}" is not in the source text`);
  return { start, end: start + fragment.length, text: fragment };
}

export function step(
  sourceText: string,
  stepId: string,
  fragment: string,
  overrides: Partial<DecompositionStepProposal> = {},
): DecompositionStepProposal {
  return {
    stepId,
    title: fragment,
    sourceSpans: [spanOf(sourceText, fragment)],
    inferred: false,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
    ...overrides,
  };
}

/**
 * Decomposition is feature-flagged off by default, so a test that injects a
 * provider and does not pass these controls exercises the rules detector and
 * silently proves nothing about its own fixture.
 */
export const MODEL_ENABLED = readRuntimeControls({ MAYBESITTER_FEATURE_DECOMPOSITION: 'true' });

/** A provider that returns exactly what a test hands it. Never a real model. */
export function stubProvider(draft: DecompositionModelDraft): DecompositionModelProvider {
  return { propose: async () => draft };
}
