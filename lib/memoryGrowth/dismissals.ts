/**
 * "Not right": the one thing a dismissal remembers (UC-3.16, #202).
 *
 * `users/{uid}/memoryDismissals/{ruleId}` holds the fingerprint last dismissed
 * for that rule. One document per rule, overwritten, so the collection cannot
 * grow into a history of every window someone was once offered — it only has
 * to answer "was *this* claim turned down?".
 *
 * Separate from `suggestionService.ts` so that `memoryService.ts` can record a
 * dismissal when a kept suggestion is deleted without importing the service
 * that imports it.
 */
import { userDoc } from '../storage/paths';
import { MEMORY_DISMISSALS, requireUserId, userSubDoc, type StorageAdapter, type StorageReader } from '../storage';
import { MEMORY_GROWTH_RULE_IDS, type MemoryGrowthRuleId } from './rules';

export interface StoredMemoryDismissal {
  readonly ruleId: MemoryGrowthRuleId;
  readonly fingerprint: string;
  readonly dismissedAt: string;
}

export function isMemoryGrowthRuleId(value: unknown): value is MemoryGrowthRuleId {
  return typeof value === 'string' && (MEMORY_GROWTH_RULE_IDS as readonly string[]).includes(value);
}

/** The ruleId a fingerprint belongs to: everything before the first colon. */
export function ruleIdOfFingerprint(fingerprint: unknown): MemoryGrowthRuleId | null {
  if (typeof fingerprint !== 'string') return null;
  const ruleId = fingerprint.split(':')[0];
  return isMemoryGrowthRuleId(ruleId) ? ruleId : null;
}

export async function readDismissedFingerprint(
  reader: StorageReader,
  uid: string,
  ruleId: MemoryGrowthRuleId,
): Promise<string | null> {
  const stored = await reader.get<StoredMemoryDismissal>(userSubDoc(requireUserId(uid), MEMORY_DISMISSALS, ruleId));
  return stored && typeof stored.fingerprint === 'string' ? stored.fingerprint : null;
}

/**
 * Records a dismissal, in a transaction that refuses while a personalization
 * purge holds the fence (M5B2A-R30-001): one written beside a delete-all could
 * land after the purge's remainder check and survive a delete that said done.
 * False when refused; nothing is written then.
 */
export async function recordDismissal(
  storage: StorageAdapter,
  uid: string,
  fingerprint: string,
  at: string,
): Promise<boolean> {
  const ruleId = ruleIdOfFingerprint(fingerprint);
  if (!ruleId) return true;
  return storage.runTransaction(async (tx) => {
    const user = await tx.get<{ personalizationPurge?: { state?: unknown } }>(userDoc(requireUserId(uid)));
    if (user?.personalizationPurge?.state === 'purging') return false;
    tx.set<StoredMemoryDismissal>(userSubDoc(uid, MEMORY_DISMISSALS, ruleId), { ruleId, fingerprint, dismissedAt: at });
    return true;
  });
}
