/**
 * The accept/edit/reject state machine for a decomposition proposal
 * (Sprint 06, issue #25).
 *
 * ── Why a reducer and not a domain state transition ─────────────────
 *
 * The issue reads as an extension of `src/domain/stateMachine.ts`, and that is
 * the one thing this must not be. `Commitment` there has no notion of a step or
 * a parent, Sprint 07's scheduler reads that type, and Sprint 06 is not
 * production-routed — so extending `DomainState` would push a schema change
 * into a surface with no live consumer, for a feature nobody can reach yet.
 * Everything here is therefore a fold over proposal-local state, and the steps
 * a user confirmed leave through an injected port (`persistencePort.ts`) that
 * this module only *describes*. The original commitment stays canonical because
 * there is no code path from here to a writer, which is checked in
 * tests/decomposition/proposalBoundaries.test.ts rather than promised here.
 *
 * ── Why silence is not consent ──────────────────────────────────────
 *
 * A step starts `pending` and the fold has no branch that leaves it pending and
 * calls the result confirmed. The alternative — treating an omitted step as
 * rejected — is the failure the "partial acceptance is explicit" criterion
 * names: it reads identically to a client that dropped a step from its payload
 * by mistake, and the user is then told they declined something they never saw.
 *
 * ── Why the first failure sticks ────────────────────────────────────
 *
 * `applyStepDecision` refuses to do anything once `failure` is set. A fold that
 * kept going could have a later decision repair the state a malformed earlier
 * one produced, so the caller would be told its request succeeded while a step
 * it named was quietly dropped. A malformed request is refused whole.
 *
 * No function in this file reads a clock, a random source, or anything outside
 * its arguments.
 */

import { isConnectiveOnly, isEmptyTitle } from '../shared/connectives';
import type {
  ConfirmationFailureCode,
  DecomposedProposal,
  DecompositionStepProposal,
  DecompositionViolation,
  StepDecision,
} from '../../../src/contracts/v1/decompositionContracts';

/**
 * Where one step sits in the proposal's lifecycle.
 *
 * `edited` is a distinct state rather than `accepted` with a changed title,
 * because "the user took what was offered" and "the user rewrote it" are
 * different facts about the proposal, and only the second one says the engine's
 * wording was wrong.
 */
export type StepState = 'pending' | 'accepted' | 'edited' | 'rejected';

export interface ProposalStepState {
  readonly stepId: string;
  readonly state: StepState;
  /**
   * The proposed step, carrying the user's title once edited. `sourceSpans` is
   * never touched: an edit changes the words the step is stated in, not the
   * words it came from, and rewriting provenance to match a new title would
   * silently break `sourceText.slice(start, end) === text`.
   */
  readonly step: DecompositionStepProposal;
  /** The engine's original wording, kept so an edit is auditable against it. */
  readonly proposedTitle: string;
}

/**
 * Why the confirmation request as a whole is refused.
 *
 * Codes are the contract's `ConfirmationFailureCode`, not a private vocabulary,
 * so the reducer's reason and the result the caller receives are the same word.
 */
export interface ProposalStateFailure {
  readonly code: Extract<
    ConfirmationFailureCode,
    'incomplete_decisions' | 'unknown_step' | 'duplicate_decision' | 'invalid_edit'
  >;
  /** The step the failure is attributed to, or null for request-level ones. */
  readonly stepId: string | null;
  /** Never contains user text — see the audit note in the contract. */
  readonly detail: string;
}

export interface ProposalState {
  readonly proposalId: string;
  readonly steps: readonly ProposalStepState[];
  /** Null while the request is still well-formed. Sticky once set. */
  readonly failure: ProposalStateFailure | null;
}

/**
 * A step that survived confirmation, on its way to the persistence port.
 *
 * Named for this track rather than for the domain. #27's boundary exports a
 * different `ConfirmedDecompositionStep`, and the two are not assignable; while
 * both carried that name a consumer importing the wrong one got
 * "Type 'ConfirmedDecompositionStep' is missing properties from type
 * 'ConfirmedDecompositionStep'", which says nothing about which two files are
 * involved. #27's is the one a future consumer reaches through the boundary, so
 * this side moved.
 */
export interface ProposalConfirmedStep {
  readonly step: DecompositionStepProposal;
  readonly disposition: 'accepted' | 'edited';
  /** The engine wording, so an adapter can record what was changed. */
  readonly proposedTitle: string;
}

export interface ResolvedConfirmation {
  readonly confirmed: readonly ProposalConfirmedStep[];
  readonly rejectedStepIds: readonly string[];
}

/**
 * The connective lexicon and the title normalisation it needs live in
 * `lib/decomposition/shared/connectives.ts`, shared with #26 and #27 so the
 * three tracks cannot disagree about what a connective is. `isEmptyTitle` and
 * `isConnectiveOnly` are the only entry points; nothing here re-implements
 * either.
 */

/**
 * What is wrong with a title on its own, or null when nothing is.
 *
 * The single standard for "this is not a step", applied both when a proposal is
 * admitted and when a user edits a step. Before, admission used this and the
 * edit path used `trim().length === 0`, so a user could edit a step into "and"
 * or "." — strings admission would have rejected outright — and the port
 * received them.
 */
function titleViolation(title: string): 'EMPTY_STEP' | 'CONJUNCTION_ONLY' | null {
  if (isEmptyTitle(title)) return 'EMPTY_STEP';
  return isConnectiveOnly(title) ? 'CONJUNCTION_ONLY' : null;
}

/* ── The fold ─────────────────────────────────────────────────────── */

export function initialProposalState(proposal: DecomposedProposal): ProposalState {
  return {
    proposalId: proposal.proposalId,
    steps: proposal.steps.map((step) => ({
      stepId: step.stepId,
      state: 'pending' as const,
      step,
      proposedTitle: step.title,
    })),
    failure: null,
  };
}

/**
 * The three verdicts that exist.
 *
 * Checked at runtime because `StepDecision` is a TypeScript union and
 * TypeScript is erased: a version-skewed client, a typo, or a future fourth
 * verdict all arrive here as ordinary strings. #27's boundary keeps the same
 * set and answers with the same code, so the two reducers cannot give one
 * request two answers.
 */
const KNOWN_VERDICTS: ReadonlySet<string> = new Set(['accept', 'reject', 'edit']);

/**
 * Longest edited title accepted, matching #27's boundary.
 *
 * A title travels from here into the persistence port with no other limit on
 * the path, so without a cap a megabyte of pasted text is a valid step.
 */
export const MAX_EDITED_TITLE_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why this decision is not a ruling, or null when it is one.
 *
 * An unrecognised verdict is `incomplete_decisions`, not a rejection. The
 * reducer used to read anything that was not `accept` as `reject`, which fails
 * closed in the write direction — nothing extra persisted — but inverts the
 * contract from the other side: the request reported success while carrying a
 * ruling nobody made, so `everyStepNeedsExplicitDecision` was satisfied by a
 * verdict the reducer invented. Silence is not consent and neither is a typo;
 * a verdict this reducer does not understand states no ruling for that step,
 * which is the same defect as omitting it.
 */
function malformedDecision(decision: StepDecision): ProposalStateFailure | null {
  if (!isRecord(decision) || typeof decision.stepId !== 'string') {
    return {
      code: 'unknown_step',
      stepId: null,
      detail: 'decision is not a well-formed ruling and names no step',
    };
  }
  const stepId = decision.stepId;

  if (typeof decision.verdict !== 'string' || !KNOWN_VERDICTS.has(decision.verdict)) {
    return {
      code: 'incomplete_decisions',
      stepId,
      detail: 'decision carries no verdict this reducer understands; that is not a ruling',
    };
  }
  if (decision.verdict === 'edit') {
    if (typeof decision.editedTitle !== 'string') {
      return { code: 'invalid_edit', stepId, detail: 'edited title is not text' };
    }
    if (decision.editedTitle.length > MAX_EDITED_TITLE_LENGTH) {
      return { code: 'invalid_edit', stepId, detail: 'edited title is longer than the accepted maximum' };
    }
  }
  return null;
}

function failed(state: ProposalState, failure: ProposalStateFailure): ProposalState {
  return { proposalId: state.proposalId, steps: state.steps, failure };
}

/**
 * Applies one decision. Pure: returns a new state and mutates nothing.
 *
 * Exported separately from `reduceStepDecisions` so a caller collecting
 * decisions incrementally (a UI ruling on one step at a time) uses the same
 * transition the batch path does, rather than a second implementation of it.
 */
export function applyStepDecision(state: ProposalState, decision: StepDecision): ProposalState {
  if (state.failure !== null) return state;

  // Before anything reads a field off it. Every property of `decision` is
  // untrusted at runtime however well-typed the call site looked.
  const malformed = malformedDecision(decision);
  if (malformed !== null) return failed(state, malformed);

  const target = state.steps.find((entry) => entry.stepId === decision.stepId);
  if (!target) {
    return failed(state, {
      code: 'unknown_step',
      stepId: decision.stepId,
      detail: 'decision names a step that is not in this proposal',
    });
  }
  if (target.state !== 'pending') {
    return failed(state, {
      code: 'duplicate_decision',
      stepId: decision.stepId,
      // Not "last one wins": two verdicts on one step means the caller does not
      // know what the user chose, and picking either is inventing an answer.
      detail: 'step already has a verdict; a decision is made once and never revised in place',
    });
  }

  let next: ProposalStepState;
  if (decision.verdict === 'edit') {
    const editedTitle = decision.editedTitle.trim();
    // The same standard admission applies, not a weaker one. `invalid_edit` is
    // the code either way: the caller needs to know which decision to fix, and
    // EMPTY_STEP/CONJUNCTION_ONLY describe a proposal, not a request.
    const titleProblem = titleViolation(editedTitle);
    if (titleProblem !== null) {
      return failed(state, {
        code: 'invalid_edit',
        stepId: decision.stepId,
        detail:
          titleProblem === 'EMPTY_STEP'
            ? 'edited title has no words; a step with no words is not a step'
            : 'edited title is only a connective; that is a split artefact, not a step',
      });
    }
    next = {
      stepId: target.stepId,
      state: 'edited',
      // Spread rather than rebuild, so a field added to the contract later
      // survives an edit instead of being dropped by omission.
      step: { ...target.step, title: editedTitle },
      proposedTitle: target.proposedTitle,
    };
  } else {
    // Reached only for a verdict `malformedDecision` admitted, so the remaining
    // pair really is accept/reject. Reading "not accept" as a rejection without
    // that guard is what turned a typo into a ruling the user never made.
    next = { ...target, state: decision.verdict === 'accept' ? 'accepted' : 'rejected' };
  }

  return {
    proposalId: state.proposalId,
    steps: state.steps.map((entry) => (entry.stepId === decision.stepId ? next : entry)),
    failure: null,
  };
}

/**
 * Closes the fold: any step still pending makes the whole request incomplete.
 *
 * Separate from `applyStepDecision` because mid-fold a pending step is normal;
 * only the end of the stream turns it into a missing decision. Idempotent, so a
 * caller that finalizes twice does not stack failures.
 */
export function finalizeProposalState(state: ProposalState): ProposalState {
  if (state.failure !== null) return state;

  const pending = state.steps.find((entry) => entry.state === 'pending');
  if (!pending) return state;

  return failed(state, {
    code: 'incomplete_decisions',
    stepId: pending.stepId,
    detail: 'step has no verdict; an omitted step is never treated as accepted or rejected',
  });
}

/** `initialProposalState` → every decision → `finalizeProposalState`. */
export function reduceStepDecisions(
  proposal: DecomposedProposal,
  decisions: readonly StepDecision[],
): ProposalState {
  const initial = initialProposalState(proposal);
  if (!Array.isArray(decisions)) {
    // `decisions.reduce` threw a raw TypeError out of the public surface. A
    // request carrying no decision list states no rulings at all, which is the
    // same finding as a list that misses a step.
    return failed(initial, {
      code: 'incomplete_decisions',
      stepId: null,
      detail: 'confirmation carries no list of decisions',
    });
  }
  return finalizeProposalState(decisions.reduce(applyStepDecision, initial));
}

/**
 * Splits a completed state into what persists and what does not.
 *
 * Finalizes first rather than trusting the caller to have done it. A state
 * mid-fold has steps still pending, and reading one directly returned the
 * decided steps as confirmed with the undecided ones in neither list — silent
 * partial acceptance, reachable by anyone wiring the documented incremental
 * path (`applyStepDecision`) straight to a port. Finalizing here makes that
 * unreachable instead of merely discouraged; it is idempotent, so a caller that
 * already finalized loses nothing.
 *
 * A state carrying a failure yields nothing on either side: a refused request
 * has no rejected steps either, because the user's rejections were part of a
 * request that was never valid.
 */
export function resolveConfirmedSteps(input: ProposalState): ResolvedConfirmation {
  const state = finalizeProposalState(input);
  if (state.failure !== null) return { confirmed: [], rejectedStepIds: [] };

  const confirmed: ProposalConfirmedStep[] = [];
  const rejectedStepIds: string[] = [];
  for (const entry of state.steps) {
    if (entry.state === 'accepted' || entry.state === 'edited') {
      confirmed.push({ step: entry.step, disposition: entry.state, proposedTitle: entry.proposedTitle });
    } else if (entry.state === 'rejected') {
      rejectedStepIds.push(entry.stepId);
    }
  }
  return { confirmed, rejectedStepIds };
}

/* ── Entry validation ─────────────────────────────────────────────── */

function violation(
  code: DecompositionViolation['code'],
  stepId: string | null,
  detail: string,
): DecompositionViolation {
  return { code, stepId, detail };
}

/**
 * True when the proposal's dependency edges contain a cycle.
 *
 * Iterative depth-first search with an explicit stack rather than recursion:
 * a proposal is caller-supplied data, and a deep chain would otherwise be able
 * to overflow the stack of whatever admitted it.
 */
function hasCycle(steps: readonly DecompositionStepProposal[]): boolean {
  const edges = new Map<string, readonly string[]>();
  for (const step of steps) {
    edges.set(
      step.stepId,
      step.dependsOn.map((edge) => edge.dependsOnStepId).filter((id) => id !== step.stepId),
    );
  }

  const finished = new Set<string>();
  for (const root of Array.from(edges.keys())) {
    if (finished.has(root)) continue;
    const onPath = new Set<string>();
    const stack: { readonly node: string; index: number }[] = [{ node: root, index: 0 }];
    onPath.add(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = edges.get(frame.node) ?? [];
      if (frame.index >= neighbours.length) {
        onPath.delete(frame.node);
        finished.add(frame.node);
        stack.pop();
        continue;
      }
      const next = neighbours[frame.index++];
      if (!edges.has(next) || finished.has(next)) continue;
      if (onPath.has(next)) return true;
      onPath.add(next);
      stack.push({ node: next, index: 0 });
    }
  }
  return false;
}

/**
 * What is structurally wrong with a proposal, in the shared vocabulary.
 *
 * Run at the boundary rather than only in #27's engine, so a proposal that
 * reached this module from anywhere — a different engine, a replay, a test
 * harness — is checked by whoever is about to offer it to a user. Every code
 * returned is a `DecompositionViolationCode`; this module invents none, because
 * a private code here would be one #26 could not count and #27 could not
 * reject.
 *
 * `INFERRED_WITH_SPAN` and `UNSOURCED_STEP` are checked here because both are
 * decidable from the step alone — they are a consistency check between
 * `inferred` and `sourceSpans`, needing nothing else — and `UNSOURCED_STEP` is
 * the provenance deliverable itself: a step with no span and no admission is
 * indistinguishable from an invented one, and admitting it would put an
 * unsourced step in front of a user.
 *
 * `SPAN_MISMATCH`, `SPAN_OUT_OF_RANGE` and `SPAN_OVERLAP` are deliberately *not*
 * checked here, and neither are `INVENTED_TIMING`, `INVENTED_OWNER` or
 * `SPLIT_ATOMIC`. Not for want of the source text — `proposal.sourceText` is
 * right here — but because each is a judgement about the *engine's* reading of
 * that text, which is #27's validator and #26's evaluator. Two independent
 * implementations of the same judgement is the second opinion the shared
 * vocabulary exists to prevent; a consistency check on one step's own fields
 * is not.
 */
export function validateProposalEntry(proposal: DecomposedProposal): readonly DecompositionViolation[] {
  const violations: DecompositionViolation[] = [];
  const seenIds = new Set<string>();
  const knownIds = new Set(proposal.steps.map((step) => step.stepId));

  for (const step of proposal.steps) {
    if (seenIds.has(step.stepId)) {
      violations.push(
        violation('DUPLICATE_STEP_ID', step.stepId, 'stepId appears more than once in this proposal'),
      );
    }
    seenIds.add(step.stepId);

    const titleProblem = titleViolation(step.title);
    if (titleProblem === 'EMPTY_STEP') {
      violations.push(violation('EMPTY_STEP', step.stepId, 'title has no words once punctuation and marks are removed'));
    } else if (titleProblem === 'CONJUNCTION_ONLY') {
      violations.push(
        violation('CONJUNCTION_ONLY', step.stepId, 'title is only a connective; this is a split artefact, not a step'),
      );
    }

    // The contract's own rule: `sourceSpans` may be empty only for a step the
    // engine admits it inferred, and a step that admits it cannot also cite
    // text. Both directions matter — an unadmitted unsourced step is an
    // invented one wearing a proposal's clothes, and a step claiming both is
    // one whose provenance nobody can act on.
    if (step.inferred && step.sourceSpans.length > 0) {
      violations.push(
        violation('INFERRED_WITH_SPAN', step.stepId, 'step is marked inferred but cites source text'),
      );
    } else if (!step.inferred && step.sourceSpans.length === 0) {
      violations.push(
        violation('UNSOURCED_STEP', step.stepId, 'step cites no source text and does not admit to being inferred'),
      );
    }

    for (const edge of step.dependsOn) {
      if (edge.dependsOnStepId === step.stepId) {
        violations.push(violation('SELF_DEPENDENCY', step.stepId, 'step depends on itself'));
      } else if (!knownIds.has(edge.dependsOnStepId)) {
        violations.push(
          violation('UNKNOWN_DEPENDENCY', step.stepId, 'edge points at a step that is not in this proposal'),
        );
      }
    }
  }

  // Proposal-level, and attributed to no step: a cycle is a property of the
  // graph, and blaming whichever node the search happened to enter it from
  // would make the report depend on step order.
  if (hasCycle(proposal.steps)) {
    violations.push(violation('CYCLIC_DEPENDENCY', null, 'dependency edges form a cycle'));
  }

  return violations;
}
