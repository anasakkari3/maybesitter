/**
 * The decomposition boundary: propose, confirm explicitly, then write.
 *
 * This is the Sprint 01 capture boundary applied to a graph instead of a list,
 * and it keeps the same four properties for the same reasons:
 *
 *  1. **Proposing never writes.** Engine output goes to the store and to the
 *     caller, never to the adapter. A `RejectedProposal` or an `AtomicProposal`
 *     is refused at confirmation rather than filtered at write time, so there
 *     is no code path where the adapter's input depends on the proposal's
 *     outcome being read correctly.
 *  2. **Every step needs its own verdict.** A confirmation that omits a step is
 *     invalid, not partially applied. Silence is not consent, and the whole
 *     point of "partial acceptance is explicit" is that the set the user did
 *     not accept is stated rather than inferred from what they left out.
 *  3. **Confirmation is scoped, idempotent and claimed before it writes.** The
 *     scope is checked before the proposal is used, and a replay of the same
 *     `idempotencyKey` returns the stored result rather than writing again.
 *     The claim is recorded *before* the adapter is awaited, because the gap
 *     between reading a proposal and recording its result is a window a second
 *     confirmation walks straight through — and here the two confirmations
 *     carry per-step verdicts, so the loser's rejected steps end up canonical.
 *  4. **Audit carries a hash, never the text.** The input is hashed and
 *     measured; the words are not copied anywhere an operator can read them.
 *     This matters more here than in Capture, because a decomposition's spans
 *     are *made of* the user's sentence.
 *
 * ── What this module does *not* decide ──────────────────────────────
 *
 * What an accept/edit/reject ruling means. That is `proposalStateMachine.ts`,
 * and it used to be here as well: `resolveDecisions` was a second reducer over
 * the same contract, written by a parallel track that could not import the
 * first. Every review round found a defect on one side that had already been
 * fixed on the other — an unknown verdict silently read as consent, an edit
 * held to a weaker standard than an admission, a verdict read twice and
 * answered differently. Two implementations of one judgement is the arrangement
 * that produces that, so this module now normalises the request, hands the
 * decisions to the reducer, and turns what comes back into the persistence
 * shape. The reducer decides; this module writes.
 */

import { createHash, randomUUID } from 'crypto';
import {
  DECOMPOSITION_CONTRACT_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  type ConfirmationFailureCode,
  type DecomposedProposal,
  type DecompositionConfirmationRequest,
  type DecompositionConfirmationResult,
  type DecompositionProposal,
} from '../../../src/contracts/v1/decompositionContracts';
import {
  createAuditEvent,
  type AuditEventEnvelope,
  type AuditOutcome,
  type RuntimeControlSnapshot,
} from '../../../src/contracts/v1/runtimeControls';
import { proposeDecomposition, titleAdmission, type DecompositionModelProvider } from '../engine/index';
// The one reducer. `resolveDecisions` used to live in this file and answer the
// same question a second time; see the header of proposalStateMachine.ts for
// what that cost. Nothing flows the other way: the reducer cannot import this
// module, which tests/decomposition/proposalBoundaries.test.ts enforces.
import {
  normaliseStepDecisions,
  reduceNormalisedDecisions,
  resolveConfirmedSteps,
  validateProposalEntry,
  type NormalisedStepDecision,
  type ProposalStateFailure,
  type ResolvedConfirmation,
} from '../proposal/proposalStateMachine';
import type { ConfirmedDecompositionStep, DecompositionPersistenceAdapter } from './persistenceAdapter';
import type { DecompositionProposalStore } from './proposalStore';

export interface DecompositionBoundaryDependencies {
  readonly store: DecompositionProposalStore;
  readonly persistence: DecompositionPersistenceAdapter;
  readonly audit?: (event: AuditEventEnvelope) => void;
  readonly controls?: RuntimeControlSnapshot;
  readonly modelProvider?: DecompositionModelProvider;
  /** Injected so a caller can make a run reproducible; defaults to `randomUUID`. */
  readonly newProposalId?: () => string;
}

/**
 * Bounds on what the boundary will look at.
 *
 * Not tuning: an unbounded input is an unbounded amount of synchronous work on
 * a single-threaded runtime, and decomposition runs rules-first by default, so
 * one request is enough to stall the process. The limits are generous for a
 * commitment a person typed and stated rather than buried.
 */
const MAX_SOURCE_TEXT_LENGTH = 10_000;

export interface ProposeDecompositionOptions {
  readonly commitmentId: string;
  readonly scopeId: string;
  readonly now: Date;
  readonly requestedEngine?: 'model' | 'rules';
  readonly minimumConfidence?: number;
  readonly allowRulesFallback?: boolean;
  readonly declaredAtomic?: boolean;
}

/**
 * Audit envelope for one boundary action.
 *
 * `createAuditEvent` copies an allowlist, so an extra field added here by a
 * later caller is dropped rather than emitted — but the hash is computed here,
 * and it is the only representation of the input that leaves.
 */
function auditEvent(
  outcome: AuditOutcome,
  raw: string,
  now: Date,
  reasonCode: string,
  itemCount: number,
): AuditEventEnvelope {
  return createAuditEvent({
    eventId: randomUUID(),
    eventType: 'module_execution',
    occurredAt: now.toISOString(),
    correlationId: randomUUID(),
    module: 'decomposition',
    fields: {
      outcome,
      reasonCode,
      itemCount,
      inputHash: createHash('sha256').update(raw).digest('hex'),
      inputLength: raw.length,
    },
  });
}

export async function proposeDecompositionBoundary(
  rawInput: unknown,
  options: ProposeDecompositionOptions,
  dependencies: DecompositionBoundaryDependencies,
): Promise<DecompositionProposal> {
  const proposalId = (dependencies.newProposalId ?? randomUUID)();

  // A caller bug is a failure of *this attempt*, never a finding about the
  // commitment. Coercing to '' and letting the engine answer `not_decomposable`
  // would record "we read this and it is one action" about input nobody read,
  // and audit it as a success. `engine_unavailable` is the honest answer: we
  // could not try.
  if (typeof rawInput !== 'string' || rawInput.length > MAX_SOURCE_TEXT_LENGTH) {
    const unreadable: DecompositionProposal = {
      version: DECOMPOSITION_CONTRACT_VERSION,
      schema: DECOMPOSITION_SCHEMA_VERSION,
      proposalId,
      commitmentId: options.commitmentId,
      sourceText: '',
      provenance: {
        requestedEngine: options.requestedEngine ?? 'model',
        executedEngine: options.requestedEngine ?? 'model',
        fallbackUsed: false,
      },
      outcome: 'atomic',
      reason: 'engine_unavailable',
    };
    dependencies.store.put({ proposal: unreadable, scopeId: options.scopeId });
    dependencies.audit?.(auditEvent(
      'failed',
      '',
      options.now,
      typeof rawInput === 'string' ? 'input_too_long' : 'unreadable_input',
      0,
    ));
    return unreadable;
  }

  const sourceText = rawInput;

  const proposal = await proposeDecomposition({
    proposalId,
    commitmentId: options.commitmentId,
    sourceText,
    requestedEngine: options.requestedEngine,
    minimumConfidence: options.minimumConfidence,
    allowRulesFallback: options.allowRulesFallback,
    declaredAtomic: options.declaredAtomic,
  }, {
    modelProvider: dependencies.modelProvider,
    controls: dependencies.controls,
  });

  dependencies.store.put({ proposal, scopeId: options.scopeId });

  const outcome: AuditOutcome = proposal.outcome === 'rejected'
    ? 'rejected'
    : proposal.provenance.fallbackUsed
      ? 'fell_back'
      : 'succeeded';
  const reasonCode = proposal.outcome === 'atomic'
    ? `atomic:${proposal.reason}`
    : proposal.outcome === 'rejected'
      ? `rejected:${proposal.violations[0].code}`
      : 'decomposed';
  dependencies.audit?.(auditEvent(
    outcome,
    sourceText,
    options.now,
    reasonCode,
    proposal.outcome === 'decomposed' ? proposal.steps.length : 0,
  ));

  return proposal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A confirmation request, already read out of the caller's object. */
interface NormalisedRequest {
  readonly proposalId: string;
  readonly scopeId: string;
  readonly idempotencyKey: string;
  readonly decisions: readonly NormalisedStepDecision[];
  readonly fingerprint: string;
}

/**
 * Read the request's own envelope once, into plain data, or say why it is not a
 * confirmation.
 *
 * "Once" is the security property, not a tidiness preference: a field read
 * twice can answer differently the second time, and every value below is used
 * to decide whether a write happens. The four reads sit in one `try` because a
 * getter or a `Proxy` trap that throws is the same hostile input as one that
 * lies, and a raw `Error` crossing this surface leaves a caller unable to tell
 * a refusal from a crash. `proposal_not_found` is the honest answer to both: a
 * request whose own fields cannot be read has not named a proposal, and it
 * leaks nothing about which ids exist.
 *
 * The object-ness check comes first because the previous version dereferenced
 * `request.proposalId` before establishing there was a request at all — the
 * same defect one level up from the one it was written to fix.
 *
 * The *decisions* are not read here. They are handed to the proposal reducer's
 * `normaliseStepDecisions`, which is the one place in the sprint that decides
 * what a well-formed ruling is. This module used to decide that too, and the
 * two answers drifted apart in every review round.
 */
function normaliseRequest(
  request: unknown,
): NormalisedRequest | ConfirmationFailureCode {
  if (!isRecord(request)) return 'proposal_not_found';

  let proposalId: unknown;
  let scopeId: unknown;
  let idempotencyKey: unknown;
  let rawDecisions: unknown;
  try {
    proposalId = request.proposalId;
    scopeId = request.scopeId;
    idempotencyKey = request.idempotencyKey;
    rawDecisions = request.decisions;
  } catch {
    return 'proposal_not_found';
  }

  if (typeof proposalId !== 'string' || typeof scopeId !== 'string' || typeof idempotencyKey !== 'string') {
    return 'proposal_not_found';
  }

  const decisions = normaliseStepDecisions(rawDecisions);
  if (!Array.isArray(decisions)) return (decisions as ProposalStateFailure).code;

  return {
    proposalId,
    scopeId,
    idempotencyKey,
    decisions,
    // Order-sensitive on purpose: two decision lists differing in order are
    // different requests, and treating them as one would silently accept a
    // ruling the user did not make. Taken over the *normalised* copy, so the
    // ruling that is fingerprinted is the ruling that is applied.
    fingerprint: JSON.stringify(
      decisions.map((decision) => [decision.stepId, decision.verdict, decision.editedTitle]),
    ),
  };
}

function failure(failureCode: ConfirmationFailureCode): DecompositionConfirmationResult {
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
 * Turn what the reducer confirmed into the batch the adapter files, or fail.
 *
 * The *judgement* — which steps the user accepted, which they rewrote, which
 * they rejected, and whether the request was a ruling at all — belongs entirely
 * to `reduceNormalisedDecisions`. Everything here is the persistence shape: the
 * flat record keyed by `(proposalId, stepId)`, with the edges a rejection made
 * dangling removed. Splitting it that way is the point of the consolidation:
 * there is one implementation of what a ruling means, and it is not in the
 * module that writes.
 */
function persistableSteps(
  proposal: DecomposedProposal,
  confirmed: ResolvedConfirmation['confirmed'],
): readonly ConfirmedDecompositionStep[] | ConfirmationFailureCode {
  const acceptedIds = new Set(confirmed.map((entry) => entry.step.stepId));
  const steps: ConfirmedDecompositionStep[] = [];

  for (const entry of confirmed) {
    // The reducer already held every *edited* title to this standard. This
    // catches the other half — a step accepted as proposed, whose title came
    // from the proposal rather than from the user. Engine output cannot reach
    // here with a blank or connective-only title, but a proposal put into the
    // store by any other producer can, and this is the last thing standing
    // before a write. `invalid_edit` rather than a throw out of the adapter,
    // because the caller can act on a code and cannot act on an exception.
    if (titleAdmission(entry.step.title) !== null) return 'invalid_edit';
    steps.push({
      stepId: entry.step.stepId,
      proposalId: proposal.proposalId,
      commitmentId: proposal.commitmentId,
      title: entry.step.title,
      // The span survives the edit: the user rewrote the wording, not the
      // origin, and a step that dropped its provenance could never be checked
      // against the sentence it came from again.
      sourceSpans: entry.step.sourceSpans,
      // An edge to a step the user rejected is dropped rather than carried:
      // keeping it would persist a dependency on something that does not
      // exist, and the adapter would refuse the whole batch for it.
      dependsOn: entry.step.dependsOn.filter((edge) => acceptedIds.has(edge.dependsOnStepId)),
      statedTiming: entry.step.statedTiming,
      statedOwner: entry.step.statedOwner,
      inferred: entry.step.inferred,
    });
  }
  // Already in proposal order: `resolveConfirmedSteps` walks the proposal's own
  // step list rather than the decision list, so a client that shuffles its
  // rulings cannot change the order the batch is written in.
  return steps;
}

/**
 * Apply one already-validated ruling. Split out so the claim on the proposal
 * can be recorded synchronously, before this is awaited.
 */
async function applyConfirmation(
  proposal: DecomposedProposal,
  accepted: readonly ConfirmedDecompositionStep[],
  rejectedStepIds: readonly string[],
  dependencies: DecompositionBoundaryDependencies,
  now: Date,
): Promise<DecompositionConfirmationResult> {
  if (accepted.length > 0) {
    try {
      await dependencies.persistence.persistAtomically(accepted);
    } catch {
      dependencies.audit?.(auditEvent('failed', proposal.sourceText, now, 'persistence_failed', 0));
      return failure('persistence_failed');
    }
  }
  dependencies.audit?.(auditEvent(
    'succeeded',
    proposal.sourceText,
    now,
    'confirmed',
    accepted.length,
  ));
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    success: true,
    replayed: false,
    persistedStepIds: accepted.map((step) => step.stepId),
    rejectedStepIds,
  };
}

export async function confirmDecomposition(
  request: DecompositionConfirmationRequest,
  dependencies: DecompositionBoundaryDependencies,
  options: { readonly now?: Date } = {},
): Promise<DecompositionConfirmationResult> {
  const now = options.now ?? new Date(0);
  const normalised = normaliseRequest(request);
  if (typeof normalised === 'string') return failure(normalised);

  const stored = dependencies.store.get(normalised.proposalId);
  if (!stored || stored.scopeId !== normalised.scopeId) return failure('proposal_not_found');

  // A proposal already claimed is spent unless this request is the very same
  // ruling arriving again. Matching on the key alone made a reused key with
  // different decisions read as a retry: a user asking to reject all three
  // steps was told all three had been saved.
  //
  // Both halves are needed: the normalised fingerprint decides *whether* this
  // is the same ruling, and `already_confirmed` says *why* a different one is
  // refused.
  //
  // `proposal_not_found` stays on the scope check above — telling a wrong scope
  // that the proposal exists would be an enumeration oracle. Here it would only
  // mislead: the caller holds a real proposal id, and the real reason is that
  // someone else ruled first. A caller told "not found" retries; a caller told
  // "already confirmed" stops, which is the correct response to this one.
  const claimed = stored.confirmedResult !== undefined || stored.inFlight !== undefined;
  const isSameRuling = stored.idempotencyKey === normalised.idempotencyKey
    && stored.decisionFingerprint === normalised.fingerprint;
  if (claimed && !isSameRuling) return failure('already_confirmed');

  if (stored.confirmedResult) return { ...stored.confirmedResult, replayed: true };
  if (stored.inFlight) {
    // Same key, still in flight: await the one real attempt rather than start a
    // second write that would collide in the adapter.
    const settled = await stored.inFlight;
    return settled.success ? { ...settled, replayed: true } : settled;
  }

  const proposal = stored.proposal;
  if (proposal.outcome !== 'decomposed') return failure('proposal_not_decomposed');

  // Structural entry validation, on the path that writes rather than on
  // admission. #25's store validated on `admit` and refused to hold a
  // malformed proposal; this store deliberately holds atomic and rejected ones
  // so a later confirmation can say why they cannot be applied, so admission
  // could never be the gate here. Engine output has already been through the
  // strictly stronger `validateDecomposition`, so this fires only for a
  // proposal some other producer put in the store — which is exactly the case
  // #25 wrote the check for. `proposal_not_decomposed` because that is what a
  // proposal whose steps do not hold together is: not a usable decomposition.
  if (validateProposalEntry(proposal).length > 0) return failure('proposal_not_decomposed');

  const state = reduceNormalisedDecisions(proposal, normalised.decisions);
  if (state.failure !== null) return failure(state.failure.code);

  const resolved = resolveConfirmedSteps(state);
  const accepted = persistableSteps(proposal, resolved.confirmed);
  if (typeof accepted === 'string') return failure(accepted);

  if (accepted.length === 0) {
    // Nothing to write, so nothing to race over; recorded without yielding.
    const result: DecompositionConfirmationResult = {
      version: DECOMPOSITION_CONTRACT_VERSION,
      success: true,
      replayed: false,
      persistedStepIds: [],
      rejectedStepIds: resolved.rejectedStepIds,
    };
    dependencies.store.claim(normalised.proposalId, normalised.idempotencyKey, normalised.fingerprint);
    dependencies.store.settle(normalised.proposalId, result);
    dependencies.audit?.(auditEvent('succeeded', proposal.sourceText, now, 'confirmed', 0));
    return result;
  }

  // Claim first, await second. Both assignments complete in this synchronous
  // turn — `applyConfirmation` runs only as far as its own first `await` before
  // handing the promise back — so any later caller sees the claim.
  const inFlight = applyConfirmation(proposal, accepted, resolved.rejectedStepIds, dependencies, now);
  dependencies.store.claim(
    normalised.proposalId,
    normalised.idempotencyKey,
    normalised.fingerprint,
    inFlight,
  );

  const result = await inFlight;
  if (result.success) {
    dependencies.store.settle(normalised.proposalId, result);
  } else {
    // A write that did not happen must stay retryable, so the claim is
    // released; marking it confirmed would make the retry report a replay of a
    // batch nobody ever applied.
    dependencies.store.release(normalised.proposalId);
  }
  return result;
}
