import { runtimeMemoryRecordPath, runtimeMemoryRecordRetrievable } from '../runtimeMemory/runtimeMemoryStore';
import {
  INTELLIGENCE_OBSERVATIONS,
  INTELLIGENCE_PROPOSALS,
  INTELLIGENCE_RUNS,
  MEMORY,
  requireUserId,
  userCol,
  userDoc,
} from '../storage/paths';
import type { StorageAdapter, StorageReader, StorageTransaction } from '../storage/storageAdapter';
import type { RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts';
import type { M5bBasisMode } from '../release/m5bCapabilities';
import { m5bBasisMode } from '../release/m5bCapabilities';

export const MEMORY_CITATIONS = 'memoryCitations';
export const EXPORT_LEASES = 'exportLeases';

export interface StoredMemoryBasis {
  memoryIds: string[];
  epoch: number;
}

export interface MemorySnapshot {
  available: boolean;
  epoch: number;
  records: Map<string, RuntimeMemoryRecord>;
}

export interface BasisSuggestionLike {
  id: string;
  status: string;
  mode?: 'on_basis' | 'on_nobasis';
  memoryBasis?: StoredMemoryBasis;
}

export interface BasisObservationLike {
  id: string;
  source: string;
  sourceRef: string;
}

function fenceOf(user: unknown): { state: string; epoch: number } {
  const fence = (user as { personalizationPurge?: { state?: unknown; epoch?: unknown } } | null)?.personalizationPurge;
  return {
    state: typeof fence?.state === 'string' ? fence.state : 'active',
    epoch: typeof fence?.epoch === 'number' && Number.isFinite(fence.epoch) ? fence.epoch : 0,
  };
}

export function liveAccount(user: unknown): boolean {
  return user !== null && !(user as { trust?: { deletedAt?: unknown } } | null)?.trust?.deletedAt;
}

export async function requireLiveAccount(tx: StorageTransaction, uid: string): Promise<unknown> {
  const user = await tx.get(userDoc(uid));
  if (!liveAccount(user)) throw new Error('account_unavailable');
  return user;
}

/** One fenced, active-and-fresh memory view for a complete operation. */
export async function readActiveMemorySnapshot(
  uid: string,
  now: string,
  storage: StorageReader,
): Promise<MemorySnapshot> {
  requireUserId(uid);
  try {
    const beforeUser = await storage.get(userDoc(uid));
    if (!liveAccount(beforeUser)) return { available: false, epoch: 0, records: new Map() };
    const before = fenceOf(beforeUser);
    if (before.state !== 'active') return { available: false, epoch: before.epoch, records: new Map() };
    const rows = await storage.list<RuntimeMemoryRecord>(userCol(uid, MEMORY));
    const afterUser = await storage.get(userDoc(uid));
    const after = fenceOf(afterUser);
    if (!liveAccount(afterUser) || after.state !== 'active' || after.epoch !== before.epoch) {
      return { available: false, epoch: before.epoch, records: new Map() };
    }
    const records = new Map<string, RuntimeMemoryRecord>();
    for (const row of rows) {
      if (runtimeMemoryRecordRetrievable(row.data, uid, now)) records.set(row.data.id, row.data);
    }
    return { available: true, epoch: before.epoch, records };
  } catch {
    return { available: false, epoch: 0, records: new Map() };
  }
}

export function basisEligible(basis: StoredMemoryBasis | undefined, snapshot: MemorySnapshot): boolean {
  if (!basis) return true;
  return snapshot.available
    && basis.epoch === snapshot.epoch
    && basis.memoryIds.length > 0
    && basis.memoryIds.every((id) => snapshot.records.has(id));
}

export function suggestionMatchesMode(
  suggestion: BasisSuggestionLike,
  mode: M5bBasisMode,
  snapshot?: MemorySnapshot,
): boolean {
  // Mode provenance controls pending cards and their actions. A decided row is
  // historical state the inbox already returned before M5b-2b-1; it remains
  // visible in every mode, with its internal markers removed by the DTO mapper.
  if (suggestion.status !== 'pending') return true;
  if (mode === 'off') return suggestion.mode === undefined && suggestion.memoryBasis === undefined;
  if (suggestion.mode !== mode) return false;
  if (mode === 'on_nobasis') return suggestion.memoryBasis === undefined;
  return !suggestion.memoryBasis || Boolean(snapshot && basisEligible(suggestion.memoryBasis, snapshot));
}

export function suggestionProjection(
  suggestion: BasisSuggestionLike,
  mode: M5bBasisMode,
  snapshot?: MemorySnapshot,
): Array<{ memoryId: string }> | undefined {
  if (mode !== 'on_basis' || suggestion.status !== 'pending' || !suggestion.memoryBasis || !snapshot
    || !basisEligible(suggestion.memoryBasis, snapshot)) return undefined;
  return suggestion.memoryBasis.memoryIds.map((memoryId) => ({ memoryId }));
}

export function filterMemoryObservations<T extends BasisObservationLike>(
  observations: readonly T[],
  mode: M5bBasisMode,
  snapshot?: MemorySnapshot,
): T[] {
  if (mode === 'off') return [...observations];
  if (mode === 'on_nobasis' || !snapshot?.available) return observations.filter((row) => row.source !== 'memory');
  return observations.filter((row) => row.source !== 'memory' || snapshot.records.has(row.sourceRef));
}

export function citationPath(uid: string, memoryId: string, suggestionId: string): string {
  return `${userCol(uid, MEMORY_CITATIONS)}/${memoryId}__${suggestionId}`;
}

function suggestionPath(uid: string, suggestionId: string): string {
  return `${userCol(uid, INTELLIGENCE_PROPOSALS)}/${suggestionId}`;
}

function runPath(uid: string): string {
  return `${userCol(uid, INTELLIGENCE_RUNS)}/latest`;
}

/** Delete one suggestion only while its current basis still intersects the target. */
async function cleanupCitation(
  uid: string,
  memoryIds: ReadonlySet<string>,
  citation: { id: string; data: { memoryId?: string; suggestionId?: string } },
  storage: StorageAdapter,
): Promise<void> {
  const suggestionId = citation.data.suggestionId;
  if (!suggestionId) {
    await storage.delete(`${userCol(uid, MEMORY_CITATIONS)}/${citation.id}`);
    return;
  }
  await storage.runTransaction(async tx => {
    const [suggestion, run] = await Promise.all([
      tx.get<BasisSuggestionLike>(suggestionPath(uid, suggestionId)),
      tx.get<{ suggestionIds?: string[] }>(runPath(uid)),
    ]);
    const basisIds = suggestion?.memoryBasis?.memoryIds ?? [];
    if (!suggestion || !basisIds.some((id) => memoryIds.has(id))) {
      tx.delete(`${userCol(uid, MEMORY_CITATIONS)}/${citation.id}`);
      return;
    }
    tx.delete(suggestionPath(uid, suggestionId));
    if (run?.suggestionIds?.includes(suggestionId)) {
      tx.set(runPath(uid), { ...run, suggestionIds: run.suggestionIds.filter((id) => id !== suggestionId) });
    }
    for (const memoryId of basisIds) tx.delete(citationPath(uid, memoryId, suggestionId));
  });
}

/** Bounded reverse-index cleanup, run before the memory records disappear. */
export async function cleanupMemoryDependents(
  uid: string,
  ids: readonly string[],
  storage: StorageAdapter,
): Promise<void> {
  const unique = Array.from(new Set(ids));
  const targets = new Set(unique);
  for (let offset = 0; offset < unique.length; offset += 30) {
    const batch = unique.slice(offset, offset + 30);
    for (;;) {
      const rows = await storage.list<{ memoryId?: string; suggestionId?: string }>(userCol(uid, MEMORY_CITATIONS), {
        where: [['memoryId', 'in', batch]], limit: 100,
      });
      if (rows.length === 0) break;
      for (const row of rows) await cleanupCitation(uid, targets, row, storage);
    }
    for (;;) {
      const rows = await storage.list<BasisObservationLike>(userCol(uid, INTELLIGENCE_OBSERVATIONS), {
        where: [['sourceRef', 'in', batch]], limit: 100,
      });
      const copies = rows.filter((row) => row.data.source === 'memory');
      if (copies.length === 0) break;
      for (const row of copies) await storage.delete(`${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${row.id}`);
      if (rows.length < 100) break;
    }
  }
}

/** Remove rows that a live snapshot proves can no longer be shown. */
export async function cleanupMemoryResidues(
  uid: string,
  now: string,
  storage: StorageAdapter,
  snapshot?: MemorySnapshot,
): Promise<boolean> {
  const view = snapshot ?? await readActiveMemorySnapshot(uid, now, storage);
  if (!view.available) return false;
  const [observations, suggestions] = await Promise.all([
    storage.list<BasisObservationLike>(userCol(uid, INTELLIGENCE_OBSERVATIONS)),
    storage.list<BasisSuggestionLike>(userCol(uid, INTELLIGENCE_PROPOSALS)),
  ]);
  for (const row of observations) {
    if (row.data.source === 'memory' && !view.records.has(row.data.sourceRef)) {
      await storage.delete(`${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${row.id}`);
    }
  }
  for (const row of suggestions) {
    const basis = row.data.memoryBasis;
    if (basis && !basisEligible(basis, view)) {
      const ids = new Set(basis.memoryIds);
      await cleanupCitation(uid, ids, { id: `${basis.memoryIds[0] ?? 'missing'}__${row.id}`, data: {
        memoryId: basis.memoryIds[0], suggestionId: row.id,
      } }, storage);
    }
  }
  const [afterObservations, afterSuggestions] = await Promise.all([
    storage.list<BasisObservationLike>(userCol(uid, INTELLIGENCE_OBSERVATIONS)),
    storage.list<BasisSuggestionLike>(userCol(uid, INTELLIGENCE_PROPOSALS)),
  ]);
  return !afterObservations.some((row) => row.data.source === 'memory' && !view.records.has(row.data.sourceRef))
    && !afterSuggestions.some((row) => row.data.memoryBasis && !basisEligible(row.data.memoryBasis, view));
}

/** Commit-time proof for every memory that shaped the model input. */
export async function memoriesStillEligible(
  tx: StorageTransaction,
  uid: string,
  now: string,
  epoch: number,
  memoryIds: readonly string[],
): Promise<boolean> {
  const user = await requireLiveAccount(tx, uid);
  const fence = fenceOf(user);
  if (fence.state !== 'active' || fence.epoch !== epoch) return false;
  const unique = Array.from(new Set(memoryIds));
  const records = await Promise.all(unique.map((id) => tx.get(runtimeMemoryRecordPath(uid, id))));
  return records.every((record) => runtimeMemoryRecordRetrievable(record, uid, now));
}

/** Availability check used immediately before every decision/answer claim. */
export async function suggestionAvailableForAction(
  uid: string,
  suggestionId: string,
  now: string,
  storage: StorageAdapter,
): Promise<boolean> {
  const mode = m5bBasisMode();
  try {
    return await storage.runTransaction(async tx => {
      const suggestion = await tx.get<BasisSuggestionLike>(suggestionPath(uid, suggestionId));
      if (!suggestion || suggestion.status !== 'pending') return false;
      if (mode === 'off') return suggestion.mode === undefined && suggestion.memoryBasis === undefined;
      if (suggestion.mode !== mode) return false;
      if (mode === 'on_nobasis') return suggestion.memoryBasis === undefined;
      if (!suggestion.memoryBasis) return true;
      return memoriesStillEligible(tx, uid, now, suggestion.memoryBasis.epoch, suggestion.memoryBasis.memoryIds);
    });
  } catch {
    return false;
  }
}
