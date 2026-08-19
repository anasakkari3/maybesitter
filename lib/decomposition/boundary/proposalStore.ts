/**
 * Where a proposal waits between being offered and being ruled on.
 *
 * Deliberately not persistence. `DECOMPOSITION_PERSISTENCE_POLICY.proposalCanPersist`
 * is false, and this store is in-memory and keyed only by proposal id so that
 * "the proposal is stored" can never be mistaken for "the steps exist".
 *
 * Two properties are enforced here rather than trusted, both ported from #25's
 * store because the mechanism is identical:
 *
 *  1. **Admission is never an overwrite.** An id already held keeps its scope
 *     and its confirmation. Re-admitting over the top of a confirmed proposal
 *     moved it into another scope and cleared the record that it had already
 *     been ruled on and written.
 *  2. **What is admitted is frozen.** The proposal is cloned before freezing,
 *     so the caller's object is neither aliased nor frozen underneath it, and a
 *     later mutation of that object cannot change what the boundary will
 *     confirm. Without this, rewriting a stored span forged the provenance that
 *     then got persisted — the spans are the entire claim a step makes about
 *     where it came from.
 */

import type { DecompositionProposal, DecompositionConfirmationResult } from '../../../src/contracts/v1/decompositionContracts';

/** Freeze in place, after the caller's copy has already been cloned away. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export interface StoredDecompositionProposal {
  readonly proposal: DecompositionProposal;
  readonly scopeId: string;
  /** Set once the proposal has been confirmed; a spent proposal is not re-confirmable. */
  confirmedResult?: DecompositionConfirmationResult;
  /**
   * The key that claimed this proposal. Written *before* the adapter is
   * awaited, not after it returns: the window between reading the proposal and
   * recording the result is long enough for a second confirmation to walk
   * straight through, and a UI double-submit is enough to reach it.
   */
  idempotencyKey?: string;
  /**
   * A canonical rendering of the decisions that claimed this proposal.
   *
   * The key alone is not identity. A caller that reuses a key while changing
   * what it asks for is making a *different* request, and answering it with the
   * stored result told a user who asked to reject every step that every step
   * had been saved.
   */
  decisionFingerprint?: string;
  /**
   * The confirmation currently in flight, so a concurrent replay of the same
   * key can await the one real attempt instead of starting a second write.
   */
  inFlight?: Promise<DecompositionConfirmationResult>;
}

export interface DecompositionProposalStore {
  put(stored: StoredDecompositionProposal): void;
  get(proposalId: string): StoredDecompositionProposal | undefined;
}

export class MemoryDecompositionProposalStore implements DecompositionProposalStore {
  private readonly proposals = new Map<string, StoredDecompositionProposal>();

  put(stored: StoredDecompositionProposal): void {
    if (this.proposals.has(stored.proposal.proposalId)) {
      // Throwing rather than refusing quietly: ids are minted per proposal, so
      // reaching this means a caller reused one, and a silent no-op would leave
      // it believing a proposal it can never confirm was admitted.
      throw new Error(`decomposition store: proposal ${stored.proposal.proposalId} is already admitted`);
    }
    this.proposals.set(stored.proposal.proposalId, {
      ...stored,
      proposal: deepFreeze(structuredClone(stored.proposal)),
    });
  }

  get(proposalId: string): StoredDecompositionProposal | undefined {
    return this.proposals.get(proposalId);
  }
}
