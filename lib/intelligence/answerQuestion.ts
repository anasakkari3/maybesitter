import { getStorage, type StorageAdapter } from '../storage';
import { analyzeSource } from './analyzeSource';
import { suggestionPath, type IntelligenceSuggestion } from './proposalEngine';
import { createHash } from 'node:crypto';
import { observationPath, type StoredObservation } from './observationStore';
import { isDismissedBehaviourOutcome } from './proposalEngine';
import { pendingSuggestionAvailability, SUGGESTION_UNAVAILABLE, SuggestionUnavailableError } from './memoryBasis';
import { readdCitationsAllowedInTransaction } from './readd';

/** A question's answer becomes evidence for the next cycle, not an obligation. */
export async function answerIntelligenceQuestion(
  uid: string,
  id: string,
  answer: string,
  now: string,
  storage: StorageAdapter = getStorage(),
  readdClientSupported = false,
): Promise<IntelligenceSuggestion | null> {
  const text = answer.trim();
  if (text.length < 2 || text.length > 500) throw new Error('invalid_answer');
  const digest = createHash('sha256').update(text).digest('hex');
  const path = suggestionPath(uid, id);
  const claimed = await storage.runTransaction(async tx => {
    const current = await tx.get<IntelligenceSuggestion>(path);
    if (!current || current.kind !== 'question' || current.status === 'dismissed') return null;
    if (current.status === 'accepting' && current.answerDigest !== digest) return null;
    // The account fence first and authoritative, then the re-add guard, then
    // the dismissed-outcome handling; every read before the first write.
    const availability = current.status === 'pending'
      ? await pendingSuggestionAvailability(tx, uid, current, now)
      : null;
    if (availability && !availability.available && availability.accountUnavailable) return availability;
    const cited = await Promise.all(current.observationIds.map(observationId =>
      tx.get<StoredObservation>(observationPath(uid, observationId))));
    if (!(await readdCitationsAllowedInTransaction(tx, uid, cited, readdClientSupported))) return SUGGESTION_UNAVAILABLE;
    if (availability) {
      if (cited.some(isDismissedBehaviourOutcome)) {
        tx.set(path, { ...current, status: 'dismissed', decidedAt: now });
        return availability.available ? null : availability;
      }
      if (!availability.available) return availability;
    }
    if (current.status === 'pending') tx.set(path, { ...current, status: 'accepting', answerDigest: digest });
    return current;
  });
  if (claimed && 'available' in claimed) throw new SuggestionUnavailableError();
  if (!claimed) return null;
  if (claimed.status === 'accepted') return claimed;
  await analyzeSource(uid, 'manual', `answer:${id}`, text, now, { storage });
  return storage.runTransaction(async tx => {
    const current = await tx.get<IntelligenceSuggestion>(path);
    if (!current || current.kind !== 'question') return null;
    const next: IntelligenceSuggestion = { ...current, status: 'accepted', decidedAt: now };
    tx.set(path, next);
    return next;
  });
}
