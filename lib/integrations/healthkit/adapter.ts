import type { HealthKitReadinessSnapshotInput } from '../readiness/healthkit';
import { buildHealthKitReadinessSnapshot } from '../readiness/healthkit';
import type {
  NativeHealthAuthorizationState,
  NativeReadinessLogger,
  NativeReadinessResult,
} from '../readiness/nativeAdapterContracts';

export const HEALTHKIT_MINIMUM_READ_PERMISSIONS = Object.freeze([
  'sleep_analysis',
  'resting_heart_rate',
  'heart_rate_variability_sdnn',
  'step_count',
] as const);

export type HealthKitReadPermission = (typeof HEALTHKIT_MINIMUM_READ_PERMISSIONS)[number];

export interface HealthKitAuthorizationSnapshot {
  readonly state: NativeHealthAuthorizationState;
  readonly granted: readonly HealthKitReadPermission[];
  readonly denied: readonly HealthKitReadPermission[];
  readonly checkedAt: string;
}

export interface HealthKitSampleWindow {
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface HealthKitNativeSamples {
  readonly sleep?: HealthKitReadinessSnapshotInput['sleep'];
  readonly heart?: HealthKitReadinessSnapshotInput['heart'];
  readonly activity?: HealthKitReadinessSnapshotInput['activity'];
}

export interface HealthKitNativePort {
  isAvailable(): Promise<boolean>;
  authorization(read: readonly HealthKitReadPermission[]): Promise<HealthKitAuthorizationSnapshot>;
  requestAuthorization(read: readonly HealthKitReadPermission[]): Promise<HealthKitAuthorizationSnapshot>;
  readSamples(window: HealthKitSampleWindow): Promise<HealthKitNativeSamples>;
  clearLocalConnection(): Promise<void>;
}

export interface HealthKitAdapterOptions {
  readonly connectionId?: string | null;
  readonly staleAfterMs?: number;
  readonly logger?: NativeReadinessLogger;
}

export interface HealthKitDisconnectResult {
  readonly localConnectionCleared: true;
  readonly providerPermissionRevocation: 'ios_settings_required';
}

const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function newestObservedAt(samples: HealthKitNativeSamples): string | null {
  const values = [samples.sleep?.observedAt, samples.heart?.observedAt, samples.activity?.observedAt]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => ({ value, ms: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((left, right) => right.ms - left.ms);
  return values[0]?.value ?? null;
}

function isStale(observedAt: string | null, now: string, staleAfterMs: number): boolean {
  if (!observedAt) return false;
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(now);
  return Number.isFinite(observedMs) && Number.isFinite(nowMs) && nowMs - observedMs > staleAfterMs;
}

export class HealthKitReadinessAdapter {
  private readonly staleAfterMs: number;

  constructor(
    private readonly port: HealthKitNativePort,
    private readonly options: HealthKitAdapterOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  async authorize(requestIfNeeded = true): Promise<HealthKitAuthorizationSnapshot> {
    if (!(await this.port.isAvailable())) {
      return this.authorizationResult('unavailable');
    }
    const current = await this.port.authorization(HEALTHKIT_MINIMUM_READ_PERMISSIONS);
    const result = requestIfNeeded && current.state === 'not_determined'
      ? await this.port.requestAuthorization(HEALTHKIT_MINIMUM_READ_PERMISSIONS)
      : current;
    this.options.logger?.log({
      event: 'authorization',
      source: 'healthkit',
      state: result.state,
      signalCount: 0,
      errorCode: null,
    });
    return result;
  }

  async collect(
    input: Pick<HealthKitReadinessSnapshotInput, 'scopeId' | 'computedAt' | 'windowStart' | 'windowEnd'>,
  ): Promise<NativeReadinessResult> {
    const provenanceBase = {
      source: 'healthkit' as const,
      connectionId: this.options.connectionId ?? null,
      collectedAt: input.computedAt,
      rawPayloadPersisted: false as const,
    };

    try {
      if (!(await this.port.isAvailable())) {
        return this.result('unavailable', 'unavailable', null, null, null, provenanceBase);
      }
      const authorization = await this.port.authorization(HEALTHKIT_MINIMUM_READ_PERMISSIONS);
      if (authorization.state !== 'authorized' && authorization.state !== 'limited') {
        return this.result('permission_denied', authorization.state, null, null, null, provenanceBase);
      }

      const samples = await this.port.readSamples({
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      });
      const snapshot = buildHealthKitReadinessSnapshot({ ...input, ...samples });
      const newestSampleAt = newestObservedAt(samples);
      const state = snapshot.signals.length === 0
        ? 'empty'
        : isStale(newestSampleAt, input.computedAt, this.staleAfterMs) ? 'stale' : 'fresh';
      return this.result(state, authorization.state, snapshot, newestSampleAt, null, provenanceBase);
    } catch {
      return this.result('error', 'error', null, null, 'healthkit_read_failed', provenanceBase);
    }
  }

  async disconnect(): Promise<HealthKitDisconnectResult> {
    await this.port.clearLocalConnection();
    this.options.logger?.log({
      event: 'disconnect',
      source: 'healthkit',
      state: 'not_determined',
      signalCount: 0,
      errorCode: null,
    });
    return {
      localConnectionCleared: true,
      providerPermissionRevocation: 'ios_settings_required',
    };
  }

  private authorizationResult(state: NativeHealthAuthorizationState): HealthKitAuthorizationSnapshot {
    return { state, granted: [], denied: [], checkedAt: new Date(0).toISOString() };
  }

  private result(
    state: NativeReadinessResult['state'],
    authorization: NativeHealthAuthorizationState,
    snapshot: NativeReadinessResult['snapshot'],
    newestSampleAt: string | null,
    errorCode: string | null,
    provenanceBase: Omit<NativeReadinessResult['provenance'], 'newestSampleAt'>,
  ): NativeReadinessResult {
    const result: NativeReadinessResult = {
      state,
      authorization,
      snapshot,
      provenance: { ...provenanceBase, newestSampleAt },
      errorCode,
    };
    this.options.logger?.log({
      event: 'read',
      source: 'healthkit',
      state,
      signalCount: snapshot?.signals.length ?? 0,
      errorCode,
    });
    return result;
  }
}
