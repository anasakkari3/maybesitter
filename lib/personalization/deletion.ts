/**
 * Deletion, and the receipt that proves it happened.
 *
 * ── Why a receipt at all ─────────────────────────────────────────
 *
 * #42's acceptance criterion is that **deletion is verifiable**, and a boolean
 * `{ deleted: true }` from the module that did the deleting verifies nothing —
 * it is the same actor asserting its own success. Every field below is instead
 * something the caller can **recompute from the stores itself** and compare.
 * That is the whole design: the receipt is a claim with its own falsifier
 * attached, not a status.
 *
 * ── What deletion means against these stores ─────────────────────
 *
 * Both stores are append-only for *corrections*: `revoke()` adds a `revokedAt`
 * and rewrites nothing, so the history of what the user asked for stays
 * inspectable. Deletion is different in kind and both stores say so with a
 * separate verb — `deleteScope()` removes the rows outright and returns how
 * many it removed.
 *
 * Deletion here is therefore a **purge**, not a mass revocation. Revoking
 * everything would leave a profile derivable-from-nothing but the events still
 * on disk, and a user who asked to be forgotten would have been given a filter
 * rather than a deletion. The remainder counts below are what makes the
 * difference checkable: after a purge they are zero, and after a mass revoke
 * they would not be.
 *
 * ── The profile is not stored, and that is a claim too ───────────
 *
 * A derived profile is recomputed per read and never persisted, so there is no
 * third store to purge. `remainingPersistedProfileCount` exists to say that out
 * loud and keep saying it: if some later sprint adds a profile cache, whoever
 * adds it has to come here and decide what the number means, instead of the
 * cache quietly surviving a deletion that reports success.
 */
import {
  PERSONALIZATION_CONTRACT_VERSION,
  PERSONALIZATION_SCHEMA_VERSION,
  type Instant,
  type PersonalizationDeletionReceipt,
} from '../../src/contracts/v1/personalizationContracts';
import {
  computeFeedbackInputDigest,
  resolveFeedbackWindowDays,
} from '../feedback/feedbackAggregation';
import type { FeedbackEventStore } from '../../src/contracts/v1/feedbackContracts';
import type { RuntimeMemoryStore } from '../../src/contracts/v1/memoryContracts';

export interface PersonalizationDeletionInput {
  readonly scopeId: string;
  /** From the caller. This module never reads a clock. */
  readonly now: Instant;
  readonly feedbackEvents: FeedbackEventStore;
  readonly runtimeMemory: RuntimeMemoryStore;
  /**
   * The window the profile would have been derived over. It enters the digest,
   * so the caller and the receipt must agree on it or the recomputation will
   * not match — which is the check working, not a bug.
   */
  readonly windowDays?: number;
}

/**
 * The digest of the derivation input for a scope holding nothing.
 *
 * Exported because **#42 has to be able to compute this without calling us**.
 * A receipt whose proof can only be produced by the module under test is not a
 * proof; the verifier needs its own path to the same number.
 *
 * `baseline: null` is deliberate. `deleteScope` removes the baseline row with
 * everything else, so a post-deletion aggregation reads no baseline — passing
 * anything else here would compute the digest of a state that does not exist.
 */
export function emptyStateDigestFor(scopeId: string, now: Instant, windowDays?: number): string {
  return computeFeedbackInputDigest({
    events: [],
    baseline: null,
    scopeId,
    now,
    windowDays: resolveFeedbackWindowDays(windowDays),
  });
}

/**
 * Purges every trace of a scope and returns the receipt for it.
 *
 * The remainders are read **after** the deletes, from the stores, by listing —
 * not by subtracting what `deleteScope` claimed to remove from what was there
 * before. Trusting the return value would make the receipt a restatement of the
 * delete call's own opinion, and the one failure this must catch is a delete
 * that reports a count and leaves rows behind.
 */
export function deletePersonalizationScope(
  input: PersonalizationDeletionInput,
): PersonalizationDeletionReceipt {
  input.feedbackEvents.deleteScope(input.scopeId);
  input.runtimeMemory.deleteScope(input.scopeId);

  return {
    version: PERSONALIZATION_CONTRACT_VERSION,
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    scopeId: input.scopeId,
    deletedAt: input.now,
    remainingFeedbackEventCount: input.feedbackEvents.list({ scopeId: input.scopeId }).length,
    remainingRuntimeMemoryRecordCount: input.runtimeMemory.listAll(input.scopeId).length,
    // Structurally zero: nothing persists a profile. See the header.
    remainingPersistedProfileCount: 0,
    emptyStateDigest: emptyStateDigestFor(input.scopeId, input.now, input.windowDays),
  };
}
