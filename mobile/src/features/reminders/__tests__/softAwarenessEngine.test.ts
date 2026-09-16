import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { wallClockIn } from '../../../lib/time/zoneOffset';
import {
  AWARENESS_CATEGORY_ID,
  AWARENESS_CHANNEL_ID,
  HARD_CATEGORY_ID,
  HARD_CHANNEL_ID,
  HARD_SOUND,
} from '../../../notifications/channels';
import type { NotificationGateway, ScheduleRequest } from '../../../notifications/gateway';
import type { ScheduledNotificationRequest } from '../../../notifications/types';
import {
  EMPTY_AWARENESS,
  loadAwareness,
  markAware,
  type AwarenessCache,
} from '../../../lib/deviceSettings/awarenessStore';
import {
  HORIZON_DAYS,
  MAX_PENDING_REQUESTS,
  type ReminderCommitment,
  type ReminderPriority,
  type ReminderSettings,
} from '../policy';
import { cancelEveryReminder, desiredRequests, syncCommitments, type SyncInput } from '../softAwarenessEngine';

/**
 * The engine, against a gateway that is a list (UC-3.11, #196).
 *
 * `getScheduled()` is exactly `getAllScheduledNotificationsAsync`, which is
 * the instrument #196's acceptance criteria are written in — so the two
 * "force-quit and relaunch" criteria are testable here rather than only on a
 * phone: a second engine run against a fresh awareness read *is* the relaunch,
 * because nothing about awareness lives in module state.
 */

const NOW = new Date('2026-09-15T09:00:00.000Z');
const ACCOUNT = 'account-a';

interface FakeGateway extends NotificationGateway {
  readonly pending: Map<string, number>;
  readonly scheduledRequests: ScheduleRequest[];
  readonly cancelled: string[];
  readonly cancelledAll: number;
  put(identifier: string, at: number | null): void;
}

function fakeGateway(): FakeGateway {
  const pending = new Map<string, number>();
  const raw = new Map<string, number | null>();
  const scheduledRequests: ScheduleRequest[] = [];
  const cancelled: string[] = [];
  let cancelledAll = 0;

  const gateway = {
    pending,
    scheduledRequests,
    cancelled,
    get cancelledAll() {
      return cancelledAll;
    },
    put(identifier: string, at: number | null) {
      raw.set(identifier, at);
      if (at !== null) pending.set(identifier, at);
    },
    async getScheduled(): Promise<ScheduledNotificationRequest[]> {
      return [...raw.entries()].map(([identifier, at]) => ({ identifier, at }));
    },
    async schedule(request: ScheduleRequest) {
      scheduledRequests.push(request);
      raw.set(request.identifier, request.at.getTime());
      pending.set(request.identifier, request.at.getTime());
    },
    async cancel(identifier: string) {
      cancelled.push(identifier);
      raw.delete(identifier);
      pending.delete(identifier);
    },
    async cancelAll() {
      cancelledAll += 1;
      raw.clear();
      pending.clear();
    },
  };
  return gateway as unknown as FakeGateway;
}

function minutesFromNow(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function input(overrides: Partial<SyncInput> = {}): SyncInput {
  return {
    commitments: [],
    now: NOW,
    settings: settingsWith({ intensity: 'followUp', escalationCeiling: 'followUp' }),
    quietHours: null,
    timeZone: 'Pacific/Chatham',
    awareness: EMPTY_AWARENESS,
    copy: { title: 'A heads-up', body: 'Something is coming up.' },
    hardCopy: { title: 'A Must item starts soon', body: 'Open MaybeSitter to see it.' },
    exactAlarms: true,
    ...overrides,
  };
}

function settingsWith(overrides: Partial<ReminderSettings> = {}): ReminderSettings {
  return {
    softEnabled: true,
    softLeadMinutes: 60,
    intensity: 'softAwareness',
    escalationCeiling: 'soft',
    hardEnabled: false,
    mustThroughQuietHours: false,
    ...overrides,
  };
}

/** "Ring for Must items", as the settings screen stores it. */
const RING = settingsWith({ escalationCeiling: 'hard', hardEnabled: true });

/** A Should by default: the #196 cases are about stages nobody rang for. */
function commitment(id: string, minutes: number, priority: ReminderPriority = 'should'): ReminderCommitment {
  return { id, startsAt: minutesFromNow(minutes), status: 'active', priority, allDay: false };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('scheduling from nothing', () => {
  it('puts both stages of a timed commitment on the awareness channel', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);

    expect(gateway.scheduledRequests.map(request => request.identifier).sort())
      .toEqual(['c1:followUp', 'c1:soft']);
    for (const request of gateway.scheduledRequests) {
      expect(request.channelId).toBe(AWARENESS_CHANNEL_ID);
      expect(request.categoryIdentifier).toBe(AWARENESS_CATEGORY_ID);
    }
  });

  it('carries ids in the payload and never a word about the commitment', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);

    for (const request of gateway.scheduledRequests) {
      // The allowlist, asserted as the *whole* key set rather than as an
      // absence: "no title today" is satisfied by any new key added tomorrow.
      expect(Object.keys(request.data).sort()).toEqual(['commitmentId', 'notificationId', 'stage']);
      expect(Object.values(request.data).every(value => typeof value === 'string')).toBe(true);
      // The copy is the same sentence for every commitment, from the bundle.
      expect(request.title).toBe('A heads-up');
    }
  });

  it('schedules nothing for an item beyond the horizon, or already past', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({
      commitments: [
        commitment('far', HORIZON_DAYS * 24 * 60 + 1),
        commitment('gone', -10),
        // Inside the lead: the soft stage is already behind us, so only the
        // follow-up is still ahead.
        commitment('soon', 45),
      ],
    }), gateway);

    expect(gateway.scheduledRequests.map(request => request.identifier)).toEqual(['soon:followUp']);
  });
});

describe('the diff', () => {
  it('leaves a request that is already at the right instant alone', async () => {
    const gateway = fakeGateway();
    const first = await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    expect(first.scheduled).toHaveLength(2);

    const second = await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    expect(second.scheduled).toEqual([]);
    expect(second.cancelled).toEqual([]);
    expect(second.kept.sort()).toEqual(['c1:followUp', 'c1:soft']);
  });

  it('reschedules when the commitment moves', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    const report = await syncCommitments(input({ commitments: [commitment('c1', 180)] }), gateway);

    expect(report.cancelled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(report.scheduled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(gateway.pending.get('c1:soft')).toBe(NOW.getTime() + 120 * 60_000);
  });

  it('cancels a request for a commitment that is gone', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    const report = await syncCommitments(input({ commitments: [] }), gateway);
    expect(report.cancelled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(gateway.pending.size).toBe(0);
  });

  it('never touches a request that is not one of its own', async () => {
    const gateway = fakeGateway();
    // What UC-3.12a (#197) and UC-3.13 (#199) will schedule.
    gateway.put('must-reminder-7', NOW.getTime() + 60_000);
    gateway.put('c1:loud', NOW.getTime() + 60_000);

    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);

    expect(gateway.cancelled).toEqual([]);
    expect(gateway.pending.has('must-reminder-7')).toBe(true);
    expect(gateway.pending.has('c1:loud')).toBe(true);
  });

  it('reschedules a pending request whose instant cannot be read', async () => {
    const gateway = fakeGateway();
    // Neither platform's trigger shape parsed: treated as wrong, not as right.
    gateway.put('c1:soft', null);
    const report = await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    expect(report.cancelled).toContain('c1:soft');
    expect(report.scheduled).toContain('c1:soft');
  });
});

describe('awareness survives a relaunch', () => {
  it('stops scheduling the follow-up after the user says they know', async () => {
    const gateway = fakeGateway();
    const item = commitment('c1', 120);
    await syncCommitments(input({ commitments: [item] }), gateway);
    expect([...gateway.pending.keys()].sort()).toEqual(['c1:followUp', 'c1:soft']);

    // The tap. Written to disk, exactly as `RemindersMount` writes it.
    await markAware(ACCOUNT, 'c1', item.startsAt, NOW);

    // The relaunch: a new engine run, reading awareness back off the device.
    const relaunched: AwarenessCache = await loadAwareness(ACCOUNT);
    const report = await syncCommitments(
      input({ commitments: [item], awareness: relaunched }),
      gateway,
    );

    expect(report.cancelled.sort()).toEqual(['c1:followUp', 'c1:soft']);
    expect(gateway.pending.size).toBe(0);
  });

  it('gives a rescheduled commitment a fresh cycle', async () => {
    const gateway = fakeGateway();
    const original = commitment('c1', 120);
    await markAware(ACCOUNT, 'c1', original.startsAt, NOW);

    const moved = commitment('c1', 300);
    const report = await syncCommitments(
      input({ commitments: [moved], awareness: await loadAwareness(ACCOUNT) }),
      gateway,
    );
    expect(report.scheduled.sort()).toEqual(['c1:followUp', 'c1:soft']);
  });
});

describe('quiet hours', () => {
  it('defers a stage inside the window to its end, and drops one too close', () => {
    withHermesIntl(() => {
      const zone = 'Pacific/Chatham';
      const minutesAt = (at: number) => {
        const clock = wallClockIn(new Date(at), zone);
        return clock.hour * 60 + clock.minute;
      };
      const findMinute = (from: number, minute: number) => {
        for (let at = from; at < from + 2 * 86_400_000; at += 60_000) {
          if (minutesAt(at) === minute) return at;
        }
        throw new Error('not found');
      };

      /*
       * Two commitments in the last hour of the quiet window, so that their
       * soft stage — one hour ahead — falls inside it.
       *
       * #196's criterion is written as "a soft stage at 22:30 with quiet hours
       * 22:00-07:00 and a commitment at 09:00": that pairing needs a ten-hour
       * lead, and the screen offers 60/30/15. The rule it is about is the one
       * tested here and in `quietHours.test.ts`, which does exercise the 22:30
       * instant directly against `deferOutOfQuietHours`.
       *
       * 07:30 defers to 07:00, thirty minutes ahead. 07:02 drops, because a
       * reminder two minutes before something is not a heads-up — which is the
       * criterion's own second half.
       */
      const morning = findMinute(NOW.getTime() + 2 * 3_600_000, 7 * 60 + 30);
      const tooEarly = findMinute(NOW.getTime() + 2 * 3_600_000, 7 * 60 + 2);

      const quiet = { start: '22:00', end: '07:00' };
      const deferred = desiredRequests(input({
        commitments: [{ id: 'c1', startsAt: new Date(morning).toISOString(), status: 'active', priority: 'should', allDay: false }],
        settings: settingsWith(),
        quietHours: quiet,
        timeZone: zone,
      }));
      const soft = deferred.desired.find(request => request.identifier === 'c1:soft');
      expect(soft).toBeDefined();
      expect(minutesAt((soft as { at: number }).at)).toBe(7 * 60);

      const dropped = desiredRequests(input({
        commitments: [{ id: 'c2', startsAt: new Date(tooEarly).toISOString(), status: 'active', priority: 'should', allDay: false }],
        settings: settingsWith(),
        quietHours: quiet,
        timeZone: zone,
      }));
      expect(dropped.desired).toEqual([]);
      expect(dropped.droppedForQuietHours).toEqual(['c2:soft']);
    });
  });
});

describe('the pending-request cap', () => {
  it('keeps the nearest fifty and reports what it cut', () => {
    const commitments = Array.from({ length: 40 }, (_, index) =>
      commitment(`c${String(index).padStart(3, '0')}`, 120 + index * 10));
    const { desired, overCap } = desiredRequests(input({ commitments }));

    // Forty commitments, two stages each: eighty wanted, fifty kept.
    expect(desired).toHaveLength(MAX_PENDING_REQUESTS);
    expect(overCap).toHaveLength(80 - MAX_PENDING_REQUESTS);

    // Nearest first, so what survives is what is about to happen.
    const latestKept = Math.max(...desired.map(request => request.at));
    const earliestCut = Math.min(...overCap.map(identifier => {
      const match = commitments.find(item => identifier.startsWith(`${item.id}:`));
      return Date.parse(match?.startsAt as string);
    }));
    expect(latestKept).toBeLessThanOrEqual(earliestCut);
  });
});

describe('the kill switch', () => {
  it('cancels everything, including another feature s requests', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('c1', 120)] }), gateway);
    gateway.put('must-reminder-7', NOW.getTime() + 60_000);

    await cancelEveryReminder(gateway);

    // The one place `cancelAll` is right: a switch that left another feature's
    // pending requests behind would still interrupt the user.
    expect(gateway.cancelledAll).toBe(1);
    expect(gateway.pending.size).toBe(0);
  });

  it('schedules nothing when the account turned reminders off', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({
      commitments: [commitment('c1', 120)],
      settings: { ...RING, softEnabled: false, intensity: 'strongReminder' },
    }), gateway);
    expect(gateway.scheduledRequests).toEqual([]);
  });
});

/*
 * ── The Must stage, on the OS and on the receipt (UC-3.12a, #197) ─────────
 */
describe('the Must stage', () => {
  it('goes on the Must channel and category, with the bundled sound, at Time Sensitive', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('m1', 120, 'must')], settings: RING }), gateway);

    const strong = gateway.scheduledRequests.find(request => request.identifier === 'm1:strong');
    expect(strong).toBeDefined();
    expect(strong).toMatchObject({
      channelId: HARD_CHANNEL_ID,
      categoryIdentifier: HARD_CATEGORY_ID,
      sound: HARD_SOUND,
      interruptionLevel: 'timeSensitive',
      title: 'A Must item starts soon',
    });
    expect(strong!.at.getTime()).toBe(NOW.getTime() + 110 * 60_000);
    // The same id-only payload as every other stage.
    expect(Object.keys(strong!.data).sort()).toEqual(['commitmentId', 'notificationId', 'stage']);
  });

  it('leaves the gentle stages of a Must commitment gentle', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({ commitments: [commitment('m1', 120, 'must')], settings: RING }), gateway);
    for (const request of gateway.scheduledRequests.filter(entry => entry.identifier !== 'm1:strong')) {
      expect(request.channelId).toBe(AWARENESS_CHANNEL_ID);
      expect(request.categoryIdentifier).toBe(AWARENESS_CATEGORY_ID);
      expect(request.sound).toBeUndefined();
      expect(request.interruptionLevel).toBeUndefined();
    }
  });

  it('never rings a Should or a Nice, even at the hard ceiling', async () => {
    const gateway = fakeGateway();
    await syncCommitments(input({
      commitments: [commitment('s1', 120, 'should'), commitment('n1', 120, 'nice')],
      settings: RING,
    }), gateway);
    expect(gateway.scheduledRequests.filter(request => request.identifier.endsWith(':strong'))).toEqual([]);
    expect(gateway.scheduledRequests.filter(request => request.channelId === HARD_CHANNEL_ID)).toEqual([]);
  });

  it('is placed first under the pending-request cap', () => {
    // Sixty Should commitments in the next hours, and one Must days away.
    const near = Array.from({ length: 60 }, (_, index) =>
      commitment(`s${String(index).padStart(3, '0')}`, 120 + index));
    const far = commitment('m-far', 5 * 24 * 60, 'must');
    const { desired, overCap } = desiredRequests(input({ commitments: [...near, far], settings: RING }));

    expect(desired).toHaveLength(MAX_PENDING_REQUESTS);
    expect(desired.map(request => request.identifier)).toContain('m-far:strong');
    expect(overCap).not.toContain('m-far:strong');
  });
});

describe('receipts for the server (#197 step 5, uploaded by #198)', () => {
  it('reports each pending Must stage with its nominal instant and the exact-alarm answer', async () => {
    const gateway = fakeGateway();
    const must = commitment('m1', 120, 'must');
    const report = await syncCommitments(input({
      commitments: [must, commitment('s1', 120, 'should')],
      settings: RING,
      exactAlarms: false,
    }), gateway);

    expect(report.hardReceipts).toEqual([{
      commitmentId: 'm1',
      notificationId: 'm1:strong',
      fireAt: new Date(Date.parse(must.startsAt as string) - 10 * 60_000).toISOString(),
      exact: false,
    }]);
  });

  it('reports a kept Must stage too, so a changed permission still reaches the server', async () => {
    const gateway = fakeGateway();
    const must = commitment('m1', 120, 'must');
    await syncCommitments(input({ commitments: [must], settings: RING, exactAlarms: false }), gateway);
    const second = await syncCommitments(input({ commitments: [must], settings: RING, exactAlarms: true }), gateway);
    expect(second.kept).toContain('m1:strong');
    expect(second.hardReceipts.map(receipt => [receipt.notificationId, receipt.exact])).toEqual([['m1:strong', true]]);
  });

  it('makes no receipt for a Must stage that is not pending', async () => {
    const gateway = fakeGateway();
    // Inside ten minutes: the stage is already behind us and is not scheduled,
    // so a receipt would tell the server the phone will ring when it will not.
    const report = await syncCommitments(input({ commitments: [commitment('m1', 8, 'must')], settings: RING }), gateway);
    expect(report.hardReceipts).toEqual([]);
    // Nor for an account that has not opted in.
    const off = await syncCommitments(input({
      commitments: [commitment('m2', 120, 'must')],
      settings: { ...RING, hardEnabled: false },
    }), fakeGateway());
    expect(off.hardReceipts).toEqual([]);
  });

  it('makes no receipt for a Must stage cut by the cap', () => {
    // The receipt set is built from what was scheduled or kept, not from what
    // was planned — checked through the pure half, where the cap is visible.
    const musts = Array.from({ length: MAX_PENDING_REQUESTS + 5 }, (_, index) =>
      commitment(`m${String(index).padStart(3, '0')}`, 120 + index, 'must'));
    const { desired, overCap } = desiredRequests(input({ commitments: musts, settings: RING }));
    expect(desired.every(request => request.identifier.endsWith(':strong'))).toBe(true);
    expect(overCap.filter(identifier => identifier.endsWith(':strong'))).toHaveLength(5);
  });
});

describe('Must reminders and quiet hours', () => {
  it('names the reminder on its receipt by its planned instant, not where quiet hours moved it', async () => {
    const zone = 'Pacific/Chatham';
    const minutesAt = (at: number) => withHermesIntl(() => {
      const clock = wallClockIn(new Date(at), zone);
      return clock.hour * 60 + clock.minute;
    });
    // A Must commitment at 07:07: its ring at 06:57 is inside 22:00–07:00 and
    // moves to 07:00, still seven minutes ahead, so it is kept — deferred.
    let start = NOW.getTime() + 2 * 3_600_000;
    while (minutesAt(start) !== 7 * 60 + 7) start += 60_000;
    const must: ReminderCommitment = {
      id: 'm1', startsAt: new Date(start).toISOString(), status: 'active', priority: 'must', allDay: false,
    };
    const gateway = fakeGateway();
    const report = await withHermesIntl(() => syncCommitments(input({
      commitments: [must],
      settings: RING,
      quietHours: { start: '22:00', end: '07:00' },
      timeZone: zone,
    }), gateway));

    expect(gateway.pending.get('m1:strong')).toBe(start - 7 * 60_000);
    // The server indexes the reminder at start − 10 minutes (#198), so that is
    // the instant the receipt has to name, or it is ignored as stale.
    expect(report.hardReceipts.map(receipt => receipt.fireAt))
      .toEqual([new Date(start - 10 * 60_000).toISOString()]);
  });

  it('lets only the strong stage through when the user allowed it', () => {
    withHermesIntl(() => {
      const zone = 'Pacific/Chatham';
      const minutesAt = (at: number) => {
        const clock = wallClockIn(new Date(at), zone);
        return clock.hour * 60 + clock.minute;
      };
      // A Must commitment at 06:30 on the zone's clock: every stage — 05:30,
      // 06:00, 06:20 — is inside 22:00–07:00.
      let start = NOW.getTime() + 2 * 3_600_000;
      while (minutesAt(start) !== 6 * 60 + 30) start += 60_000;
      const must: ReminderCommitment = {
        id: 'm1', startsAt: new Date(start).toISOString(), status: 'active', priority: 'must', allDay: false,
      };
      const quiet = { start: '22:00', end: '07:00' };

      const through = desiredRequests(input({
        commitments: [must],
        settings: { ...RING, mustThroughQuietHours: true },
        quietHours: quiet,
        timeZone: zone,
      }));
      expect(through.desired.map(request => request.identifier)).toEqual(['m1:strong']);
      expect(through.desired[0]!.at).toBe(start - 10 * 60_000);
      // The gentle stages still wait — and here waiting past the start drops them.
      expect(through.droppedForQuietHours.sort()).toEqual(['m1:followUp', 'm1:soft']);

      const held = desiredRequests(input({
        commitments: [must],
        settings: { ...RING, mustThroughQuietHours: false },
        quietHours: quiet,
        timeZone: zone,
      }));
      expect(held.desired).toEqual([]);
      expect(held.droppedForQuietHours).toContain('m1:strong');
    });
  });
});
