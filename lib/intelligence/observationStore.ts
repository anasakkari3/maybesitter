import { createHash } from 'node:crypto';
import { getStorage, INTELLIGENCE_OBSERVATIONS, requireUserId, userCol, type StorageAdapter } from '../storage';
import { createStorageRuntimeMemoryStore } from '../runtimeMemory/runtimeMemoryStore';
import type { SemanticObservation } from './semantic';

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

function path(uid: string, id: string): string {
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
): Promise<StoredObservation[]> {
  requireUserId(uid);
  if (!sourceRef || sourceRef.length > 200 || !Number.isFinite(Date.parse(observedAt))) throw new Error('invalid source');
  const out: StoredObservation[] = [];
  for (const item of items.slice(0, 12)) {
    const id = observationId(source, sourceRef, item);
    if (monitorGuard) {
      const guarded = await storage.runTransaction(async tx => {
        const [monitor, existing] = await Promise.all([
          tx.get<{ enabled: boolean; generation: string }>(monitorGuard.path),
          tx.get<StoredObservation>(path(uid, id)),
        ]);
        if (!monitor?.enabled || monitor.generation !== monitorGuard.generation) return null;
        if (existing) return existing;
        const record: StoredObservation = { ...item, id, source, sourceRef, observedAt,
          ...initialReview(source, observedAt), linkedMemoryId: null };
        tx.create(path(uid, id), record);
        return record;
      });
      if (!guarded) throw new Error('monitor_disabled');
      out.push(guarded);
      continue;
    }
    const existing = await storage.get<StoredObservation>(path(uid, id));
    if (existing) { out.push(existing); continue; }
    const record: StoredObservation = {
      ...item, id, source, sourceRef, observedAt,
      ...initialReview(source, observedAt), linkedMemoryId: null,
    };
    await storage.set(path(uid, id), record);
    out.push(record);
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
    const current = await tx.get<StoredObservation>(path(uid, id));
    if (!current) return null;
    if (current.review !== 'pending') return current;
    const next = { ...current, review, reviewedAt: at };
    tx.set(path(uid, id), next);
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
    const current = await tx.get<StoredObservation>(path(uid, id));
    if (!current) return null;
    if (current.review !== 'confirmed' || current.linkedMemoryId) return current;
    const next = { ...current, linkedMemoryId: memory.id };
    tx.set(path(uid, id), next);
    return next;
  });
}
