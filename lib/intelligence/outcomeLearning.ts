import type { DomainEvent } from '../../src/domain/stateMachine';
import { getStorage, EVENTS, userCol, type StorageAdapter } from '../storage';
import { loadDomainState } from '../services/mobile/participantState';
import { putObservations, type StoredObservation } from './observationStore';
import { personalizationGrowthAllowed } from '../consents/personalizationConsentService';

const OUTCOME_TYPES = new Set(['commitment_completed', 'commitment_postponed', 'commitment_dropped']);

/**
 * Records only what an action proves: completed, postponed or dropped.
 * Postponing is not proof of failure, and an email is never proof of completion.
 * Stable event ids make repeated scans idempotent.
 */
export async function learnFromCommitmentEvents(
  uid: string,
  storage: StorageAdapter = getStorage(),
): Promise<StoredObservation[]> {
  if (!(await personalizationGrowthAllowed(uid, { storage }))) return [];
  const [rows, state] = await Promise.all([
    storage.list<DomainEvent>(userCol(uid, EVENTS), { orderBy: { field: 'at', direction: 'desc' }, limit: 100 }),
    loadDomainState(storage, uid),
  ]);
  const learned: StoredObservation[] = [];
  for (const { data: event } of rows) {
    if (!OUTCOME_TYPES.has(event.type) || !event.id || !Number.isFinite(Date.parse(event.at))) continue;
    const commitment = state.commitments[event.aggregateId];
    if (!commitment) continue;
    const verb = event.type === 'commitment_completed' ? 'Completed'
      : event.type === 'commitment_postponed' ? 'Postponed' : 'Dropped';
    const evidence = `${verb}: ${commitment.title}`.slice(0, 240);
    learned.push(...await putObservations(uid, 'behavior', event.id, event.at, [{
      kind: 'outcome', evidence, confidence: 1,
    }], storage));
  }
  return learned;
}
