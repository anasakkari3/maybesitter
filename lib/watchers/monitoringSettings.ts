/**
 * Account-level background monitoring controls (#527).
 *
 * A single account-level pause switch: when paused, watchers still exist,
 * connections stay connected, and sweeps/observations still run and update
 * runtime state (lastObservedAt, baseline digest), but no user-affecting
 * effects fire. When unpaused, effects resume normally without replaying
 * state that changed while paused.
 */
import { getStorage, type StorageAdapter } from '../storage';
import { INTELLIGENCE_MONITORS, INTELLIGENCE_SOURCE_MARKERS, userCol, userDoc } from '../storage/paths';
import { INTELLIGENCE_GMAIL_SCANS } from '../storage/paths';
import { legacyMarkerIdFor, providerMarkerIdFor, type M5aMarker } from '../intelligence/m5aGmailScan';

export interface MonitoringSettings {
  readonly paused: boolean;
  readonly updatedAt: string | null;
}

export interface MonitoringSettingsBearingUser {
  readonly monitoringSettings?: MonitoringSettings;
  readonly monitoringPaused?: boolean;
}

export const DEFAULT_MONITORING_SETTINGS: MonitoringSettings = Object.freeze({
  paused: false,
  updatedAt: null,
});

export interface PauseInterval { readonly from: string; readonly to: string }

/** Coalesces overlaps, then merges the closest gaps in the privacy-safe direction. */
export function coalescePauseIntervals(intervals: readonly PauseInterval[], cap = 32): PauseInterval[] {
  const sorted = intervals
    .filter(row => Number.isFinite(Date.parse(row.from)) && Number.isFinite(Date.parse(row.to)))
    .map(row => ({ from: row.from, to: new Date(Math.max(Date.parse(row.from), Date.parse(row.to))).toISOString() }))
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  const merged: PauseInterval[] = [];
  for (const row of sorted) {
    const previous = merged.at(-1);
    if (previous && Date.parse(row.from) <= Date.parse(previous.to)) {
      merged[merged.length - 1] = { from: previous.from, to: new Date(Math.max(Date.parse(previous.to), Date.parse(row.to))).toISOString() };
    } else merged.push(row);
  }
  while (merged.length > cap) {
    let closest = 0;
    let gap = Number.POSITIVE_INFINITY;
    for (let index = 0; index < merged.length - 1; index++) {
      const candidate = Date.parse(merged[index + 1]!.from) - Date.parse(merged[index]!.to);
      if (candidate < gap) { gap = candidate; closest = index; }
    }
    merged.splice(closest, 2, { from: merged[closest]!.from, to: merged[closest + 1]!.to });
  }
  return merged;
}

export class MonitoringSettingsValidationError extends Error {
  constructor(message: string, readonly reason: string = 'invalid_argument') {
    super(message);
    this.name = 'MonitoringSettingsValidationError';
  }
}

export async function readMonitoringSettings(
  uid: string,
  deps: { storage?: StorageAdapter } = {},
): Promise<MonitoringSettings> {
  const storage = deps.storage ?? getStorage();
  const user = await storage.get<MonitoringSettingsBearingUser>(userDoc(uid));
  const paused = Boolean(user?.monitoringSettings?.paused ?? user?.monitoringPaused ?? false);
  const updatedAt = user?.monitoringSettings?.updatedAt ?? null;
  return { paused, updatedAt };
}

export async function saveMonitoringSettings(
  uid: string,
  paused: boolean,
  now: string = new Date().toISOString(),
  deps: { storage?: StorageAdapter } = {},
): Promise<MonitoringSettings> {
  if (typeof paused !== 'boolean') {
    throw new MonitoringSettingsValidationError('paused must be a boolean', 'invalid_paused');
  }
  const storage = deps.storage ?? getStorage();
  const path = userDoc(uid);
  return storage.runTransaction(async (tx) => {
    const monitorPath = `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`;
    const dailyPath = `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/dailyV2`;
    const [storedUser, monitor, daily] = await Promise.all([
      tx.get<Record<string, unknown>>(path),
      tx.get<{ enabled?: boolean; cursor?: string | null; pageToken?: string | null; m5?: {
        providerAccountId?: string;
        pauseEpoch?: number; pausedSince?: string | null; excluded?: Array<{ from: string; to: string }>;
        nextSweepAt?: string; pendingSweepDay?: string; sweepTimezone?: string;
      }; waitingMessageId?: string | null }>(monitorPath),
      tx.get<Record<string, unknown>>(dailyPath),
    ]);
    const user = storedUser ?? { uid };
    if (monitor?.waitingMessageId && monitor.m5?.providerAccountId) {
      const ids = [providerMarkerIdFor(uid, monitor.m5.providerAccountId, monitor.waitingMessageId),
        legacyMarkerIdFor(monitor.waitingMessageId)];
      const markers = await Promise.all(ids.map(id => tx.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${id}`)));
      markers.forEach((marker, index) => {
        if (marker?.state === 'waiting_for_calendar') tx.set(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${ids[index]}`, {
          ...marker, state: 'released', origin: undefined, requestedAt: undefined, nextEligibleAt: undefined,
        });
      });
    }
    const nextSettings: MonitoringSettings = { paused, updatedAt: now };
    tx.set(path, {
      ...user,
      monitoringSettings: nextSettings,
      monitoringPaused: paused,
    });
    if (monitor?.m5) {
      const wasPaused = monitor.m5.pausedSince !== null && monitor.m5.pausedSince !== undefined;
      if (paused && !wasPaused) {
        const { nextSweepAt: _nextSweepAt, ...m5 } = monitor.m5;
        tx.set(monitorPath, {
          ...monitor,
          waitingMessageId: null,
          m5: { ...m5, pausedSince: now, pauseEpoch: (monitor.m5.pauseEpoch ?? 0) + 1 },
        });
        if (daily && (daily.status === 'running' || daily.status === 'failed')) {
          const { nextEligibleAt: _nextEligibleAt, ...held } = daily;
          tx.set(dailyPath, { ...held, leaseOwner: null, leaseUntil: null });
        }
      }
      if (!paused && wasPaused) {
        const end = new Date(Math.max(Date.parse(monitor.m5.pausedSince!), Date.parse(now))).toISOString();
        // Re-arm immediately. The sweep recovery transaction re-reads the
        // account timezone and computes the exact local-day boundary.
        const nextSweepAt = monitor.m5.sweepTimezone && monitor.m5.pendingSweepDay ? now : undefined;
        tx.set(monitorPath, {
        ...monitor,
        waitingMessageId: null,
        cursor: null,
        pageToken: null,
        m5: {
          ...monitor.m5,
          pausedSince: null,
          pauseEpoch: (monitor.m5.pauseEpoch ?? 0) + 1,
          excluded: coalescePauseIntervals([...(monitor.m5.excluded ?? []), { from: monitor.m5.pausedSince!, to: end }]),
          ...(nextSweepAt ? { nextSweepAt } : {}),
        },
      });
        if (daily && (daily.status === 'running' || daily.status === 'failed')) tx.set(dailyPath, {
          ...daily, nextEligibleAt: now, leaseOwner: null, leaseUntil: null,
        });
      }
    }
    return nextSettings;
  });
}

export async function isMonitoringPaused(
  uid: string,
  storage: StorageAdapter,
  tx?: { get<T>(path: string): Promise<T | null> },
): Promise<boolean> {
  const reader = tx ?? storage;
  const user = await reader.get<MonitoringSettingsBearingUser>(userDoc(uid));
  return Boolean(user?.monitoringSettings?.paused ?? user?.monitoringPaused ?? false);
}
