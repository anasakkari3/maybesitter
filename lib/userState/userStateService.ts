import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  READINESS_SOURCE_KINDS,
  type ReadinessBand,
  type ReadinessMetricKind,
  type ReadinessSignal,
  type ReadinessSnapshot,
  type ReadinessSourceKind,
  type ReadinessValueUnit,
  type SubjectiveEnergyLevel,
} from '../../src/contracts/v1/readinessContracts';
import type { UserStateProjection } from '../../src/contracts/v1/userStateProjectionContracts';
import { assertLiveAccount } from '../account/accountLiveness';
import { getStorage, type StorageAdapter } from '../storage';
import { userDoc } from '../storage/paths';
import {
  resolveReadinessForUserState,
  type ReadinessResolution,
  type SubjectiveEnergyCheckIn,
} from '../integrations/readiness/subjectiveEnergy';
import {
  composeUserStateProjection,
  type UserStateCompositionInput,
} from './composeUserStateProjection';
import { resolveMemoryLearning } from '../release/m5bCapabilities';

export const READINESS_CONTEXT_SCHEMA_VERSION = 'readiness-context-v1' as const;

export interface StoredReadinessContext {
  readonly schemaVersion: typeof READINESS_CONTEXT_SCHEMA_VERSION;
  readonly currentSubjective: SubjectiveEnergyCheckIn | null;
  readonly recentReadiness: ReadinessSnapshot | null;
  readonly historicalInference: ReadinessSnapshot | null;
  readonly updatedAt: string;
}

export interface UserStateServiceOptions {
  readonly storage?: StorageAdapter;
  readonly userDocument?: unknown;
  /** M5b: discard stale, future and historical readings before composition. */
  readonly readiness?: 'fresh';
}

export interface CurrentUserStateInput extends Omit<UserStateCompositionInput, 'scopeId' | 'readiness'> {
  readonly uid: string;
}

export interface CurrentUserState {
  readonly projection: UserStateProjection;
  readonly readiness: ReadinessResolution;
}

export type ReadinessContextWrite = 'stored' | 'unchanged' | 'stale_ignored';

const METRICS: readonly ReadinessMetricKind[] = [
  'sleep',
  'recovery',
  'strain',
  'heart_rate',
  'hrv',
  'steps',
  'subjective_energy',
];
const UNITS: readonly ReadinessValueUnit[] = [
  'score_0_1',
  'minutes',
  'count',
  'beats_per_minute',
  'milliseconds',
  'label',
];
const BANDS: readonly ReadinessBand[] = ['unknown', 'low', 'steady', 'high'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function readingIsTooFarInFuture(timestamp: string, now: string): boolean {
  return Date.parse(timestamp) > Date.parse(now) + 5 * 60 * 1000;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSourceKind(value: unknown): value is ReadinessSourceKind {
  return typeof value === 'string' && (READINESS_SOURCE_KINDS as readonly string[]).includes(value);
}

function uniqueSourceKinds(value: unknown): ReadinessSourceKind[] | null {
  if (!Array.isArray(value) || !value.every(isSourceKind)) return null;
  return Array.from(new Set(value));
}

function sanitizeSignal(value: unknown): ReadinessSignal | null {
  if (!isRecord(value) || !isRecord(value.source)) return null;
  if (typeof value.signalId !== 'string' || value.signalId.length === 0) return null;
  if (!isSourceKind(value.source.kind)) return null;
  if (typeof value.metric !== 'string' || !(METRICS as readonly string[]).includes(value.metric)) return null;
  if (!isInstant(value.observedAt)) return null;
  if (value.normalizedScore !== null && !isUnitInterval(value.normalizedScore)) return null;
  if (typeof value.nativeUnit !== 'string' || !(UNITS as readonly string[]).includes(value.nativeUnit)) return null;
  if (!isUnitInterval(value.confidence)) return null;

  return {
    signalId: value.signalId,
    source: {
      kind: value.source.kind,
      ...(typeof value.source.provider === 'string' ? { provider: value.source.provider as ReadinessSignal['source']['provider'] } : {}),
      ...(typeof value.source.connectionId === 'string' ? { connectionId: value.source.connectionId } : {}),
    },
    metric: value.metric as ReadinessMetricKind,
    observedAt: value.observedAt,
    normalizedScore: value.normalizedScore,
    nativeValue: null,
    nativeUnit: value.nativeUnit as ReadinessValueUnit,
    confidence: value.confidence,
  };
}

/**
 * Keeps only the normalized planning signal. Raw health values are deliberately
 * discarded before the existing user document sees the snapshot.
 */
export function sanitizeReadinessSnapshot(value: unknown, scopeId: string): ReadinessSnapshot | null {
  if (!isRecord(value) || value.version !== READINESS_CONTRACT_VERSION || value.schemaVersion !== READINESS_SCHEMA_VERSION) {
    return null;
  }
  if (value.scopeId !== scopeId || !isInstant(value.computedAt) || !isInstant(value.windowStart) || !isInstant(value.windowEnd)) {
    return null;
  }
  if (typeof value.band !== 'string' || !(BANDS as readonly string[]).includes(value.band)) return null;
  if (value.score !== null && !isUnitInterval(value.score)) return null;
  if (!isRecord(value.derived) || value.derived.readinessBand !== value.band) return null;
  if (value.derived.confidence !== null && !isUnitInterval(value.derived.confidence)) return null;
  if (!Array.isArray(value.signals)) return null;
  const signals = value.signals.map(sanitizeSignal);
  if (signals.some((signal) => signal === null)) return null;
  const sourceKinds = uniqueSourceKinds(value.sourceKinds);
  const missingSourceKinds = uniqueSourceKinds(value.missingSourceKinds);
  if (!sourceKinds || !missingSourceKinds) return null;

  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId,
    computedAt: value.computedAt,
    windowStart: value.windowStart,
    windowEnd: value.windowEnd,
    band: value.band as ReadinessBand,
    score: value.score,
    normalizedSignals: {},
    subjective: null,
    derived: {
      readinessBand: value.band as ReadinessBand,
      confidence: value.derived.confidence,
    },
    signals: signals as ReadinessSignal[],
    sourceKinds,
    missingSourceKinds,
  };
}

function subjective(value: unknown): SubjectiveEnergyCheckIn | null {
  if (!isRecord(value)) return null;
  const energy = value.energy;
  if (typeof energy !== 'number' || !Number.isInteger(energy) || energy < 1 || energy > 5 || !isInstant(value.observedAt)) {
    return null;
  }
  return { energy: energy as SubjectiveEnergyLevel, observedAt: value.observedAt };
}

export function storedReadinessContext(value: unknown, scopeId: string): StoredReadinessContext | null {
  if (!isRecord(value) || value.schemaVersion !== READINESS_CONTEXT_SCHEMA_VERSION || !isInstant(value.updatedAt)) return null;
  const currentSubjective = value.currentSubjective === null ? null : subjective(value.currentSubjective);
  const recentReadiness = value.recentReadiness === null ? null : sanitizeReadinessSnapshot(value.recentReadiness, scopeId);
  const historicalInference = value.historicalInference === null
    ? null
    : sanitizeReadinessSnapshot(value.historicalInference, scopeId);
  if (value.currentSubjective !== null && !currentSubjective) return null;
  if (value.recentReadiness !== null && !recentReadiness) return null;
  if (value.historicalInference !== null && !historicalInference) return null;
  return {
    schemaVersion: READINESS_CONTEXT_SCHEMA_VERSION,
    currentSubjective,
    recentReadiness,
    historicalInference,
    updatedAt: value.updatedAt,
  };
}

function emptyContext(at: string): StoredReadinessContext {
  return {
    schemaVersion: READINESS_CONTEXT_SCHEMA_VERSION,
    currentSubjective: null,
    recentReadiness: null,
    historicalInference: null,
    updatedAt: at,
  };
}

async function updateContext(
  uid: string,
  at: string,
  storage: StorageAdapter,
  update: (current: StoredReadinessContext) => { context: StoredReadinessContext; result: ReadinessContextWrite },
): Promise<ReadinessContextWrite> {
  return storage.runTransaction(async (tx) => {
    const user = await tx.get<Record<string, unknown>>(userDoc(uid));
    // The account deletion fence (#772): a missing user document (swept) or a
    // deleted account is refused before the merge could re-create it.
    assertLiveAccount(user);
    if (!user) throw new Error('readiness context requires an existing user');
    const current = storedReadinessContext(user.readinessContext, uid) ?? emptyContext(at);
    const outcome = update(current);
    if (outcome.result !== 'stored') return outcome.result;
    tx.merge<Record<string, unknown>>(userDoc(uid), {
      readinessContext: outcome.context,
      updatedAt: at,
    });
    return outcome.result;
  });
}

export async function saveSubjectiveEnergyCheckIn(
  uid: string,
  checkIn: SubjectiveEnergyCheckIn,
  options: { readonly storage?: StorageAdapter; readonly now?: string } = {},
): Promise<ReadinessContextWrite> {
  const clean = subjective(checkIn);
  if (!clean) throw new TypeError('subjective energy must be an integer from 1 to 5 with an observedAt instant');
  const at = options.now ?? new Date().toISOString();
  if (!isInstant(at)) throw new TypeError('now must be an instant');
  if (resolveMemoryLearning() && readingIsTooFarInFuture(clean.observedAt, at)) {
    throw new TypeError('subjective energy observedAt is too far in the future');
  }
  return updateContext(uid, at, options.storage ?? getStorage(), (current) => {
    const prior = resolveMemoryLearning() && current.currentSubjective
      && readingIsTooFarInFuture(current.currentSubjective.observedAt, at)
      ? null
      : current.currentSubjective;
    if (prior && Date.parse(clean.observedAt) < Date.parse(prior.observedAt)) {
      return { context: current, result: 'stale_ignored' };
    }
    if (prior?.energy === clean.energy && prior.observedAt === clean.observedAt) {
      return { context: current, result: 'unchanged' };
    }
    return {
      result: 'stored',
      context: { ...current, currentSubjective: clean, updatedAt: at },
    };
  });
}

export async function saveNormalizedReadinessSnapshot(
  uid: string,
  snapshot: ReadinessSnapshot,
  options: { readonly storage?: StorageAdapter; readonly now?: string } = {},
): Promise<ReadinessContextWrite> {
  const clean = sanitizeReadinessSnapshot(snapshot, uid);
  if (!clean) throw new TypeError('readiness snapshot is malformed or belongs to another account');
  const at = options.now ?? new Date().toISOString();
  if (!isInstant(at)) throw new TypeError('now must be an instant');
  if (resolveMemoryLearning() && readingIsTooFarInFuture(clean.computedAt, at)) {
    throw new TypeError('readiness snapshot computedAt is too far in the future');
  }
  return updateContext(uid, at, options.storage ?? getStorage(), (current) => {
    const prior = resolveMemoryLearning() && current.recentReadiness
      && readingIsTooFarInFuture(current.recentReadiness.computedAt, at)
      ? null
      : current.recentReadiness;
    if (prior && Date.parse(clean.computedAt) < Date.parse(prior.computedAt)) {
      return { context: current, result: 'stale_ignored' };
    }
    if (prior && JSON.stringify(prior) === JSON.stringify(clean)) {
      return { context: current, result: 'unchanged' };
    }
    return {
      result: 'stored',
      context: {
        ...current,
        recentReadiness: clean,
        historicalInference: prior ?? current.historicalInference,
        updatedAt: at,
      },
    };
  });
}

export async function composeCurrentUserState(
  input: CurrentUserStateInput,
  options: UserStateServiceOptions = {},
): Promise<CurrentUserState> {
  const user = options.userDocument === undefined
    ? await (options.storage ?? getStorage()).get<Record<string, unknown>>(userDoc(input.uid))
    : options.userDocument;
  let context = storedReadinessContext(isRecord(user) ? user.readinessContext : undefined, input.uid);
  if (options.readiness === 'fresh' || resolveMemoryLearning()) {
    const { freshReadinessInputs } = await import('../integrations/readiness/freshReadiness');
    const filtered = freshReadinessInputs(context, input.now);
    context = context ? { ...context, ...filtered } : null;
  }
  const readiness = resolveReadinessForUserState({
    scopeId: input.uid,
    now: input.now,
    currentSubjective: context?.currentSubjective ?? null,
    recentReadiness: context?.recentReadiness ?? null,
    historicalInference: context?.historicalInference ?? null,
  });
  return {
    readiness,
    projection: composeUserStateProjection({
      ...input,
      scopeId: input.uid,
      readiness: readiness.snapshot,
    }),
  };
}
