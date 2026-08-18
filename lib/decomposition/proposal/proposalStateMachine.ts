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

/** A step that survived confirmation, on its way to the persistence port. */
export interface ConfirmedDecompositionStep {
  readonly step: DecompositionStepProposal;
  readonly disposition: 'accepted' | 'edited';
  /** The engine wording, so an adapter can record what was changed. */
  readonly proposedTitle: string;
}

export interface ResolvedConfirmation {
  readonly confirmed: readonly ConfirmedDecompositionStep[];
  readonly rejectedStepIds: readonly string[];
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
    if (editedTitle.length === 0) {
      return failed(state, {
        code: 'invalid_edit',
        stepId: decision.stepId,
        detail: 'edited title is blank; a step with no words is not a step',
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
  return finalizeProposalState(decisions.reduce(applyStepDecision, initialProposalState(proposal)));
}

/**
 * Splits a completed state into what persists and what does not.
 *
 * A state carrying a failure yields nothing on either side: a refused request
 * has no rejected steps either, because the user's rejections were part of a
 * request that was never valid.
 */
export function resolveConfirmedSteps(state: ProposalState): ResolvedConfirmation {
  if (state.failure !== null) return { confirmed: [], rejectedStepIds: [] };

  const confirmed: ConfirmedDecompositionStep[] = [];
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

/**
 * Titles that are only a connective.
 *
 * English `and`/`then` are the obvious ones. Arabic `و` and Hebrew `ו` are here
 * because both languages write the conjunction as a clitic prefixed onto the
 * next word with no whitespace (`واطلب`, `ותזמין`), so a splitter that strips
 * the prefix to find the boundary emits the bare letter as if it were a step.
 * That artefact is a single character and would pass any "non-empty title"
 * check, which is exactly why `CONJUNCTION_ONLY` is a separate code from
 * `EMPTY_STEP`.
 *
 * Matching is whole-title only. A title that merely *starts* with a connective
 * ("and order the cake", "واطلب الكعكة") is a real step, and rejecting those
 * would break the very rows the clitic handling exists to support.
 */
const CONNECTIVE_TITLES: ReadonlySet<string> = new Set([
  'and',
  'then',
  'and then',
  'also',
  'next',
  'و',
  'ثم',
  'وثم',
  'وبعدها',
  'بعدها',
  'ו',
  'ואז',
  'וגם',
  'אחכ',
]);

/**
 * Punctuation and separators that carry no meaning on their own.
 *
 * Stripped before the connective lookup so " , then " and "and." are recognised
 * as the same artefact as "then" — a splitter that leaves the delimiter attached
 * would otherwise walk straight through the check. Arabic comma, semicolon and
 * question mark are listed explicitly: they are separate code points from their
 * Latin lookalikes, so a class built only from ASCII punctuation would leave an
 * Arabic split artefact looking like a real title.
 *
 * No `u` flag: the repo compiles to es5, and every character here is in the BMP,
 * so the class means the same thing without it.
 */
const TITLE_NOISE = /[\s.,;:!?،؛؟‐-―"'`()[\]{}«»“”‘’]+/g;

function normalizeTitle(title: string): string {
  return title.replace(TITLE_NOISE, ' ').trim().toLowerCase();
}

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
 * Span exactness, invented timings and owners, and the atomic/do-not-split
 * judgement are deliberately *not* checked here: they need the source text and
 * the label, which is #27's validator and #26's evaluator, and duplicating them
 * would create the second opinion the shared vocabulary exists to prevent.
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

    const normalized = normalizeTitle(step.title);
    if (normalized.length === 0) {
      violations.push(violation('EMPTY_STEP', step.stepId, 'title is blank or punctuation only'));
    } else if (CONNECTIVE_TITLES.has(normalized)) {
      violations.push(
        violation('CONJUNCTION_ONLY', step.stepId, 'title is only a connective; this is a split artefact, not a step'),
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
