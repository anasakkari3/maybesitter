/**
 * Decomposition contracts (Sprint 06, issues #25, #26, #27).
 *
 * One commitment ("plan my sister's wedding") becomes a *proposal* of several
 * steps. The commitment itself does not move: decomposition adds a view of it,
 * it never rewrites it. Capture (Sprint 01) established that model output can
 * only produce a proposal; this is the same boundary applied to a harder shape,
 * because a decomposition is a graph and a capture was a list.
 *
 * Four things here are structural rather than conventional, each because the
 * alternative fails quietly.
 *
 *  1. **A span is an offset pair into the original text, and the text travels
 *     with it.** Provenance that cannot be checked is provenance that will
 *     drift. Carrying `text` next to `start`/`end` makes "this step came from
 *     these words" a round-trippable assertion (`raw.slice(start, end) === text`)
 *     rather than a claim. See `SourceSpan`.
 *
 *  2. **"Could not split" is a different shape from "split into one".** A
 *     one-element step list and an honest refusal to decompose are the same
 *     data if status is just a label, and the first is what a heuristic
 *     produces when it gives up. They are separate variants of
 *     `DecompositionProposal`, so a fallback cannot be typed as a result.
 *
 *  3. **Every step needs an explicit decision at confirmation.** A step the
 *     user never ruled on must not become a step the user accepted. Silence is
 *     not consent, so a confirmation request that omits a step is invalid
 *     rather than partially applied. See `DecompositionConfirmationRequest`.
 *
 *  4. **The validator (#27) and the evaluator (#26) share one vocabulary of
 *     what is wrong.** They were built in parallel; had each named violations
 *     for itself, both would pass their own tests while disagreeing about what
 *     a correct decomposition is, and nothing would have caught it. See
 *     `DecompositionViolationCode`.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const DECOMPOSITION_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const DECOMPOSITION_SCHEMA_VERSION = 'decomposition-v1' as const;

/* ── Source provenance ───────────────────────────────────────────── */

/**
 * A half-open range `[start, end)` in UTF-16 code units over the *original*
 * commitment text, plus the text it selects.
 *
 * Offsets are logical, not visual. Arabic and Hebrew render right-to-left, but
 * `String.prototype.slice` indexes storage order, so a span over an RTL clause
 * is an ordinary increasing range and needs no bidi handling to be exact. What
 * it does need is checking: `raw.slice(start, end) === text` must hold, which
 * is why `text` is carried rather than recomputed by each consumer. Code units,
 * not code points, because that is what `slice` uses — a definition that
 * disagrees with the language's own indexing would be wrong for every string
 * containing an emoji or an astral character.
 */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
  /** Exactly `raw.slice(start, end)` of the source text. */
  readonly text: string;
}

/* ── Steps and dependencies ──────────────────────────────────────── */

/**
 * Why one step must wait for another.
 *
 * Typed now because Sprint 07's scheduler reads these edges, and an untyped
 * edge cannot tell it whether two steps merely share a resource (schedulable in
 * either order under contention) or are genuinely sequential. Adding the
 * distinction later is a breaking change to a contract five sprints depend on;
 * adding it here costs one field.
 */
export type DependencyKind = 'temporal' | 'resource' | 'informational';

export interface StepDependency {
  /** `stepId` of the step that must come first. */
  readonly dependsOnStepId: string;
  readonly kind: DependencyKind;
}

/**
 * A proposed step. It is not a commitment and has no lifecycle of its own:
 * until confirmation it exists only inside a proposal.
 *
 * `sourceSpans` is a list because a single step is often stated across
 * discontinuous parts of one sentence. It may be empty only for a step the
 * engine inferred rather than read, and `inferred` must then say so — a step
 * with no span and no admission is indistinguishable from an invented one.
 */
export interface DecompositionStepProposal {
  readonly stepId: string;
  readonly title: string;
  readonly sourceSpans: readonly SourceSpan[];
  /** True when no source text states this step. Requires `sourceSpans` empty. */
  readonly inferred: boolean;
  readonly dependsOn: readonly StepDependency[];
  /**
   * Time the source text states for this step, verbatim and unresolved.
   * Never a date the engine computed: resolving "next week" against a clock is
   * Capture's job, and inventing one here is the failure #26 tests for.
   */
  readonly statedTiming: string | null;
  /** Owner named in the source text, or null. Never inferred from context. */
  readonly statedOwner: string | null;
}

/* ── Engine provenance ───────────────────────────────────────────── */

/**
 * How the proposal was produced.
 *
 * `fallbackUsed` without `fallbackReason` is not representable, because a
 * fallback whose cause is unrecorded reads, a week later, exactly like a
 * deliberate rules-only run.
 */
export type DecompositionProvenance =
  | {
      readonly requestedEngine: 'model' | 'rules';
      readonly executedEngine: 'model' | 'rules';
      readonly fallbackUsed: false;
    }
  | {
      readonly requestedEngine: 'model' | 'rules';
      readonly executedEngine: 'model' | 'rules';
      readonly fallbackUsed: true;
      readonly fallbackReason: string;
    };

/* ── Violations: the shared vocabulary of "wrong" ────────────────── */

/**
 * What can be wrong with a decomposition.
 *
 * #27 rejects proposals carrying these; #26 scores datasets by counting them.
 * The two must agree, so the list lives here and neither owns it. A code added
 * on one side without the other is a compile error rather than a silent
 * divergence.
 *
 * - `EMPTY_STEP`          — a step whose title is blank or whitespace.
 * - `CONJUNCTION_ONLY`    — a step that is only a connective ("and", "ثم",
 *                           "ואז"): a split artefact, not a step.
 * - `SPAN_MISMATCH`       — `raw.slice(start, end) !== text`.
 * - `SPAN_OUT_OF_RANGE`   — a span reaching outside the source text.
 * - `SPAN_OVERLAP`        — two steps claiming overlapping source text.
 * - `INVENTED_TIMING`     — `statedTiming` not present in the source text.
 * - `INVENTED_OWNER`      — `statedOwner` not present in the source text.
 * - `INFERRED_WITH_SPAN`  — claims to be inferred while citing source text.
 * - `UNSOURCED_STEP`      — has no span and does not admit to being inferred.
 * - `DUPLICATE_STEP_ID`   — two steps sharing a `stepId`.
 * - `UNKNOWN_DEPENDENCY`  — an edge pointing at no step in this proposal.
 * - `CYCLIC_DEPENDENCY`   — the dependency graph is not acyclic.
 * - `SELF_DEPENDENCY`     — a step depending on itself.
 * - `SPLIT_ATOMIC`        — a commitment marked do-not-split was split anyway.
 */
export type DecompositionViolationCode =
  | 'EMPTY_STEP'
  | 'CONJUNCTION_ONLY'
  | 'SPAN_MISMATCH'
  | 'SPAN_OUT_OF_RANGE'
  | 'SPAN_OVERLAP'
  | 'INVENTED_TIMING'
  | 'INVENTED_OWNER'
  | 'INFERRED_WITH_SPAN'
  | 'UNSOURCED_STEP'
  | 'DUPLICATE_STEP_ID'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLIC_DEPENDENCY'
  | 'SELF_DEPENDENCY'
  | 'SPLIT_ATOMIC';

export interface DecompositionViolation {
  readonly code: DecompositionViolationCode;
  /** `stepId` the violation is attributed to, or null for proposal-level ones. */
  readonly stepId: string | null;
  /** Human-readable detail. Never contains raw user text — see audit policy. */
  readonly detail: string;
}

/* ── Proposals ───────────────────────────────────────────────────── */

/**
 * Why a commitment was not decomposed.
 *
 * `not_decomposable` is a finding about the commitment; the rest are findings
 * about this attempt. Collapsing them would make "this is one task" and "the
 * model was unavailable" the same answer to the user.
 */
export type AtomicReason =
  | 'not_decomposable'
  | 'below_confidence'
  | 'engine_unavailable'
  | 'validation_rejected';

interface DecompositionProposalBase {
  readonly version: typeof DECOMPOSITION_CONTRACT_VERSION;
  readonly schema: typeof DECOMPOSITION_SCHEMA_VERSION;
  readonly proposalId: string;
  /** The commitment this describes. It is not modified by this proposal. */
  readonly commitmentId: string;
  /** Source text the spans index into. */
  readonly sourceText: string;
  readonly provenance: DecompositionProvenance;
}

/**
 * A real decomposition. `steps` has at least two entries by construction of the
 * variant: one step is `AtomicProposal`, not a decomposition of size one.
 */
export interface DecomposedProposal extends DecompositionProposalBase {
  readonly outcome: 'decomposed';
  readonly steps: readonly [
    DecompositionStepProposal,
    DecompositionStepProposal,
    ...DecompositionStepProposal[],
  ];
}

/**
 * The commitment stands as one step, and says why.
 *
 * This is the shape #27's "single-item fallback is explicit, never heuristic
 * masquerading as reviewed" acceptance criterion requires: a caller cannot read
 * this as a decomposition, because it has no `steps` to read.
 */
export interface AtomicProposal extends DecompositionProposalBase {
  readonly outcome: 'atomic';
  readonly reason: AtomicReason;
}

/** The attempt produced something invalid. Nothing here is offerable. */
export interface RejectedProposal extends DecompositionProposalBase {
  readonly outcome: 'rejected';
  readonly violations: readonly [DecompositionViolation, ...DecompositionViolation[]];
}

export type DecompositionProposal = DecomposedProposal | AtomicProposal | RejectedProposal;

/* ── Confirmation ────────────────────────────────────────────────── */

/**
 * A ruling on one proposed step.
 *
 * `edit` carries the replacement title, so an edited step is confirmed as what
 * the user wrote rather than as the engine's wording plus a note.
 */
export type StepDecision =
  | { readonly stepId: string; readonly verdict: 'accept' }
  | { readonly stepId: string; readonly verdict: 'reject' }
  | { readonly stepId: string; readonly verdict: 'edit'; readonly editedTitle: string };

/**
 * Partial acceptance, made explicit.
 *
 * `decisions` must cover every step in the proposal exactly once. A missing
 * step invalidates the request instead of defaulting — the entire point of
 * "partial acceptance is explicit" is that the set the user did *not* accept is
 * stated rather than inferred from what they left out.
 */
export interface DecompositionConfirmationRequest {
  readonly proposalId: string;
  readonly scopeId: string;
  readonly decisions: readonly StepDecision[];
  readonly idempotencyKey: string;
}

export type ConfirmationFailureCode =
  | 'proposal_not_found'
  | 'proposal_not_decomposed'
  | 'incomplete_decisions'
  | 'unknown_step'
  | 'duplicate_decision'
  | 'invalid_edit'
  /**
   * The proposal was already confirmed, and this request is not a replay of
   * that confirmation — a reused idempotency key carrying different decisions,
   * or a fresh key against a proposal that has already been applied.
   *
   * Distinct from `proposal_not_found`, which is what those cases reported
   * before this member existed. Collapsing them tells a caller its proposal
   * never existed when in fact its decisions were rejected because someone had
   * already decided — the one case where a retry is exactly the wrong response.
   */
  | 'already_confirmed'
  | 'persistence_failed';

export interface DecompositionConfirmationResult {
  readonly version: typeof DECOMPOSITION_CONTRACT_VERSION;
  readonly success: boolean;
  /** True when a prior identical confirmation already applied. */
  readonly replayed: boolean;
  readonly persistedStepIds: readonly string[];
  readonly rejectedStepIds: readonly string[];
  readonly failureCode?: ConfirmationFailureCode;
}

/* ── Annotation provenance (#26) ─────────────────────────────────── */

/**
 * Whether a labelled example reflects a human judgement.
 *
 * Carried in the data, not inferred from which file a row sits in, for the
 * reason Sprint 05 carried judgment provenance: a corpus that has to be trusted
 * to be described correctly will eventually be described incorrectly. Sprint 06
 * ships `synthetic` rows only; `human_reviewed` exists so the pipeline does not
 * change shape when real review happens.
 */
export type AnnotationProvenance = 'synthetic' | 'human_reviewed';

export type DecompositionLabelKind = 'atomic' | 'multi_step' | 'do_not_split';

/** One labelled example. The unit both the evaluator and the golden set use. */
export interface DecompositionExample {
  readonly exampleId: string;
  readonly locale: string;
  readonly sourceText: string;
  readonly label: DecompositionLabelKind;
  readonly provenance: AnnotationProvenance;
  /** Expected steps. Empty for `atomic` and `do_not_split`. */
  readonly expectedSteps: readonly DecompositionStepProposal[];
  /** Why this example is here — especially why a `do_not_split` must not split. */
  readonly note: string;
}

/* ── Policy ──────────────────────────────────────────────────────── */

export const DECOMPOSITION_PERSISTENCE_POLICY = Object.freeze({
  proposalCanPersist: false,
  confirmationRequired: true,
  adapterOwnsCanonicalWrites: true,
  atomicBatchRequired: true,
  rawInputInAudit: false,
  /** Decomposition adds steps beside a commitment; it never edits or replaces it. */
  originalCommitmentRemainsCanonical: true,
  /** Every proposed step needs its own verdict; omission is not acceptance. */
  everyStepNeedsExplicitDecision: true,
});
