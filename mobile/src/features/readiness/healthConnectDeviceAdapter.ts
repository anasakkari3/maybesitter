import {
  HealthConnectReadinessAdapter,
  type HealthConnectAdapterOptions,
} from '../../../../lib/integrations/healthConnect/adapter';
import {
  createHealthConnectNativePort,
  type HealthConnectReadinessNativeModule,
} from '../../../modules/health-connect-readiness';

export function createDeviceHealthConnectReadinessAdapter(
  options: HealthConnectAdapterOptions = {},
  nativeModule?: HealthConnectReadinessNativeModule | null,
): HealthConnectReadinessAdapter {
  return new HealthConnectReadinessAdapter(
    createHealthConnectNativePort(nativeModule),
    options,
  );
}
