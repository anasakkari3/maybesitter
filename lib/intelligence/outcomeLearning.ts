import type { DomainEvent } from '../../src/domain/stateMachine';
import { getStorage, EVENTS, INTELLIGENCE_OBSERVATIONS, userCol, type StorageAdapter } from '../storage';
import { loadDomainState } from '../services/mobile/participantState';
import { putObservations, type StoredObservation } from './observationStore';
import { personalizationGrowthAllowed } from '../consents/personalizationConsentService';
import { intelligenceEnabled } from './gate';

const OUTCOME_TYPES = new Set(['commitment_completed', 'commitment_postponed', 'commitment_dropped']);

/**
 * Records only what an action proves: completed, postponed or dropped.
 * Postponing is not proof of failure, and an email is never proof of completion.
 *
 * One event is one observation, ever. The observation id hashes the evidence,
 * and the evidence carries the commitment's title, so renaming a commitment
 * after it was completed used to mint a second "Completed" for the same event
 * on the next scan. The event id is the stable key: an event already recorded
 * under it is skipped, whatever its commitment is called now.
 */
export async function learnFromCommitmentEvents(
  uid: string,
  storage: StorageAdapter = getStorage(),
): Promise<StoredObservation[]> {
  if (!(await personalizationGrowthAllowed(uid, { storage }))) return [];
  const rows = await storage.list<DomainEvent>(userCol(uid, EVENTS), { orderBy: { field: 'at', direction: 'desc' }, limit: 100 });
  const outcomes = rows.map(row => row.data)
    .filter(event => OUTCOME_TYPES.has(event.type) && event.id && Number.isFinite(Date.parse(event.at)));
  if (outcomes.length === 0) return [];
  // What is already recorded, read only as far back as the oldest outcome in
  // this scan: an outcome observation is stamped with its event's time, so
  // nothing older can be one of these. One field, so no composite index, and
  // the read stays the size of the scan window rather than of the account.
  const oldest = outcomes.reduce((min, event) => event.at < min ? event.at : min, outcomes[0]!.at);
  const [state, recorded] = await Promise.all([
    loadDomainState(storage, uid),
    storage.list<StoredObservation>(userCol(uid, INTELLIGENCE_OBSERVATIONS), { where: [['observedAt', '>=', oldest]] }),
  ]);
  const seen = new Set(recorded.filter(row => row.data.source === 'behavior').map(row => row.data.sourceRef));
  const learned: StoredObservation[] = [];
  for (const event of outcomes) {
    if (seen.has(event.id)) continue;
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

/**
 * Outcome learning wired to what the person actually does (review of
 * 2026-10-03, priority 2): called after a commitment is completed, postponed
 * or dropped, and when the inbox is read — never only from generation, which
 * nobody reached in production. No model call; the loop's own gate and the
 * personalization consent (inside `learnFromCommitmentEvents`) decide, and a
 * failure here never fails the action that triggered it.
 */
export async function learnOutcomesWhenEnabled(
  uid: string,
  storage: StorageAdapter = getStorage(),
): Promise<StoredObservation[]> {
  if (!intelligenceEnabled()) return [];
  try { return await learnFromCommitmentEvents(uid, storage); }
  catch { return []; }
}

/**
 * The same, waited for at most `ms`: a person's tap or an inbox read is never
 * held hostage by the scan. What does not finish in time keeps running and is
 * caught up by the next read; it cannot fail, since the call above cannot.
 */
export async function learnOutcomesWithin(
  uid: string,
  ms = 1_000,
  storage: StorageAdapter = getStorage(),
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      learnOutcomesWhenEnabled(uid, storage),
      new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
