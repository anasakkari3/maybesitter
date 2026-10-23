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
import { AccountUnavailableError, liveAccount, requireLiveAccount } from '../account/accountLiveness';

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

export type SuggestionActionAvailability =
  | { available: true }
  | { available: false; reason: 'suggestion_unavailable'; accountUnavailable?: false }
  | { available: false; reason: 'suggestion_unavailable'; accountUnavailable: true };

export const SUGGESTION_UNAVAILABLE = {
  available: false,
  reason: 'suggestion_unavailable',
} as const satisfies SuggestionActionAvailability;

const SUGGESTION_ACCOUNT_UNAVAILABLE = {
  available: false,
  reason: 'suggestion_unavailable',
  accountUnavailable: true,
} as const satisfies SuggestionActionAvailability;

export class SuggestionUnavailableError extends Error {
  readonly result = SUGGESTION_UNAVAILABLE;

  constructor() {
    super('suggestion_unavailable');
    this.name = 'SuggestionUnavailableError';
  }
}

function fenceOf(user: unknown): { state: string; epoch: number } {
  const fence = (user as { personalizationPurge?: { state?: unknown; epoch?: unknown } } | null)?.personalizationPurge;
  return {
    state: typeof fence?.state === 'string' ? fence.state : 'active',
    epoch: typeof fence?.epoch === 'number' && Number.isFinite(fence.epoch) ? fence.epoch : 0,
  };
}

// One definition of "live", shared with the domain-state fence (#772).
export { AccountUnavailableError, liveAccount, requireLiveAccount };

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
  }
  // Memory copies are found per memory with two equalities, which Firestore
  // serves from single-field indexes: an `in` beside an equality would need a
  // composite index, and the deploy adds indexes only after traffic has moved
  // to the code that queries them. Each page is deleted before the next read,
  // so non-memory rows sharing a sourceRef can never hide a copy.
  for (const memoryId of unique) {
    for (;;) {
      const rows = await storage.list<BasisObservationLike>(userCol(uid, INTELLIGENCE_OBSERVATIONS), {
        where: [['sourceRef', '==', memoryId], ['source', '==', 'memory']], limit: 100,
      });
      for (const row of rows) await storage.delete(`${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${row.id}`);
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
      await storage.runTransaction(async tx => {
        const [current, user] = await Promise.all([
          tx.get<BasisObservationLike>(`${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${row.id}`),
          tx.get(userDoc(uid)),
        ]);
        if (!current || current.source !== 'memory' || current.sourceRef !== row.data.sourceRef) return;
        const fence = fenceOf(user);
        if (!liveAccount(user) || fence.state !== 'active' || fence.epoch !== view.epoch) return;
        const memory = await tx.get(runtimeMemoryRecordPath(uid, current.sourceRef));
        if (runtimeMemoryRecordRetrievable(memory, uid, now)) return;
        tx.delete(`${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${row.id}`);
      });
    }
  }
  for (const row of suggestions) {
    const basis = row.data.memoryBasis;
    if (basis && !basisEligible(basis, view)) {
      await storage.runTransaction(async tx => {
        const [current, run, user] = await Promise.all([
          tx.get<BasisSuggestionLike>(suggestionPath(uid, row.id)),
          tx.get<{ suggestionIds?: string[] }>(runPath(uid)),
          tx.get(userDoc(uid)),
        ]);
        const currentBasis = current?.memoryBasis;
        if (!current || !currentBasis
          || currentBasis.epoch !== basis.epoch
          || currentBasis.memoryIds.length !== basis.memoryIds.length
          || currentBasis.memoryIds.some((id, index) => id !== basis.memoryIds[index])) return;
        const fence = fenceOf(user);
        if (!liveAccount(user) || fence.state !== 'active' || fence.epoch !== view.epoch) return;
        const records = await Promise.all(currentBasis.memoryIds.map((id) =>
          tx.get(runtimeMemoryRecordPath(uid, id))));
        if (currentBasis.epoch === fence.epoch
          && currentBasis.memoryIds.length > 0
          && records.every((record) => runtimeMemoryRecordRetrievable(record, uid, now))) return;
        tx.delete(suggestionPath(uid, row.id));
        if (run?.suggestionIds?.includes(row.id)) {
          tx.set(runPath(uid), { ...run, suggestionIds: run.suggestionIds.filter((id) => id !== row.id) });
        }
        for (const memoryId of currentBasis.memoryIds) tx.delete(citationPath(uid, memoryId, row.id));
      });
    }
  }
  const verified = await readActiveMemorySnapshot(uid, now, storage);
  if (!verified.available) return false;
  const [afterObservations, afterSuggestions] = await Promise.all([
    storage.list<BasisObservationLike>(userCol(uid, INTELLIGENCE_OBSERVATIONS)),
    storage.list<BasisSuggestionLike>(userCol(uid, INTELLIGENCE_PROPOSALS)),
  ]);
  return !afterObservations.some((row) => row.data.source === 'memory' && !verified.records.has(row.data.sourceRef))
    && !afterSuggestions.some((row) => row.data.memoryBasis && !basisEligible(row.data.memoryBasis, verified));
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

/** Exact mode and live memory basis, read by the transaction claiming a pending suggestion. */
export async function pendingSuggestionAvailability(
  tx: StorageTransaction,
  uid: string,
  suggestion: BasisSuggestionLike,
  now: string,
): Promise<SuggestionActionAvailability> {
  const mode = m5bBasisMode();
  if (suggestion.status !== 'pending') return SUGGESTION_UNAVAILABLE;
  try {
    await requireLiveAccount(tx, uid);
  } catch {
    return SUGGESTION_ACCOUNT_UNAVAILABLE;
  }
  if (mode === 'off') {
    if (suggestion.mode !== undefined || suggestion.memoryBasis !== undefined) return SUGGESTION_UNAVAILABLE;
    return { available: true };
  }
  if (suggestion.mode !== mode) return SUGGESTION_UNAVAILABLE;
  if (mode === 'on_nobasis') {
    if (suggestion.memoryBasis !== undefined) return SUGGESTION_UNAVAILABLE;
    return { available: true };
  }
  if (!suggestion.memoryBasis) return { available: true };
  try {
    return await memoriesStillEligible(
      tx, uid, now, suggestion.memoryBasis.epoch, suggestion.memoryBasis.memoryIds,
    ) ? { available: true } : SUGGESTION_UNAVAILABLE;
  } catch (error) {
    return error instanceof AccountUnavailableError ? SUGGESTION_ACCOUNT_UNAVAILABLE : SUGGESTION_UNAVAILABLE;
  }
}

/** Availability check used immediately before every decision/answer claim. */
export async function suggestionAvailableForAction(
  uid: string,
  suggestionId: string,
  now: string,
  storage: StorageAdapter,
): Promise<boolean> {
  try {
    return await storage.runTransaction(async tx => {
      const suggestion = await tx.get<BasisSuggestionLike>(suggestionPath(uid, suggestionId));
      if (!suggestion) return false;
      return (await pendingSuggestionAvailability(tx, uid, suggestion, now)).available;
    });
  } catch {
    return false;
  }
}
