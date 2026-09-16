import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

import {
  createHealthKitNativePort,
  type HealthKitReadinessNativeModule,
} from '../../../../modules/healthkit-readiness';

const NOW = '2026-09-16T12:00:00.000Z';
const WINDOW_START = '2026-09-15T12:00:00.000Z';
const MINIMUM_READ_PERMISSIONS = [
  'sleep_analysis',
  'resting_heart_rate',
  'heart_rate_variability_sdnn',
  'step_count',
] as const;

function nativeModule(overrides: Partial<HealthKitReadinessNativeModule> = {}): HealthKitReadinessNativeModule {
  return {
    isAvailable: async () => true,
    authorization: async (read) => ({ state: 'limited', granted: read, denied: [], checkedAt: NOW }),
    requestAuthorization: async (read) => ({ state: 'limited', granted: read, denied: [], checkedAt: NOW }),
    readSamples: async () => ({
      sleep: {
        observedAt: NOW,
        sleepStart: '2026-09-15T22:00:00.000Z',
        sleepEnd: '2026-09-16T06:00:00.000Z',
        totalSleepMinutes: 480,
      },
      heart: { observedAt: NOW, restingHeartRate: 58, hrvMilliseconds: 62 },
      activity: { observedAt: NOW, stepCount: 2400 },
    }),
    clearLocalConnection: async () => undefined,
    ...overrides,
  };
}

describe('HealthKit device readiness bridge', () => {
  it('passes the canonical minimum through the native port and returns native samples', async () => {
    const requested: string[][] = [];
    const native = nativeModule({
      requestAuthorization: async (read) => {
        requested.push([...read]);
        return { state: 'limited', granted: [], denied: [], checkedAt: NOW };
      },
    });
    const port = createHealthKitNativePort(native);

    await expect(port.requestAuthorization(MINIMUM_READ_PERMISSIONS)).resolves.toMatchObject({ state: 'limited' });
    expect(requested).toEqual([[...MINIMUM_READ_PERMISSIONS]]);
    await expect(port.readSamples({
      windowStart: WINDOW_START,
      windowEnd: NOW,
    })).resolves.toMatchObject({
      sleep: { totalSleepMinutes: 480 },
      heart: { restingHeartRate: 58, hrvMilliseconds: 62 },
      activity: { stepCount: 2400 },
    });
    const composition = readFileSync('src/features/readiness/healthKitDeviceAdapter.ts', 'utf8');
    expect(composition).toMatch(/new HealthKitReadinessAdapter/);
    expect(composition).toMatch(/createHealthKitNativePort/);
  });

  it('fails closed when the native module is absent', async () => {
    const port = createHealthKitNativePort(null);
    await expect(port.isAvailable()).resolves.toBe(false);
    await expect(port.authorization(MINIMUM_READ_PERMISSIONS)).resolves.toMatchObject({ state: 'unavailable' });
    await expect(port.readSamples({
      windowStart: WINDOW_START,
      windowEnd: NOW,
    })).resolves.toEqual({});
  });

  it('clearLocalConnection delegates once without claiming native permission revocation', async () => {
    const clearLocalConnection = jest.fn(async () => undefined);
    const port = createHealthKitNativePort(nativeModule({ clearLocalConnection }));

    await expect(port.clearLocalConnection()).resolves.toBeUndefined();
    expect(clearLocalConnection).toHaveBeenCalledTimes(1);
  });
});
