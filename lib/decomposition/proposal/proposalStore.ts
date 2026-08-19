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
 * A proposal id is admitted once. Re-admitting an id that is already held is
 * refused rather than overwritten, which Capture's store does not do and needs
 * to here: an overwrite reset the stored confirmation, so re-admitting an
 * applied proposal made it applicable a second time, and re-admitting it under
 * another `scopeId` moved a live proposal into a scope that never owned it. A
 * guard that any caller can clear by calling `admit` again is not a guard.
 *
 * ── Idempotency ─────────────────────────────────────────────────────
 *
 * A replayed identical confirmation returns `replayed: true` and does not call
 * the port again, matching lib/services/captureBoundary/. Two cases Capture
 * handled with its catch-all code report `already_confirmed` here:
 *
 *  - Same key, different decisions. Returning the stored result would tell the
 *    caller its new decisions were applied when they were discarded.
 *  - A new key against an already-confirmed proposal. This is a second apply,
 *    and the whole point of the confirmation boundary is that it happens once.
 *
 * Neither is `proposal_not_found`: a caller told its proposal does not exist
 * will retry, and this is the one case where retrying is exactly wrong.
 *
 * ── Ordering of the write and the record ────────────────────────────
 *
 * The confirmation is recorded only after the port returns. Recording first
 * would leave a failed write looking like a completed one, and the retry that
 * would have fixed it would be refused as a duplicate.
 *
 * That ordering opens a window, so confirmations for one proposal are
 * serialized: `confirm` chains onto any call already in flight for the same id
 * *before* it yields, so two concurrent callers cannot both read an unconfirmed
 * proposal and both reach the port. The chaining is synchronous up to the first
 * await, which is what makes the reservation atomic on a single-threaded loop.
 *
 * ── Nothing mutable leaves ──────────────────────────────────────────
 *
 * An admitted proposal is cloned and deep-frozen. The store used to hand back
 * the caller's own object, and a confirmed step shared its `sourceSpans` array
 * with the stored proposal — so an adapter normalizing spans in place would
 * rewrite the provenance of the stored proposal, which is precisely the
 * corruption the reducer's "spans are never touched" rule exists to prevent,
 * reached by a route that rule did not cover.
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

/**
 * Why a proposal was not admitted.
 *
 * `already_admitted` carries no violations: nothing is wrong with the proposal,
 * the id is simply taken. Keeping it distinct from `invalid` matters because
 * the two need opposite responses — fix the proposal, or stop re-admitting it.
 */
export type AdmissionRefusal = 'invalid' | 'proposal_rejected' | 'already_admitted';

export type ProposalAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: AdmissionRefusal;
      readonly violations: readonly DecompositionViolation[];
    };

export interface ProposalStoreDependencies {
  readonly persistence: DecompositionPersistencePort;
}

/**
 * The reducer-side store: admission, proposal state, and confirmation.
 *
 * Distinct from #27's `DecompositionProposalStore`, which is the boundary
 * service's store and holds a different shape. The names collided until now,
 * and a mistaken import failed with a message naming the same type twice.
 */
export interface ProposalStateStore {
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
 * Recursively freezes a value in place.
 *
 * Applied to the store's own clone, never to the caller's object — freezing an
 * argument is a side effect on someone else's data. Frozen rather than cloned
 * on every read: a clone per `get` is a fresh mutable object each time, so a
 * caller could still corrupt what it was handed and be surprised later, and the
 * port would still receive mutable spans.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
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
): ProposalStateStore {
  const proposals = new Map<string, StoredProposal>();
  /** Tail of the confirmation chain per proposalId. See the header. */
  const inFlight = new Map<string, Promise<void>>();

  function admit(entry: {
    readonly proposal: DecompositionProposal;
    readonly scopeId: string;
  }): ProposalAdmission {
    const { proposal } = entry;

    // Never an overwrite. An id already held keeps its scope and its
    // confirmation, so neither can be reset by admitting over the top of it.
    if (proposals.has(proposal.proposalId)) {
      return { admitted: false, reason: 'already_admitted', violations: [] };
    }

    // A rejected proposal already carries the reason it is unusable; re-deriving
    // one here would produce a second opinion about the same proposal.
    if (proposal.outcome === 'rejected') {
      return { admitted: false, reason: 'proposal_rejected', violations: proposal.violations };
    }
    if (proposal.outcome === 'decomposed') {
      const violations = validateProposalEntry(proposal);
      if (violations.length > 0) return { admitted: false, reason: 'invalid', violations };
    }

    // Cloned before freezing so the caller's object is neither aliased nor
    // frozen underneath it, and so a later mutation of that object cannot
    // change what was admitted.
    proposals.set(proposal.proposalId, {
      proposal: deepFreeze(structuredClone(proposal)),
      scopeId: entry.scopeId,
      confirmed: null,
    });
    return { admitted: true };
  }

  /**
   * Why the request's own envelope is unusable, or null.
   *
   * The three identity fields are checked before anything reads them: a
   * non-string `idempotencyKey` used to be stored verbatim and compared by
   * `===` on replay, so a key of `{}` never matched itself and every retry read
   * as a fresh confirmation of an applied proposal. `proposal_not_found` is the
   * honest answer — a request that cannot name a proposal has not found one —
   * and it leaks nothing about which ids exist.
   *
   * The decisions themselves are the reducer's to judge, and it does; this is
   * only the envelope the reducer never sees.
   */
  function malformedEnvelope(request: DecompositionConfirmationRequest): boolean {
    return (
      typeof request?.proposalId !== 'string'
      || typeof request.scopeId !== 'string'
      || typeof request.idempotencyKey !== 'string'
    );
  }

  async function confirmExclusive(
    request: DecompositionConfirmationRequest,
  ): Promise<DecompositionConfirmationResult> {
    if (malformedEnvelope(request)) return failure('proposal_not_found');

    const stored = proposals.get(request.proposalId);
    // Scope mismatch is reported as "not found" rather than "not yours": a
    // caller outside the scope must not learn the id exists.
    if (!stored || stored.scopeId !== request.scopeId) return failure('proposal_not_found');

    if (stored.confirmed) {
      const isReplay =
        stored.confirmed.idempotencyKey === request.idempotencyKey &&
        stored.confirmed.decisionFingerprint === fingerprint(request);
      if (!isReplay) return failure('already_confirmed');
      return { ...stored.confirmed.result, replayed: true };
    }

    if (stored.proposal.outcome !== 'decomposed') return failure('proposal_not_decomposed');

    const state: ProposalState = reduceStepDecisions(stored.proposal, request.decisions);
    if (state.failure !== null) return failure(state.failure.code);

    const resolved = resolveConfirmedSteps(state);
    if (resolved.confirmed.length > 0) {
      try {
        await dependencies.persistence.persistConfirmedSteps(
          deepFreeze({
            proposalId: stored.proposal.proposalId,
            commitmentId: stored.proposal.commitmentId,
            scopeId: stored.scopeId,
            steps: resolved.confirmed,
          }),
        );
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

  function confirm(
    request: DecompositionConfirmationRequest,
  ): Promise<DecompositionConfirmationResult> {
    // Everything up to the first `await` inside this function runs without
    // yielding, so registering the new tail here reserves the slot: a second
    // caller arriving later chains onto this call rather than racing it.
    // A request that cannot name a proposal is refused before it can key the
    // in-flight map with a non-string and share a chain with unrelated callers.
    if (malformedEnvelope(request)) return Promise.resolve(failure('proposal_not_found'));

    const tail = inFlight.get(request.proposalId);
    const run = tail
      ? tail.then(() => confirmExclusive(request))
      : confirmExclusive(request);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    inFlight.set(request.proposalId, settled);
    void settled.then(() => {
      // Only the last caller clears the entry, so the chain does not grow
      // without bound and a later confirm does not wait on a finished one.
      if (inFlight.get(request.proposalId) === settled) inFlight.delete(request.proposalId);
    });
    return run;
  }

  return {
    admit,
    get: (proposalId: string) => proposals.get(proposalId),
    confirm,
  };
}
