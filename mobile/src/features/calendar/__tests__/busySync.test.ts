/**
 * When this app may read a calendar, and what it sends when it does
 * (UC-3.2, #186 steps 3–4).
 *
 * Every rule about *when* is a case here rather than a comment, because none of
 * them can be seen on a device: a throttle is invisible until somebody has
 * waited fifteen minutes, and a consent gate that has quietly stopped working
 * looks exactly like one that is working.
 *
 * The one that matters most is the order: the calendar is read only after the
 * consent switch has been checked. Reading somebody's calendar and *then*
 * deciding not to upload it is still reading somebody's calendar, and the
 * assertion below is on the port never having been called at all.
 *
 * ── The block id is a contract with the server ───────────────────
 *
 * `deviceBlockId` here and `busyBlockId` in `lib/calendar/busyBlocks.ts` must
 * agree exactly or a re-upload writes a second row for every event. They run in
 * two different runtimes and cannot import each other, so the same vector is
 * pinned on both sides — see `tests/calendar/busyBlocks.test.ts`.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BUSY_SYNC_MIN_INTERVAL_MS,
  BUSY_SYNC_UPLOAD_LIMIT,
  busySyncDecision,
  busyUploadFor,
  deviceBlockId,
  deviceSourceId,
  runBusySync,
  type BusySyncPorts,
  type BusySyncTrigger,
} from '../busySync';
import type { DeviceBusyBlock } from '../busyBlocks';
import type { CalendarBusyUpload } from '../../../api/endpoints/calendar';

const NOW = new Date();
const MINUTE = 60_000;

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * MINUTE).toISOString();
}

function block(nativeId: string, from: number, to: number, allDay = false): DeviceBusyBlock {
  return { nativeId, startAt: at(from), endAt: at(to), allDay };
}

function decision(over: Partial<Parameters<typeof busySyncDecision>[0]> = {}) {
  return busySyncDecision({
    trigger: 'foreground',
    featureEnabled: true,
    signedIn: true,
    consented: true,
    lastSyncedAt: null,
    now: NOW,
    ...over,
  });
}

/* ── When a sync may happen ──────────────────────────────────────── */

describe('the gates, strongest first', () => {
  it('runs when everything says yes', () => {
    expect(decision()).toEqual({ run: true });
  });

  it('never runs in a build with the feature switched off', () => {
    expect(decision({ featureEnabled: false })).toEqual({ run: false, because: 'feature_off' });
  });

  it('never runs for nobody', () => {
    expect(decision({ signedIn: false })).toEqual({ run: false, because: 'signed_out' });
  });

  it('never runs without the calendar switch', () => {
    expect(decision({ consented: false })).toEqual({ run: false, because: 'no_consent' });
  });

  it('refuses on consent even when the user asked for it by hand', () => {
    for (const trigger of ['connect', 'refresh', 'foreground', 'calendar_write'] as BusySyncTrigger[]) {
      expect(decision({ trigger, consented: false })).toEqual({ run: false, because: 'no_consent' });
    }
  });
});

describe('the throttle', () => {
  const justNow = NOW.getTime() - MINUTE;
  const longAgo = NOW.getTime() - BUSY_SYNC_MIN_INTERVAL_MS - MINUTE;

  it('stops a second automatic sync inside the window', () => {
    expect(decision({ trigger: 'foreground', lastSyncedAt: justNow })).toEqual({ run: false, because: 'too_soon' });
    expect(decision({ trigger: 'calendar_write', lastSyncedAt: justNow })).toEqual({ run: false, because: 'too_soon' });
  });

  it('lets an automatic sync through once the window has passed', () => {
    expect(decision({ trigger: 'foreground', lastSyncedAt: longAgo })).toEqual({ run: true });
  });

  it('is exactly fifteen minutes, not fourteen', () => {
    expect(decision({ trigger: 'foreground', lastSyncedAt: NOW.getTime() - BUSY_SYNC_MIN_INTERVAL_MS }))
      .toEqual({ run: true });
    expect(decision({ trigger: 'foreground', lastSyncedAt: NOW.getTime() - BUSY_SYNC_MIN_INTERVAL_MS + 1 }))
      .toEqual({ run: false, because: 'too_soon' });
  });

  it('never stops the user asking', () => {
    expect(decision({ trigger: 'connect', lastSyncedAt: justNow })).toEqual({ run: true });
    expect(decision({ trigger: 'refresh', lastSyncedAt: justNow })).toEqual({ run: true });
  });

  it('does not wedge when the clock has gone backwards', () => {
    expect(decision({ trigger: 'foreground', lastSyncedAt: NOW.getTime() + 60 * MINUTE })).toEqual({ run: true });
  });
});

/* ── What is sent ────────────────────────────────────────────────── */

describe('the upload body', () => {
  it('carries four fields per block and no fifth', async () => {
    const body = await busyUploadFor('device:w1', 'ios', { startAt: at(0), endAt: at(60 * 24) }, [block('a', 60, 120)]);
    expect(Object.keys(body).sort()).toEqual(['blocks', 'platform', 'sourceId', 'windowEnd', 'windowStart']);
    expect(Object.keys(body.blocks[0]!).sort()).toEqual(['allDay', 'blockId', 'endAt', 'startAt']);
  });

  it('never carries the calendar\'s own id for the event', async () => {
    const body = await busyUploadFor('device:w1', 'ios', { startAt: at(0), endAt: at(60) }, [
      block('EVENT-ID-THE-SERVER-MUST-NOT-SEE', 10, 20),
    ]);
    expect(JSON.stringify(body)).not.toContain('EVENT-ID-THE-SERVER-MUST-NOT-SEE');
  });

  it('gives an unchanged event the same id twice, so a re-upload overwrites', async () => {
    const one = await busyUploadFor('device:w1', 'ios', { startAt: at(0), endAt: at(60) }, [block('a', 10, 20)]);
    const two = await busyUploadFor('device:w1', 'ios', { startAt: at(0), endAt: at(60) }, [block('a', 10, 20)]);
    expect(one.blocks[0]!.blockId).toBe(two.blocks[0]!.blockId);
  });

  it('gives a moved event a different id, which is why the server must delete', async () => {
    const before = await busyUploadFor('device:w1', 'ios', { startAt: at(0), endAt: at(60) }, [block('a', 10, 20)]);
    const after = await busyUploadFor('device:w1', 'ios', { startAt: at(0), endAt: at(60) }, [block('a', 15, 25)]);
    expect(before.blocks[0]!.blockId).not.toBe(after.blocks[0]!.blockId);
  });

  it('gives two devices different ids for the same event', async () => {
    const mine = await busyUploadFor('device:w1', 'ios', { startAt: at(0), endAt: at(60) }, [block('a', 10, 20)]);
    const theirs = await busyUploadFor('device:w2', 'ios', { startAt: at(0), endAt: at(60) }, [block('a', 10, 20)]);
    expect(mine.blocks[0]!.blockId).not.toBe(theirs.blocks[0]!.blockId);
  });

  /**
   * The vector the server pins too.
   *
   * `tests/calendar/busyBlocks.test.ts` asserts `busyBlockId` produces this same
   * digest for these same three strings. Two runtimes, one contract, and the
   * only way a change to either preimage is noticed before a user's calendar
   * doubles in size.
   */
  it('matches the digest the server computes for the same three strings', async () => {
    expect(await deviceBlockId(
      'device:11111111-2222-4333-8444-555555555555',
      'evt-1',
      '2026-09-16T11:00:00.000Z',
    )).toBe('b28be7bd48db3877fcbb73e97de365fe3fe312b927d2c5ec876193366974f36c');
  });

  it('names the source after the installation', () => {
    expect(deviceSourceId('w-1')).toBe('device:w-1');
  });
});

/* ── More than the cap ───────────────────────────────────────────── */

/**
 * Found by adversarial review of #418: the phone used to `slice(0, 1000)` and
 * send the result under the full 28-day window. Blocks are sorted by start, so
 * what was thrown away was the *end* of the month, and the server — told the
 * window was complete — recorded those weeks as free. That is the exact failure
 * the server's own refusal exists to prevent, done one hop earlier where nobody
 * could see it. Removing the slice altogether left the whole suite green.
 *
 * Now the window is shortened to what was actually sent. The planner is told
 * "I know up to the 19th" rather than "the 20th onwards is empty".
 */
describe('a calendar with more blocks than one upload carries', () => {
  const window = { startAt: at(0), endAt: at(60 * 24 * 28) };
  const many = (count: number) => Array.from({ length: count }, (_, index) => block(`e-${index}`, index * 30, index * 30 + 15));

  it('never sends more than the cap', async () => {
    const body = await busyUploadFor('device:w1', 'ios', window, many(BUSY_SYNC_UPLOAD_LIMIT + 50));
    expect(body.blocks.length).toBeLessThanOrEqual(BUSY_SYNC_UPLOAD_LIMIT);
  });

  it('keeps the earliest blocks, not an arbitrary subset', async () => {
    const body = await busyUploadFor('device:w1', 'ios', window, many(BUSY_SYNC_UPLOAD_LIMIT + 50));
    expect(body.blocks[0]!.startAt).toBe(at(0));
  });

  it('declares a window that ends where the blocks it could not send begin', async () => {
    const blocks = many(BUSY_SYNC_UPLOAD_LIMIT + 50);
    const body = await busyUploadFor('device:w1', 'ios', window, blocks);
    expect(body.windowEnd).toBe(blocks[BUSY_SYNC_UPLOAD_LIMIT]!.startAt);
    // And every block sent is inside it, which the server now checks.
    for (const sent of body.blocks) expect(Date.parse(sent.startAt)).toBeLessThan(Date.parse(body.windowEnd));
  });

  it('leaves the window alone when everything fits', async () => {
    const body = await busyUploadFor('device:w1', 'ios', window, many(3));
    expect(body.windowEnd).toBe(window.endAt);
    expect(body.blocks).toHaveLength(3);
  });

  it('says so in the outcome, so the shortening is not silent', async () => {
    const outcome = await runBusySync({
      readBusy: async () => many(BUSY_SYNC_UPLOAD_LIMIT + 50),
      ownEventIds: async () => [],
      cache: async () => {},
      upload: async () => {},
      recordSync: async () => {},
    }, {
      trigger: 'connect', featureEnabled: true, signedIn: true, consented: true, lastSyncedAt: null,
      now: NOW, sourceId: 'device:w1', platform: 'ios', window,
    });
    expect(outcome).toEqual({
      kind: 'synced',
      blocks: BUSY_SYNC_UPLOAD_LIMIT,
      windowEnd: many(BUSY_SYNC_UPLOAD_LIMIT + 50)[BUSY_SYNC_UPLOAD_LIMIT]!.startAt,
    });
  });
});

/* ── One pass ────────────────────────────────────────────────────── */

describe('a pass', () => {
  let read: jest.Mock<(ids: ReadonlySet<string>, now: Date) => Promise<DeviceBusyBlock[]>>;
  let cached: DeviceBusyBlock[][];
  let uploaded: CalendarBusyUpload[];
  let recorded: Date[];
  let uploadFails: boolean;

  function ports(): BusySyncPorts {
    return {
      readBusy: (ids, now) => read(ids, now),
      ownEventIds: async () => ['ours'],
      cache: async (blocks) => { cached.push([...blocks]); },
      upload: async (body) => {
        if (uploadFails) throw new Error('offline');
        uploaded.push(body);
      },
      recordSync: async (at_) => { recorded.push(at_); },
    };
  }

  function input(over: Record<string, unknown> = {}) {
    return {
      trigger: 'connect' as BusySyncTrigger,
      featureEnabled: true,
      signedIn: true,
      consented: true,
      lastSyncedAt: null,
      now: NOW,
      sourceId: 'device:w1',
      platform: 'ios' as const,
      window: { startAt: at(0), endAt: at(60 * 24 * 28) },
      ...over,
    };
  }

  beforeEach(() => {
    read = jest.fn<(ids: ReadonlySet<string>, now: Date) => Promise<DeviceBusyBlock[]>>()
      .mockResolvedValue([block('a', 60, 120)]);
    cached = [];
    uploaded = [];
    recorded = [];
    uploadFails = false;
  });

  it('reads, caches, uploads and records', async () => {
    expect(await runBusySync(ports(), input())).toEqual({ kind: 'synced', blocks: 1, windowEnd: input().window.endAt });
    expect(cached).toHaveLength(1);
    expect(uploaded).toHaveLength(1);
    expect(recorded).toEqual([NOW]);
  });

  it('hands the read this installation\'s own event ids', async () => {
    await runBusySync(ports(), input());
    expect([...read.mock.calls[0]![0]]).toEqual(['ours']);
  });

  it('does not touch the calendar at all when a gate said no', async () => {
    expect(await runBusySync(ports(), input({ consented: false })))
      .toEqual({ kind: 'skipped', because: 'no_consent' });
    expect(read).not.toHaveBeenCalled();
    expect(cached).toEqual([]);
    expect(uploaded).toEqual([]);
  });

  it('leaves the cache alone when the calendar cannot be read', async () => {
    read.mockRejectedValue(new Error('permission denied'));
    expect(await runBusySync(ports(), input())).toEqual({ kind: 'denied' });
    expect(cached).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('keeps the chips working when the upload fails, and does not record the sync', async () => {
    uploadFails = true;
    expect(await runBusySync(ports(), input())).toEqual({ kind: 'failed' });
    expect(cached).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  it('uploads an empty window rather than skipping it, so an emptied calendar empties the server', async () => {
    read.mockResolvedValue([]);
    expect(await runBusySync(ports(), input())).toEqual({ kind: 'synced', blocks: 0, windowEnd: input().window.endAt });
    expect(uploaded[0]!.blocks).toEqual([]);
  });
});
