import type { ReadinessSnapshot, ReadinessSourceKind } from '../../../src/contracts/v1/readinessContracts';

export type NativeHealthAuthorizationState =
  | 'not_determined'
  | 'requesting'
  | 'authorized'
  | 'limited'
  | 'denied'
  | 'unavailable'
  | 'error';

export type NativeReadinessState =
  | 'fresh'
  | 'stale'
  | 'empty'
  | 'permission_denied'
  | 'unavailable'
  | 'error';

export interface NativeReadinessProvenance {
  readonly source: Extract<ReadinessSourceKind, 'healthkit' | 'health_connect'>;
  readonly connectionId: string | null;
  readonly collectedAt: string;
  readonly newestSampleAt: string | null;
  readonly rawPayloadPersisted: false;
}

export interface NativeReadinessResult {
  readonly state: NativeReadinessState;
  readonly authorization: NativeHealthAuthorizationState;
  readonly snapshot: ReadinessSnapshot | null;
  readonly provenance: NativeReadinessProvenance;
  readonly errorCode: string | null;
}

export interface PrivacySafeNativeReadinessLog {
  readonly event: 'authorization' | 'read' | 'disconnect';
  readonly source: NativeReadinessProvenance['source'];
  readonly state: NativeReadinessState | NativeHealthAuthorizationState;
  readonly signalCount: number;
  readonly errorCode: string | null;
}

export interface NativeReadinessLogger {
  log(event: PrivacySafeNativeReadinessLog): void;
}

export const NATIVE_READINESS_PRIVACY_POLICY = Object.freeze({
  rawPayloadLoggingAllowed: false,
  rawPayloadPersistenceAllowed: false,
  medicalInterpretationAllowed: false,
});
