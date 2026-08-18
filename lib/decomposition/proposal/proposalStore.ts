/**
 * In-memory store for decomposition proposals and their confirmations
 * (Sprint 06, issue #25).
 *
 * ── Admission, not `put` ────────────────────────────────────────────
 *
 * Storing a proposal is a decision, so the method returns one. A proposal that
 * fails entry validation is never stored, which means an inadmissible proposal
 * is not merely un-confirmable — it is not offerable either. Entry validation
 * runs here rather than only in #27's engine because a proposal can reach a
 * store from more than one producer, and the check that matters is the one made
 * by whoever is about to show it to a user.
 *
 * ── Idempotency ─────────────────────────────────────────────────────
 *
 * A replayed identical confirmation returns `replayed: true` and does not call
 * the port again, matching lib/services/captureBoundary/. Two cases Capture
 * handled with its catch-all code are handled explicitly here:
 *
 *  - Same key, different decisions. Returning the stored result would tell the
 *    caller its new decisions were applied when they were discarded, so it is
 *    refused.
 *  - A new key against an already-confirmed proposal. This is a second apply,
 *    and the whole point of the confirmation boundary is that it happens once.
 *
 * **Contract gap (reported, not worked around):** `ConfirmationFailureCode` has
 * no `already_confirmed`. Both cases above therefore return
 * `proposal_not_found` — accurate in the sense that there is no *open* proposal
 * left to confirm, and the least-wrong of the codes that exist. See
 * docs/architecture/decomposition-boundary.md.
 *
 * ── Ordering of the write and the record ────────────────────────────
 *
 * The confirmation is recorded only after the port returns. Recording first
 * would leave a failed write looking like a completed one, and the retry that
 * would have fixed it would be refused as a duplicate.
 *
 * Nothing here reads a clock or a random source: ids come from the proposal and
 * the request.
 */

import {
  DECOMPOSITION_CONTRACT_VERSION,
  type DecompositionConfirmationRequest,
  type DecompositionConfirmationResult,
  type DecompositionProposal,
  type DecompositionViolation,
} from '../../../src/contracts/v1/decompositionContracts';
import type { DecompositionPersistencePort } from './persistencePort';
import {
  reduceStepDecisions,
  resolveConfirmedSteps,
  validateProposalEntry,
  type ProposalState,
} from './proposalStateMachine';

export interface StoredProposal {
  readonly proposal: DecompositionProposal;
  readonly scopeId: string;
  /** Set once a confirmation has been applied. Absent means still open. */
  readonly confirmed: AppliedConfirmation | null;
}

export interface AppliedConfirmation {
  readonly idempotencyKey: string;
  /** The decisions as applied, so a replay can be told from a new request. */
  readonly decisionFingerprint: string;
  readonly result: DecompositionConfirmationResult;
}

export type ProposalAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly violations: readonly [DecompositionViolation, ...DecompositionViolation[]];
    };

export interface ProposalStoreDependencies {
  readonly persistence: DecompositionPersistencePort;
}

export interface DecompositionProposalStore {
  /** Validates on entry; an inadmissible proposal is not stored. */
  admit(entry: { readonly proposal: DecompositionProposal; readonly scopeId: string }): ProposalAdmission;
  get(proposalId: string): StoredProposal | undefined;
  confirm(request: DecompositionConfirmationRequest): Promise<DecompositionConfirmationResult>;
}

function failure(
  failureCode: NonNullable<DecompositionConfirmationResult['failureCode']>,
): DecompositionConfirmationResult {
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    success: false,
    replayed: false,
    persistedStepIds: [],
    rejectedStepIds: [],
    failureCode,
  };
}

/**
 * A canonical rendering of the decisions, used only to tell a replay from a new
 * request under a reused key. Order-sensitive on purpose: two decision lists
 * that differ in order are different requests to the reducer (the duplicate and
 * unknown-step checks are order-dependent), so they must not compare equal here.
 */
function fingerprint(request: DecompositionConfirmationRequest): string {
  return JSON.stringify(
    request.decisions.map((decision) => [
      decision.stepId,
      decision.verdict,
      decision.verdict === 'edit' ? decision.editedTitle.trim() : '',
    ]),
  );
}

export function createInMemoryProposalStore(
  dependencies: ProposalStoreDependencies,
): DecompositionProposalStore {
  const proposals = new Map<string, StoredProposal>();

  function admit(entry: {
    readonly proposal: DecompositionProposal;
    readonly scopeId: string;
  }): ProposalAdmission {
    const { proposal } = entry;

    // A rejected proposal already carries the reason it is unusable; re-deriving
    // one here would produce a second opinion about the same proposal.
    if (proposal.outcome === 'rejected') {
      return { admitted: false, violations: proposal.violations };
    }
    if (proposal.outcome === 'decomposed') {
      const violations = validateProposalEntry(proposal);
      if (violations.length > 0) {
        return {
          admitted: false,
          violations: violations as readonly [DecompositionViolation, ...DecompositionViolation[]],
        };
      }
    }

    proposals.set(proposal.proposalId, { proposal, scopeId: entry.scopeId, confirmed: null });
    return { admitted: true };
  }

  async function confirm(
    request: DecompositionConfirmationRequest,
  ): Promise<DecompositionConfirmationResult> {
    const stored = proposals.get(request.proposalId);
    // Scope mismatch is reported as "not found" rather than "not yours": a
    // caller outside the scope must not learn the id exists.
    if (!stored || stored.scopeId !== request.scopeId) return failure('proposal_not_found');

    if (stored.confirmed) {
      const isReplay =
        stored.confirmed.idempotencyKey === request.idempotencyKey &&
        stored.confirmed.decisionFingerprint === fingerprint(request);
      if (!isReplay) return failure('proposal_not_found');
      return { ...stored.confirmed.result, replayed: true };
    }

    if (stored.proposal.outcome !== 'decomposed') return failure('proposal_not_decomposed');

    const state: ProposalState = reduceStepDecisions(stored.proposal, request.decisions);
    if (state.failure !== null) return failure(state.failure.code);

    const resolved = resolveConfirmedSteps(state);
    if (resolved.confirmed.length > 0) {
      try {
        await dependencies.persistence.persistConfirmedSteps({
          proposalId: stored.proposal.proposalId,
          commitmentId: stored.proposal.commitmentId,
          scopeId: stored.scopeId,
          steps: resolved.confirmed,
        });
      } catch {
        // Nothing is recorded, so the caller may retry with the same key once
        // the adapter is healthy — the alternative strands the user with a
        // proposal that believes it was applied and steps that were not.
        return failure('persistence_failed');
      }
    }

    const result: DecompositionConfirmationResult = {
      version: DECOMPOSITION_CONTRACT_VERSION,
      success: true,
      replayed: false,
      persistedStepIds: resolved.confirmed.map((entry) => entry.step.stepId),
      rejectedStepIds: resolved.rejectedStepIds,
    };
    proposals.set(request.proposalId, {
      proposal: stored.proposal,
      scopeId: stored.scopeId,
      confirmed: {
        idempotencyKey: request.idempotencyKey,
        decisionFingerprint: fingerprint(request),
        result,
      },
    });
    return result;
  }

  return {
    admit,
    get: (proposalId: string) => proposals.get(proposalId),
    confirm,
  };
}
