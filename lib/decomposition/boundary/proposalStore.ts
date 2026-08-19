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

/**
 * Freeze in place, after the caller's copy has already been cloned away.
 *
 * Iterative, with an explicit stack, for the same reason the cycle walker is:
 * one JS frame per level means a deeply nested object overflows the stack, and
 * this ran on data that had just come from a model provider. Fixing recursion
 * in one place and leaving it in another is how a defect class survives a fix.
 */
function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const key of Object.keys(current as Record<string, unknown>)) {
      pending.push((current as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** What a caller admits: a proposal and the scope it belongs to. */
export interface StoredDecompositionProposal {
  readonly proposal: DecompositionProposal;
  readonly scopeId: string;
}

/**
 * What a reader gets back: a snapshot, not a handle.
 *
 * `get` used to return the live internal record, so anyone holding it could
 * clear the idempotency key or plant a confirmation — the proposal inside was
 * cloned and frozen, but the record around it was not, and that record is what
 * decides whether a write has already happened. Confirmation state changes only
 * through `claim`, `settle` and `release`.
 */
export interface StoredDecompositionProposalView extends StoredDecompositionProposal {
  /** Set once the proposal has been confirmed; a spent proposal is not re-confirmable. */
  readonly confirmedResult?: DecompositionConfirmationResult;
  /**
   * The key that claimed this proposal. Written *before* the adapter is
   * awaited, not after it returns: the window between reading the proposal and
   * recording the result is long enough for a second confirmation to walk
   * straight through, and a UI double-submit is enough to reach it.
   */
  readonly idempotencyKey?: string;
  /**
   * A canonical rendering of the decisions that claimed this proposal.
   *
   * The key alone is not identity. A caller that reuses a key while changing
   * what it asks for is making a *different* request, and answering it with the
   * stored result told a user who asked to reject every step that every step
   * had been saved.
   */
  readonly decisionFingerprint?: string;
  /**
   * The confirmation currently in flight, so a concurrent replay of the same
   * key can await the one real attempt instead of starting a second write.
   */
  readonly inFlight?: Promise<DecompositionConfirmationResult>;
}

export interface DecompositionProposalStore {
  put(stored: StoredDecompositionProposal): void;
  get(proposalId: string): StoredDecompositionProposalView | undefined;
  /** Take the proposal, before the adapter is awaited. */
  claim(
    proposalId: string,
    idempotencyKey: string,
    decisionFingerprint: string,
    inFlight?: Promise<DecompositionConfirmationResult>,
  ): void;
  /** Record the ruling that landed. */
  settle(proposalId: string, result: DecompositionConfirmationResult): void;
  /** Give the proposal back, because the write did not happen. */
  release(proposalId: string): void;
}

interface StoreRecord {
  readonly proposal: DecompositionProposal;
  readonly scopeId: string;
  confirmedResult?: DecompositionConfirmationResult;
  idempotencyKey?: string;
  decisionFingerprint?: string;
  inFlight?: Promise<DecompositionConfirmationResult>;
}

export class MemoryDecompositionProposalStore implements DecompositionProposalStore {
  private readonly proposals = new Map<string, StoreRecord>();

  put(stored: StoredDecompositionProposal): void {
    if (this.proposals.has(stored.proposal.proposalId)) {
      // Throwing rather than refusing quietly: ids are minted per proposal, so
      // reaching this means a caller reused one, and a silent no-op would leave
      // it believing a proposal it can never confirm was admitted.
      throw new Error(`decomposition store: proposal ${stored.proposal.proposalId} is already admitted`);
    }
    this.proposals.set(stored.proposal.proposalId, {
      proposal: deepFreeze(structuredClone(stored.proposal)),
      scopeId: stored.scopeId,
    });
  }

  get(proposalId: string): StoredDecompositionProposalView | undefined {
    const record = this.proposals.get(proposalId);
    if (!record) return undefined;
    // A frozen snapshot. The proposal is already deeply frozen from `put`; this
    // copies the mutable confirmation fields so a holder cannot rewrite them.
    return Object.freeze({
      proposal: record.proposal,
      scopeId: record.scopeId,
      confirmedResult: record.confirmedResult,
      idempotencyKey: record.idempotencyKey,
      decisionFingerprint: record.decisionFingerprint,
      inFlight: record.inFlight,
    });
  }

  claim(
    proposalId: string,
    idempotencyKey: string,
    decisionFingerprint: string,
    inFlight?: Promise<DecompositionConfirmationResult>,
  ): void {
    const record = this.proposals.get(proposalId);
    if (!record) return;
    record.idempotencyKey = idempotencyKey;
    record.decisionFingerprint = decisionFingerprint;
    record.inFlight = inFlight;
  }

  settle(proposalId: string, result: DecompositionConfirmationResult): void {
    const record = this.proposals.get(proposalId);
    if (!record) return;
    record.confirmedResult = result;
    record.inFlight = undefined;
  }

  release(proposalId: string): void {
    const record = this.proposals.get(proposalId);
    if (!record) return;
    record.idempotencyKey = undefined;
    record.decisionFingerprint = undefined;
    record.inFlight = undefined;
  }
}
