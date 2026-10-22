import React from 'react';
import { Pressable, View } from 'react-native';
import { render } from '@testing-library/react-native';
import { IntelligencePanel } from '../../features/goals/IntelligencePanel';
import { PlanScreen } from '../../screens/PlanScreen';
import {
  useAcceptWeekDay,
  useDeleteAllMemory,
  useDeleteMemory,
  usePatchMemory,
} from '../../api/queries';
import {
  NOW,
  Providers,
  TODAY,
  ZONE,
  initialState,
  memoryItem,
  plan,
  prepare,
  teardown,
  type M5bHarness,
  type RecordedRequest,
  type RouteHandler,
  type RouteReply,
} from '../m5b/harness';

export { NOW, Providers, TODAY, ZONE, initialState, memoryItem, prepare, teardown };
export type { M5bHarness, RecordedRequest, RouteHandler, RouteReply };

export const FUTURE = '2030-03-30';
export const BASIS_ID = 'memory-focus';
export const BASIS_WINDOW = { start: '09:00', end: '12:00' } as const;

export type OutcomeSignal = 'completed' | 'postponed' | 'dropped';

export function outcome(
  id: string,
  signal: OutcomeSignal = 'completed',
  observedAt = '2030-03-29T08:00:00.000Z',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    kind: 'outcome',
    evidence: `evidence-${id}`,
    confidence: 1,
    source: 'behavior',
    sourceRef: `commitment-${id}`,
    observedAt,
    review: 'confirmed',
    reviewedAt: observedAt,
    linkedMemoryId: null,
    outcome: { signal, title: `Title ${id}` },
    ...overrides,
  };
}

export function inbox(observations: unknown[]) {
  return { success: true, observations, suggestions: [], schedule: [] };
}

export function planWithBasis(
  date = TODAY,
  memoryId = BASIS_ID,
  options: { changed?: boolean; rebuildsLeft?: number; status?: 'proposed' | 'accepted' | 'edited' | 'dismissed' } = {},
) {
  return {
    ...plan(undefined, false, options.rebuildsLeft ?? 2),
    date,
    status: options.status ?? 'proposed',
    memoryBasis: { memoryId, window: BASIS_WINDOW },
    memoryBasisChanged: options.changed ?? false,
  };
}

export function planEnvelope(value: Record<string, unknown> = planWithBasis()) {
  return { success: true, plan: value, proposal: null };
}

export function weekEnvelope(value = planWithBasis(FUTURE)) {
  return {
    success: true,
    plan: value,
    week: {
      today: TODAY,
      timezone: ZONE,
      days: [],
      moves: [],
      drops: [],
      waiting: 0,
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A real-client handler for the panel, with only the M5b wire supplied by hand. */
export function panelHandler(options: {
  observations: Record<string, unknown>[];
  capability?: true | false | 'unknown';
  dismissal?: 'dismissed' | 'unchanged' | 'failed';
  order?: string[];
}): RouteHandler {
  let rows = [...options.observations];
  return (request) => {
    if (request.path === '/api/mobile/intelligence' && request.method === 'GET') {
      options.order?.push('inbox');
      return { status: 200, body: inbox(rows) };
    }
    if (request.path === '/api/mobile/intelligence/sources/gmail/monitor') {
      return { status: 200, body: { success: true, enabled: false, lastSuccessAt: null, error: null } };
    }
    if (request.path === '/api/mobile/capabilities/m5b') {
      options.order?.push('capability');
      if (options.capability === 'unknown') return { status: 500, body: { success: false, error: 'unavailable' } };
      return { status: 200, body: { success: true, memoryLearning: options.capability !== false } };
    }
    const match = /^\/api\/mobile\/intelligence\/observations\/([^/]+)$/.exec(request.path);
    if (match && request.method === 'POST') {
      options.order?.push('dismiss');
      const found = rows.find(row => row.id === match[1]) ?? outcome(match[1]!);
      if (options.dismissal === 'failed') return { status: 500, body: { success: false, error: 'unavailable' } };
      if (options.dismissal !== 'unchanged') rows = rows.filter(row => row.id !== match[1]);
      return {
        status: 200,
        body: { success: true, observation: { ...found, review: options.dismissal === 'unchanged' ? 'confirmed' : 'dismissed' } },
      };
    }
    return undefined;
  };
}

export async function showPanel(harness: M5bHarness) {
  return render(
    <Providers harness={harness}>
      <IntelligencePanel onChanged={() => undefined} />
    </Providers>,
  );
}

export async function showBasisPlan(harness: M5bHarness, date = TODAY, children?: React.ReactNode) {
  return render(
    <Providers harness={harness}>
      <View>
        <PlanScreen date={date} onBack={() => undefined} />
        {children}
      </View>
    </Providers>,
  );
}

/** Test-only controls that drive the shipping hooks and endpoints. */
export function MemoryMutationDriver({ id = BASIS_ID }: { id?: string }) {
  const patch = usePatchMemory();
  const remove = useDeleteMemory();
  const removeAll = useDeleteAllMemory();
  return <View>
    <Pressable testID="gate-patch" onPress={() => patch.mutate({ id, content: 'corrected focus' })} />
    <Pressable testID="gate-delete" onPress={() => remove.mutate(id)} />
    <Pressable testID="gate-delete-all" onPress={() => removeAll.mutate()} />
  </View>;
}

export function WeekAcceptDriver({ date = FUTURE }: { date?: string }) {
  const accept = useAcceptWeekDay({ moves: [], drops: [] });
  return <Pressable testID="gate-week-accept" onPress={() => accept.mutate({ date, shown: ['task-1'] })} />;
}

export function mutationReply(request: RecordedRequest, itemId = BASIS_ID): RouteReply | undefined {
  if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${itemId}`) {
    return { status: 200, body: { success: true, memory: memoryItem(`${itemId}-replacement`) } };
  }
  if (request.method === 'DELETE' && request.path === `/api/mobile/memory/${itemId}`) {
    return { status: 200, body: { success: true, deleted: 1 } };
  }
  if (request.method === 'DELETE' && request.path === '/api/mobile/memory') {
    return { status: 200, body: { success: true, deleted: 1 } };
  }
  return undefined;
}
