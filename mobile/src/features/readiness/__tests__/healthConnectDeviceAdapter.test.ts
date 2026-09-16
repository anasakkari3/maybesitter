import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

import {
  createHealthConnectNativePort,
  type HealthConnectReadinessNativeModule,
} from '../../../../modules/health-connect-readiness';

const NOW = '2026-09-16T12:00:00.000Z';
const WINDOW_START = '2026-09-15T12:00:00.000Z';
const MINIMUM_READ_PERMISSIONS = [
  'sleep_session',
  'resting_heart_rate',
  'heart_rate_variability_rmssd',
  'steps',
] as const;

function nativeModule(
  overrides: Partial<HealthConnectReadinessNativeModule> = {},
): HealthConnectReadinessNativeModule {
  return {
    isSdkAvailable: async () => true,
    authorization: async (read) => ({ state: 'authorized', granted: read, denied: [], checkedAt: NOW }),
    requestAuthorization: async (read) => ({ state: 'authorized', granted: read, denied: [], checkedAt: NOW }),
    readRecords: async () => ({
      sleep: {
        observedAt: NOW,
        sleepStart: '2026-09-15T22:00:00.000Z',
        sleepEnd: '2026-09-16T06:00:00.000Z',
        totalSleepMinutes: 480,
      },
      heart: { observedAt: NOW, restingHeartRate: 58, hrvMilliseconds: 62 },
      steps: { observedAt: NOW, count: 2400 },
    }),
    revokeAllPermissions: async () => undefined,
    clearLocalConnection: async () => undefined,
    ...overrides,
  };
}

describe('Health Connect device readiness bridge', () => {
  it('passes the canonical minimum through the native port and returns native records', async () => {
    const requested: string[][] = [];
    const native = nativeModule({
      requestAuthorization: async (read) => {
        requested.push([...read]);
        return { state: 'authorized', granted: read, denied: [], checkedAt: NOW };
      },
    });
    const port = createHealthConnectNativePort(native);

    await expect(port.requestAuthorization(MINIMUM_READ_PERMISSIONS)).resolves.toMatchObject({ state: 'authorized' });
    expect(requested).toEqual([[...MINIMUM_READ_PERMISSIONS]]);
    await expect(port.readRecords({
      windowStart: WINDOW_START,
      windowEnd: NOW,
    })).resolves.toMatchObject({
      sleep: { totalSleepMinutes: 480 },
      heart: { restingHeartRate: 58, hrvMilliseconds: 62 },
      steps: { count: 2400 },
    });
    const composition = readFileSync('src/features/readiness/healthConnectDeviceAdapter.ts', 'utf8');
    expect(composition).toMatch(/new HealthConnectReadinessAdapter/);
    expect(composition).toMatch(/createHealthConnectNativePort/);
  });

  it('fails closed when the native module is absent', async () => {
    const port = createHealthConnectNativePort(null);
    await expect(port.isSdkAvailable()).resolves.toBe(false);
    await expect(port.authorization(MINIMUM_READ_PERMISSIONS)).resolves.toMatchObject({ state: 'unavailable' });
    await expect(port.readRecords({
      windowStart: WINDOW_START,
      windowEnd: NOW,
    })).resolves.toEqual({});
  });

  it('native revoke and local clear calls remain independently delegated', async () => {
    const calls: string[] = [];
    const revokeAllPermissions = jest.fn(async () => { calls.push('revoke'); });
    const clearLocalConnection = jest.fn(async () => { calls.push('clear'); });
    const port = createHealthConnectNativePort(nativeModule({
      revokeAllPermissions,
      clearLocalConnection,
    }));

    await port.revokeAllPermissions();
    await port.clearLocalConnection();
    expect(calls).toEqual(['revoke', 'clear']);
  });
});
