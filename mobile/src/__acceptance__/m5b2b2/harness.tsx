import React from 'react';
import { render } from '@testing-library/react-native';
import { IntelligencePanel } from '../../features/goals/IntelligencePanel';
import {
  NOW,
  Providers,
  ZONE,
  initialState,
  outcome,
  prepare,
  teardown,
  type M5bHarness,
  type RecordedRequest,
  type RouteHandler,
  type RouteReply,
} from '../m5b2a/harness';
import { suggestion } from '../m5b2b1/harness';

export { NOW, Providers, ZONE, initialState, outcome, prepare, suggestion, teardown };
export type { M5bHarness, RecordedRequest, RouteHandler, RouteReply };

export type ReaddAfter = 'dropped' | 'completed';
export type Review = 'pending' | 'confirmed' | 'dismissed';
export type Capability = true | false | 'unknown';

export const readdTestIds = {
  row: (id: string) => `m5b-learned-readd-${id}`,
  guess: (id: string) => `m5b-learned-guess-${id}`,
  right: (id: string) => `m5b-learned-right-${id}`,
  wrong: (id: string) => `m5b-learned-wrong-${id}`,
} as const;

export function readdMarker(
  id: string,
  review: Review = 'pending',
  after: ReaddAfter = 'dropped',
  observedAt = '2030-03-29T08:00:00.000Z',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    kind: 'outcome',
    evidence: 'Re-added',
    confidence: 0.6,
    source: 'behavior',
    sourceRef: `readd:commitment-${id}`,
    observedAt,
    review,
    reviewedAt: review === 'pending' ? null : observedAt,
    linkedMemoryId: null,
    readd: { after, title: `Title ${id}` },
    ...overrides,
  };
}

export function inbox(
  observations: Record<string, unknown>[],
  suggestions: Record<string, unknown>[] = [],
) {
  return {
    success: true,
    observations,
    suggestions,
    schedule: [],
    basisMode: 'on_nobasis',
  };
}

export interface ReaddPanelState {
  observations: Record<string, unknown>[];
  suggestions: Record<string, unknown>[];
  capability: Capability;
  unchangedIds: Set<string>;
  failedIds: Set<string>;
  order: string[];
  onMoved?: ((id: string, review: 'confirmed' | 'dismissed', state: ReaddPanelState) => void) | undefined;
}

export function panelState(options: Partial<ReaddPanelState> = {}): ReaddPanelState {
  return {
    observations: [],
    suggestions: [],
    capability: true,
    unchangedIds: new Set<string>(),
    failedIds: new Set<string>(),
    order: [],
    ...options,
  };
}

/** A real-client handler whose mutable state models the additive 2b-2 wire. */
export function panelHandler(state: ReaddPanelState): RouteHandler {
  return request => {
    if (request.path === '/api/mobile/intelligence' && request.method === 'GET') {
      state.order.push('inbox');
      return { status: 200, body: inbox(state.observations, state.suggestions) };
    }
    if (request.path === '/api/mobile/intelligence/generate' && request.method === 'POST') {
      state.order.push('generate');
      return {
        status: 200,
        body: { success: true, suggestions: state.suggestions, schedule: [], basisMode: 'on_nobasis' },
      };
    }
    if (request.path === '/api/mobile/intelligence/sources/gmail/monitor') {
      return { status: 200, body: { success: true, enabled: false, lastSuccessAt: null, error: null } };
    }
    if (request.path === '/api/mobile/capabilities/m5b') {
      state.order.push('capability');
      if (state.capability === 'unknown') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      return { status: 200, body: { success: true, memoryLearning: state.capability } };
    }

    const match = /^\/api\/mobile\/intelligence\/observations\/([^/]+)$/.exec(request.path);
    if (match && request.method === 'POST') {
      const id = decodeURIComponent(match[1]!);
      const requested = (request.body as { review?: unknown }).review;
      if (requested !== 'confirmed' && requested !== 'dismissed') return undefined;
      state.order.push(`review:${id}:${requested}`);
      const found = state.observations.find(item => item.id === id) ?? readdMarker(id);
      if (state.failedIds.has(id)) {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (state.unchangedIds.has(id)) {
        return { status: 200, body: { success: true, observation: found } };
      }
      const moved = { ...found, review: requested, reviewedAt: NOW.toISOString() };
      state.observations = state.observations.map(item => item.id === id ? moved : item);
      state.onMoved?.(id, requested, state);
      return { status: 200, body: { success: true, observation: moved } };
    }
    return undefined;
  };
}

export async function showPanel(harness: M5bHarness, autoGenerate = false) {
  return render(
    <Providers harness={harness}>
      <IntelligencePanel onChanged={() => undefined} autoGenerate={autoGenerate} />
    </Providers>,
  );
}
