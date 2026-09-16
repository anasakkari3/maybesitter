import {
  HealthKitReadinessAdapter,
  type HealthKitAdapterOptions,
} from '../../../../lib/integrations/healthkit/adapter';
import {
  createHealthKitNativePort,
  type HealthKitReadinessNativeModule,
} from '../../../modules/healthkit-readiness';

export function createDeviceHealthKitReadinessAdapter(
  options: HealthKitAdapterOptions = {},
  nativeModule?: HealthKitReadinessNativeModule | null,
): HealthKitReadinessAdapter {
  return new HealthKitReadinessAdapter(
    createHealthKitNativePort(nativeModule),
    options,
  );
}
