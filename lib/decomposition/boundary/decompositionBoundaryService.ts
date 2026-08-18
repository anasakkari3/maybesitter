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
 *  3. **Confirmation is scoped and idempotent.** The scope is checked before
 *     the proposal is used, and a replay of the same `idempotencyKey` returns
 *     the stored result rather than writing again.
 *  4. **Audit carries a hash, never the text.** The input is hashed and
 *     measured; the words are not copied anywhere an operator can read them.
 *     This matters more here than in Capture, because a decomposition's spans
 *     are *made of* the user's sentence.
 */

import { createHash, randomUUID } from 'crypto';
import {
  DECOMPOSITION_CONTRACT_VERSION,
  type ConfirmationFailureCode,
  type DecompositionConfirmationRequest,
  type DecompositionConfirmationResult,
  type DecompositionProposal,
  type DecompositionStepProposal,
} from '../../../src/contracts/v1/decompositionContracts';
import {
  createAuditEvent,
  type AuditEventEnvelope,
  type AuditOutcome,
  type RuntimeControlSnapshot,
} from '../../../src/contracts/v1/runtimeControls';
import { proposeDecomposition, type DecompositionModelProvider } from '../engine/index';
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
    module: 'planning',
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
  // Non-string input is a caller bug, but the boundary answers it in the
  // contract's own vocabulary rather than throwing: a decomposition request
  // that cannot be read has produced no steps, which is what atomic means.
  const sourceText = typeof rawInput === 'string' ? rawInput : '';
  const proposalId = (dependencies.newProposalId ?? randomUUID)();

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

interface ResolvedDecisions {
  readonly accepted: readonly ConfirmedDecompositionStep[];
  readonly rejectedStepIds: readonly string[];
}

/**
 * Turn a decision set into the batch to write, or fail.
 *
 * The coverage check runs before anything else is derived, because every later
 * step assumes a one-to-one mapping between steps and rulings; deriving first
 * and checking after is how a missing decision turns into a defaulted one.
 */
function resolveDecisions(
  proposal: Extract<DecompositionProposal, { outcome: 'decomposed' }>,
  request: DecompositionConfirmationRequest,
): ResolvedDecisions | ConfirmationFailureCode {
  const byStepId = new Map<string, DecompositionStepProposal>();
  for (const step of proposal.steps) byStepId.set(step.stepId, step);

  const seen = new Set<string>();
  for (const decision of request.decisions) {
    if (!byStepId.has(decision.stepId)) return 'unknown_step';
    if (seen.has(decision.stepId)) return 'duplicate_decision';
    seen.add(decision.stepId);
  }
  if (seen.size !== proposal.steps.length) return 'incomplete_decisions';

  const acceptedIds = new Set(
    request.decisions.filter((decision) => decision.verdict !== 'reject').map((decision) => decision.stepId),
  );
  const accepted: ConfirmedDecompositionStep[] = [];
  const rejectedStepIds: string[] = [];

  for (const decision of request.decisions) {
    const step = byStepId.get(decision.stepId) as DecompositionStepProposal;
    if (decision.verdict === 'reject') {
      rejectedStepIds.push(step.stepId);
      continue;
    }
    const title = decision.verdict === 'edit' ? decision.editedTitle.trim() : step.title;
    if (title.length === 0) return 'invalid_edit';
    accepted.push({
      stepId: step.stepId,
      proposalId: proposal.proposalId,
      commitmentId: proposal.commitmentId,
      title,
      // The span survives the edit: the user rewrote the wording, not the
      // origin, and a step that dropped its provenance could never be checked
      // against the sentence it came from again.
      sourceSpans: step.sourceSpans,
      // An edge to a step the user rejected is dropped rather than carried:
      // keeping it would persist a dependency on something that does not
      // exist, and the adapter would refuse the whole batch for it.
      dependsOn: step.dependsOn.filter((edge) => acceptedIds.has(edge.dependsOnStepId)),
      statedTiming: step.statedTiming,
      statedOwner: step.statedOwner,
    });
  }

  // Preserve proposal order rather than decision order, so the persisted batch
  // reads in the order the user's sentence did.
  const order = new Map(proposal.steps.map((step, index) => [step.stepId, index] as const));
  return {
    accepted: accepted.slice().sort((left, right) =>
      (order.get(left.stepId) as number) - (order.get(right.stepId) as number)),
    rejectedStepIds,
  };
}

export async function confirmDecomposition(
  request: DecompositionConfirmationRequest,
  dependencies: DecompositionBoundaryDependencies,
  options: { readonly now?: Date } = {},
): Promise<DecompositionConfirmationResult> {
  const now = options.now ?? new Date(0);
  const stored = dependencies.store.get(request.proposalId);
  if (!stored || stored.scopeId !== request.scopeId) return failure('proposal_not_found');

  if (stored.confirmedResult) {
    // A spent proposal answers only its own replay. A *different* decision set
    // arriving after the write is not a retry of anything; treating it as one
    // would apply the first ruling and report success for the second.
    if (stored.idempotencyKey !== request.idempotencyKey) return failure('proposal_not_found');
    return { ...stored.confirmedResult, replayed: true };
  }

  const proposal = stored.proposal;
  if (proposal.outcome !== 'decomposed') return failure('proposal_not_decomposed');

  const resolved = resolveDecisions(proposal, request);
  if (typeof resolved === 'string') return failure(resolved);

  if (resolved.accepted.length > 0) {
    try {
      await dependencies.persistence.persistAtomically(resolved.accepted);
    } catch {
      // The proposal is deliberately left unspent: a write that did not happen
      // must stay retryable, and marking it confirmed here would make the retry
      // report a replay of a batch nobody ever applied.
      dependencies.audit?.(auditEvent('failed', proposal.sourceText, now, 'persistence_failed', 0));
      return failure('persistence_failed');
    }
  }

  const result: DecompositionConfirmationResult = {
    version: DECOMPOSITION_CONTRACT_VERSION,
    success: true,
    replayed: false,
    persistedStepIds: resolved.accepted.map((step) => step.stepId),
    rejectedStepIds: resolved.rejectedStepIds,
  };
  stored.confirmedResult = result;
  stored.idempotencyKey = request.idempotencyKey;
  dependencies.audit?.(auditEvent(
    'succeeded',
    proposal.sourceText,
    now,
    'confirmed',
    resolved.accepted.length,
  ));
  return result;
}
