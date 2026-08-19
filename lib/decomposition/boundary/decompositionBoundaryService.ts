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
 */

import { createHash, randomUUID } from 'crypto';
import {
  DECOMPOSITION_CONTRACT_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
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
import { proposeDecomposition, titleAdmission, type DecompositionModelProvider } from '../engine/index';
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
const MAX_EDITED_TITLE_LENGTH = 500;

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

/**
 * A canonical rendering of the decisions, used only to tell a replay from a new
 * request under a reused key.
 *
 * Order-sensitive on purpose: two decision lists differing in order are
 * different requests, and treating them as one would silently accept a ruling
 * the user did not make.
 */
/**
 * The three verdicts that exist. Checked at runtime because `StepDecision` is a
 * TypeScript union and TypeScript is erased: a version-skewed client, a typo,
 * or a future fourth verdict all arrive here as ordinary strings.
 */
const KNOWN_VERDICTS: ReadonlySet<string> = new Set(['accept', 'reject', 'edit']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why this request is not a well-formed confirmation, or null.
 *
 * Everything below used to be assumed. `decisions` that was not an array threw
 * a raw `TypeError` out of the function this module's own docblock calls "the
 * boundary", and an unrecognised verdict was read as acceptance — on the one
 * path here that writes, against a contract whose stated rule is that silence
 * is not consent. Failing closed in the contract's own vocabulary is the whole
 * job of this function.
 */
function malformedRequest(request: DecompositionConfirmationRequest): ConfirmationFailureCode | null {
  if (typeof request.proposalId !== 'string'
    || typeof request.scopeId !== 'string'
    || typeof request.idempotencyKey !== 'string') {
    return 'proposal_not_found';
  }
  if (!Array.isArray(request.decisions)) return 'incomplete_decisions';

  for (const decision of request.decisions) {
    if (!isRecord(decision) || typeof decision.stepId !== 'string') return 'unknown_step';
    if (typeof decision.verdict !== 'string' || !KNOWN_VERDICTS.has(decision.verdict)) {
      // Not an acceptance and not a rejection: the request states no ruling
      // this reducer understands for that step, which is the same defect as
      // omitting it.
      return 'incomplete_decisions';
    }
    if (decision.verdict === 'edit') {
      if (typeof decision.editedTitle !== 'string') return 'invalid_edit';
      if (decision.editedTitle.length > MAX_EDITED_TITLE_LENGTH) return 'invalid_edit';
    }
  }
  return null;
}

function decisionFingerprint(request: DecompositionConfirmationRequest): string {
  return JSON.stringify(
    request.decisions.map((decision) => [
      decision.stepId,
      decision.verdict,
      decision.verdict === 'edit' ? decision.editedTitle.trim() : '',
    ]),
  );
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

  // Positive test. Anything that is not literally 'reject' used to be an
  // acceptance, so an unknown verdict silently wrote; the request-level guard
  // rejects those before we get here, and this stays positive so the two can
  // never drift apart into "unknown means yes" again.
  const acceptedIds = new Set(
    request.decisions
      .filter((decision) => decision.verdict === 'accept' || decision.verdict === 'edit')
      .map((decision) => decision.stepId),
  );
  const accepted: ConfirmedDecompositionStep[] = [];
  const rejectedStepIds: string[] = [];

  for (const decision of request.decisions) {
    const step = byStepId.get(decision.stepId) as DecompositionStepProposal;
    if (decision.verdict !== 'accept' && decision.verdict !== 'edit') {
      rejectedStepIds.push(step.stepId);
      continue;
    }
    const title = decision.verdict === 'edit' ? decision.editedTitle.trim() : step.title;
    // The same standard admission applies to an edit, not a weaker one. This
    // used to check only for emptiness, so a step could be edited into "and" —
    // a string the validator rejects outright as a split artefact — and written.
    // `invalid_edit` is the right code either way: EMPTY_STEP and
    // CONJUNCTION_ONLY describe a proposal, and this is a bad request.
    if (decision.verdict === 'edit' && titleAdmission(title) !== null) return 'invalid_edit';
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
      inferred: step.inferred,
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

/**
 * Apply one already-validated ruling. Split out so the claim on the proposal
 * can be recorded synchronously, before this is awaited.
 */
async function applyConfirmation(
  proposal: Extract<DecompositionProposal, { outcome: 'decomposed' }>,
  resolved: ResolvedDecisions,
  dependencies: DecompositionBoundaryDependencies,
  now: Date,
): Promise<DecompositionConfirmationResult> {
  if (resolved.accepted.length > 0) {
    try {
      await dependencies.persistence.persistAtomically(resolved.accepted);
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
    resolved.accepted.length,
  ));
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    success: true,
    replayed: false,
    persistedStepIds: resolved.accepted.map((step) => step.stepId),
    rejectedStepIds: resolved.rejectedStepIds,
  };
}

export async function confirmDecomposition(
  request: DecompositionConfirmationRequest,
  dependencies: DecompositionBoundaryDependencies,
  options: { readonly now?: Date } = {},
): Promise<DecompositionConfirmationResult> {
  const now = options.now ?? new Date(0);
  const malformed = malformedRequest(request);
  if (malformed !== null) return failure(malformed);

  const stored = dependencies.store.get(request.proposalId);
  if (!stored || stored.scopeId !== request.scopeId) return failure('proposal_not_found');

  // A proposal already claimed is spent unless this request is the very same
  // ruling arriving again. Matching on the key alone made a reused key with
  // different decisions read as a retry: a user asking to reject all three
  // steps was told all three had been saved.
  //
  // Both halves of this are needed: #27's fingerprint decides *whether* the
  // ruling is the same one, and `already_confirmed` says *why* a different one
  // is refused.
  //
  // `proposal_not_found` stays on the scope check above — telling a wrong scope
  // that the proposal exists would be an enumeration oracle. Here it would only
  // mislead: the caller holds a real proposal id, and the real reason is that
  // someone else ruled first. A caller told "not found" retries; a caller told
  // "already confirmed" stops, which is the correct response to this one.
  const fingerprint = decisionFingerprint(request);
  const claimed = stored.confirmedResult !== undefined || stored.inFlight !== undefined;
  const isSameRuling =
    stored.idempotencyKey === request.idempotencyKey && stored.decisionFingerprint === fingerprint;
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

  const resolved = resolveDecisions(proposal, request);
  if (typeof resolved === 'string') return failure(resolved);

  if (resolved.accepted.length === 0) {
    // Nothing to write, so nothing to race over; recorded without yielding.
    const result: DecompositionConfirmationResult = {
      version: DECOMPOSITION_CONTRACT_VERSION,
      success: true,
      replayed: false,
      persistedStepIds: [],
      rejectedStepIds: resolved.rejectedStepIds,
    };
    stored.confirmedResult = result;
    stored.idempotencyKey = request.idempotencyKey;
    stored.decisionFingerprint = fingerprint;
    dependencies.audit?.(auditEvent('succeeded', proposal.sourceText, now, 'confirmed', 0));
    return result;
  }

  // Claim first, await second. Both assignments complete in this synchronous
  // turn — `applyConfirmation` runs only as far as its own first `await` before
  // handing the promise back — so any later caller sees the claim.
  stored.idempotencyKey = request.idempotencyKey;
  stored.decisionFingerprint = fingerprint;
  stored.inFlight = applyConfirmation(proposal, resolved, dependencies, now);

  const result = await stored.inFlight;
  stored.inFlight = undefined;
  if (result.success) {
    stored.confirmedResult = result;
  } else {
    // A write that did not happen must stay retryable, so the claim is
    // released; marking it confirmed would make the retry report a replay of a
    // batch nobody ever applied.
    stored.idempotencyKey = undefined;
    stored.decisionFingerprint = undefined;
  }
  return result;
}
