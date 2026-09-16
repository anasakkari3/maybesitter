import { requireOptionalNativeModule } from 'expo';

import type {
  HealthConnectAuthorizationSnapshot,
  HealthConnectNativePort,
  HealthConnectNativeRecords,
  HealthConnectReadPermission,
  HealthConnectRecordWindow,
} from '../../../lib/integrations/healthConnect/adapter';

export interface HealthConnectReadinessNativeModule {
  isSdkAvailable(): Promise<boolean>;
  authorization(read: readonly HealthConnectReadPermission[]): Promise<HealthConnectAuthorizationSnapshot>;
  requestAuthorization(read: readonly HealthConnectReadPermission[]): Promise<HealthConnectAuthorizationSnapshot>;
  readRecords(window: HealthConnectRecordWindow): Promise<HealthConnectNativeRecords>;
  revokeAllPermissions(): Promise<void>;
  clearLocalConnection(): Promise<void>;
}

export function healthConnectReadinessNativeModule(): HealthConnectReadinessNativeModule | null {
  return requireOptionalNativeModule<HealthConnectReadinessNativeModule>('HealthConnectReadiness');
}

export function createHealthConnectNativePort(
  nativeModule: HealthConnectReadinessNativeModule | null = healthConnectReadinessNativeModule(),
): HealthConnectNativePort {
  return {
    isSdkAvailable: async () => nativeModule?.isSdkAvailable() ?? false,
    authorization: async (read) => nativeModule
      ? nativeModule.authorization(read)
      : unavailableAuthorization(),
    requestAuthorization: async (read) => nativeModule
      ? nativeModule.requestAuthorization(read)
      : unavailableAuthorization(),
    readRecords: async (window) => nativeModule?.readRecords(window) ?? {},
    revokeAllPermissions: async () => {
      await nativeModule?.revokeAllPermissions();
    },
    clearLocalConnection: async () => {
      await nativeModule?.clearLocalConnection();
    },
  };
}

function unavailableAuthorization(): HealthConnectAuthorizationSnapshot {
  return {
    state: 'unavailable',
    granted: [],
    denied: [],
    checkedAt: new Date(0).toISOString(),
  };
}
