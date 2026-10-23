import { getStorage, type StorageAdapter } from '../storage';
import { listMemory } from '../services/mobile/memoryService';
import { loadDomainState } from '../services/mobile/participantState';
import { putObservations, type StoredObservation } from './observationStore';
import { m5bBasisMode } from '../release/m5bCapabilities';
import { readActiveMemorySnapshot, type MemorySnapshot } from './memoryBasis';

/** Pull existing confirmed goals and work into the same evidence index. */
export async function syncCanonicalObservations(
  uid: string,
  now: string,
  storage: StorageAdapter = getStorage(),
  suppliedSnapshot?: MemorySnapshot,
): Promise<StoredObservation[]> {
  const mode = m5bBasisMode();
  const state = await loadDomainState(storage, uid);
  let snapshot = suppliedSnapshot;
  let memory: Awaited<ReturnType<typeof listMemory>> = [];
  if (mode !== 'on_nobasis') {
    if (mode === 'on_basis') {
      snapshot = snapshot ?? await readActiveMemorySnapshot(uid, now, storage);
      memory = snapshot.available ? Array.from(snapshot.records.values()).map(item => ({
        id: item.id, kind: item.kind, content: item.content, language: item.language,
        source: item.source, confidence: item.confidence, status: item.status,
        observedAt: item.observedAt, staleAfter: item.staleAfter,
      } as any)) : [];
    } else {
      memory = await listMemory(uid, now, { storage });
    }
  }
  const result: StoredObservation[] = [];
  for (const item of memory.filter(item => item.kind === 'goal').slice(0, 30)) {
    result.push(...await putObservations(uid, 'memory', item.id, item.observedAt,
      [{ kind: 'goal', evidence: item.content, confidence: item.confidence }], storage, undefined,
      mode === 'on_basis' ? { memoryId: item.id, personalizationEpoch: snapshot!.epoch, now } : undefined));
  }
  for (const item of Object.values(state.commitments)
    .filter(item => item.status === 'active' || item.status === 'deferred').slice(0, 50)) {
    result.push(...await putObservations(uid, 'commitment', item.id, item.updatedAt,
      [{ kind: 'commitment', evidence: item.title, confidence: 1 }], storage));
  }
  return result;
}
