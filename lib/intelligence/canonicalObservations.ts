import { getStorage, type StorageAdapter } from '../storage';
import { listMemory } from '../services/mobile/memoryService';
import { loadDomainState } from '../services/mobile/participantState';
import { putObservations, type StoredObservation } from './observationStore';

/** Pull existing confirmed goals and work into the same evidence index. */
export async function syncCanonicalObservations(
  uid: string,
  now: string,
  storage: StorageAdapter = getStorage(),
): Promise<StoredObservation[]> {
  const [memory, state] = await Promise.all([
    listMemory(uid, now, { storage }), loadDomainState(storage, uid),
  ]);
  const result: StoredObservation[] = [];
  for (const item of memory.filter(item => item.kind === 'goal').slice(0, 30)) {
    result.push(...await putObservations(uid, 'memory', item.id, item.observedAt,
      [{ kind: 'goal', evidence: item.content, confidence: item.confidence }], storage));
  }
  for (const item of Object.values(state.commitments)
    .filter(item => item.status === 'active' || item.status === 'deferred').slice(0, 50)) {
    result.push(...await putObservations(uid, 'commitment', item.id, item.updatedAt,
      [{ kind: 'commitment', evidence: item.title, confidence: 1 }], storage));
  }
  return result;
}
