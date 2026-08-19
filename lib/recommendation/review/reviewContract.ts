/**
 * The review surface for the `recommendation` module (Sprint 08, issue #35).
 *
 * #33 defines what a recommendation *is*. This file defines what a reviewer is
 * shown, what they may decide, and what a decision submission looks like on the
 * wire. `present.ts` is the only place that turns one into the other; this file
 * is types, closed vocabularies and frozen policy, and holds no logic beyond
 * two total helpers over its own unions.
 *
 * ── Relationship to the shipped pilot ────────────────────────────────────
 *
 * `src/contracts/v1/nextStepContracts.ts` and `src/components/NextStepReview.tsx`
 * already ship a working review interaction: one step, one sentence of
 * explanation, five verdicts, a confirm-before-saving notice. This file does not
 * replace them, does not import them at runtime, and nothing here changes the
 * `/api/next-step` wire format. Sprint 06's recorded cost of shipping two
 * complete implementations of one mechanism was four review rounds, each finding
 * a defect already fixed on the other side, so every overlap is labelled at the
 * type as **same concept at module scope**, **superset**, or **deliberately
 * different**.
 *
 * The reason this surface exists separately at all is structural, not stylistic:
 * `NextStepRecommendationContract.primaryStep` is a single nullable step. It has
 * no place to put an alternative, a confidence band, a soleness verdict, or an
 * evidence-derived explanation — and #33's decision 2 exists precisely to forbid
 * the `{ primary, alternatives }` shape that renders correctly when the
 * alternatives are dropped. A review surface over #33's model cannot be
 * expressed in the pilot's contract without discarding the thing that makes it a
 * proposal rather than an instruction.
 *
 * ── Four structural decisions ────────────────────────────────────────────
 *
 *  1. **Nothing persists before explicit confirmation, as a shape property.**
 *     There is exactly one value in this module an adapter will accept as
 *     authority to write — `ReviewPersistenceHandoff` — and it appears in
 *     exactly one branch of `ReviewDecisionOutcome`, the branch reachable only
 *     from a `confirmation.stage === 'confirmed'` submission. A caller cannot
 *     obtain one by omitting a field, because `ReviewConfirmation` is a
 *     discriminated union rather than a `confirmed?: boolean`: silence is not
 *     an unconfirmed *value*, it is not a confirmation at all. This is
 *     `DecompositionConfirmationRequest`'s rule — a set the user did not accept
 *     is stated rather than inferred from what they left out — applied to a
 *     single decision. Additionally every outcome branch carries
 *     `persisted: false` as a *literal type*, so "we wrote it" is not
 *     expressible on this wire format.
 *
 *  2. **A confirmation restates its target.** `ConfirmedReview` carries
 *     `acknowledgedVerdict` and `acknowledgedIndex`, and `present.ts` rejects a
 *     submission whose confirmation names a different verdict or position than
 *     the decision it accompanies. A boolean flag would let a stale confirmation
 *     — the user confirmed the first option, the offer re-rendered, the decision
 *     now targets the third — authorise a write against something the user never
 *     saw. The mismatch is the failure this shape makes reportable.
 *
 *  3. **Blind review is a different type, not a renderer that remembers.**
 *     `BlindReviewView` has no `optionIndex`, no `confidence`, no `soleness`, no
 *     `lead`/`alternatives` split and no `excluded` list. Those are the first
 *     pass's own judgements — which option the selector preferred, how sure it
 *     was, and what it ruled out — and a blind second pass that can see them is
 *     measuring agreement with the first pass rather than the thing itself, the
 *     confound `lib/calibration/contracts.ts` records a real calibration round
 *     losing to. Redaction by omission at the type is checkable; redaction by a
 *     renderer that declines to print a field is a convention, and the field is
 *     still on the wire.
 *
 *  4. **A blind decision cannot name an option.** `ReviewTarget` is a union: the
 *     attributed branch carries `optionIndex`, the blind branch carries
 *     `slotIndex` and the salt that produced the slot ordering. A blind client
 *     therefore cannot *express* an offer position, so the mapping is not
 *     something the client is trusted to keep secret — it is something the
 *     client never had. `present.ts` recomputes it from the recommendation and
 *     the salt.
 *
 * ── Rules this file is written under ─────────────────────────────────────
 *
 * No ambient clock: every instant is an explicit field, and nothing here or in
 * `present.ts` calls `Date.now()`, `new Date()`, `Math.random()` or
 * `randomUUID`. No caller-chosen identifier appears in any human-readable
 * string: ids travel in typed fields where a consumer that must not display them
 * can drop them, per #33's ruling on `EvidenceBackedReason.detail` and the leak
 * it was written for. Ordering that affects output uses `compareByCodePoint`
 * from `lib/planning/shared/compare.ts`, never `localeCompare`.
 */

import type {
  ConfidenceBand,
  EvidenceNodeId,
  ExclusionReasonCode,
  Instant,
  OptionSet,
  Recommendation,
  RecommendationDecisionVerdict,
  RecommendationDefectCode,
  RecommendedAction,
  StalenessReasonCode,
  SupportReasonCode,
  TimeInterval,
  TrustedSource,
  WithholdingReasonCode,
} from '../../../src/contracts/v1/recommendationContracts';
import type { NextStepLocale } from '../../../src/contracts/v1/nextStepContracts';

export const RECOMMENDATION_REVIEW_SCHEMA_VERSION = 'recommendation-review-v1' as const;

/* ── Locale ──────────────────────────────────────────────────────── */

/**
 * The locales this surface renders.
 *
 * Declared here as data because `present.ts` needs to iterate them at runtime,
 * and `NextStepLocale` is a type with no runtime counterpart to iterate. The
 * assertion below is what keeps the two from drifting: it is a **type-only**
 * relationship, erased before it can put the pilot's wire format into this
 * module's runtime closure, and it fails at compile time if either side gains or
 * loses a locale. Two independently maintained copies of one set is the Sprint
 * 06 gap; a copy with a compile-time equality proof against the original is not.
 */
export const REVIEW_LOCALES = Object.freeze(['en', 'ar', 'he'] as const);

export type ReviewLocale = (typeof REVIEW_LOCALES)[number];

type _MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _reviewLocalesMatchPilot: _MutuallyAssignable<ReviewLocale, NextStepLocale> = true;
export const REVIEW_LOCALE_COVERAGE = _reviewLocalesMatchPilot;

export type ReviewDirection = 'ltr' | 'rtl';

/** Right-to-left locales. Data rather than a conditional inside the presenter. */
export const RTL_REVIEW_LOCALES = Object.freeze(['ar', 'he'] as const) satisfies readonly ReviewLocale[];

/* ── Review mode ─────────────────────────────────────────────────── */

/**
 * Who is looking.
 *
 * - `attributed` — the user whose recommendation this is. They see the offer as
 *   the selector built it: lead first, alternatives after, soleness stated, and
 *   what was excluded, because #33's decision 2 is that a lone option presented
 *   with no context reads as an instruction.
 * - `blind` — an evaluator judging the proposal without seeing the first pass's
 *   own judgement of it. See decision 3.
 */
export type ReviewMode = 'attributed' | 'blind';

export const REVIEW_MODES = Object.freeze(['attributed', 'blind'] as const) satisfies readonly ReviewMode[];

/**
 * Field names a `BlindReviewView` must not carry, at any depth.
 *
 * Kept because it names the *specific* things this surface is known to have to
 * withhold, and a named check produces a better failure message than a
 * set-difference. It is **not the guard**, though: a deny list only catches
 * leaks somebody thought of. Adding `rank: option.optionIndex` to a blind slot
 * passed all sixty-five tests in an earlier revision, because `rank` was not on
 * this list — and a leak under a name nobody remembered is precisely the
 * dangerous direction.
 *
 * `BLIND_VIEW_ALLOWED_FIELDS` below is the guard. This stays as the readable
 * statement of intent.
 */
export const BLIND_REDACTED_FIELDS = Object.freeze([
  'optionIndex',
  'confidence',
  'confidenceLabel',
  'soleness',
  'solenessNotice',
  'lead',
  'alternatives',
  'excluded',
] as const);

/**
 * Every key that may appear anywhere in a `BlindReviewView`.
 *
 * An **allow** list, and that inversion is the whole point. The test walks a
 * built blind view and its JSON serialisation and asserts every key it finds is
 * in here, so a new field leaks only if someone also adds its name to this list
 * — which is a line in a diff a reviewer reads, rather than an absence nobody
 * can see. `BLIND_REDACTED_FIELDS` answers "did we remove the things we know
 * about"; this answers "did anything at all get added".
 *
 * Derived by hand rather than from the type because TypeScript types are erased
 * before the test runs, and a runtime guard needs runtime data.
 */
export const BLIND_VIEW_ALLOWED_FIELDS = Object.freeze([
  // ReviewViewBase
  'schema',
  'recommendationId',
  'locale',
  'direction',
  'heading',
  'headingElementId',
  'confirmNotice',
  'confirmPrompt',
  'confirmLabel',
  'cancelLabel',
  'whyHeading',
  // BlindReviewView
  'mode',
  'slotsHeading',
  'slots',
  'verdicts',
  // BlindReviewSlot
  'slotIndex',
  'actionKind',
  'actionLabel',
  'subject',
  'whyThisNow',
  'elementId',
  // ReviewActionSubject
  'commitmentId',
  'slot',
  'until',
  'proposalId',
  // TimeInterval
  'startsAt',
  'endsAt',
  // ReviewReasonLine
  'code',
  'text',
  'citedNodeCount',
  'rootSourceKinds',
  'basisText',
  // ReviewVerdictAction
  'verdict',
  'label',
  'requiresConfirmation',
] as const);

/**
 * Hard limits, enforced before any input reaches #33's checkers.
 *
 * These are **resource** limits, not semantic ones, and they exist because the
 * route is public and unauthenticated. A structurally valid recommendation with
 * a linear `derived` chain 8,000 nodes deep — about 1 MB of JSON — took
 * `resolveEvidenceRoots` past Node's stack limit and returned a 500; at 20,000
 * it burned 5.4 seconds of CPU first. Neither is malformed. Nothing in the
 * pipeline bounded anything, and App Router routes have no default body cap, so
 * one request per worker was enough.
 *
 * `maxEvidenceNodes` is the load-bearing one: a chain can be no deeper than the
 * graph has nodes, so capping nodes caps recursion depth as well, and 500 frames
 * is far inside any engine's limit. It also caps the quadratic term in #33's
 * cycle detector, which intersects forward and backward reachability per node.
 *
 * `maxOfferedOptions` is deliberately much larger than
 * `RECOMMENDATION_OPTION_POLICY.maxOptions` (3). Three is the *product* rule and
 * #33 reports `OPTION_CAP_EXCEEDED` for it, which is a finding a caller should
 * see; 64 is the point past which we decline to allocate rather than explain.
 * Collapsing the two would replace a useful semantic finding with a resource
 * refusal.
 */
export const RECOMMENDATION_REVIEW_LIMITS = Object.freeze({
  // 2048, not 500. At 500 the module's *own* selector output stopped being
  // reviewable at roughly 55 commitments — it emits about nine evidence nodes
  // per commitment, so a scope of 64 produced 579 nodes and the review surface
  // returned RECOMMENDATION_TOO_LARGE for a recommendation the selector had
  // just declared defect-free. Neither track could see that alone, and the
  // cross-track corpus used four commitments.
  //
  // The original 500 was chosen to cap recursion depth and the quadratic term
  // in the cycle detector. Both reasons have since weakened: resolveEvidenceRoots
  // is iterative (tested at 50,000 nodes), and the amplification an attacker
  // actually reaches is refs-per-reason, now bounded below. Measured on this
  // runtime, checkEvidenceGraph over a flat 4,000-node graph is ~1ms.
  //
  // 2048 covers a scope of roughly 225 commitments. Beyond that the selector
  // should bound its own evidence rather than the review surface refusing it —
  // recorded as deferred work, and pinned by a cross-track test that fails if
  // this limit and the selector's output-per-commitment drift apart again.
  maxEvidenceNodes: 2048,
  maxParentsPerNode: 64,
  maxOfferedOptions: 64,
  // Raised with maxEvidenceNodes and for the same reason: the selector emits one
  // excluded row per ineligible commitment, so 64 refused a scope of 65.
  maxExcludedCandidates: 256,
  maxReasonsPerOption: 32,
  maxEvidenceRefsPerReason: 64,
  maxEditedTitleLength: 500,
});

/* ── What a reviewer is shown ────────────────────────────────────── */

/**
 * One line of the why-this-now explanation.
 *
 * `code` is #33's shared vocabulary, so #34 emits it and this renders it without
 * a translation table in between — the layer a translation would be wrong in.
 * `text` is the localised sentence for that code and nothing else: it is
 * selected by code, never assembled from user content, so it cannot carry a
 * commitment title or a caller-chosen id.
 *
 * `rootSourceKinds` is the evidence-graph half, and it is what makes this an
 * explanation rather than a label. It is computed by resolving the reason's
 * `supportedBy` node ids through `resolveEvidenceRoots` to the *observed* nodes
 * they ultimately rest on, then reporting the distinct `TrustedSource.kind` of
 * those roots. #33's decision 1 guarantees that list is non-empty for any graph
 * `checkRecommendation` accepts, so "this rests on nothing" is not a state this
 * field can be in without the presenter having already refused to render.
 *
 * The kinds are reported, never the ids: `commitmentId`, `proposalId`, `itemId`
 * and `nodeId` are free strings people fill with content.
 */
export interface ReviewReasonLine {
  readonly code: SupportReasonCode;
  readonly text: string;
  /** How many evidence nodes the reason cites directly. */
  readonly citedNodeCount: number;
  /** Distinct kinds of trusted state the reason ultimately rests on. */
  readonly rootSourceKinds: readonly TrustedSource['kind'][];
  /**
   * `rootSourceKinds` as a localised sentence — "Based on your commitments and
   * your plan."
   *
   * Assembled here rather than in the component so that the component owns no
   * copy table and no list-joining rule. A renderer that built this sentence
   * would need the locale's conjunction and its list separator, which is exactly
   * the kind of presentation logic that then has to be re-tested per component.
   */
  readonly basisText: string;
}

/** One line of "why you are not seeing this". Attributed mode only. */
export interface ReviewExclusionLine {
  readonly code: ExclusionReasonCode;
  readonly text: string;
}

/**
 * The typed, droppable half of an action.
 *
 * Every identifier the action carries lives here and nowhere else, so a consumer
 * that must not display identifiers drops this object and still has a renderable
 * card. That is the same division #33 makes between `RecommendationDefect`'s
 * typed `nodeId` field and its id-free `detail`.
 */
export interface ReviewActionSubject {
  readonly commitmentId: string;
  /** Present for a `schedule` action. */
  readonly slot: TimeInterval | null;
  /** Present for a `defer` action. */
  readonly until: Instant | null;
  /** Present for a `decompose` action. */
  readonly proposalId: string | null;
}

/**
 * One option as it appears in an attributed review.
 *
 * `elementId` is derived from the option's *position*, never from any
 * identifier, and exists so the component can pair a heading with the group it
 * labels without inventing ids in JSX. An id built from `commitmentId` would put
 * a caller-chosen string into the DOM and into any accessibility tree dump.
 */
export interface ReviewOptionCard {
  readonly optionIndex: number;
  readonly actionKind: RecommendedAction['kind'];
  readonly actionLabel: string;
  readonly subject: ReviewActionSubject;
  readonly whyThisNow: readonly [ReviewReasonLine, ...ReviewReasonLine[]];
  readonly confidence: ConfidenceBand;
  readonly confidenceLabel: string;
  readonly elementId: string;
}

/**
 * One option as it appears in a blind review.
 *
 * Structurally a `ReviewOptionCard` minus every first-pass judgement: no
 * `optionIndex`, no `confidence`, no `confidenceLabel`. `slotIndex` is the
 * position in the blind ordering, which is a pure function of the
 * recommendation and the caller's salt and carries no rank information — see
 * `blindSlotOrder` in `present.ts`.
 */
export interface BlindReviewSlot {
  readonly slotIndex: number;
  readonly actionKind: RecommendedAction['kind'];
  readonly actionLabel: string;
  readonly subject: ReviewActionSubject;
  readonly whyThisNow: readonly [ReviewReasonLine, ...ReviewReasonLine[]];
  readonly elementId: string;
}

/**
 * A verdict offered to the reviewer, with the copy and the confirmation rule
 * that governs it.
 *
 * `requiresConfirmation` travels with the verdict rather than living in the
 * component, because a component that decided which verdicts need confirming
 * would be the second copy of that rule, and the one nothing tests. It is what
 * lets `RecommendationReview.tsx` be a renderer with no decision logic at all.
 */
export interface ReviewVerdictAction {
  readonly verdict: RecommendationDecisionVerdict;
  readonly label: string;
  readonly requiresConfirmation: boolean;
}

/**
 * Every string the component renders arrives on the view model.
 *
 * The component owns no copy table, no locale switch and no list-joining rule.
 * That is not tidiness: this repo has no DOM test infrastructure, so a string
 * chosen inside a component is a string no test in this sprint can reach. Moving
 * the choice here moves it somewhere `tests/recommendation/reviewContract.test.ts`
 * can assert it for all three locales at once.
 */
interface ReviewViewBase {
  readonly schema: typeof RECOMMENDATION_REVIEW_SCHEMA_VERSION;
  readonly recommendationId: string;
  readonly locale: ReviewLocale;
  readonly direction: ReviewDirection;
  readonly heading: string;
  /** Id of the element that names the whole surface. Position-derived, never an id from input. */
  readonly headingElementId: string;
  /** "Nothing is saved until you confirm." Rendered on every offer. */
  readonly confirmNotice: string;
  /** Shown once a verdict that would write has been staged. */
  readonly confirmPrompt: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly whyHeading: string;
}

/**
 * The offer as its owner sees it.
 *
 * The field layout mirrors #33's `OptionSetSummary` on purpose: there is no
 * `.primary` and no way to obtain the lead without also receiving `soleness`,
 * `alternatives` and `excluded`. A renderer that wants only the lead has to
 * destructure the fact that it is discarding the rest, in a diff a reviewer can
 * see.
 */
export interface AttributedReviewView extends ReviewViewBase {
  readonly mode: 'attributed';
  readonly soleness: OptionSet['kind'];
  readonly solenessNotice: string;
  readonly lead: ReviewOptionCard;
  readonly alternatives: readonly ReviewOptionCard[];
  /**
   * Named even though it is obvious from position, because a group of cards
   * with no heading forces the card headings up a level and the document then
   * skips from h2 to h4. Every group carries a heading so the outline never
   * jumps.
   */
  readonly leadHeading: string;
  readonly alternativesHeading: string;
  readonly excludedHeading: string;
  readonly excluded: readonly {
    readonly actionKind: RecommendedAction['kind'];
    readonly actionLabel: string;
    readonly subject: ReviewActionSubject;
    readonly reasons: readonly [ReviewExclusionLine, ...ReviewExclusionLine[]];
  }[];
  readonly verdicts: readonly [ReviewVerdictAction, ...ReviewVerdictAction[]];
}

export interface BlindReviewView extends ReviewViewBase {
  readonly mode: 'blind';
  /** One neutral group heading. It must not say which slot is which. */
  readonly slotsHeading: string;
  readonly slots: readonly [BlindReviewSlot, ...BlindReviewSlot[]];
  readonly verdicts: readonly [ReviewVerdictAction, ...ReviewVerdictAction[]];
}

/**
 * Why there is nothing to review.
 *
 * Three causes rather than one empty state, for the reason #33 separates
 * `sole_survivor` from `only_candidate`: "the module read your state and has
 * nothing to propose", "there was an offer and it has gone stale" and "the
 * producer emitted something malformed" are different statements, and a single
 * `empty` collapses a bug into a fact about the user's life. The pilot's
 * `NextStepState` collapses the first two of these and has no room for the
 * third — **deliberately different**, and this is the difference.
 *
 * Codes only. A `withheld` recommendation's reasons carry evidence node ids and
 * a stale verdict carries them too; neither reaches the wire here.
 */
export type NothingToReviewCause = 'withheld' | 'stale' | 'defective';

export interface NothingToReviewView extends ReviewViewBase {
  readonly mode: 'none';
  readonly cause: NothingToReviewCause;
  readonly message: string;
  /** Present when `cause` is `withheld`. */
  readonly withholdingCodes: readonly WithholdingReasonCode[];
  /** Present when `cause` is `stale`. */
  readonly stalenessCodes: readonly StalenessReasonCode[];
  /** Present when `cause` is `defective`. */
  readonly defectCodes: readonly RecommendationDefectCode[];
}

export type ReviewView = AttributedReviewView | BlindReviewView | NothingToReviewView;

/* ── Decisions ───────────────────────────────────────────────────── */

/**
 * Which option a decision is about, in the vocabulary the reviewer actually had.
 *
 * See decision 4. `optionIndex`/`slotIndex` are `null` only for a verdict that
 * is about the whole offer rather than one option — `dismiss` — matching #33's
 * `RecommendationDecision.optionIndex`, which is nullable for exactly that case.
 */
export type ReviewTarget =
  | { readonly mode: 'attributed'; readonly optionIndex: number | null }
  | {
      readonly mode: 'blind';
      readonly slotIndex: number | null;
      /** The same salt the blind view was built with. Non-blank. */
      readonly blindingSalt: string;
    };

/** The position the reviewer saw, whichever vocabulary they saw it in. */
export function targetPosition(target: ReviewTarget): number | null {
  return target.mode === 'attributed' ? target.optionIndex : target.slotIndex;
}

/**
 * Explicit confirmation, or its absence — and its absence is a *variant*, not a
 * falsy field. See decision 1.
 *
 * `acknowledgedIndex` is the position the confirming reviewer saw, in their own
 * vocabulary: an option index in attributed mode, a slot index in blind mode.
 * It is restated rather than copied by the client so that a confirmation which
 * has drifted from the decision it accompanies is reportable rather than
 * silently authoritative. See decision 2.
 */
export type ReviewConfirmation =
  | { readonly stage: 'unconfirmed' }
  | {
      readonly stage: 'confirmed';
      readonly acknowledgedVerdict: RecommendationDecisionVerdict;
      readonly acknowledgedIndex: number | null;
      /** Supplied by the caller. Nothing in this module reads a clock. */
      readonly confirmedAt: Instant;
    };

/**
 * What the component hands back when a reviewer presses something.
 *
 * Not a `ReviewDecisionSubmission`: the component does not know the
 * recommendation id, does not read a clock for `decidedAt`, and does not decide
 * whether a confirmation is required — it reports which control was pressed and
 * at which position, and the container assembles the submission. A component
 * that built the submission would be deciding, and deciding is the part no test
 * in this repo can reach inside a component.
 */
export interface ReviewIntent {
  readonly verdict: RecommendationDecisionVerdict;
  /** The position the reviewer saw, in their own vocabulary. */
  readonly position: number | null;
  readonly stage: ReviewConfirmation['stage'];
}

export interface ReviewDecisionSubmission {
  readonly recommendationId: string;
  readonly target: ReviewTarget;
  readonly verdict: RecommendationDecisionVerdict;
  /** Required for `edit`, forbidden otherwise. */
  readonly editedTitle?: string;
  /** Supplied by the caller. Nothing in this module reads a clock. */
  readonly decidedAt: Instant;
  readonly confirmation: ReviewConfirmation;
}

/**
 * The only value in this module an adapter will accept as authority to write.
 *
 * It is constructible in exactly one place — the confirmed branch of
 * `evaluateReviewSubmission` — and it is **not reachable from
 * `ReviewDecisionOutcome`**, so it is not part of any HTTP response. See the
 * note on `ReviewDecisionOutcome` for the leak that made that separation
 * necessary.
 *
 * `optionIndex` is the *offer* position even when the reviewer was blind: the
 * translation from slot to option happens server side, from the salt. That is
 * exactly why this value must not travel — it is the mapping, resolved.
 */
export interface ReviewPersistenceHandoff {
  readonly recommendationId: string;
  /** Position in the offer. Null only for a whole-offer dismissal. */
  readonly optionIndex: number | null;
  readonly verdict: RecommendationDecisionVerdict;
  /** Present only for an `edit` verdict. */
  readonly editedTitle?: string;
  readonly confirmedAt: Instant;
}

/**
 * What came of a submission — the part that is safe to send back.
 *
 * `persisted` is the literal type `false` on every branch, so this contract
 * cannot express a write having happened — the same device
 * `NextStepRecommendationContract.persistence.occurred` uses, at module scope.
 *
 * **There is deliberately no `handoff` on this type.** An earlier revision put
 * the `ReviewPersistenceHandoff` inside the `confirmed` branch, which meant a
 * *blind* reviewer's confirmation came back carrying `handoff.optionIndex` — the
 * offer position, which is the first entry in `BLIND_REDACTED_FIELDS` and the
 * single thing a blind exchange exists to withhold. Three confirmed decisions
 * recovered the whole permutation. The fix is structural rather than a
 * mode-dependent redaction step: write authority is **not part of the response
 * shape at all**. `evaluateReviewSubmission` returns it as a sibling of the
 * outcome, for a server-side adapter; `handleReviewRequest` returns only the
 * outcome. A wire format with no field for write authority cannot leak one, in
 * either mode, and cannot grow one without a visible change to this type.
 */
export type ReviewDecisionOutcome =
  | {
      readonly status: 'confirmation_required';
      readonly persisted: false;
      readonly awaitingVerdict: RecommendationDecisionVerdict;
      readonly awaitingIndex: number | null;
      readonly notice: string;
    }
  | {
      readonly status: 'confirmed';
      readonly persisted: false;
      readonly notice: string;
    }
  | {
      readonly status: 'recorded_without_penalty';
      readonly persisted: false;
      readonly notice: string;
    };

/* ── Findings: what can be wrong with a review exchange ──────────── */

/**
 * Everything a review entry point can refuse for, as codes rather than throws.
 *
 * This is #33's `RECOMMENDATION_INPUT_POLICY.reportWhatTheTaxonomyNames` applied
 * at the boundary: a route that raises on malformed input cannot return the list
 * it exists to return, and a 500 tells a client nothing it can act on. The
 * codes are partitioned by what a caller would fix.
 *
 * - `MALFORMED_REQUEST_BODY`        — the body is not JSON, or not an object.
 * - `UNSUPPORTED_REQUEST_KIND`      — `kind` is neither `present` nor `decide`.
 * - `MALFORMED_RECOMMENDATION`      — no recommendation, or one whose `outcome`
 *                                     is neither `offered` nor `withheld`. Note
 *                                     this is about the envelope: a structurally
 *                                     *defective* recommendation is a
 *                                     `NothingToReviewView`, not a rejection,
 *                                     because a reviewer being told "there is
 *                                     nothing to show you and here is the code"
 *                                     is a better outcome than a 400.
 * - `UNSUPPORTED_LOCALE`            — a locale outside `REVIEW_LOCALES`.
 * - `MISSING_EVALUATION_INSTANT`    — no `now`. Not defaulted to a clock
 *                                     reading: `noAmbientClock` is the whole
 *                                     reason expiry is checkable at all.
 * - `MALFORMED_FINGERPRINT_MAP`     — `currentFingerprints` is not a record of
 *                                     string-or-null. Absent is legal and means
 *                                     every observed node is unverifiable, which
 *                                     #33 resolves as stale, failing closed.
 * - `BLINDING_SALT_REQUIRED`        — blind mode with a blank or missing salt.
 *                                     A blind ordering derived from an empty
 *                                     salt is one every client can reproduce.
 * - `MALFORMED_SUBMISSION`          — the submission is not an object, or its
 *                                     target/confirmation is not one of the
 *                                     variants.
 * - `RECOMMENDATION_ID_MISMATCH`    — the submission names a different
 *                                     recommendation than the one supplied. The
 *                                     case a retry is exactly the wrong response
 *                                     to, so it is not folded into
 *                                     `MALFORMED_SUBMISSION`.
 * - `NOTHING_OFFERED`               — a decision against a withheld, stale or
 *                                     defective recommendation. There is no
 *                                     option to accept.
 * - `TARGET_MODE_MISMATCH`          — an attributed target against a blind
 *                                     exchange or the reverse. **Not a defence
 *                                     against a hostile client**: `mode` is
 *                                     declared by the same request, so a caller
 *                                     that wants an attributed exchange simply
 *                                     asks for one. It catches a *client bug* —
 *                                     a blind session whose submit path was
 *                                     wired to the attributed builder — and a
 *                                     replayed submission from the other mode.
 *                                     The property that actually keeps offer
 *                                     order away from a blind reviewer is that
 *                                     a blind exchange never returns it (see
 *                                     `ReviewDecisionOutcome`).
 * - `TARGET_REQUIRED`               — a verdict that is about one option
 *                                     (`accept`, `edit`, `done`, `defer`)
 *                                     with a null position.
 * - `TARGET_OUT_OF_RANGE`           — a position past the end of the offer.
 * - `EDIT_TITLE_REQUIRED`           — `edit` with no title, or a blank one. An
 *                                     edit that carries no replacement is an
 *                                     accept of the engine's wording wearing an
 *                                     edit's label.
 * - `EDIT_TITLE_NOT_APPLICABLE`     — a title on a non-`edit` verdict. Reported
 *                                     rather than dropped, because a client
 *                                     sending one believes it will be used.
 * - `CONFIRMATION_TARGET_MISMATCH`  — the confirmation names a verdict or a
 *                                     position the decision does not. See
 *                                     decision 2.
 * - `INVALID_INSTANT`               — `decidedAt`, `confirmedAt` or `now` does
 *                                     not parse.
 */
export type ReviewFindingCode =
  | 'MALFORMED_REQUEST_BODY'
  | 'UNSUPPORTED_REQUEST_KIND'
  | 'MALFORMED_RECOMMENDATION'
  | 'UNSUPPORTED_LOCALE'
  | 'MISSING_EVALUATION_INSTANT'
  | 'MALFORMED_FINGERPRINT_MAP'
  | 'BLINDING_SALT_REQUIRED'
  | 'MALFORMED_SUBMISSION'
  | 'RECOMMENDATION_ID_MISMATCH'
  | 'NOTHING_OFFERED'
  | 'TARGET_MODE_MISMATCH'
  | 'TARGET_REQUIRED'
  | 'TARGET_OUT_OF_RANGE'
  | 'EDIT_TITLE_REQUIRED'
  | 'EDIT_TITLE_NOT_APPLICABLE'
  | 'CONFIRMATION_TARGET_MISMATCH'
  | 'INVALID_INSTANT'
  | 'RECOMMENDATION_TOO_LARGE'
  | 'EDIT_TITLE_TOO_LONG';

export const REVIEW_FINDING_CODES = Object.freeze([
  'MALFORMED_REQUEST_BODY',
  'UNSUPPORTED_REQUEST_KIND',
  'MALFORMED_RECOMMENDATION',
  'UNSUPPORTED_LOCALE',
  'MISSING_EVALUATION_INSTANT',
  'MALFORMED_FINGERPRINT_MAP',
  'BLINDING_SALT_REQUIRED',
  'MALFORMED_SUBMISSION',
  'RECOMMENDATION_ID_MISMATCH',
  'NOTHING_OFFERED',
  'TARGET_MODE_MISMATCH',
  'TARGET_REQUIRED',
  'TARGET_OUT_OF_RANGE',
  'EDIT_TITLE_REQUIRED',
  'EDIT_TITLE_NOT_APPLICABLE',
  'CONFIRMATION_TARGET_MISMATCH',
  'INVALID_INSTANT',
  'RECOMMENDATION_TOO_LARGE',
  'EDIT_TITLE_TOO_LONG',
] as const) satisfies readonly ReviewFindingCode[];

type _ReviewFindingCodesCovered =
  Exclude<ReviewFindingCode, (typeof REVIEW_FINDING_CODES)[number]> extends never ? true : never;
const _reviewFindingCodesAreExhaustive: _ReviewFindingCodesCovered = true;
export const REVIEW_FINDING_CODE_COVERAGE = _reviewFindingCodesAreExhaustive;

/**
 * One finding.
 *
 * `field` names *which* field was wrong by name, never by value: echoing the
 * offending string back would put unvalidated caller input into a message, which
 * is exactly what #33's `StalenessReason.field` exists to avoid. `detail` is for
 * humans and carries no caller-chosen identifier — positions and counts only.
 */
export interface ReviewFinding {
  readonly code: ReviewFindingCode;
  readonly field: string | null;
  /** The position the finding is about, in the reviewer's vocabulary. */
  readonly position: number | null;
  readonly detail: string;
}

/* ── The wire format ─────────────────────────────────────────────── */

/**
 * What `/api/recommendation/review` accepts.
 *
 * The recommendation travels **in the request** rather than being fetched by the
 * route, and that is deliberate for as long as #34's selector is unmerged: a
 * route that invented a producer would ship a second selector, which is the
 * duplication this sprint is explicitly avoiding. When #34 lands, `present` gains
 * a variant that names a scope and the route resolves it; `decide` does not
 * change, because it already re-validates whatever it is handed.
 *
 * `now` is required on both kinds. Freshness is not checkable without it and
 * this module will not read a clock to supply one.
 */
export type ReviewRequest =
  | {
      readonly kind: 'present';
      readonly recommendation: Recommendation;
      readonly locale: ReviewLocale;
      readonly mode: ReviewMode;
      /** Required when `mode` is `blind`. Non-blank. */
      readonly blindingSalt?: string;
      readonly now: Instant;
      /** Absent means every observed node is unverifiable, which fails closed. */
      readonly currentFingerprints?: Readonly<Record<EvidenceNodeId, string | null>>;
    }
  | {
      readonly kind: 'decide';
      readonly recommendation: Recommendation;
      readonly locale: ReviewLocale;
      /**
       * The mode the reviewer was presented in, stated separately from
       * `submission.target.mode`, which is what makes `TARGET_MODE_MISMATCH`
       * checkable at all. Without it, a client that was shown a blind view could
       * submit an attributed target carrying an offer position, and the server
       * would have no way to know the reviewer was never supposed to have one.
       */
      readonly mode: ReviewMode;
      readonly now: Instant;
      readonly currentFingerprints?: Readonly<Record<EvidenceNodeId, string | null>>;
      readonly submission: ReviewDecisionSubmission;
    };

export type ReviewResponse =
  | { readonly kind: 'presented'; readonly persisted: false; readonly view: ReviewView }
  | { readonly kind: 'decided'; readonly persisted: false; readonly outcome: ReviewDecisionOutcome }
  | {
      readonly kind: 'rejected';
      readonly persisted: false;
      readonly findings: readonly [ReviewFinding, ...ReviewFinding[]];
    };

/* ── Policy ──────────────────────────────────────────────────────── */

/**
 * Which verdicts are about one option and which are about the whole offer.
 *
 * `dismiss` is the only whole-offer verdict: dismissing means "none of these",
 * which is a statement about the offer. `defer` is per-option because deferring
 * the lead while leaving an alternative on the table is a real thing a user
 * does, and folding it into a whole-offer verdict would lose that.
 */
export const WHOLE_OFFER_VERDICTS = Object.freeze(['dismiss'] as const) satisfies
  readonly RecommendationDecisionVerdict[];

/**
 * Verdicts that would result in a write, and therefore require confirmation.
 *
 * `defer` and `dismiss` are absent because neither writes anything: they are
 * feedback about an offer that was never canonical, which is why the pilot
 * records them `recorded_without_penalty` and why
 * `NEXT_STEP_PRODUCT_POLICY.rejectionHasPenalty` is false. Same concept at
 * module scope.
 */
export const CONFIRMING_VERDICTS = Object.freeze(['accept', 'edit', 'done'] as const) satisfies
  readonly RecommendationDecisionVerdict[];

export const RECOMMENDATION_REVIEW_POLICY = Object.freeze({
  /** This surface is a presenter. It never writes canonical user state. */
  reviewMayPersist: false,
  confirmationRequiredBeforePersistence: true,
  /** The handoff exists in exactly one outcome branch, and only after confirming. */
  handoffOnlyOnExplicitConfirmation: true,
  /** A confirmation restates its target, so a drifted one is reportable. */
  confirmationRestatesTarget: true,
  /** The presenter runs #33's checkers before rendering; it does not trust the producer. */
  validateBeforeRender: true,
  /** A stale or defective recommendation is not offerable. */
  staleRecommendationIsNotOfferable: true,
  /** A blind view carries none of the first pass's own judgement. */
  blindViewCarriesFirstPassJudgement: false,
  /** Every instant comes from an explicit input. */
  noAmbientClock: true,
});
