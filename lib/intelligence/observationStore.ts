import { createHash } from 'node:crypto';
import { getStorage, INTELLIGENCE_OBSERVATIONS, requireUserId, userCol, type StorageAdapter } from '../storage';
import { createStorageRuntimeMemoryStore } from '../runtimeMemory/runtimeMemoryStore';
import type { SemanticObservation } from './semantic';
import { resolveMemoryLearning } from '../release/m5bCapabilities';
import { requireLiveAccount } from './memoryBasis';
import { runtimeMemoryRecordPath, runtimeMemoryRecordRetrievable } from '../runtimeMemory/runtimeMemoryStore';

export type ObservationSource = 'manual' | 'gmail' | 'calendar' | 'drive' | 'share' | 'behavior' | 'memory' | 'commitment';
export type ObservationReview = 'pending' | 'confirmed' | 'dismissed';

export interface StoredObservation extends SemanticObservation {
  id: string;
  source: ObservationSource;
  /** Opaque provider id; no address, URL, token or raw message body. */
  sourceRef: string;
  observedAt: string;
  review: ObservationReview;
  reviewedAt: string | null;
  /** A confirmed goal is represented by the existing memory store. */
  linkedMemoryId: string | null;
  /** Present only when the observation was confirmed by the self-reply write. */
  autoAddId?: string;
}

/**
 * Sources that are the person's own record, not something read about them:
 * a goal they kept, a commitment they saved, an outcome they tapped. They are
 * facts already confirmed by the person, so they are stored confirmed and
 * never come back as "is this right?" (review of 2026-10-03). Everything read
 * from a statement, an email or a file stays pending until reviewed.
 */
export const SELF_CONFIRMED_SOURCES: ReadonlySet<ObservationSource> = new Set<ObservationSource>(['memory', 'commitment', 'behavior']);

function initialReview(source: ObservationSource, observedAt: string): Pick<StoredObservation, 'review' | 'reviewedAt'> {
  return SELF_CONFIRMED_SOURCES.has(source)
    ? { review: 'confirmed', reviewedAt: observedAt }
    : { review: 'pending', reviewedAt: null };
}

export function observationId(source: ObservationSource, sourceRef: string, item: SemanticObservation): string {
  return createHash('sha256').update([source, sourceRef, item.kind, item.evidence].join('\0')).digest('hex');
}

export function observationPath(uid: string, id: string): string {
  requireUserId(uid);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid observation id');
  return `${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${id}`;
}

export async function putObservations(
  uid: string,
  source: ObservationSource,
  sourceRef: string,
  observedAt: string,
  items: readonly SemanticObservation[],
  storage: StorageAdapter = getStorage(),
  monitorGuard?: { path: string; generation: string },
  writeGuard?: { memoryId?: string; personalizationEpoch?: number; now?: string },
): Promise<StoredObservation[]> {
  requireUserId(uid);
  if (!sourceRef || sourceRef.length > 200 || !Number.isFinite(Date.parse(observedAt))) throw new Error('invalid source');
  const out: StoredObservation[] = [];
  for (const item of items.slice(0, 12)) {
    const id = observationId(source, sourceRef, item);
    const guarded = await storage.runTransaction(async tx => {
      const account = await requireLiveAccount(tx, uid) as { personalizationPurge?: { state?: unknown; epoch?: unknown } };
      const monitor = monitorGuard
        ? await tx.get<{ enabled: boolean; generation: string }>(monitorGuard.path)
        : null;
      if (monitorGuard && (!monitor?.enabled || monitor.generation !== monitorGuard.generation)) return null;
      const existing = await tx.get<StoredObservation>(observationPath(uid, id));
      if (existing) return existing;
      if (writeGuard?.personalizationEpoch !== undefined) {
        const fence = account.personalizationPurge;
        const state = typeof fence?.state === 'string' ? fence.state : 'active';
        const epoch = typeof fence?.epoch === 'number' ? fence.epoch : 0;
        if (state !== 'active' || epoch !== writeGuard.personalizationEpoch) return null;
      }
      if (writeGuard?.memoryId) {
        const memory = await tx.get(runtimeMemoryRecordPath(uid, writeGuard.memoryId));
        if (!runtimeMemoryRecordRetrievable(memory, uid, writeGuard.now ?? observedAt)) return null;
      }
      const record: StoredObservation = { ...item, id, source, sourceRef, observedAt,
        ...initialReview(source, observedAt), linkedMemoryId: null };
      tx.create(observationPath(uid, id), record);
      return record;
    });
    if (!guarded) {
      if (monitorGuard) throw new Error('monitor_disabled');
      continue;
    }
    out.push(guarded);
  }
  return out;
}

export async function listObservations(uid: string, storage: StorageAdapter = getStorage()): Promise<StoredObservation[]> {
  requireUserId(uid);
  const rows = await storage.list<StoredObservation>(userCol(uid, INTELLIGENCE_OBSERVATIONS));
  return rows.map(row => row.data).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
}

export async function reviewObservation(
  uid: string,
  id: string,
  review: Exclude<ObservationReview, 'pending'>,
  at: string,
  storage: StorageAdapter = getStorage(),
): Promise<StoredObservation | null> {
  if (!Number.isFinite(Date.parse(at))) throw new Error('invalid review time');
  const reviewed = await storage.runTransaction(async tx => {
    const current = await tx.get<StoredObservation>(observationPath(uid, id));
    if (!current) return null;
    if (review === 'dismissed' && current.review === 'confirmed'
      && current.source === 'behavior' && current.kind === 'outcome'
      && resolveMemoryLearning()) {
      const next: StoredObservation = { ...current, review: 'dismissed', reviewedAt: at };
      tx.set(observationPath(uid, id), next);
      return next;
    }
    if (current.review !== 'pending') return current;
    const next = { ...current, review, reviewedAt: at };
    tx.set(observationPath(uid, id), next);
    return next;
  });
  if (!reviewed || reviewed.review !== 'confirmed' || reviewed.kind !== 'goal' || reviewed.linkedMemoryId) return reviewed;

  // A retry after a memory write failure must finish the same goal, not
  // confirm a second copy. The review is claimed first so a concurrent
  // dismissal cannot create memory for an observation the person rejected.
  const content = reviewed.evidence.trim();
  const language = /[\u0590-\u05ff]/.test(content) ? 'he'
    : /[\u0600-\u06ff]/.test(content) ? 'ar' : 'en';
  const memory = await createStorageRuntimeMemoryStore(undefined, storage).putIdempotent({
    scopeId: uid, kind: 'goal', content, language,
    source: 'model_inferred', confidence: reviewed.confidence,
    observedAt: reviewed.observedAt, evidenceIds: [reviewed.id],
    provenance: { origin: 'proactive_suggestion', originRef: reviewed.id, confirmedByUserAt: reviewed.reviewedAt ?? at },
  }, reviewed.reviewedAt ?? at, `observation-goal:${reviewed.id}`);
  return storage.runTransaction(async tx => {
    const current = await tx.get<StoredObservation>(observationPath(uid, id));
    if (!current) return null;
    if (current.review !== 'confirmed' || current.linkedMemoryId) return current;
    const next = { ...current, linkedMemoryId: memory.id };
    tx.set(observationPath(uid, id), next);
    return next;
  });
}
