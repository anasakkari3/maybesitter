import type { HealthConnectReadinessSnapshotInput } from '../readiness/healthConnect';
import { buildHealthConnectReadinessSnapshot } from '../readiness/healthConnect';
import type {
  NativeHealthAuthorizationState,
  NativeReadinessLogger,
  NativeReadinessResult,
} from '../readiness/nativeAdapterContracts';

export const HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS = Object.freeze([
  'sleep_session',
  'resting_heart_rate',
  'heart_rate_variability_rmssd',
  'steps',
] as const);

export type HealthConnectReadPermission = (typeof HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS)[number];

export interface HealthConnectAuthorizationSnapshot {
  readonly state: NativeHealthAuthorizationState;
  readonly granted: readonly HealthConnectReadPermission[];
  readonly denied: readonly HealthConnectReadPermission[];
  readonly checkedAt: string;
}

export interface HealthConnectRecordWindow {
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface HealthConnectNativeRecords {
  readonly sleep?: HealthConnectReadinessSnapshotInput['sleep'];
  readonly heart?: HealthConnectReadinessSnapshotInput['heart'];
  readonly steps?: HealthConnectReadinessSnapshotInput['steps'];
}

export interface HealthConnectNativePort {
  isSdkAvailable(): Promise<boolean>;
  authorization(read: readonly HealthConnectReadPermission[]): Promise<HealthConnectAuthorizationSnapshot>;
  requestAuthorization(read: readonly HealthConnectReadPermission[]): Promise<HealthConnectAuthorizationSnapshot>;
  readRecords(window: HealthConnectRecordWindow): Promise<HealthConnectNativeRecords>;
  revokeAllPermissions(): Promise<void>;
  clearLocalConnection(): Promise<void>;
}

export interface HealthConnectAdapterOptions {
  readonly connectionId?: string | null;
  readonly staleAfterMs?: number;
  readonly logger?: NativeReadinessLogger;
}

export interface HealthConnectDisconnectResult {
  readonly localConnectionCleared: true;
  readonly providerPermissionRevocation: 'revoked';
}

const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function newestObservedAt(records: HealthConnectNativeRecords): string | null {
  const values = [records.sleep?.observedAt, records.heart?.observedAt, records.steps?.observedAt]
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

export class HealthConnectReadinessAdapter {
  private readonly staleAfterMs: number;

  constructor(
    private readonly port: HealthConnectNativePort,
    private readonly options: HealthConnectAdapterOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  async authorize(requestIfNeeded = true): Promise<HealthConnectAuthorizationSnapshot> {
    if (!(await this.port.isSdkAvailable())) {
      return this.authorizationResult('unavailable');
    }
    const current = await this.port.authorization(HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS);
    const result = requestIfNeeded && current.state === 'not_determined'
      ? await this.port.requestAuthorization(HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS)
      : current;
    this.options.logger?.log({
      event: 'authorization',
      source: 'health_connect',
      state: result.state,
      signalCount: 0,
      errorCode: null,
    });
    return result;
  }

  async collect(
    input: Pick<HealthConnectReadinessSnapshotInput, 'scopeId' | 'computedAt' | 'windowStart' | 'windowEnd'>,
  ): Promise<NativeReadinessResult> {
    const provenanceBase = {
      source: 'health_connect' as const,
      connectionId: this.options.connectionId ?? null,
      collectedAt: input.computedAt,
      rawPayloadPersisted: false as const,
    };

    try {
      if (!(await this.port.isSdkAvailable())) {
        return this.result('unavailable', 'unavailable', null, null, null, provenanceBase);
      }
      const authorization = await this.port.authorization(HEALTH_CONNECT_MINIMUM_READ_PERMISSIONS);
      if (authorization.state !== 'authorized' && authorization.state !== 'limited') {
        return this.result('permission_denied', authorization.state, null, null, null, provenanceBase);
      }

      const records = await this.port.readRecords({
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      });
      const snapshot = buildHealthConnectReadinessSnapshot({
        ...input,
        ...(records.sleep !== undefined ? { sleep: records.sleep } : {}),
        ...(records.heart !== undefined ? { heart: records.heart } : {}),
        ...(records.steps !== undefined ? { steps: records.steps } : {}),
      });
      const newestSampleAt = newestObservedAt(records);
      const state = snapshot.signals.length === 0
        ? 'empty'
        : isStale(newestSampleAt, input.computedAt, this.staleAfterMs) ? 'stale' : 'fresh';
      return this.result(state, authorization.state, snapshot, newestSampleAt, null, provenanceBase);
    } catch {
      return this.result('error', 'error', null, null, 'health_connect_read_failed', provenanceBase);
    }
  }

  async disconnect(): Promise<HealthConnectDisconnectResult> {
    await this.port.revokeAllPermissions();
    await this.port.clearLocalConnection();
    this.options.logger?.log({
      event: 'disconnect',
      source: 'health_connect',
      state: 'not_determined',
      signalCount: 0,
      errorCode: null,
    });
    return {
      localConnectionCleared: true,
      providerPermissionRevocation: 'revoked',
    };
  }

  private authorizationResult(state: NativeHealthAuthorizationState): HealthConnectAuthorizationSnapshot {
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
      source: 'health_connect',
      state,
      signalCount: snapshot?.signals.length ?? 0,
      errorCode,
    });
    return result;
  }
}
