import React from 'react';
import { Pressable } from 'react-native';
import { render } from '@testing-library/react-native';
import { IntelligencePanel } from '../../features/goals/IntelligencePanel';
import { ProactiveInboxBanner } from '../../features/goals/ProactiveInboxBanner';
import { usePatchMemory } from '../../api/queries';
import {
  NOW,
  Providers,
  ZONE,
  initialState,
  memoryItem,
  prepare,
  teardown,
  type M5bHarness,
  type RecordedRequest,
  type RouteHandler,
  type RouteReply,
} from '../m5b2a/harness';

export { NOW, Providers, ZONE, initialState, prepare, teardown };
export type { M5bHarness, RecordedRequest, RouteHandler, RouteReply };

export const MEMORY_A = 'basis-memory-a';
export const MEMORY_B = 'basis-memory-b';
export const MEMORY_C = 'basis-memory-c';
export const MEMORY_D = 'basis-memory-d';
export const SUGGESTION_ID = 'basis-suggestion';

export type BasisMode = 'on_basis' | 'on_nobasis';

export function memory(id: string, content = `Memory ${id}`) {
  return { ...memoryItem(id), content };
}

export function suggestion(
  id = SUGGESTION_ID,
  options: {
    kind?: 'goal' | 'action' | 'question' | 'warning';
    status?: 'pending' | 'accepting' | 'accepted' | 'dismissed';
    memoryIds?: string[];
    title?: string;
  } = {},
) {
  return {
    id,
    kind: options.kind ?? 'action',
    title: options.title ?? `Suggestion ${id}`,
    reason: `Reason ${id}`,
    observationIds: [],
    confidence: 0.8,
    durationMinutes: options.kind === 'question' ? null : 30,
    status: options.status ?? 'pending',
    decidedAt: null,
    linkedEntityId: null,
    generatedAt: '2030-03-29T08:30:00.000Z',
    ...(options.memoryIds === undefined
      ? {}
      : { memoryBasis: options.memoryIds.map(memoryId => ({ memoryId })) }),
  };
}

export function schedule(suggestionId = SUGGESTION_ID) {
  return {
    suggestionId,
    slot: {
      startsAt: '2030-03-29T11:00:00.000Z',
      endsAt: '2030-03-29T11:30:00.000Z',
    },
    reason: null,
  };
}

export function inbox(
  suggestions: Record<string, unknown>[],
  options: {
    basisMode?: BasisMode;
    schedule?: Record<string, unknown>[];
    observations?: Record<string, unknown>[];
  } = {},
) {
  return {
    success: true,
    observations: options.observations ?? [],
    suggestions,
    schedule: options.schedule ?? [],
    ...(options.basisMode === undefined ? {} : { basisMode: options.basisMode }),
  };
}

export function generated(
  suggestions: Record<string, unknown>[],
  options: { basisMode?: BasisMode; schedule?: Record<string, unknown>[] } = {},
) {
  return {
    success: true,
    suggestions,
    schedule: options.schedule ?? [],
    ...(options.basisMode === undefined ? {} : { basisMode: options.basisMode }),
  };
}

export async function showPanel(harness: M5bHarness, children?: React.ReactNode) {
  return render(
    <Providers harness={harness}>
      <IntelligencePanel onChanged={() => undefined} />
      {children}
    </Providers>,
  );
}

export async function showBanner(harness: M5bHarness) {
  return render(
    <Providers harness={harness}>
      <ProactiveInboxBanner />
    </Providers>,
  );
}

/** Drives the shipping memory mutation hook; no product state is forged. */
export function MemoryCorrectionDriver({ id = MEMORY_A }: { id?: string }) {
  const patch = usePatchMemory();
  return (
    <Pressable
      testID="gate-correct-memory"
      onPress={() => patch.mutate({ id, content: `Corrected ${id}` })}
    />
  );
}

export function noRetries(harness: M5bHarness): void {
  harness.client.setDefaultOptions({
    queries: { retry: false },
    mutations: { retry: false },
  });
}
