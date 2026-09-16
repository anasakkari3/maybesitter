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
    readSamples: async (window) => nativeModule?.readSamples(window) ?? {},
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
