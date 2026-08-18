/**
 * Feedback history + revoke API (issue #15).
 *
 * The routes depend on a narrow port rather than on the event store itself,
 * so these tests drive them against an in-memory fake. The real store lands in
 * a sibling track; the port is the seam the two are joined at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generatePilotToken } from '../../lib/pilot/pilotTokenService.ts';
import {
  createFeedbackHistoryPort,
  setFeedbackHistoryPort,
  type FeedbackHistoryPort,
  type FeedbackRevokeRequest,
  type FeedbackRevokeResult,
} from '../../lib/feedbackHistory/feedbackHistoryPort.ts';
import { GET as historyGet } from '../../src/app/api/mobile/feedback/history/route.ts';
import { POST as revokePost } from '../../src/app/api/mobile/feedback/[id]/revoke/route.ts';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
  type FeedbackBaseline,
  type FeedbackEvent,
  type FeedbackEventQuery,
  type FeedbackEventStore,
  type FeedbackHistoryResponse,
  type FeedbackOutcome,
} from '../../src/contracts/v1/feedbackContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const TEST_SECRET = 'test-secret-min-16-chars-long-security-key';
// The pilot runtime refuses to start with an allowlist smaller than the closed
// pilot contract, so the roster is real-sized and the two scopes are drawn from it.
const PILOT_IDS = Array.from({ length: 25 }, (_, index) => `p-${String(index + 700).padStart(3, '0')}`);
const [OWNER, OTHER] = PILOT_IDS;

/* ── An in-memory stand-in for the sibling track's event store ─────── */

function event(
  overrides: Partial<FeedbackEvent> & Pick<FeedbackEvent, 'id' | 'scopeId' | 'outcome' | 'occurredAt'>,
): FeedbackEvent {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    subjectId: `subject-${overrides.id}`,
    actor: 'user',
    source: 'mobile_action',
    recordedAt: overrides.occurredAt,
    idempotencyKey: `${overrides.scopeId}|${overrides.outcome}|${overrides.occurredAt}`,
    ...overrides,
  };
}

/**
 * The fake enforces exactly the guarantees the routes rely on and nothing
 * more: scope-filtered reads, a revocation that is stamped once and never
 * moved, and a cross-scope revoke that is indistinguishable from a miss.
 */
function fakePort(seed: readonly FeedbackEvent[], baselines: Record<string, FeedbackBaseline> = {}): FeedbackHistoryPort {
  const events = new Map(seed.map((entry) => [entry.id, { ...entry }]));
  return {
    listForScope(scopeId: string): readonly FeedbackEvent[] {
      return Array.from(events.values()).filter((entry) => entry.scopeId === scopeId);
    },
    readBaseline(scopeId: string): FeedbackBaseline | null {
      return baselines[scopeId] ?? null;
    },
    revokeForScope({ scopeId, eventId, at }: FeedbackRevokeRequest): FeedbackRevokeResult {
      const found = events.get(eventId);
      if (!found || found.scopeId !== scopeId) return { outcome: 'not_found', event: null };
      if (found.revokedAt) return { outcome: 'already_revoked', event: found };
      const revoked = { ...found, revokedAt: at };
      events.set(eventId, revoked);
      return { outcome: 'revoked', event: revoked };
    },
  };
}

function baseline(scopeId: string, overrides: Partial<FeedbackBaseline['counters']> = {}): FeedbackBaseline {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId,
    counters: {
      ignoredSuggestions: 0,
      completedActions: 0,
      delayedActions: 0,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
      ...overrides,
    },
    lastUpdatedAt: '2026-07-01T00:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: '2026-08-18T00:00:00.000Z',
  };
}

/* ── Harness ──────────────────────────────────────────────────────── */

function request(path: string, options: { method?: string; participantId?: string } = {}): Request {
  const headers = new Headers();
  if (options.participantId) {
    headers.set('authorization', `Bearer ${generatePilotToken(options.participantId, TEST_SECRET)}`);
  }
  return new Request(`${BASE}${path}`, { method: options.method ?? 'GET', headers });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function setup(port: FeedbackHistoryPort | null): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-feedback-history-'));
  const previous: Record<string, string | undefined> = {
    MAYBESITTER_CLOSED_PILOT_IDS: process.env.MAYBESITTER_CLOSED_PILOT_IDS,
    MAYBESITTER_PILOT_MODE: process.env.MAYBESITTER_PILOT_MODE,
    MAYBESITTER_PILOT_TOKEN_SECRET: process.env.MAYBESITTER_PILOT_TOKEN_SECRET,
    MAYBESITTER_PILOT_TRUST_FILE: process.env.MAYBESITTER_PILOT_TRUST_FILE,
    MAYBESITTER_DATA_DIR: process.env.MAYBESITTER_DATA_DIR,
  };
  process.env.MAYBESITTER_CLOSED_PILOT_IDS = PILOT_IDS.join(',');
  process.env.MAYBESITTER_PILOT_MODE = 'true';
  process.env.MAYBESITTER_PILOT_TOKEN_SECRET = TEST_SECRET;
  process.env.MAYBESITTER_PILOT_TRUST_FILE = join(directory, 'pilot-trust.json');
  process.env.MAYBESITTER_DATA_DIR = directory;
  setFeedbackHistoryPort(port);

  return () => {
    setFeedbackHistoryPort(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  };
}

async function historyFor(participantId: string, query = ''): Promise<FeedbackHistoryResponse> {
  const response = await historyGet(request(`/api/mobile/feedback/history${query}`, { participantId }));
  assert.equal(response.status, 200);
  return await response.json() as FeedbackHistoryResponse;
}

/* ── History ──────────────────────────────────────────────────────── */

test('feedback history: unauthenticated read is refused', async () => {
  const teardown = setup(fakePort([]));
  try {
    const response = await historyGet(request('/api/mobile/feedback/history'));
    assert.equal(response.status, 401);
  } finally {
    teardown();
  }
});

test('feedback history: rows are newest-first and carry the observed outcome', async () => {
  const teardown = setup(fakePort([
    event({ id: 'e1', scopeId: OWNER, outcome: 'complete', occurredAt: '2026-08-10T09:00:00.000Z' }),
    event({ id: 'e2', scopeId: OWNER, outcome: 'defer', occurredAt: '2026-08-12T09:00:00.000Z' }),
    event({ id: 'e3', scopeId: OWNER, outcome: 'ignore', occurredAt: '2026-08-11T09:00:00.000Z' }),
  ]));
  try {
    const body = await historyFor(OWNER);
    assert.equal(body.version, FEEDBACK_EVENT_SCHEMA_VERSION);
    assert.deepEqual(body.rows.map((row) => row.id), ['e2', 'e3', 'e1']);
    const outcomes: FeedbackOutcome[] = body.rows.map((row) => row.outcome);
    assert.deepEqual(outcomes, ['defer', 'ignore', 'complete']);
    assert.deepEqual(body.rows.map((row) => row.revokedAt), [null, null, null]);
    assert.ok(body.rows.every((row) => row.canRevoke));
    assert.equal(body.rows[0].subjectId, 'subject-e2');
  } finally {
    teardown();
  }
});

test('feedback history: same occurredAt still yields a stable total order', async () => {
  const at = '2026-08-12T09:00:00.000Z';
  const teardown = setup(fakePort([
    event({ id: 'b', scopeId: OWNER, outcome: 'defer', occurredAt: at, recordedAt: at }),
    event({ id: 'a', scopeId: OWNER, outcome: 'defer', occurredAt: at, recordedAt: at }),
    event({ id: 'c', scopeId: OWNER, outcome: 'defer', occurredAt: at, recordedAt: '2026-08-13T09:00:00.000Z' }),
  ]));
  try {
    // Later recordedAt breaks the tie first; identical pairs fall back to id.
    assert.deepEqual((await historyFor(OWNER)).rows.map((row) => row.id), ['c', 'a', 'b']);
  } finally {
    teardown();
  }
});

test('feedback history: revoked rows stay visible and stop being revocable', async () => {
  const teardown = setup(fakePort([
    event({ id: 'e1', scopeId: OWNER, outcome: 'defer', occurredAt: '2026-08-10T09:00:00.000Z' }),
    event({
      id: 'e2',
      scopeId: OWNER,
      outcome: 'ignore',
      occurredAt: '2026-08-11T09:00:00.000Z',
      revokedAt: '2026-08-14T10:00:00.000Z',
    }),
  ]));
  try {
    const body = await historyFor(OWNER);
    // History shows corrections rather than hiding them.
    assert.equal(body.rows.length, 2);
    const revoked = body.rows.find((row) => row.id === 'e2');
    assert.equal(revoked?.revokedAt, '2026-08-14T10:00:00.000Z');
    assert.equal(revoked?.canRevoke, false);
  } finally {
    teardown();
  }
});

test('feedback history: one scope never sees another scope rows', async () => {
  const teardown = setup(fakePort([
    event({ id: 'mine', scopeId: OWNER, outcome: 'complete', occurredAt: '2026-08-10T09:00:00.000Z' }),
    event({ id: 'theirs', scopeId: OTHER, outcome: 'complete', occurredAt: '2026-08-11T09:00:00.000Z' }),
  ]));
  try {
    assert.deepEqual((await historyFor(OWNER)).rows.map((row) => row.id), ['mine']);
    assert.deepEqual((await historyFor(OTHER)).rows.map((row) => row.id), ['theirs']);
  } finally {
    teardown();
  }
});

test('feedback history: baseline counters are reported as a notice, never as rows', async () => {
  const teardown = setup(fakePort([], { [OWNER]: baseline(OWNER, { completedActions: 4, delayedActions: 2 }) }));
  try {
    const body = await historyFor(OWNER);
    assert.equal(body.rows.length, 0);
    assert.equal(body.baselineNotice?.counters.completedActions, 4);
    assert.equal(body.baselineNotice?.counters.delayedActions, 2);
    assert.equal(body.baselineNotice?.lastUpdatedAt, '2026-07-01T00:00:00.000Z');
  } finally {
    teardown();
  }
});

test('feedback history: an all-zero baseline is not announced as history', async () => {
  const teardown = setup(fakePort([], { [OWNER]: baseline(OWNER) }));
  try {
    assert.equal((await historyFor(OWNER)).baselineNotice, null);
  } finally {
    teardown();
  }
});

test('feedback history: no baseline means no notice', async () => {
  const teardown = setup(fakePort([]));
  try {
    assert.equal((await historyFor(OWNER)).baselineNotice, null);
  } finally {
    teardown();
  }
});

test('feedback history: limit is clamped rather than trusted', async () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    event({
      id: `e${index}`,
      scopeId: OWNER,
      outcome: 'defer',
      occurredAt: `2026-08-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
    }));
  const teardown = setup(fakePort(many));
  try {
    assert.equal((await historyFor(OWNER, '?limit=3')).rows.length, 3);
    // Newest survive the truncation, not the oldest.
    assert.equal((await historyFor(OWNER, '?limit=3')).rows[0].id, 'e11');
    assert.equal((await historyFor(OWNER, '?limit=0')).rows.length, 12);
    assert.equal((await historyFor(OWNER, '?limit=-5')).rows.length, 12);
    assert.equal((await historyFor(OWNER, '?limit=nonsense')).rows.length, 12);
  } finally {
    teardown();
  }
});

test('feedback history: an unwired port reports unavailable rather than an empty history', async () => {
  const teardown = setup(null);
  try {
    const response = await historyGet(request('/api/mobile/feedback/history', { participantId: OWNER }));
    assert.equal(response.status, 503);
    const body = await response.json() as { reason?: string };
    assert.equal(body.reason, 'feedback_history_unavailable');
  } finally {
    teardown();
  }
});

/* ── Revoke ───────────────────────────────────────────────────────── */

test('feedback revoke: unauthenticated revoke is refused', async () => {
  const port = fakePort([event({ id: 'e1', scopeId: OWNER, outcome: 'defer', occurredAt: '2026-08-10T09:00:00.000Z' })]);
  const teardown = setup(port);
  try {
    const response = await revokePost(request('/api/mobile/feedback/e1/revoke', { method: 'POST' }), routeParams('e1'));
    assert.equal(response.status, 401);
    assert.equal(port.listForScope(OWNER)[0].revokedAt, undefined);
  } finally {
    teardown();
  }
});

test('feedback revoke: the revocation persists through the port and shows in history', async () => {
  const port = fakePort([
    event({ id: 'e1', scopeId: OWNER, outcome: 'defer', occurredAt: '2026-08-10T09:00:00.000Z' }),
  ]);
  const teardown = setup(port);
  try {
    const response = await revokePost(
      request('/api/mobile/feedback/e1/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('e1'),
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { row: { id: string; revokedAt: string | null; canRevoke: boolean } };
    assert.equal(body.row.id, 'e1');
    assert.ok(body.row.revokedAt, 'expected a revocation timestamp');
    assert.equal(body.row.canRevoke, false);

    // The store, not just the response, carries the correction.
    assert.equal(port.listForScope(OWNER)[0].revokedAt, body.row.revokedAt);

    const history = await historyFor(OWNER);
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].revokedAt, body.row.revokedAt);
  } finally {
    teardown();
  }
});

test('feedback revoke: revoking twice is not an error and never moves the timestamp', async () => {
  const port = fakePort([
    event({ id: 'e1', scopeId: OWNER, outcome: 'defer', occurredAt: '2026-08-10T09:00:00.000Z' }),
  ]);
  const teardown = setup(port);
  try {
    const first = await revokePost(
      request('/api/mobile/feedback/e1/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('e1'),
    );
    const firstBody = await first.json() as { row: { revokedAt: string }; alreadyRevoked: boolean };
    const second = await revokePost(
      request('/api/mobile/feedback/e1/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('e1'),
    );
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { row: { revokedAt: string }; alreadyRevoked: boolean };
    assert.equal(firstBody.alreadyRevoked, false);
    assert.equal(secondBody.alreadyRevoked, true);
    assert.equal(secondBody.row.revokedAt, firstBody.row.revokedAt);
  } finally {
    teardown();
  }
});

test('feedback revoke: another scope event is not found and is left untouched', async () => {
  const port = fakePort([
    event({ id: 'theirs', scopeId: OTHER, outcome: 'complete', occurredAt: '2026-08-10T09:00:00.000Z' }),
  ]);
  const teardown = setup(port);
  try {
    const response = await revokePost(
      request('/api/mobile/feedback/theirs/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('theirs'),
    );
    // Deliberately identical to a missing id: a probe must not reveal that the
    // event exists in someone else's scope.
    assert.equal(response.status, 404);
    const body = await response.json() as { reason?: string };
    assert.equal(body.reason, 'event_not_found');
    assert.equal(port.listForScope(OTHER)[0].revokedAt, undefined);
  } finally {
    teardown();
  }
});

test('feedback revoke: an unknown id is a 404, not a fabricated success', async () => {
  const teardown = setup(fakePort([]));
  try {
    const response = await revokePost(
      request('/api/mobile/feedback/nope/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('nope'),
    );
    assert.equal(response.status, 404);
  } finally {
    teardown();
  }
});

test('feedback revoke: a blank id is rejected before it reaches the port', async () => {
  const teardown = setup(fakePort([]));
  try {
    const response = await revokePost(
      request('/api/mobile/feedback//revoke', { method: 'POST', participantId: OWNER }),
      routeParams('   '),
    );
    assert.equal(response.status, 400);
  } finally {
    teardown();
  }
});

/**
 * The store contract's `revoke(id, at)` takes no scope, and event ids are
 * derived from their own fields rather than randomly generated — so an id is
 * computable by anyone who knows the four inputs behind it, and the store will
 * revoke whatever it is handed. This drives the route through the *real*
 * adapter over a store that behaves exactly that way, so the refusal is proven
 * end to end rather than assumed from a fake that enforces it for us.
 */
function naiveStore(seed: readonly FeedbackEvent[]): FeedbackEventStore {
  const events = new Map(seed.map((entry) => [entry.id, { ...entry }]));
  return {
    append(_input: AppendFeedbackEventInput, _recordedAt: string): FeedbackEvent {
      throw new Error('the history routes must never append');
    },
    get(id: string): FeedbackEvent | null {
      return events.get(id) ?? null;
    },
    list(query: FeedbackEventQuery): readonly FeedbackEvent[] {
      return Array.from(events.values()).filter((entry) => entry.scopeId === query.scopeId);
    },
    // No scope, no question asked: revokes any id it is given.
    revoke(id: string, at: string): boolean {
      const found = events.get(id);
      if (!found || found.revokedAt) return false;
      events.set(id, { ...found, revokedAt: at });
      return true;
    },
    deleteScope(): number {
      return 0;
    },
    readBaseline(): FeedbackBaseline | null {
      return null;
    },
    writeBaseline(): void {},
  };
}

test('feedback revoke: a participant cannot revoke another participant event through the real adapter', async () => {
  const store = naiveStore([
    event({ id: 'fbk_derived', scopeId: OTHER, outcome: 'complete', occurredAt: '2026-08-10T09:00:00.000Z' }),
  ]);
  const teardown = setup(createFeedbackHistoryPort(store));
  try {
    const response = await revokePost(
      request('/api/mobile/feedback/fbk_derived/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('fbk_derived'),
    );

    assert.equal(response.status, 404);
    // The store would have revoked it happily. It is still untouched.
    assert.equal(store.get('fbk_derived')?.revokedAt, undefined);
  } finally {
    teardown();
  }
});

test('feedback revoke: the owner of that same event can still revoke it', async () => {
  const store = naiveStore([
    event({ id: 'fbk_derived', scopeId: OWNER, outcome: 'complete', occurredAt: '2026-08-10T09:00:00.000Z' }),
  ]);
  const teardown = setup(createFeedbackHistoryPort(store));
  try {
    // The refusal above is about ownership, not about the route being inert.
    const response = await revokePost(
      request('/api/mobile/feedback/fbk_derived/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('fbk_derived'),
    );

    assert.equal(response.status, 200);
    assert.ok(store.get('fbk_derived')?.revokedAt);
  } finally {
    teardown();
  }
});

test('feedback revoke: another scope history is unreadable through the real adapter', async () => {
  const store = naiveStore([
    event({ id: 'fbk_theirs', scopeId: OTHER, outcome: 'complete', occurredAt: '2026-08-10T09:00:00.000Z' }),
  ]);
  const teardown = setup(createFeedbackHistoryPort(store));
  try {
    assert.deepEqual((await historyFor(OWNER)).rows, []);
  } finally {
    teardown();
  }
});

test('feedback revoke: a store that refuses the write is reported as a failure, not a success', async () => {
  const port: FeedbackHistoryPort = createFeedbackHistoryPort({
    ...naiveStore([
      event({ id: 'e1', scopeId: OWNER, outcome: 'defer', occurredAt: '2026-08-10T09:00:00.000Z' }),
    ]),
    revoke: () => false,
  });
  const teardown = setup(port);
  try {
    const response = await revokePost(
      request('/api/mobile/feedback/e1/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('e1'),
    );

    assert.equal(response.status, 500);
    const body = await response.json() as { success?: boolean; reason?: string };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'revoke_failed');
  } finally {
    teardown();
  }
});

test('feedback revoke: an unwired port reports unavailable rather than claiming success', async () => {
  const teardown = setup(null);
  try {
    const response = await revokePost(
      request('/api/mobile/feedback/e1/revoke', { method: 'POST', participantId: OWNER }),
      routeParams('e1'),
    );
    assert.equal(response.status, 503);
    const body = await response.json() as { success?: boolean; reason?: string };
    assert.equal(body.success, false);
    assert.equal(body.reason, 'feedback_history_unavailable');
  } finally {
    teardown();
  }
});
