import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  OUTBOX_DEDUPE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_AGE_MS,
  backoffMs,
  clearOutbox,
  enqueueTap,
  flushOutbox,
  loadOutbox,
  outboxStorageKey,
  parseOutbox,
  pendingCommitmentIds,
  type OutboxItem,
  type SendOutcome,
} from '../actionOutbox';

/**
 * The notification-button outbox (UC-3.14, #200).
 *
 * Instants are NOW plus offsets; nothing reads the wall clock or the zone.
 */
const NOW = Date.UTC(2026, 8, 16, 9, 0);
const A = 'account-a';
const B = 'account-b';

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

/** A server that applies each clientActionId once, like the real route. */
function fakeServer() {
  const applied = new Map<string, number>();
  let loseNextAnswer = false;
  return {
    applied,
    events: () => Array.from(applied.values()).reduce((sum, n) => sum + n, 0),
    loseNextAnswer: () => {
      loseNextAnswer = true;
    },
    send: async (item: OutboxItem): Promise<SendOutcome> => {
      if (!applied.has(item.clientActionId)) applied.set(item.clientActionId, 1);
      if (loseNextAnswer) {
        loseNextAnswer = false;
        throw new Error('the answer never arrived');
      }
      return 'sent';
    },
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  counter = 0;
});

describe('enqueue', () => {
  it('persists a tap with ids and instants only', async () => {
    expect(await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW))).toBe(true);
    const raw = await AsyncStorage.getItem(outboxStorageKey(A));
    expect(raw).not.toBeNull();
    const [item] = parseOutbox(raw).items;
    expect(Object.keys(item!).sort()).toEqual(
      ['action', 'attempts', 'clientActionId', 'commitmentId', 'dedupeKey', 'nextAttemptAt', 'occurredAt'],
    );
  });

  it('the same press delivered twice is queued once', async () => {
    const tap = { commitmentId: 'c1', action: 'complete' as const, notificationId: 'c1:soft' };
    expect(await enqueueTap(A, tap, newId, new Date(NOW))).toBe(true);
    // The live listener and the cold-start response, or a relaunch.
    expect(await enqueueTap(A, tap, newId, new Date(NOW + 1000))).toBe(false);
    expect((await loadOutbox(A)).items).toHaveLength(1);
  });

  it('concurrent deliveries of the same press still queue once', async () => {
    const tap = { commitmentId: 'c1', action: 'complete' as const, notificationId: 'c1:soft' };
    const results = await Promise.all([
      enqueueTap(A, tap, newId, new Date(NOW)),
      enqueueTap(A, tap, newId, new Date(NOW)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await loadOutbox(A)).items).toHaveLength(1);
  });

  it('a re-ring under the same identifier is a new press; one press delivered three ways is queued once', async () => {
    const ring = { commitmentId: 'cmt_x', action: 'postpone' as const, notificationId: 'cmt_x:strong', postponedUntil: new Date(NOW + 3_600_000).toISOString() };
    // Listener, cold start and background task all see the same delivery instant.
    expect(await enqueueTap(A, { ...ring, deliveredAt: NOW }, newId, new Date(NOW))).toBe(true);
    expect(await enqueueTap(A, { ...ring, deliveredAt: NOW }, newId, new Date(NOW + 1000))).toBe(false);
    expect(await enqueueTap(A, { ...ring, deliveredAt: NOW }, newId, new Date(NOW + 2000))).toBe(false);
    // An hour later the same commitment rings again and Later is pressed again.
    expect(await enqueueTap(A, { ...ring, deliveredAt: NOW + 3_600_000 }, newId, new Date(NOW + 3_600_000))).toBe(true);
    expect((await loadOutbox(A)).items).toHaveLength(2);
  });

  it('a different button on the same notification is a different tap', async () => {
    await enqueueTap(A, { commitmentId: 'c1', action: 'aware', notificationId: 'c1:soft' }, newId, new Date(NOW));
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    expect((await loadOutbox(A)).items.map((item) => item.action)).toEqual(['aware', 'complete']);
  });

  it('the dedupe memory lasts a day, not forever', async () => {
    const tap = { commitmentId: 'c1', action: 'complete' as const, notificationId: 'c1:soft' };
    await enqueueTap(A, tap, newId, new Date(NOW));
    expect(await enqueueTap(A, tap, newId, new Date(NOW + OUTBOX_DEDUPE_MS + 1))).toBe(true);
  });

  it('is per account', async () => {
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    expect((await loadOutbox(B)).items).toHaveLength(0);
    await clearOutbox(A);
    expect((await loadOutbox(A)).items).toHaveLength(0);
  });

  it('a stored blob this version does not understand is empty, and a bad row is skipped', () => {
    expect(parseOutbox('{nope').items).toEqual([]);
    expect(parseOutbox(JSON.stringify({ version: 2, items: [] })).items).toEqual([]);
    const parsed = parseOutbox(JSON.stringify({
      version: 1,
      items: [
        { clientActionId: 'x', commitmentId: 'c1', action: 'cancel', occurredAt: 'a', dedupeKey: 'k' },
        { clientActionId: 'y', commitmentId: 'c1', action: 'postpone', occurredAt: 'a', dedupeKey: 'k' },
        { clientActionId: 'z', commitmentId: 'c1', action: 'complete', occurredAt: 'a', dedupeKey: 'k', title: 'secret' },
      ],
      seen: {},
    }));
    expect(parsed.items.map((item) => item.clientActionId)).toEqual(['z']);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });
});

describe('flush', () => {
  it('offline, then online: exactly one action reaches the server', async () => {
    const server = fakeServer();
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    // Airplane mode.
    const offline = await flushOutbox(A, async () => 'retry', () => NOW);
    expect(offline.retrying).toBe(1);
    expect((await loadOutbox(A)).items).toHaveLength(1);
    // Back online, after the backoff.
    await flushOutbox(A, server.send, () => NOW + backoffMs(1));
    expect(server.events()).toBe(1);
    expect((await loadOutbox(A)).items).toHaveLength(0);
  });

  it('a request that landed but lost its answer is replayed with the same id: one server action', async () => {
    const server = fakeServer();
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    server.loseNextAnswer();
    await flushOutbox(A, server.send, () => NOW);
    const [kept] = (await loadOutbox(A)).items;
    expect(kept).toBeDefined();
    // Relaunch, replayed twice.
    await flushOutbox(A, server.send, () => NOW + OUTBOX_DEDUPE_MS);
    await flushOutbox(A, server.send, () => NOW + OUTBOX_DEDUPE_MS * 2);
    expect(Array.from(server.applied.keys())).toEqual([kept!.clientActionId]);
    expect(server.events()).toBe(1);
  });

  it('a tap older than a day is dropped unsent', async () => {
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    let sends = 0;
    const tally = await flushOutbox(A, async () => {
      sends += 1;
      return 'sent';
    }, () => NOW + OUTBOX_MAX_AGE_MS + 1);
    expect(sends).toBe(0);
    expect(tally.dropped).toBe(1);
    expect((await loadOutbox(A)).items).toHaveLength(0);
  });

  it('stops, keeping the items, when the signed-in account is no longer this one', async () => {
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    let sends = 0;
    await flushOutbox(A, async () => {
      sends += 1;
      return 'sent';
    }, () => NOW, () => false);
    expect(sends).toBe(0);
    expect((await loadOutbox(A)).items).toHaveLength(1);
  });

  it('a refusal is dropped, not retried', async () => {
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    const tally = await flushOutbox(A, async () => 'drop', () => NOW);
    expect(tally.dropped).toBe(1);
    expect((await loadOutbox(A)).items).toHaveLength(0);
  });

  it('backs off exponentially and gives up after the last attempt', async () => {
    await enqueueTap(A, { commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' }, newId, new Date(NOW));
    let clock = NOW;
    let sends = 0;
    const failing = async () => {
      sends += 1;
      return 'retry' as const;
    };
    // Not due yet: nothing is sent.
    await flushOutbox(A, failing, () => clock);
    expect(sends).toBe(1);
    await flushOutbox(A, failing, () => clock + backoffMs(1) - 1);
    expect(sends).toBe(1);
    expect(backoffMs(2)).toBe(backoffMs(1) * 2);
    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      clock += backoffMs(attempt);
      await flushOutbox(A, failing, () => clock);
    }
    expect(sends).toBe(OUTBOX_MAX_ATTEMPTS);
    expect((await loadOutbox(A)).items).toHaveLength(0);
  });

  it('keeps order and stops at the first failure, so later taps are not sent ahead of it', async () => {
    await enqueueTap(A, { commitmentId: 'c1', action: 'postpone', notificationId: 'c1:soft', postponedUntil: new Date(NOW + 3_600_000).toISOString() }, newId, new Date(NOW));
    await enqueueTap(A, { commitmentId: 'c2', action: 'complete', notificationId: 'c2:soft' }, newId, new Date(NOW));
    const seen: string[] = [];
    await flushOutbox(A, async (item) => {
      seen.push(item.commitmentId);
      return 'retry';
    }, () => NOW);
    expect(seen).toEqual(['c1']);
    expect(pendingCommitmentIds(await loadOutbox(A))).toEqual(new Set(['c1', 'c2']));
  });
});
