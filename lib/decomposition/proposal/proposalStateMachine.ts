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
 * Everything here is therefore a fold over proposal-local state. The steps a
 * user confirmed leave through the confirmation boundary in
 * lib/decomposition/boundary/, which is the only thing in this sprint that
 * writes; nothing in this module can reach it. The original commitment stays
 * canonical because there is no code path from here to a writer, which is
 * checked in tests/decomposition/proposalBoundaries.test.ts rather than
 * promised here.
 *
 * ── Why this is the only reducer ────────────────────────────────────
 *
 * It was not. #25 shipped this fold and #27 shipped a second one inside
 * `decompositionBoundaryService.resolveDecisions`, both deciding what an
 * accept/edit/reject ruling means, from the same contract, with no import
 * between them. Four review rounds each found a defect on one side that had
 * already been fixed on the other — the unknown-verdict-reads-as-consent bug,
 * the edit-held-to-a-weaker-standard bug, the read-the-verdict-twice bug. Two
 * implementations of one judgement is the arrangement that generates that, so
 * there is now one: the boundary normalises a request, hands the decisions
 * here, and persists what `resolveConfirmedSteps` returns.
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

import { MAX_EDITED_TITLE_LENGTH } from '../shared/limits';
export { MAX_EDITED_TITLE_LENGTH };
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
 * A step that survived confirmation, on its way to persistence.
 *
 * Named for this track rather than for the domain. The boundary exports a
 * different `ConfirmedDecompositionStep` — the flat record the adapter files —
 * and the two are not assignable; while both carried that name a consumer
 * importing the wrong one got "Type 'ConfirmedDecompositionStep' is missing
 * properties from type 'ConfirmedDecompositionStep'", which says nothing about
 * which two files are involved.
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
 * or "." — strings admission would have rejected outright — and they were
 * persisted.
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
 * verdict all arrive here as ordinary strings.
 */
const KNOWN_VERDICTS: ReadonlySet<string> = new Set(['accept', 'reject', 'edit']);

/**
 * Longest edited title accepted.
 *
 * A title travels from here into persistence with no other limit on the path,
 * so without a cap a megabyte of pasted text is a valid step.
 */

/**
 * C0 and C1 control characters, plus the line and paragraph separators.
 *
 * A title is something a person will read in a list. NUL and friends are not
 * text a user typed on purpose, they survive JSON transport intact, and they
 * are invisible in every surface that would show the title back — so `buy`,
 * NUL, `milk` and `buy milk` look like the same step and are not. The
 * connective normaliser cannot stand in for this: it treats NUL as neither
 * punctuation nor whitespace, so two NULs normalised to a two-character
 * "title" that was neither empty nor a connective, and persisted.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One ruling, read out of the request and into plain data.
 *
 * Plainness is the security property, not a tidiness preference: everything
 * downstream reads this copy, so a value that answers differently between reads
 * — or throws on the second one — has nothing left to change and nothing left
 * to throw at.
 */
export interface NormalisedStepDecision {
  readonly stepId: string;
  readonly verdict: 'accept' | 'reject' | 'edit';
  /** Trimmed. Empty string for any verdict that is not an edit. */
  readonly editedTitle: string;
}

function isFailure(
  value: NormalisedStepDecision | ProposalStateFailure,
): value is ProposalStateFailure {
  return (value as ProposalStateFailure).code !== undefined;
}

/**
 * A field read exactly once, with a throw treated as "absent".
 *
 * A getter or a `Proxy` trap that throws is the same class of hostile input as
 * one that answers differently each time, and both arrive by the same route: a
 * `StepDecision` is a TypeScript type and TypeScript is erased. Answering
 * `undefined` lets each field's own type check produce the right contract code
 * — an unreadable `verdict` is a decision carrying no verdict, an unreadable
 * `stepId` names no step — instead of a raw `Error` crossing the public
 * surface, where a caller cannot tell a refusal from a crash.
 */
function readField(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

/**
 * Turn one untrusted decision into plain data, or say why it is not a ruling.
 *
 * An unrecognised verdict is `incomplete_decisions`, not a rejection. The
 * reducer used to read anything that was not `accept` as `reject`, which fails
 * closed in the write direction — nothing extra persisted — but inverts the
 * contract from the other side: the request reported success while carrying a
 * ruling nobody made, so `everyStepNeedsExplicitDecision` was satisfied by a
 * verdict the reducer invented. Silence is not consent and neither is a typo;
 * a verdict this reducer does not understand states no ruling for that step,
 * which is the same defect as omitting it.
 *
 * The title's *content* is deliberately not judged here. Whether an edited
 * title is empty or a bare connective is checked once the step it names has
 * been found, so that a ruling on a step the proposal does not contain reports
 * `unknown_step` rather than a complaint about the wording of a decision that
 * could never have applied to anything.
 */
export function normaliseStepDecision(
  decision: unknown,
): NormalisedStepDecision | ProposalStateFailure {
  if (!isRecord(decision)) {
    return {
      code: 'unknown_step',
      stepId: null,
      detail: 'decision is not a well-formed ruling and names no step',
    };
  }

  const stepId = readField(decision, 'stepId');
  if (typeof stepId !== 'string') {
    return {
      code: 'unknown_step',
      stepId: null,
      detail: 'decision is not a well-formed ruling and names no step',
    };
  }

  const verdict = readField(decision, 'verdict');
  if (typeof verdict !== 'string' || !KNOWN_VERDICTS.has(verdict)) {
    return {
      code: 'incomplete_decisions',
      stepId,
      detail: 'decision carries no verdict this reducer understands; that is not a ruling',
    };
  }

  if (verdict !== 'edit') {
    return { stepId, verdict: verdict as 'accept' | 'reject', editedTitle: '' };
  }

  const editedTitle = readField(decision, 'editedTitle');
  if (typeof editedTitle !== 'string') {
    return { code: 'invalid_edit', stepId, detail: 'edited title is not text' };
  }
  if (editedTitle.length > MAX_EDITED_TITLE_LENGTH) {
    return { code: 'invalid_edit', stepId, detail: 'edited title is longer than the accepted maximum' };
  }
  if (CONTROL_CHARACTERS.test(editedTitle)) {
    return { code: 'invalid_edit', stepId, detail: 'edited title carries control characters' };
  }
  // Trimmed here rather than at the point of use, so the value compared, the
  // value stored and the value fingerprinted for idempotency are one string.
  return { stepId, verdict: 'edit', editedTitle: editedTitle.trim() };
}

/**
 * Read a whole decision list into plain data, or say why it is not one.
 *
 * Iterated by index over a length read once, rather than with `reduce`, `map`
 * or `forEach`. Those three skip holes: a sparse list of three rulings for a
 * three-step proposal validated as complete while a fourth entry nobody could
 * read was dropped without a word. An index walk reads a hole as `undefined`,
 * which is not a well-formed ruling — the same answer as an explicit `null`.
 *
 * Exported because the confirmation boundary needs the normalised list itself:
 * its idempotency fingerprint has to be taken over the ruling that was applied,
 * not over the request object it came from.
 */
export function normaliseStepDecisions(
  decisions: unknown,
): readonly NormalisedStepDecision[] | ProposalStateFailure {
  const unreadableList: ProposalStateFailure = {
    code: 'incomplete_decisions',
    stepId: null,
    detail: 'confirmation carries no list of decisions',
  };
  if (!Array.isArray(decisions)) return unreadableList;

  let length: unknown;
  try {
    length = (decisions as readonly unknown[]).length;
  } catch {
    return unreadableList;
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return unreadableList;
  }

  const normalised: NormalisedStepDecision[] = [];
  for (let index = 0; index < length; index += 1) {
    let raw: unknown;
    try {
      raw = (decisions as readonly unknown[])[index];
    } catch {
      return {
        code: 'unknown_step',
        stepId: null,
        detail: 'a decision in the list could not be read and so names no step',
      };
    }
    const one = normaliseStepDecision(raw);
    if (isFailure(one)) return one;
    normalised.push(one);
  }
  return normalised;
}

function failed(state: ProposalState, failure: ProposalStateFailure): ProposalState {
  return { proposalId: state.proposalId, steps: state.steps, failure };
}

/**
 * Applies one already-normalised ruling. Pure: returns a new state and mutates
 * nothing.
 *
 * Every field of `decision` here is a plain string that was read once, so the
 * repeated reads below cannot disagree with the reads that admitted it. That
 * was not true before: `verdict` was read twice in the guard, again to ask
 * whether it was an edit, and again to choose accepted or rejected, so an
 * accessor answering `reject` for the guard and `accept` afterwards was
 * validated as a rejection and recorded as an acceptance — and an `stepId` read
 * once to find the target and again to rebuild the list wrote one step's ruling
 * into another step's slot.
 */
export function applyNormalisedDecision(
  state: ProposalState,
  decision: NormalisedStepDecision,
): ProposalState {
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
    // The same standard admission applies, not a weaker one. `invalid_edit` is
    // the code either way: the caller needs to know which decision to fix, and
    // EMPTY_STEP/CONJUNCTION_ONLY describe a proposal, not a request.
    const titleProblem = titleViolation(decision.editedTitle);
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
      step: { ...target.step, title: decision.editedTitle },
      proposedTitle: target.proposedTitle,
    };
  } else {
    // Reached only for a verdict normalisation admitted, so the remaining pair
    // really is accept/reject. Reading "not accept" as a rejection without that
    // guard is what turned a typo into a ruling the user never made.
    next = { ...target, state: decision.verdict === 'accept' ? 'accepted' : 'rejected' };
  }

  return {
    proposalId: state.proposalId,
    steps: state.steps.map((entry) => (entry.stepId === decision.stepId ? next : entry)),
    failure: null,
  };
}

/**
 * Applies one untrusted decision: normalise, then act on the copy.
 *
 * Exported separately from `reduceStepDecisions` so a caller collecting
 * decisions incrementally (a UI ruling on one step at a time) uses the same
 * transition the batch path does, rather than a second implementation of it.
 */
export function applyStepDecision(state: ProposalState, decision: StepDecision): ProposalState {
  if (state.failure !== null) return state;

  const normalised = normaliseStepDecision(decision);
  if (isFailure(normalised)) return failed(state, normalised);
  return applyNormalisedDecision(state, normalised);
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

/**
 * `initialProposalState` → every normalised decision → `finalizeProposalState`.
 *
 * The entry point for a caller that has already normalised, which is the
 * confirmation boundary: it needs the same list for its idempotency
 * fingerprint, and normalising twice would reintroduce the second read this
 * whole design exists to remove.
 */
export function reduceNormalisedDecisions(
  proposal: DecomposedProposal,
  decisions: readonly NormalisedStepDecision[],
): ProposalState {
  let state = initialProposalState(proposal);
  for (let index = 0; index < decisions.length; index += 1) {
    state = applyNormalisedDecision(state, decisions[index]);
  }
  return finalizeProposalState(state);
}

/** Normalise an untrusted decision list, then fold it. */
export function reduceStepDecisions(
  proposal: DecomposedProposal,
  decisions: readonly StepDecision[],
): ProposalState {
  const normalised = normaliseStepDecisions(decisions);
  if (!Array.isArray(normalised)) {
    // A request carrying no readable list of decisions states no rulings at
    // all, which is the same finding as a list that misses a step.
    return failed(initialProposalState(proposal), normalised as ProposalStateFailure);
  }
  return reduceNormalisedDecisions(proposal, normalised);
}

/**
 * Splits a completed state into what persists and what does not.
 *
 * Finalizes first rather than trusting the caller to have done it. A state
 * mid-fold has steps still pending, and reading one directly returned the
 * decided steps as confirmed with the undecided ones in neither list — silent
 * partial acceptance, reachable by anyone wiring the documented incremental
 * path (`applyStepDecision`) straight to a writer. Finalizing here makes that
 * unreachable instead of merely discouraged; it is idempotent, so a caller that
 * already finalized loses nothing.
 *
 * Both lists come out in *proposal* order rather than decision order, so a
 * client that shuffles its rulings cannot change the order the steps are
 * written or reported in.
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
 * Run at the confirmation boundary rather than only in #27's engine, so a
 * proposal that reached a store from anywhere — a different engine, a replay, a
 * test harness — is checked by whoever is about to write steps from it. Every
 * code returned is a `DecompositionViolationCode`; this module invents none,
 * because a private code here would be one #26 could not count and #27 could
 * not reject.
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
