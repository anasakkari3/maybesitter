import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_MONITORS, INTELLIGENCE_SOURCE_MARKERS,
  createMemoryStorage, userCol,
} from '../../lib/storage';
import type { StorageAdapter, StorageTransaction } from '../../lib/storage/storageAdapter';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';
import { cleanupCalendarWaits, gmailTickScope, runGmailJobTick } from '../../lib/intelligence/gmailJobs';
import type { M5aMarker } from '../../lib/intelligence/m5aGmailScan';

// The gate for the scheduled M5a work, one case per combination that matters:
// environment flags, kill switch, controls availability, and waiting-marker
// state. Every case runs against the memory adapter, never a hosted service.

const NOW = '2026-10-20T10:00:00.000Z';
const PAST = '2026-10-20T09:00:00.000Z';
const STAGING = { MAYBESITTER_ENV: 'staging' };
const EMAIL_ON = { ...STAGING, MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' };
const ALL_ON = {
  ...EMAIL_ON,
  MAYBESITTER_FEATURE_CALENDAR_CHOICE: 'true',
  MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true',
};

function markerId(index: number): string {
  return String(index).padStart(64, '0');
}

async function seedWaitingMarker(storage: StorageAdapter, uid: string, index: number, emailEpoch: number): Promise<string> {
  const path = `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${markerId(index)}`;
  const marker: M5aMarker = {
    v: 2, state: 'waiting_for_calendar', providerAccountId: 'acct', emailEpoch,
    origin: { kind: 'scan', scanId: `scan-${uid}`, scanKind: 'manual' },
    requestedAt: PAST, nextEligibleAt: PAST,
  } as unknown as M5aMarker;
  await storage.set(path, marker);
  return path;
}

async function seedManualScan(storage: StorageAdapter, uid: string, status: 'running' | 'failed' | 'completed'): Promise<void> {
  await storage.set(`${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/manualV2`, {
    scanId: `scan-${uid}`, kind: 'manual', status, nextEligibleAt: PAST,
  });
}

async function controls(storage: StorageAdapter, value: unknown): Promise<void> {
  await storage.set('system/m5aControls', value);
}

/**
 * Wraps the adapter so every write is counted, including the writes made inside
 * transactions. Reads pass through untouched.
 */
function countingStorage(inner: StorageAdapter): { storage: StorageAdapter; writes: string[] } {
  const writes: string[] = [];
  const WRITERS = new Set(['set', 'delete', 'update', 'create', 'deleteTree']);
  // A plain copy rather than a Proxy: the adapter has non-configurable members
  // that a Proxy cannot answer for.
  const wrap = (target: object, transact: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Array.from(new Set(allKeys(target)))) {
      if (key === 'constructor') continue;
      const value = (target as Record<string, unknown>)[key];
      if (typeof value !== 'function') { out[key] = value; continue; }
      const fn = value as (...args: unknown[]) => unknown;
      if (transact && key === 'runTransaction') {
        out[key] = (work: (tx: unknown) => unknown) => fn.call(target, (tx: unknown) => work(wrap(tx as object, false)));
      } else if (WRITERS.has(key)) {
        out[key] = (path: string, ...rest: unknown[]) => {
          writes.push(`${key} ${path}`);
          return fn.call(target, path, ...rest);
        };
      } else {
        out[key] = (...args: unknown[]) => fn.apply(target, args);
      }
    }
    return out;
  };
  return { storage: wrap(inner, true) as unknown as StorageAdapter, writes };
}

function allKeys(target: object): string[] {
  const keys: string[] = [];
  for (let o: object | null = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    keys.push(...Object.getOwnPropertyNames(o));
  }
  return keys;
}

function runtimeWith(storage: StorageAdapter, env: Record<string, string>): GoogleRuntime {
  return {
    storage, env: env as GoogleRuntime['env'], secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
  } as GoogleRuntime;
}

async function markerState(storage: StorageAdapter, path: string): Promise<string | undefined> {
  return (await storage.get<M5aMarker>(path))?.state;
}

// ── The environment matrix ─────────────────────────────────────────────

test('gate matrix: each switch is separate, and the email capability needs its flag, an allowed environment and no kill', () => {
  const cases: Array<[string, Record<string, string>, { monitor: boolean; emailSources: boolean; calendarChoice: boolean }]> = [
    ['nothing set', {}, { monitor: false, emailSources: false, calendarChoice: false }],
    ['staging, email flag only', EMAIL_ON, { monitor: false, emailSources: true, calendarChoice: false }],
    ['staging, email flag and its kill switch', { ...EMAIL_ON, MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES: 'true' },
      { monitor: false, emailSources: false, calendarChoice: false }],
    ['staging, email flag with kill switch set to false', { ...EMAIL_ON, MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES: 'false' },
      { monitor: false, emailSources: true, calendarChoice: false }],
    ['production pins M5a off even with the flags on', { ...ALL_ON, MAYBESITTER_ENV: 'production' },
      { monitor: true, emailSources: false, calendarChoice: false }],
    ['local allows M5a, but the proactive loop is only staging and production', { MAYBESITTER_ENV: 'local',
      MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' },
      { monitor: false, emailSources: true, calendarChoice: false }],
    ['the monitor does not depend on the email flag', { ...STAGING, MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' },
      { monitor: true, emailSources: false, calendarChoice: false }],
    ['the proactive kill switch stops the monitor and leaves M5a alone', { ...ALL_ON, MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP: 'true' },
      { monitor: false, emailSources: true, calendarChoice: true }],
    ['calendar flag is independent of email', { ...STAGING, MAYBESITTER_FEATURE_CALENDAR_CHOICE: 'true' },
      { monitor: false, emailSources: false, calendarChoice: true }],
    ['unknown environment name fails closed', { MAYBESITTER_ENV: 'dev', MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' },
      { monitor: false, emailSources: false, calendarChoice: false }],
  ];
  for (const [name, env, expected] of cases) {
    assert.deepEqual(gmailTickScope(env), expected, name);
  }
});

// ── Cleanup: what it may release, by controls state ───────────────────

test('cleanup with no controls document releases nothing and writes nothing', async () => {
  const inner = createMemoryStorage();
  const uid = 'u-missing';
  const path = await seedWaitingMarker(inner, uid, 1, 1);
  const { storage, writes } = countingStorage(inner);
  assert.equal(await cleanupCalendarWaits(storage, new Date(NOW)), 0);
  assert.equal(await markerState(inner, path), 'waiting_for_calendar');
  assert.deepEqual(writes, []);
});

test('cleanup with an invalid controls document releases nothing', async () => {
  const inner = createMemoryStorage();
  const path = await seedWaitingMarker(inner, 'u-invalid', 1, 1);
  await controls(inner, { email: { enabled: 'yes', epoch: 1 }, calendar: { enabled: false, epoch: 0 } });
  assert.equal(await cleanupCalendarWaits(inner, new Date(NOW)), 0);
  assert.equal(await markerState(inner, path), 'waiting_for_calendar');
});

test('cleanup with a valid document that disables email releases the stale wait (the documented kill fence)', async () => {
  const inner = createMemoryStorage();
  const path = await seedWaitingMarker(inner, 'u-killed', 1, 1);
  await controls(inner, { email: { enabled: false, epoch: 2 }, calendar: { enabled: false, epoch: 0 } });
  assert.equal(await cleanupCalendarWaits(inner, new Date(NOW)), 1);
  assert.equal(await markerState(inner, path), 'released');
});

test('cleanup keeps the wait when the controls document vanishes between the pre-check and the transaction', async () => {
  const inner = createMemoryStorage();
  const path = await seedWaitingMarker(inner, 'u-race', 1, 1);
  await controls(inner, { email: { enabled: false, epoch: 2 }, calendar: { enabled: false, epoch: 0 } });
  const { storage } = countingStorage(inner);
  // The pre-check sees a valid, disabled document; inside the transaction the
  // document reads as absent. Without the in-transaction guard this would release.
  const racing = {
    ...storage,
    runTransaction: (work: (tx: StorageTransaction) => Promise<unknown>) => storage.runTransaction(
      (tx: StorageTransaction) => work({
        ...tx,
        get: async (p: string) => (p === 'system/m5aControls' ? null : tx.get(p)),
      } as unknown as StorageTransaction),
    ),
  } as unknown as StorageAdapter;
  assert.equal(await cleanupCalendarWaits(racing, new Date(NOW)), 0);
  assert.equal(await markerState(inner, path), 'waiting_for_calendar');
});

test('cleanup keeps an authorized wait: enabled, same epoch, scan still running', async () => {
  const inner = createMemoryStorage();
  const uid = 'u-authorized';
  const path = await seedWaitingMarker(inner, uid, 1, 1);
  await seedManualScan(inner, uid, 'running');
  await controls(inner, { email: { enabled: true, epoch: 1 }, calendar: { enabled: false, epoch: 0 } });
  assert.equal(await cleanupCalendarWaits(inner, new Date(NOW)), 0);
  assert.equal(await markerState(inner, path), 'waiting_for_calendar');
});

test('cleanup releases a wait whose epoch has moved on, even when email is enabled again', async () => {
  const inner = createMemoryStorage();
  const uid = 'u-reenabled';
  const path = await seedWaitingMarker(inner, uid, 1, 1);
  await seedManualScan(inner, uid, 'running');
  await controls(inner, { email: { enabled: true, epoch: 2 }, calendar: { enabled: false, epoch: 0 } });
  assert.equal(await cleanupCalendarWaits(inner, new Date(NOW)), 1);
  assert.equal(await markerState(inner, path), 'released');
});

test('cleanup releases a wait whose scan is gone, and keeps the one whose scan is running', async () => {
  const inner = createMemoryStorage();
  const kept = await seedWaitingMarker(inner, 'u-with-scan', 1, 1);
  await seedManualScan(inner, 'u-with-scan', 'running');
  const released = await seedWaitingMarker(inner, 'u-no-scan', 2, 1);
  await controls(inner, { email: { enabled: true, epoch: 1 }, calendar: { enabled: false, epoch: 0 } });
  assert.equal(await cleanupCalendarWaits(inner, new Date(NOW)), 1);
  assert.equal(await markerState(inner, kept), 'waiting_for_calendar');
  assert.equal(await markerState(inner, released), 'released');
});

test('cleanup is idempotent: a second run over the same state releases nothing and writes nothing', async () => {
  const inner = createMemoryStorage();
  const path = await seedWaitingMarker(inner, 'u-twice', 1, 1);
  await controls(inner, { email: { enabled: false, epoch: 2 }, calendar: { enabled: false, epoch: 0 } });
  assert.equal(await cleanupCalendarWaits(inner, new Date(NOW)), 1);
  const { storage, writes } = countingStorage(inner);
  assert.equal(await cleanupCalendarWaits(storage, new Date(NOW)), 0);
  assert.equal(await markerState(inner, path), 'released');
  assert.deepEqual(writes, []);
});

test('cleanup isolates accounts: one account authorized, one not, only the other is touched', async () => {
  const inner = createMemoryStorage();
  const ok = await seedWaitingMarker(inner, 'acct-a', 1, 1);
  await seedManualScan(inner, 'acct-a', 'failed');
  const stale = await seedWaitingMarker(inner, 'acct-b', 2, 1);
  await controls(inner, { email: { enabled: true, epoch: 1 }, calendar: { enabled: false, epoch: 0 } });
  assert.equal(await cleanupCalendarWaits(inner, new Date(NOW)), 1);
  assert.equal(await markerState(inner, ok), 'waiting_for_calendar', 'the authorized account keeps its wait');
  assert.equal(await markerState(inner, stale), 'released');
});

// ── The tick: disabled work creates nothing ───────────────────────────

test('sweep tick with email off creates no scan and writes nothing, even with a due monitor and enabled controls', async () => {
  const inner = createMemoryStorage();
  const uid = 'u-due';
  await controls(inner, { email: { enabled: true, epoch: 1 }, calendar: { enabled: false, epoch: 0 } });
  await inner.set(`${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`, {
    enabled: true, generation: 'g1', nextPollAt: PAST, proposalsPending: false,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: PAST, timezone: 'UTC', at: PAST,
      pauseEpoch: 0, pausedSince: null, excluded: [], nextSweepAt: PAST },
  });
  const { storage, writes } = countingStorage(inner);
  const result = await runGmailJobTick('sweep', { runtime: runtimeWith(storage, STAGING) });
  assert.equal(result.processed, 0);
  assert.deepEqual(writes, []);
});

test('sweep tick with the kill switch set creates no scan, even when the email flag is on', async () => {
  const inner = createMemoryStorage();
  const uid = 'u-killed-tick';
  await controls(inner, { email: { enabled: true, epoch: 1 }, calendar: { enabled: false, epoch: 0 } });
  await inner.set(`${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`, {
    enabled: true, generation: 'g1', nextPollAt: PAST, proposalsPending: false,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: PAST, timezone: 'UTC', at: PAST,
      pauseEpoch: 0, pausedSince: null, excluded: [], nextSweepAt: PAST },
  });
  const { storage, writes } = countingStorage(inner);
  const result = await runGmailJobTick('sweep', {
    runtime: runtimeWith(storage, { ...EMAIL_ON, MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES: 'true' }),
  });
  assert.equal(result.processed, 0);
  assert.deepEqual(writes, []);
});

test('an env-only change does not release an authorized wait: the controls still authorize it', async () => {
  const inner = createMemoryStorage();
  const uid = 'u-env-only';
  const path = await seedWaitingMarker(inner, uid, 1, 1);
  await seedManualScan(inner, uid, 'running');
  await controls(inner, { email: { enabled: true, epoch: 1 }, calendar: { enabled: false, epoch: 0 } });
  // The environment says off; the document still authorizes. Nothing is released.
  await runGmailJobTick('sweep', { runtime: runtimeWith(inner, STAGING) });
  assert.equal(await markerState(inner, path), 'waiting_for_calendar');
});

test('calendar maintenance does not run when its env capability is off, even if its controls are enabled', async () => {
  const inner = createMemoryStorage();
  await controls(inner, { email: { enabled: false, epoch: 0 }, calendar: { enabled: true, epoch: 1 } });
  const { storage, writes } = countingStorage(inner);
  await runGmailJobTick('sweep', { runtime: runtimeWith(storage, STAGING) });
  assert.deepEqual(writes, []);
});

// ── The live tick: no writes and no provider call when every switch is off ──

async function seedDueMonitors(storage: StorageAdapter): Promise<void> {
  // One enrolled (M5a) monitor with proposals pending, one legacy monitor.
  await storage.set(`${userCol('u-live-m5', INTELLIGENCE_MONITORS)}/gmail`, {
    enabled: true, generation: 'g1', nextPollAt: PAST, proposalsPending: true, proposalNextEligibleAt: PAST,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: PAST, timezone: 'UTC', at: PAST,
      pauseEpoch: 0, pausedSince: null, excluded: [], nextSweepAt: PAST },
  });
  await storage.set(`${userCol('u-live-legacy', INTELLIGENCE_MONITORS)}/gmail`, {
    enabled: true, generation: 'g1', nextPollAt: PAST,
  });
}

for (const [name, env] of [
  ['nothing set', {}],
  ['staging, every flag on but every kill switch set', {
    ...ALL_ON,
    MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP: 'true',
    MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES: 'true',
    MAYBESITTER_KILL_SWITCH_CALENDAR_CHOICE: 'true',
  }],
  ['staging, no flag on', STAGING],
] as Array<[string, Record<string, string>]>) {
  for (const route of ['live', 'sweep'] as const) {
    test(`${route} tick with ${name}: no Firestore write and no provider call, even with due monitors and enabled controls`, async () => {
      const inner = createMemoryStorage();
      await controls(inner, { email: { enabled: true, epoch: 1 }, calendar: { enabled: true, epoch: 1 } });
      await seedDueMonitors(inner);
      const { storage, writes } = countingStorage(inner);
      const calls: string[] = [];
      const runtime = {
        ...runtimeWith(storage, env),
        fetchImpl: (async (input: unknown) => { calls.push(`fetch ${String(input)}`); throw new Error('no network'); }) as typeof fetch,
      } as GoogleRuntime;
      const result = await runGmailJobTick(route, {
        runtime,
        transport: (uid: string) => { calls.push(`transport ${uid}`); throw new Error('no provider'); },
        ensureReadable: async (uid: string) => { calls.push(`readable ${uid}`); },
      });
      assert.equal(result.processed, 0);
      assert.deepEqual(writes, []);
      assert.deepEqual(calls, []);
    });
  }
}
