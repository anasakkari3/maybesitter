import { requireOptionalNativeModule } from 'expo';

import type {
  HealthKitAuthorizationSnapshot,
  HealthKitNativePort,
  HealthKitNativeSamples,
  HealthKitReadPermission,
  HealthKitSampleWindow,
} from '../../../lib/integrations/healthkit/adapter';

export interface HealthKitReadinessNativeModule {
  isAvailable(): Promise<boolean>;
  authorization(read: readonly HealthKitReadPermission[]): Promise<HealthKitAuthorizationSnapshot>;
  requestAuthorization(read: readonly HealthKitReadPermission[]): Promise<HealthKitAuthorizationSnapshot>;
  readSamples(window: HealthKitSampleWindow): Promise<HealthKitNativeSamples>;
  clearLocalConnection(): Promise<void>;
}

export function healthKitReadinessNativeModule(): HealthKitReadinessNativeModule | null {
  return requireOptionalNativeModule<HealthKitReadinessNativeModule>('HealthKitReadiness');
}

export function createHealthKitNativePort(
  nativeModule: HealthKitReadinessNativeModule | null = healthKitReadinessNativeModule(),
): HealthKitNativePort {
  return {
    isAvailable: async () => nativeModule?.isAvailable() ?? false,
    authorization: async (read) => nativeModule
      ? nativeModule.authorization(read)
      : unavailableAuthorization(),
    requestAuthorization: async (read) => nativeModule
      ? nativeModule.requestAuthorization(read)
      : unavailableAuthorization(),
    readSamples: async (window) => nativeModule?.readSamples(nativeWindow(window)) ?? {},
    clearLocalConnection: async () => {
      await nativeModule?.clearLocalConnection();
    },
  };
}

function unavailableAuthorization(): HealthKitAuthorizationSnapshot {
  return {
    state: 'unavailable',
    granted: [],
    denied: [],
    checkedAt: new Date(0).toISOString(),
  };
}

/**
 * The window as the Swift module can parse it (closure CL2b, D5).
 *
 * `HealthKitReadinessModule.swift` reads the window with a default
 * `ISO8601DateFormatter`, which rejects fractional seconds, and a window built
 * with `toISOString()` always has them (".000Z"). Every read therefore threw
 * before a sample was asked for, and the card said «ما قدرنا نقرأ أو نبعت» —
 * with data or without. Whole seconds parse on the formatter this build has
 * shipped with; the Swift side now accepts both, so neither half alone can
 * bring it back.
 */
export function nativeWindow(window: HealthKitSampleWindow): HealthKitSampleWindow {
  return { windowStart: wholeSeconds(window.windowStart), windowEnd: wholeSeconds(window.windowEnd) };
}

function wholeSeconds(instant: string): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return instant;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
