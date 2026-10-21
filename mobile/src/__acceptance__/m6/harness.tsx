import { StyleSheet } from 'react-native';
import type { Commitment } from '../../api/schemas/common';
import {
  ACCOUNT_A,
  NOW,
  TODAY,
  ZONE,
  initialState,
  memoryItem,
  plan,
  prepare,
  type M5bHarness,
  type RecordedRequest,
  type RouteHandler,
  type RouteReply,
} from '../m5b/harness';

export { ACCOUNT_A, NOW, TODAY, ZONE };
export { Providers, press, teardown, waitForRequest } from '../m5b/harness';
export type { RecordedRequest, RouteReply } from '../m5b/harness';

export type Language = 'ar' | 'en' | 'he';

export interface M6Options {
  searchHistory?: boolean;
  commitments?: ReturnType<typeof commitment>[];
  memoryItems?: ReturnType<typeof fact>[];
  searchItems?: ReturnType<typeof commitment>[];
  truncated?: boolean;
  plan?: Record<string, unknown> | null;
  habits?: unknown[];
  seeds?: unknown[];
  handler?: RouteHandler;
}

export interface M6Harness extends M5bHarness {
  commitments: ReturnType<typeof commitment>[];
  searchItems: ReturnType<typeof commitment>[];
  setSearchItems: (items: ReturnType<typeof commitment>[]) => void;
}

export function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  const due = `2030-03-${String(29 + (Number(id.replace(/\D/g, '')) || 0) % 3).padStart(2, '0')}T12:00:00.000Z`;
  return {
    id,
    kind: 'task',
    title: `Task ${id}`,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: due, endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2030-01-01T09:00:00.000Z',
    updatedAt: '2030-03-20T09:00:00.000Z',
    confirmedAt: '2030-01-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    rank: Number(id.replace(/\D/g, '')) || 0,
    reasonCodes: [],
    deviceCalendarLink: null,
    ...overrides,
  };
}

export function fact(id: string, content: string, sourceLabel = 'you_told_us') {
  return {
    ...memoryItem(id),
    content,
    language: firstLanguage(content),
    sourceLabel,
  };
}

export function denseCommitments(): ReturnType<typeof commitment>[] {
  return Array.from({ length: 60 }, (_, index) => {
    const id = `dense-${index + 1}`;
    const arabic = index % 2 === 0;
    const title = arabic
      // Arabic: "Ahmad task". Kept escaped so the source stays reviewable in every editor.
      ? `\u0645\u0647\u0645\u0629 \u0623\u062d\u0645\u062f ${index + 1}`
      : `English task ${index + 1}`;
    const done = index >= 40 && index < 55;
    const dropped = index >= 55;
    const starts = `2030-03-${String(29 + (index % 3)).padStart(2, '0')}T${String(8 + (index % 10)).padStart(2, '0')}:00:00.000Z`;
    return commitment(id, {
      title,
      status: done ? 'completed' /* GA-M6-AMEND-2: the DTO's own vocabulary (density fixture) */ : dropped ? 'dropped' : 'active',
      priority: {
        level: index % 3 === 0 ? 'high' : index % 3 === 1 ? 'normal' : 'low',
        source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none',
      },
      timeSpec: {
        kind: index % 7 === 0 ? 'scheduled_event' : 'due_by',
        dueAt: starts,
        endAt: index % 7 === 0 ? new Date(Date.parse(starts) + (index % 4 + 1) * 60 * 60 * 1_000).toISOString() : null,
        remindAt: null,
        allDay: false,
        timezone: ZONE,
      },
      completedAt: done ? '2030-03-20T10:00:00.000Z' : null,
      droppedAt: dropped ? '2030-03-21T10:00:00.000Z' : null,
      rank: index,
    });
  });
}

export function keptPlan() {
  return {
    ...plan(),
    unscheduled: [
      { itemId: 'same-a', title: 'First same reason', reasonCode: 'NO_FEASIBLE_SLOT', blockId: 'block:same-a' },
      { itemId: 'same-b', title: 'Second same reason', reasonCode: 'HORIZON_EXHAUSTED', blockId: 'block:same-b' },
      { itemId: 'different', title: 'Different reason', reasonCode: 'FIXED_EVENT_CONFLICT', blockId: 'block:different' },
    ],
  };
}

export async function prepareM6(language: Language = 'en', options: M6Options = {}): Promise<M6Harness> {
  const commitments = options.commitments ?? [commitment('local')];
  let searchItems = options.searchItems ?? [];
  const route = async (request: RecordedRequest): Promise<RouteReply | undefined> => {
    const custom = await options.handler?.(request);
    if (custom !== undefined) return custom;
    if (request.path === '/api/mobile/capabilities/m6') {
      return { status: 200, body: { success: true, searchHistory: options.searchHistory ?? true } };
    }
    if (request.path === '/api/mobile/commitments/search' && request.method === 'POST') {
      return { status: 200, body: { success: true, items: searchItems, truncated: options.truncated ?? false } };
    }
    if (request.path === '/api/mobile/commitments/today') {
      return { status: 200, body: { items: commitments.slice(0, 30), calendarOrphans: [] } };
    }
    if (request.path === '/api/mobile/commitments/upcoming') {
      return { status: 200, body: { items: commitments.slice(30) } };
    }
    if (request.path === '/api/mobile/habits') return { status: 200, body: { success: true, items: options.habits ?? [] } };
    if (request.path === '/api/mobile/seeds') return { status: 200, body: { items: options.seeds ?? [] } };
    return undefined;
  };
  const baseState = initialState({
    memoryItems: options.memoryItems ?? [fact('memory-1', 'English fact')],
    plan: options.plan === undefined ? plan() : options.plan,
  });
  const harness = await prepare(language, baseState, route);
  return {
    ...harness,
    commitments,
    get searchItems() { return searchItems; },
    setSearchItems(items) { searchItems = items; },
  };
}

export function flatStyle(node: { props: { style?: unknown } }): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style) as Record<string, unknown>;
}

export function firstLanguage(text: string): Language {
  for (const character of text) {
    if (/\p{Script=Hebrew}/u.test(character)) return 'he';
    if (/\p{Script=Arabic}/u.test(character)) return 'ar';
    if (/\p{Script=Latin}/u.test(character)) return 'en';
  }
  return 'en';
}

export function searchRequests(harness: M5bHarness): RecordedRequest[] {
  return harness.server.matching('POST', /^\/api\/mobile\/commitments\/search$/);
}

export function instant(day: string, clock: string): string {
  return new Date(`${day}T${clock}:00+03:00`).toISOString();
}

