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
import { INTELLIGENCE_MONITORS, userCol, userDoc } from '../storage/paths';

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
    const [storedUser, monitor] = await Promise.all([
      tx.get<Record<string, unknown>>(path),
      tx.get<{ enabled?: boolean; cursor?: string | null; pageToken?: string | null; m5?: {
        pauseEpoch?: number; pausedSince?: string | null; excluded?: Array<{ from: string; to: string }>;
      } }>(monitorPath),
    ]);
    const user = storedUser ?? { uid };
    const nextSettings: MonitoringSettings = { paused, updatedAt: now };
    tx.set(path, {
      ...user,
      monitoringSettings: nextSettings,
      monitoringPaused: paused,
    });
    if (monitor?.m5) {
      const wasPaused = monitor.m5.pausedSince !== null && monitor.m5.pausedSince !== undefined;
      if (paused && !wasPaused) tx.set(monitorPath, {
        ...monitor,
        m5: { ...monitor.m5, pausedSince: now, pauseEpoch: (monitor.m5.pauseEpoch ?? 0) + 1 },
      });
      if (!paused && wasPaused) tx.set(monitorPath, {
        ...monitor,
        cursor: null,
        pageToken: null,
        m5: {
          ...monitor.m5,
          pausedSince: null,
          pauseEpoch: (monitor.m5.pauseEpoch ?? 0) + 1,
          excluded: [...(monitor.m5.excluded ?? []), { from: monitor.m5.pausedSince!, to: now }].slice(-32),
        },
      });
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
