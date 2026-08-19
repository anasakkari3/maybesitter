/**
 * Recommendation contracts (Sprint 08, issues #33, #34, #35).
 *
 * A recommendation answers "what should I do next" and is a *proposal*: it is
 * offered, never written (see `RECOMMENDATION_PERSISTENCE_POLICY`). Priority
 * said what matters, Planning said when it fits; Recommendation says which
 * single move to make now, what else was on the table, how sure it is, what it
 * read to decide, and when that reading stops being true.
 *
 * ── Relationship to the shipped V03 pilot ────────────────────────────────
 *
 * `src/contracts/v1/nextStepContracts.ts` and `lib/services/nextStepBaseline.ts`
 * already ship a working one-next-step surface behind `/api/next-step`. This
 * file does **not** replace them and does not import them; nothing here changes
 * that route's wire format.
 *
 * The division of authority is:
 *
 *   - `nextStepContracts` is authoritative for the **shipped product surface** —
 *     the JSON `/api/next-step` returns and `NextStepReview.tsx` renders. Its
 *     job is to be stable for a client that is already deployed.
 *   - This file is authoritative for the **`recommendation` intelligence
 *     module** — the thing #34 selects and #35 reviews, at the same scope as
 *     `lib/priority/**`, `lib/decomposition/**` and `lib/planning/**` sit beside
 *     the product code they will eventually inform.
 *
 * Where the two cover the same ground, the overlap is called out *at the type*,
 * one of: **same concept at module scope** (this file is the general form),
 * **superset** (this file adds a field the pilot has no place for), or
 * **deliberately different** (the shapes disagree and the comment says why).
 * Sprint 06's recorded cost of not doing this was four review rounds, each
 * finding a defect that had already been fixed on the other side.
 *
 * ── Five structural decisions, each because the alternative fails quietly ──
 *
 *  1. **An unsourced claim is unrepresentable, not discouraged.** Evidence is a
 *     graph of two node kinds: an `ObservedEvidence` names a record in trusted
 *     state, and a `DerivedEvidence` names a **non-empty** list of parents. There
 *     is no third kind and no "inferred" escape hatch. Because
 *     `checkEvidenceGraph` rejects cycles and dangling references, and
 *     `derivedFrom` is a non-empty tuple, every maximal ancestry path in an
 *     accepted graph terminates at an observed node — so "every claim traces to
 *     trusted state" is a theorem about the type rather than a convention.
 *     Sprint 06 got this far with `inferred` + empty `sourceSpans`, which is an
 *     *admission* an engine can make honestly and a caller can ignore; Sprint 07
 *     went further with `Effort` being a variant. This goes one step further
 *     again: there is nothing to admit to, because the shape has no room for it.
 *     See `EvidenceNode` and `resolveEvidenceRoots`.
 *
 *  2. **A lone option must say why it is alone.** `OptionSet` has three variants
 *     and no `primary` field. A UI cannot read "the recommendation" and drop the
 *     rest, because there is no field that means that: it must destructure a
 *     `choice` (two or more, ordered), a `sole_survivor` (one, plus the non-empty
 *     list of what was excluded and why), or an `only_candidate` (one, plus the
 *     evidence that nothing else existed). The shape `{ primary, alternatives }`
 *     is what this exists to forbid: it renders correctly when `alternatives` is
 *     dropped, so dropping it is invisible, and the pilot's
 *     `NextStepRecommendationContract.primaryStep` is exactly that shape. See
 *     `OptionSet` and `summarizeOptionSet`.
 *
 *  3. **Staleness is a computed verdict with a fail-closed default.** Wall-clock
 *     expiry is the easy half. The half that matters is that a recommendation is
 *     derived from state that keeps moving: the commitment gets completed, the
 *     plan is rebuilt, the priority policy changes. Every `ObservedEvidence`
 *     carries a `valueFingerprint` of what it read, so re-verification is a
 *     comparison rather than a guess — and a node the caller supplies **no**
 *     current fingerprint for is reported `SOURCE_UNVERIFIABLE` and the whole
 *     recommendation is stale. Treating unverifiable as fresh is the quiet
 *     failure: it makes the check pass hardest exactly when the caller has lost
 *     track of the source. See `evaluateRecommendationStaleness`.
 *
 *  4. **One vocabulary of "why", shared by three tracks and owned by none.**
 *     #34's selector emits these codes, #35's review renders them, and the
 *     merge's cross-track test compares them. Sprint 07's lesson is that the
 *     comparison must be at `(subject, code)` granularity, not on the set of
 *     code names — so reasons carry the option they belong to by *index* and
 *     the evidence they rest on by node id. The codes are partitioned into
 *     support / exclusion / withholding (`REASON_CODE_PARTITIONS`) because
 *     "this is why I picked it", "this is why I did not offer it" and "this is
 *     why I have nothing" are three different messages, and one flat list lets
 *     an implementation answer the wrong question with a true-looking code.
 *
 *  5. **Confidence lives on the option, not on the recommendation.** A set-level
 *     confidence would necessarily be a function of the options' — and a second
 *     copy of a number that something else computes is the gap Sprint 06 spent
 *     four rounds on. The lead option's confidence *is* the recommendation's.
 *     `Confidence` carries `value`, `band` and the evidence the number rests on,
 *     and `CONFIDENCE_BAND_MISMATCH` exists because a band that disagrees with
 *     its value is invisible: ranking reads the number and the UI reads the band.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { Field, LifeState, UnknownReason } from './lifeStateContracts';
import type { Instant, TimeInterval } from './planningContracts';

export const RECOMMENDATION_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const RECOMMENDATION_SCHEMA_VERSION = 'recommendation-v1' as const;

/**
 * `Instant` and `TimeInterval` are imported from `planningContracts` rather than
 * redeclared, and the import is type-only so it is erased before it can close a
 * runtime cycle (see the TDZ note on the `decomposition` descriptor in
 * `moduleContracts.ts`).
 *
 * Redeclaring them locally is the tempting alternative and it is the Sprint 06
 * failure applied to types: two structurally identical `Instant` aliases assign
 * to each other silently, so the day one of them grows a constraint — a branded
 * type, a stricter doc contract about the `Z` suffix — the other keeps accepting
 * what the first now rejects, and nothing anywhere fails. A recommendation whose
 * `schedule` action carries a planning slot must carry *planning's* interval, or
 * the half-open convention stated once in `planningContracts` would be stated
 * twice and eventually differently.
 */
export type { Instant, TimeInterval };

/* ── Sources: the loci of trusted state ──────────────────────────── */

/**
 * The fields of `LifeState` that are actual projections, derived from `LifeState`
 * rather than listed again.
 *
 * Listing them by hand would let this contract go on naming a field the
 * projection had dropped, or — worse — silently fail to offer a field it had
 * gained, so evidence for a new dimension of trusted state would have nowhere
 * to point and #34 would reach for a free-string source instead. The mapped type
 * selects exactly the `Field<…>`-typed keys, so `version`, `scopeId`,
 * `computedAt` and `inputDigest` are excluded automatically: they are metadata
 * about the projection, not observations about the user.
 */
export type LifeStateSourceField = {
  readonly [K in keyof LifeState]-?: LifeState[K] extends Field<unknown> ? K : never;
}[keyof LifeState];

/**
 * The same set as a value, for runtime iteration.
 *
 * The `_lifeStateSourceFieldsAreExhaustive` assignment below is the guard that
 * makes this array trustworthy: adding a projected view to `LifeState` without
 * adding it here is a compile error rather than a silently narrower audit.
 */
export const LIFE_STATE_SOURCE_FIELDS = Object.freeze([
  'commitments',
  'availability',
  'load',
  'recentOutcomes',
] as const) satisfies readonly LifeStateSourceField[];

type _LifeStateFieldsCovered =
  Exclude<LifeStateSourceField, (typeof LIFE_STATE_SOURCE_FIELDS)[number]> extends never ? true : never;
const _lifeStateSourceFieldsAreExhaustive: _LifeStateFieldsCovered = true;
export const LIFE_STATE_SOURCE_FIELD_COVERAGE = _lifeStateSourceFieldsAreExhaustive;

/**
 * Which part of a commitment record was read.
 *
 * Snake-cased leaf names rather than dotted paths into `Commitment`, because a
 * dotted path is a free string that happens to look structured — `priority.level`
 * and `priority .level` are different sources to a comparison and the same source
 * to a reader. A closed union makes the set of things a recommendation is allowed
 * to have read reviewable in one place.
 *
 * `title` is deliberately absent. A recommendation may name a commitment by id
 * and a renderer may fetch its title, but a *claim* resting on the title's text
 * would be a claim about content this module never validates, and the evidence
 * graph would then carry raw user text into audit records.
 */
export type CommitmentSourceField =
  | 'due_at'
  | 'remind_at'
  | 'status'
  | 'confirmed_at'
  | 'importance';

/**
 * A record in trusted state that an observation was read from.
 *
 * Closed union, and that is the whole point. `priorityContracts.FeatureEvidence`
 * models the same idea as a free dotted string (`'commitment.timeSpec.dueAt'`),
 * which was right for one module reading one shape. #34's selector reads from
 * four modules, and with a free string nothing stops `source: 'model_output'` or
 * `source: 'heuristic'` from typechecking and satisfying every "is it sourced"
 * assertion anyone would write. Every variant here names something a caller can
 * go and re-read, which is what makes `valueFingerprint` re-verifiable at all.
 *
 * - `commitment`      — canonical user state, the strongest source available.
 * - `life_state_field`— the Sprint 02 projection. Carries `known` because
 *                       LifeState distinguishes known-zero from unknown, and an
 *                       observation of "we looked and there is nothing" is a
 *                       real observation. It is what lets a *withheld*
 *                       recommendation cite trusted state instead of citing
 *                       nothing, so the empty scope is not an exception to
 *                       decision 1.
 * - `priority_score`  — Sprint 04-05 output. Carries `policyVersion` because a
 *                       score is only meaningful against the weights that
 *                       produced it, and a policy change must invalidate a
 *                       recommendation that leaned on the old one.
 * - `plan_slot`       — Sprint 07 output. Carries `planDigest` for the same
 *                       reason: `Plan.inputDigest` is what makes "the same plan"
 *                       checkable, and a slot cited without one is a slot from
 *                       some plan.
 * - `decomposition_step` — Sprint 06 output, for a `decompose` action.
 * - `feedback_aggregate` — Sprint 03 output. Scope-wide by construction, so it
 *                       carries no subject id: attributing a scope's counts to
 *                       one commitment invents a signal, which is the reason
 *                       recorded in the roadmap for why Priority did not consume
 *                       these either.
 */
export type TrustedSource =
  | {
      readonly kind: 'commitment';
      readonly commitmentId: string;
      readonly field: CommitmentSourceField;
    }
  | {
      readonly kind: 'life_state_field';
      readonly field: LifeStateSourceField;
      /** False when the projection reported the field unknown rather than empty. */
      readonly known: boolean;
    }
  | {
      readonly kind: 'priority_score';
      readonly commitmentId: string;
      readonly policyVersion: string;
    }
  | {
      readonly kind: 'plan_slot';
      readonly itemId: string;
      readonly planDigest: string;
    }
  | {
      readonly kind: 'decomposition_step';
      readonly proposalId: string;
      readonly stepId: string;
    }
  | {
      readonly kind: 'feedback_aggregate';
      readonly windowDays: number;
    };

export const TRUSTED_SOURCE_KINDS = Object.freeze([
  'commitment',
  'life_state_field',
  'priority_score',
  'plan_slot',
  'decomposition_step',
  'feedback_aggregate',
] as const) satisfies readonly TrustedSource['kind'][];

type _TrustedSourceKindsCovered =
  Exclude<TrustedSource['kind'], (typeof TRUSTED_SOURCE_KINDS)[number]> extends never ? true : never;
const _trustedSourceKindsAreExhaustive: _TrustedSourceKindsCovered = true;
export const TRUSTED_SOURCE_KIND_COVERAGE = _trustedSourceKindsAreExhaustive;

/* ── Claims ──────────────────────────────────────────────────────── */

/**
 * A named band a claim can fall in.
 *
 * Closed rather than a free label, because this is the field a renderer turns
 * into a human string and a free label is where raw user text ends up. The
 * pilot's `BaselineScore.evidenceLabels` is the rendered form of exactly these
 * — `'overdue'`, `'due within 24 hours'`, `'importance: high'` — built by
 * `lib/services/nextStepBaseline.ts` as English sentence fragments.
 *
 * **Deliberately different, and the direction matters.** The pilot's labels are
 * *presentation*: pre-rendered, English-only, and lossy (`'importance: high'`
 * cannot be compared to anything without parsing it back). These are
 * *provenance*: a label is derivable from a category and a locale, and a
 * category is not recoverable from a label. #35 renders these; it must not
 * consume the pilot's strings, or the module would inherit a presentation
 * decision as a data contract.
 */
export type EvidenceCategory =
  | 'overdue'
  | 'due_today'
  | 'due_this_week'
  | 'not_due'
  | 'no_stated_time'
  | 'importance_low'
  | 'importance_normal'
  | 'importance_high'
  | 'status_open'
  | 'status_closed'
  | 'unconfirmed'
  | 'load_light'
  | 'load_moderate'
  | 'load_heavy'
  | 'load_overloaded'
  | 'blocked'
  | 'unblocked';

/** Units a quantitative claim can be stated in. Closed for the same reason. */
export type EvidenceUnit = 'minutes' | 'hours' | 'days' | 'count' | 'ratio' | 'points';

/**
 * What a node asserts.
 *
 * `absent` is a first-class claim, not a missing one, and it reuses
 * `lifeStateContracts.UnknownReason` rather than restating those three cases.
 * "We read the due date and there is none" is a fact that can carry a
 * recommendation — it is what supports `no_stated_time` — and modelling it as
 * "no evidence node" would make the two cases "we looked and found nothing" and
 * "we never looked" identical in the graph. That is the same distinction
 * `FieldProvenance` was given `source` *and* `derivedFrom` to preserve.
 */
export type EvidenceClaim =
  | { readonly kind: 'instant'; readonly value: Instant }
  | { readonly kind: 'quantity'; readonly value: number; readonly unit: EvidenceUnit }
  | { readonly kind: 'flag'; readonly value: boolean }
  | { readonly kind: 'category'; readonly value: EvidenceCategory }
  | { readonly kind: 'absent'; readonly reason: UnknownReason };

/* ── The evidence graph ──────────────────────────────────────────── */

export type EvidenceNodeId = string;

/**
 * How a derived claim was computed from its parents.
 *
 * Closed so that a derived node cannot invent its own justification. A free
 * string here would make `rule: 'because the model said so'` a valid derivation,
 * and the graph would still typecheck as fully sourced — the node would name
 * parents it did not actually use, and nothing distinguishes that from a real
 * derivation. A closed list means every rule is one an auditor can look up and
 * one #34 had to add to this file before it could emit it.
 */
export type DerivationRuleCode =
  | 'OVERDUE_FROM_DUE_AT'
  | 'DUE_SOON_FROM_DUE_AT'
  | 'ELIGIBLE_FROM_STATUS'
  | 'ELIGIBLE_FROM_CONFIRMATION'
  | 'BLOCKED_FROM_DEPENDENCY'
  | 'RANK_FROM_PRIORITY'
  | 'SLOT_IMMINENT_FROM_PLAN'
  | 'CAPACITY_FROM_LOAD'
  | 'EFFORT_FROM_PLAN_SLOT';

/**
 * A claim read directly from trusted state. A root of the graph.
 *
 * `observedAt` is null when the source carries no timestamp of its own — a
 * LifeState known-zero is derived from the absence of records and so has no
 * "newest input that contributed", exactly as `FieldProvenance.derivedFrom` is
 * null in that case. Null is not "now": nothing in this module may substitute a
 * clock reading for a missing timestamp.
 *
 * `valueFingerprint` is an opaque digest of what was read, supplied by whoever
 * read it. It must be non-empty (`EMPTY_FINGERPRINT`), because an empty
 * fingerprint compares equal to the next empty fingerprint and so makes
 * `SOURCE_CHANGED` permanently undetectable for that node — a recommendation
 * that can never be invalidated by its own source moving, while looking fully
 * instrumented.
 */
export interface ObservedEvidence {
  readonly kind: 'observed';
  readonly nodeId: EvidenceNodeId;
  readonly source: TrustedSource;
  readonly claim: EvidenceClaim;
  /** ISO instant the source record was last written, or null if it has none. */
  readonly observedAt: Instant | null;
  /** Opaque, non-empty digest of the source value at observation time. */
  readonly valueFingerprint: string;
}

/**
 * A claim computed from other claims.
 *
 * `derivedFrom` is a **non-empty tuple**, and that single choice is what makes
 * decision 1 structural. A `readonly EvidenceNodeId[]` would admit `[]`, and a
 * derived node with no parents is precisely an unsourced claim wearing the
 * costume of a derived one — it satisfies "has a rule", "has a claim" and "is in
 * the graph", and no per-node assertion distinguishes it from a real derivation.
 * With the tuple, and with `checkEvidenceGraph` rejecting cycles and dangling
 * ids, every ancestry path is finite and strictly ascending toward parents, so
 * it must end at an `ObservedEvidence`. `resolveEvidenceRoots` computes that
 * termination point and returns it, so the property is asserted rather than
 * argued.
 */
export interface DerivedEvidence {
  readonly kind: 'derived';
  readonly nodeId: EvidenceNodeId;
  readonly rule: DerivationRuleCode;
  readonly claim: EvidenceClaim;
  readonly derivedFrom: readonly [EvidenceNodeId, ...EvidenceNodeId[]];
}

export type EvidenceNode = ObservedEvidence | DerivedEvidence;

/**
 * The graph, as its node list.
 *
 * There is no separate edge list: an edge lives on the child that depends on it,
 * once. A second representation of the same edges — a `nodes` array plus an
 * `edges` array — is two copies of one dataset, which is the Sprint 06 lesson
 * verbatim, and the failure mode is specific here: the checker would validate
 * one of them and the traversal would read the other.
 */
export interface EvidenceGraph {
  readonly nodes: readonly EvidenceNode[];
}

/* ── Reason codes: the shared vocabulary ─────────────────────────── */

/**
 * Why an option is being offered.
 *
 * These are the codes #34's selector emits and #35 renders. Several intentionally
 * mirror `priorityContracts.ReasonCode` (`OVERDUE`, `DUE_SOON`,
 * `HIGH_IMPORTANCE`, `REPEATEDLY_DELAYED`) — the mirroring is the point, the way
 * `PlanningDependencyKind` mirrors `DependencyKind`: a recommendation that had to
 * translate priority's reasons into its own vocabulary would be the place the
 * translation is wrong. Priority's codes explain a *score*; these explain an
 * *offer*, and the shared spelling means the two can be compared without a
 * lookup table.
 */
export type SupportReasonCode =
  | 'OVERDUE'
  | 'DUE_SOON'
  | 'HIGH_IMPORTANCE'
  | 'REPEATEDLY_DELAYED'
  | 'PLAN_SLOT_IMMINENT'
  | 'UNBLOCKS_DEPENDENTS'
  | 'QUICK_WIN'
  | 'ONLY_ELIGIBLE_ACTION';

/**
 * Why a candidate is not being offered.
 *
 * **Same concept at module scope as the pilot's
 * `BaselineScore.exclusionReason`,** which is
 * `'not_confirmed' | 'closed' | 'invalid_time' | null`. Those three map onto
 * `NOT_CONFIRMED`, `ALREADY_CLOSED` and `INVALID_SOURCE_TIME` and mean the same
 * thing. Two differences are deliberate:
 *
 *   - The pilot's field is nullable, so "not excluded" and "excluded for a
 *     reason we did not record" are the same value. Here an exclusion is a
 *     non-empty list of reasons attached to an `ExcludedOption`, so a candidate
 *     is either offered or excluded-with-a-stated-cause; there is no third state.
 *   - The pilot has no code for losing a comparison. `LOWER_RANKED` and
 *     `OPTION_CAP_REACHED` exist because "you are not seeing this because three
 *     other things scored higher" is the most common exclusion by far and the
 *     one a user is most likely to disagree with, and a taxonomy without it
 *     forces an implementation to either invent a code or drop the candidate
 *     silently. The pilot drops it silently.
 */
export type ExclusionReasonCode =
  | 'NOT_CONFIRMED'
  | 'ALREADY_CLOSED'
  | 'INVALID_SOURCE_TIME'
  | 'BLOCKED_BY_DEPENDENCY'
  | 'NO_PLANNED_SLOT'
  | 'OUTSIDE_WORKING_WINDOW'
  | 'INSUFFICIENT_EVIDENCE'
  | 'LOWER_RANKED'
  | 'OPTION_CAP_REACHED';

/**
 * Why the module is offering nothing at all.
 *
 * **Same concept at module scope as the pilot's `NextStepState`,** which is
 * `'ready' | 'empty' | 'insufficient_evidence'`. `outcome: 'offered'` covers
 * `ready`; `NO_ELIGIBLE_CANDIDATE` covers `empty`; `INSUFFICIENT_EVIDENCE`
 * covers the third. **Deliberately different** in that the pilot's states are
 * flat labels carrying no data, so `insufficient_evidence` cannot say what was
 * missing, and `empty` cannot distinguish "nothing to do" from "everything was
 * filtered out". Here a withheld recommendation carries non-empty
 * `WithholdingReason`s, each with its own `supportedBy` evidence — a refusal is
 * a claim, and decision 1 applies to claims regardless of which way they point.
 *
 * `INPUT_STALE` is the code for a run that declined to recommend because the
 * state it was handed had already been invalidated. It exists so that a caller
 * cannot express "I could not recommend" and "what I recommended has gone stale"
 * with the same code — see `evaluateRecommendationStaleness`, which answers the
 * second question about an already-built recommendation and never emits this.
 */
export type WithholdingReasonCode =
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'ALL_CANDIDATES_EXCLUDED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'INPUT_STALE'
  | 'MODULE_DISABLED';

export type RecommendationReasonCode =
  | SupportReasonCode
  | ExclusionReasonCode
  | WithholdingReasonCode;

export const SUPPORT_REASON_CODES = Object.freeze([
  'OVERDUE',
  'DUE_SOON',
  'HIGH_IMPORTANCE',
  'REPEATEDLY_DELAYED',
  'PLAN_SLOT_IMMINENT',
  'UNBLOCKS_DEPENDENTS',
  'QUICK_WIN',
  'ONLY_ELIGIBLE_ACTION',
] as const) satisfies readonly SupportReasonCode[];

export const EXCLUSION_REASON_CODES = Object.freeze([
  'NOT_CONFIRMED',
  'ALREADY_CLOSED',
  'INVALID_SOURCE_TIME',
  'BLOCKED_BY_DEPENDENCY',
  'NO_PLANNED_SLOT',
  'OUTSIDE_WORKING_WINDOW',
  'INSUFFICIENT_EVIDENCE',
  'LOWER_RANKED',
  'OPTION_CAP_REACHED',
] as const) satisfies readonly ExclusionReasonCode[];

export const WITHHOLDING_REASON_CODES = Object.freeze([
  'NO_ELIGIBLE_CANDIDATE',
  'ALL_CANDIDATES_EXCLUDED',
  'INSUFFICIENT_EVIDENCE',
  'INPUT_STALE',
  'MODULE_DISABLED',
] as const) satisfies readonly WithholdingReasonCode[];

/**
 * The three partitions as one value, so a cross-track test can iterate them.
 *
 * They are *not* disjoint, and pretending otherwise would be the bug:
 * `INSUFFICIENT_EVIDENCE` is legitimately both an exclusion (this candidate is
 * unsupported) and a withholding (nothing was supported). What the partition
 * contracts is **which positions a code may appear in** — a `SupportReason` can
 * never carry `LOWER_RANKED`, and the type enforces it. Exported as data because
 * the exhaustiveness test has to iterate the codes at runtime, which a type
 * alone cannot do.
 */
export const REASON_CODE_PARTITIONS = Object.freeze({
  support: SUPPORT_REASON_CODES,
  exclusion: EXCLUSION_REASON_CODES,
  withholding: WITHHOLDING_REASON_CODES,
});

/**
 * One stated reason, resting on named evidence.
 *
 * `supportedBy` is a non-empty tuple for the same reason `derivedFrom` is: a
 * reason with no evidence is an assertion, and the whole acceptance criterion is
 * that there are none of those. Every id in it must resolve to a node in the
 * recommendation's graph — `checkRecommendationEvidence` reports
 * `UNKNOWN_EVIDENCE_NODE` otherwise, because a reference into nothing is
 * indistinguishable from no reference at all once the graph is serialised.
 *
 * `detail` is for humans and **never carries a caller-chosen identifier**. This
 * is Sprint 07's ruling, and the leak it was written for was real: ids are free
 * strings that people fill with content, and a detail reading
 * `working window call-dr.cohen-about-the-biopsy` passed a test that checked
 * only that titles were absent. So a `detail` names options **by index**, names
 * evidence **by position in the graph's node list**, names sources by their
 * `kind`, and otherwise carries only numbers derived from the input. It does not
 * repeat `code`, and it does not name a `commitmentId`, `nodeId`, `scopeId`,
 * `proposalId` or `itemId` — those travel in their own typed fields, where a
 * consumer that must not display them can drop them.
 */
export interface EvidenceBackedReason<TCode extends RecommendationReasonCode> {
  readonly code: TCode;
  readonly supportedBy: readonly [EvidenceNodeId, ...EvidenceNodeId[]];
  readonly detail: string;
}

export type SupportReason = EvidenceBackedReason<SupportReasonCode>;
export type ExclusionReason = EvidenceBackedReason<ExclusionReasonCode>;
export type WithholdingReason = EvidenceBackedReason<WithholdingReasonCode>;

/* ── Confidence ──────────────────────────────────────────────────── */

export type ConfidenceBand = 'low' | 'medium' | 'high';

/**
 * Lower bounds, inclusive: `value >= high` is `high`, `value >= medium` is
 * `medium`, otherwise `low`.
 *
 * Frozen and exported as data rather than living as literals inside #34, for the
 * reason `LOAD_BAND_THRESHOLDS` and `PriorityPolicy` are: the formula is
 * versioned with the schema and inspectable by the test that checks a stored
 * band still matches its value. A threshold hidden in the selector cannot be
 * checked by the reviewer that renders the band.
 */
export const CONFIDENCE_BAND_THRESHOLDS = Object.freeze({
  medium: 0.34,
  high: 0.67,
});

/**
 * How sure the module is about one option.
 *
 * `basis` is non-empty: a confidence number with no evidence behind it is the
 * most persuasive unsourced claim the product can make, because a user reads
 * "87%" as a measurement. `band` is stored beside `value` rather than computed
 * on read because #35 renders the band and #34 ranks on the value, and a
 * consumer that recomputed it would silently diverge the day the thresholds
 * moved — which is why `CONFIDENCE_BAND_MISMATCH` exists to check them against
 * each other instead.
 *
 * The pilot has **no** confidence concept at all: `NextStepRecommendationContract`
 * carries a state and an explanation and nothing quantitative. This is new
 * ground, not a redefinition.
 */
export interface Confidence {
  /** 0..1 inclusive. Outside that range is `CONFIDENCE_OUT_OF_RANGE`. */
  readonly value: number;
  readonly band: ConfidenceBand;
  readonly basis: readonly [EvidenceNodeId, ...EvidenceNodeId[]];
}

/**
 * The band `value` falls in, or null when `value` is not a number in 0..1.
 *
 * Null rather than a thrown error and rather than a clamped `'low'`: this is the
 * `RECOMMENDATION_INPUT_POLICY` rule applied to arithmetic. Clamping is the
 * dangerous repair — `NaN >= 0.67` is `false`, so a NaN confidence would quietly
 * become `'low'` and be presented as a measured judgement of low confidence
 * rather than as the broken input it is. That exact shape (`Math.max` repairing
 * a non-finite number into a plausible one) is the buffer-clamping defect
 * recorded under `EFFORT_NOT_POSITIVE` in `planningContracts`.
 */
export function bandForConfidence(value: number): ConfidenceBand | null {
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  if (value >= CONFIDENCE_BAND_THRESHOLDS.high) return 'high';
  if (value >= CONFIDENCE_BAND_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/* ── Actions and options ─────────────────────────────────────────── */

/**
 * What the user is being invited to do.
 *
 * A variant per verb rather than `{ verb, payload }`, so that the data a verb
 * needs travels with it and cannot be absent: `schedule` without a slot and
 * `defer` without a target instant are both unrepresentable. Every variant names
 * a `commitmentId`, because a recommendation is always *about* something the
 * user already committed to — this module proposes moves on existing state and
 * never proposes new commitments, which is `originalCommitmentRemainsCanonical`
 * stated in the type.
 *
 * There is no `drop`/`abandon` variant in v1. Recommending that a user give
 * something up is a coaching and safety judgement (Sprint 09), not a selection
 * one, and shipping the shape before the policy that governs it is how the shape
 * becomes the policy.
 */
export type RecommendedAction =
  | { readonly kind: 'do_now'; readonly commitmentId: string }
  | {
      readonly kind: 'schedule';
      readonly commitmentId: string;
      /** A slot from a Plan. Half-open, per `planningContracts` rule 1. */
      readonly slot: TimeInterval;
    }
  | {
      readonly kind: 'decompose';
      readonly commitmentId: string;
      readonly proposalId: string;
    }
  | { readonly kind: 'defer'; readonly commitmentId: string; readonly until: Instant };

export const RECOMMENDED_ACTION_KINDS = Object.freeze([
  'do_now',
  'schedule',
  'decompose',
  'defer',
] as const) satisfies readonly RecommendedAction['kind'][];

type _ActionKindsCovered =
  Exclude<RecommendedAction['kind'], (typeof RECOMMENDED_ACTION_KINDS)[number]> extends never ? true : never;
const _actionKindsAreExhaustive: _ActionKindsCovered = true;
export const RECOMMENDED_ACTION_KIND_COVERAGE = _actionKindsAreExhaustive;

/**
 * A canonical, id-free key for an action.
 *
 * Two purposes, and the second is the one that needs stating. It is how
 * `DUPLICATE_OPTION_ACTION` and `EXCLUDED_OPTION_ALSO_OFFERED` are decided
 * without a deep structural comparison that would drift as variants are added.
 * It is *not* safe to put in a `detail` string — it contains `commitmentId` —
 * which is why the checkers below compare keys internally and report positions.
 */
export function actionKey(action: RecommendedAction): string {
  switch (action.kind) {
    case 'do_now':
      return `do_now:${action.commitmentId}`;
    case 'schedule':
      return `schedule:${action.commitmentId}:${action.slot.startsAt}:${action.slot.endsAt}`;
    case 'decompose':
      return `decompose:${action.commitmentId}:${action.proposalId}`;
    case 'defer':
      return `defer:${action.commitmentId}:${action.until}`;
  }
}

/**
 * One thing the user could do, with why and how sure.
 *
 * `optionIndex` duplicates the array position on purpose, and
 * `OPTION_INDEX_MISMATCH` checks the two agree. It is not redundancy for its own
 * sake: reasons and decisions refer to an option by index precisely so that no
 * identifier has to appear in a `detail` string or in a decision payload, and an
 * index that has drifted from its position silently retargets every one of those
 * references. The alternative — an `optionId` — reintroduces exactly the free
 * string the index exists to avoid.
 */
export interface RecommendationOption {
  /** Position in the offered list, from 0. Must equal the array index. */
  readonly optionIndex: number;
  readonly action: RecommendedAction;
  readonly support: readonly [SupportReason, ...SupportReason[]];
  readonly confidence: Confidence;
}

/** A candidate that was considered and is not being offered, and why not. */
export interface ExcludedOption {
  readonly action: RecommendedAction;
  readonly exclusion: readonly [ExclusionReason, ...ExclusionReason[]];
}

/**
 * The offer. See decision 2.
 *
 * - `choice` — two or more options, ordered by `RECOMMENDATION_ORDERING_KEYS`,
 *   lead first. `excluded` may be empty: with a genuine choice on screen, the
 *   user's control does not depend on being told what else was filtered.
 * - `sole_survivor` — one option, and a **non-empty** account of what was
 *   excluded. This is the variant the acceptance criterion is about. A single
 *   option presented with no context reads as "this is what you must do"; the
 *   same option presented beside "three others were ruled out, here is why" is a
 *   proposal the user can push back on. The non-emptiness is what makes the
 *   distinction unfakeable — a `choice` with one option is not constructible,
 *   and a `sole_survivor` with an empty exclusion list is not constructible.
 * - `only_candidate` — one option because there was genuinely nothing else, with
 *   `attested` naming the evidence for that claim. Separated from
 *   `sole_survivor` for the reason `AtomicReason` separates `not_decomposable`
 *   from `engine_unavailable`: "this is the only thing on your plate" and "this
 *   is the only thing that survived filtering" are different statements about
 *   the user's life, and collapsing them makes the system sound more certain
 *   than it is. `attested` is required because "nothing else existed" is itself a
 *   claim, and decision 1 does not exempt claims about absence.
 */
export type OptionSet =
  | {
      readonly kind: 'choice';
      readonly options: readonly [RecommendationOption, RecommendationOption, ...RecommendationOption[]];
      readonly excluded: readonly ExcludedOption[];
    }
  | {
      readonly kind: 'sole_survivor';
      readonly option: RecommendationOption;
      readonly excluded: readonly [ExcludedOption, ...ExcludedOption[]];
    }
  | {
      readonly kind: 'only_candidate';
      readonly option: RecommendationOption;
      readonly attested: readonly [EvidenceNodeId, ...EvidenceNodeId[]];
    };

/**
 * What a presenter reads.
 *
 * There is no `.primary` accessor and no way to get the lead option without also
 * receiving `soleness` and `alternatives`. That is the enforcement half of
 * decision 2: the type makes the wrong shape unconstructible, and this makes the
 * wrong *read* awkward — a renderer that wants only the lead has to destructure
 * the fact that it is discarding the rest, in a diff a reviewer can see.
 */
export interface OptionSetSummary {
  readonly lead: RecommendationOption;
  /** Everything after the lead, in offer order. Empty for the one-option kinds. */
  readonly alternatives: readonly RecommendationOption[];
  readonly soleness: OptionSet['kind'];
  readonly excluded: readonly ExcludedOption[];
}

export function summarizeOptionSet(options: OptionSet): OptionSetSummary {
  if (options.kind === 'choice') {
    return {
      lead: options.options[0],
      alternatives: options.options.slice(1),
      soleness: 'choice',
      excluded: options.excluded,
    };
  }
  if (options.kind === 'sole_survivor') {
    return {
      lead: options.option,
      alternatives: [],
      soleness: 'sole_survivor',
      excluded: options.excluded,
    };
  }
  return { lead: options.option, alternatives: [], soleness: 'only_candidate', excluded: [] };
}

/** Every offered option, in order, whatever the variant. */
export function offeredOptions(options: OptionSet): readonly RecommendationOption[] {
  return options.kind === 'choice' ? options.options : [options.option];
}

/* ── Validity: expiry and invalidation ───────────────────────────── */

/**
 * When this recommendation stops being true.
 *
 * Two fields, and **no watch list**. The set of things whose change invalidates
 * the recommendation is exactly the set of `observed` nodes in its evidence
 * graph — not a subset chosen at build time. A selective watch list would be a
 * second copy of a subset that nothing can check, and its failure mode is the
 * one this whole section exists to prevent: "we chose not to watch that one" is
 * how a stale recommendation survives, and it looks identical to a correct
 * narrow watch. Deriving it from the graph means a node cannot be cited as
 * support and simultaneously ignored for invalidation.
 *
 * `expiresAt` is **exclusive**, matching the half-open convention
 * `planningContracts` states once for every interval in this repo: the
 * recommendation is valid while `basisAt <= now < expiresAt`. At exactly
 * `expiresAt` it is stale. Inclusive-vs-exclusive at the boundary is the kind of
 * off-by-one that only surfaces on a scheduler tick that lands on a round
 * minute, which is most of them.
 *
 * `basisAt` is the instant the run was computed *against*, taken from the
 * caller's `now`. It is stored because `NOT_YET_VALID` is checkable only against
 * it, and a recommendation evaluated before it was computed is a replay or a
 * clock defect that must not be answered "fresh".
 */
export interface RecommendationValidity {
  /** The `now` the run was computed against. Never a clock reading. */
  readonly basisAt: Instant;
  /** Exclusive. Valid while `basisAt <= now < expiresAt`. */
  readonly expiresAt: Instant;
}

/**
 * A default time-to-live for callers that have no policy of their own.
 *
 * A default, not a rule: `expiresAt` is always an explicit field, and nothing in
 * this module computes an expiry by adding this to a clock reading. Sixty
 * minutes because the dominant invalidator in practice is the state moving, not
 * time passing — the fingerprint check is the real guard and the TTL is the
 * backstop for the case where nothing re-verifies at all.
 */
export const DEFAULT_RECOMMENDATION_TTL_MINUTES = 60;

/* ── The recommendation ──────────────────────────────────────────── */

interface RecommendationBase {
  readonly version: typeof RECOMMENDATION_CONTRACT_VERSION;
  readonly schema: typeof RECOMMENDATION_SCHEMA_VERSION;
  readonly recommendationId: string;
  readonly scopeId: string;
  readonly validity: RecommendationValidity;
  readonly evidence: EvidenceGraph;
  /**
   * Hash of the inputs this run read, for replay equality — the same role
   * `Plan.inputDigest` plays. Never user text: it is a hash over a canonical
   * serialisation.
   *
   * Computed **after** the structural pass, per
   * `RECOMMENDATION_INPUT_POLICY.digestAfterStaticPass`. Sprint 07 shipped the
   * other order and the digest threw on exactly the malformed inputs the pass
   * existed to report.
   */
  readonly inputDigest: string;
}

export interface OfferedRecommendation extends RecommendationBase {
  readonly outcome: 'offered';
  readonly options: OptionSet;
}

/**
 * The module read the state and has nothing to propose.
 *
 * It still carries `validity` and `evidence`, which is the point: "there is
 * nothing for you to do" is a claim about trusted state with a shelf life, and a
 * withheld verdict that could not go stale would be cached past the moment the
 * user added a commitment. It is also why `TrustedSource` includes
 * `life_state_field` with a `known` flag — LifeState's known-zero is what a
 * withheld recommendation cites, so the empty scope has real evidence rather
 * than being an exception carved out of decision 1.
 */
export interface WithheldRecommendation extends RecommendationBase {
  readonly outcome: 'withheld';
  readonly reasons: readonly [WithholdingReason, ...WithholdingReason[]];
}

export type Recommendation = OfferedRecommendation | WithheldRecommendation;

/* ── Structural defects ──────────────────────────────────────────── */

/**
 * What can be structurally wrong with an evidence graph.
 *
 * Partitioned from the recommendation-level codes below for the reason
 * `planningContracts` partitions static from attempt codes: "the graph is
 * malformed" and "the offer is malformed" are different bugs in different
 * tracks, and one flat list lets a checker report the wrong owner.
 *
 * - `BLANK_NODE_ID`            — an empty or whitespace-only `nodeId`. Blank ids
 *                                collide with each other, so every reference to
 *                                one resolves to whichever blank node came
 *                                first — a dangling reference that reports as
 *                                resolved.
 * - `DUPLICATE_EVIDENCE_NODE`  — two nodes sharing a `nodeId`. Every reference
 *                                to it is ambiguous, and the two nodes may carry
 *                                different fingerprints, so re-verification
 *                                becomes order-dependent.
 * - `UNKNOWN_EVIDENCE_NODE`    — a `derivedFrom` entry naming no node in this
 *                                graph.
 * - `SELF_DERIVED_EVIDENCE`    — a node deriving from itself. Takes precedence
 *                                over `CYCLIC_EVIDENCE`, following the rule
 *                                `decompositionContracts` set and
 *                                `planningContracts` repeated: one defect earns
 *                                one code.
 * - `CYCLIC_EVIDENCE`          — a derivation cycle of length > 1. This is the
 *                                only way a claim can appear sourced while
 *                                resting on nothing: two nodes each citing the
 *                                other satisfy "has non-empty parents" and reach
 *                                no observation. Rejecting cycles is therefore
 *                                not hygiene, it is the second half of the
 *                                theorem in decision 1.
 * - `EMPTY_FINGERPRINT`        — an observed node whose `valueFingerprint` is
 *                                blank. See `ObservedEvidence`.
 *
 * There is deliberately **no `UNROOTED_CLAIM` code.** A graph that passes the
 * five above cannot contain a derived node whose ancestry misses every
 * observation: parents are non-empty, all parents resolve, and the graph is
 * acyclic and finite, so every ancestry path terminates at a node with no
 * parents, which is an `ObservedEvidence` by construction. Adding the code would
 * imply the condition is reachable and invite an implementation to check for it
 * instead of relying on the structure. What *would* reintroduce it is widening
 * `derivedFrom` to a plain array — which is the change this note exists to
 * flag to whoever is tempted by it.
 */
export type EvidenceGraphDefectCode =
  | 'BLANK_NODE_ID'
  | 'DUPLICATE_EVIDENCE_NODE'
  | 'UNKNOWN_EVIDENCE_NODE'
  | 'SELF_DERIVED_EVIDENCE'
  | 'CYCLIC_EVIDENCE'
  | 'EMPTY_FINGERPRINT';

/**
 * What can be structurally wrong with the offer itself.
 *
 * - `CONFIDENCE_OUT_OF_RANGE`     — `value` is not a finite number in 0..1.
 * - `CONFIDENCE_BAND_MISMATCH`    — `band` is not what `value` maps to. See
 *                                   `Confidence`: ranking reads the number and
 *                                   the UI reads the band, so a disagreement is
 *                                   invisible to both.
 * - `DUPLICATE_OPTION_ACTION`     — two offered options proposing the same
 *                                   action. A fake choice: two rows on screen,
 *                                   one outcome. It defeats decision 2 while
 *                                   satisfying every cardinality check, which is
 *                                   why it is a code and not a nicety.
 * - `EXCLUDED_OPTION_ALSO_OFFERED`— the same action appears in both the offered
 *                                   and the excluded list, so the recommendation
 *                                   states and denies one thing.
 * - `OPTION_INDEX_MISMATCH`       — `optionIndex` is not the array position. See
 *                                   `RecommendationOption`.
 * - `OPTION_CAP_EXCEEDED`         — more offered options than
 *                                   `RECOMMENDATION_OPTION_POLICY.maxOptions`.
 *                                   A cap because a "recommendation" of eight
 *                                   things is a list, and the acceptance
 *                                   criterion about user control is about a
 *                                   choice a person can actually hold.
 */
export type RecommendationStructureDefectCode =
  | 'CONFIDENCE_OUT_OF_RANGE'
  | 'CONFIDENCE_BAND_MISMATCH'
  | 'DUPLICATE_OPTION_ACTION'
  | 'EXCLUDED_OPTION_ALSO_OFFERED'
  | 'OPTION_INDEX_MISMATCH'
  | 'OPTION_CAP_EXCEEDED';

export type RecommendationDefectCode =
  | EvidenceGraphDefectCode
  | RecommendationStructureDefectCode;

export const EVIDENCE_GRAPH_DEFECT_CODES = Object.freeze([
  'BLANK_NODE_ID',
  'DUPLICATE_EVIDENCE_NODE',
  'UNKNOWN_EVIDENCE_NODE',
  'SELF_DERIVED_EVIDENCE',
  'CYCLIC_EVIDENCE',
  'EMPTY_FINGERPRINT',
] as const) satisfies readonly EvidenceGraphDefectCode[];

export const RECOMMENDATION_STRUCTURE_DEFECT_CODES = Object.freeze([
  'CONFIDENCE_OUT_OF_RANGE',
  'CONFIDENCE_BAND_MISMATCH',
  'DUPLICATE_OPTION_ACTION',
  'EXCLUDED_OPTION_ALSO_OFFERED',
  'OPTION_INDEX_MISMATCH',
  'OPTION_CAP_EXCEEDED',
] as const) satisfies readonly RecommendationStructureDefectCode[];

/**
 * One structural finding.
 *
 * `nodeId` and `optionIndex` are the typed fields a caller may render or drop;
 * `detail` carries neither, per the ruling on `EvidenceBackedReason.detail`.
 * `nodeId` is exempt from the id rule only because it has its own field here, on
 * the same terms `PlanningReason.itemId` is exempt.
 */
export interface RecommendationDefect {
  readonly code: RecommendationDefectCode;
  /** The node the finding is about, or null for offer-level findings. */
  readonly nodeId: EvidenceNodeId | null;
  /** The offered option the finding is about, or null. */
  readonly optionIndex: number | null;
  readonly detail: string;
}

/* ── Graph checking ──────────────────────────────────────────────── */

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Structural check over an evidence graph alone.
 *
 * Returns findings; it does not throw. Per `RECOMMENDATION_INPUT_POLICY`, every
 * condition this taxonomy names comes back as data — a checker that raises
 * cannot return the list it exists to return, which is the defect
 * `planningContracts` records three instances of.
 *
 * **Ordering is by input position**, deliberately, and not by any string
 * comparison. Findings are emitted node by node in `graph.nodes` order and, for
 * each node, in a fixed code order. That makes the output deterministic without
 * this file needing a string comparator at all — which matters, because the
 * repo's comparator (`compareByCodePoint`) lives in `lib/planning/shared/` and a
 * contract must not import `lib/`, so the only ways to sort by id here would be
 * a second copy of that arithmetic (the Sprint 06 gap) or `localeCompare`, whose
 * result depends on the runtime's ICU data and default locale.
 *
 * The V03 pilot surface had four `localeCompare` sites — `nextStepBaseline.ts`
 * twice, `nextStepReviewService.ts` and `experiments/nextStepArms.ts` once each —
 * all of which now use `compareByCodePoint`. They are recorded here because a
 * reader who finds them in the history should not read them as a precedent this
 * module may follow: they were a pre-existing defect, and the count is worth
 * stating because the first grep that went looking for them returned two. A
 * truncated search over a rule that must hold everywhere reports a clean result
 * for the part it saw, which is the same shape of failure as a cross-track test
 * comparing at too coarse a granularity.
 *
 * **The suppression rule**, matching `planningContracts`: a finding is suppressed
 * only when it borrows a bound from something already reported malformed. A node
 * with a blank id is not also reported as a duplicate of the next blank id,
 * because the duplication is an artefact of the blankness. A dangling
 * `derivedFrom` edge does not suppress a cycle among the edges that do resolve —
 * those borrow nothing from the broken one.
 */
export function checkEvidenceGraph(graph: EvidenceGraph): readonly RecommendationDefect[] {
  const defects: RecommendationDefect[] = [];
  const nodes = graph.nodes;

  const firstIndexById = new Map<EvidenceNodeId, number>();
  const blankIndices = new Set<number>();

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (isBlank(node.nodeId)) {
      blankIndices.add(index);
      defects.push({
        code: 'BLANK_NODE_ID',
        nodeId: null,
        optionIndex: null,
        detail: `evidence node #${index} has a blank id`,
      });
      continue;
    }
    const first = firstIndexById.get(node.nodeId);
    if (first === undefined) {
      firstIndexById.set(node.nodeId, index);
    } else {
      defects.push({
        code: 'DUPLICATE_EVIDENCE_NODE',
        nodeId: node.nodeId,
        optionIndex: null,
        detail: `evidence node #${index} repeats the id first used by node #${first}`,
      });
    }
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.kind !== 'observed') continue;
    if (isBlank(node.valueFingerprint)) {
      defects.push({
        code: 'EMPTY_FINGERPRINT',
        nodeId: blankIndices.has(index) ? null : node.nodeId,
        optionIndex: null,
        detail: `observed evidence node #${index} carries a blank value fingerprint`,
      });
    }
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.kind !== 'derived') continue;
    const nodeId = blankIndices.has(index) ? null : node.nodeId;
    let selfReported = false;
    for (let edge = 0; edge < node.derivedFrom.length; edge += 1) {
      const parentId = node.derivedFrom[edge];
      if (!blankIndices.has(index) && parentId === node.nodeId) {
        if (!selfReported) {
          selfReported = true;
          defects.push({
            code: 'SELF_DERIVED_EVIDENCE',
            nodeId,
            optionIndex: null,
            detail: `derived evidence node #${index} derives from itself`,
          });
        }
        continue;
      }
      if (!firstIndexById.has(parentId)) {
        defects.push({
          code: 'UNKNOWN_EVIDENCE_NODE',
          nodeId,
          optionIndex: null,
          detail: `derived evidence node #${index} names a parent that is not in this graph, at edge #${edge}`,
        });
      }
    }
  }

  const cyclic = findCyclicNodeIndices(nodes, firstIndexById, blankIndices);
  for (let position = 0; position < cyclic.length; position += 1) {
    const index = cyclic[position];
    defects.push({
      code: 'CYCLIC_EVIDENCE',
      nodeId: nodes[index].nodeId,
      optionIndex: null,
      detail: `derived evidence node #${index} lies on a derivation cycle`,
    });
  }

  return defects;
}

/**
 * Indices of nodes on a derivation cycle of length > 1.
 *
 * Every member of a cycle is reported, not just the node the traversal happened
 * to enter through. Sprint 07's cross-track fuzz found exactly the opposite bug
 * in the planning cycle detector: a member reached through a cross edge was
 * missed while the code stayed in the reported *set*, contributed by the two
 * members that were found — so a set-level comparison saw perfect agreement and
 * the caller was told the third node was fine. Membership is computed by
 * intersecting forward reachability with backward reachability, which cannot
 * miss a member by traversal order.
 *
 * Self-edges are excluded here: they are `SELF_DERIVED_EVIDENCE`, one defect one
 * code. A node with a self-edge *and* a real cycle earns both, because those are
 * two distinct defects rather than one told twice.
 */
function findCyclicNodeIndices(
  nodes: readonly EvidenceNode[],
  firstIndexById: ReadonlyMap<EvidenceNodeId, number>,
  blankIndices: ReadonlySet<number>,
): readonly number[] {
  const outgoing: number[][] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const edges: number[] = [];
    if (node.kind === 'derived' && !blankIndices.has(index)) {
      for (let edge = 0; edge < node.derivedFrom.length; edge += 1) {
        const parentId = node.derivedFrom[edge];
        if (parentId === node.nodeId) continue;
        const target = firstIndexById.get(parentId);
        if (target !== undefined) edges.push(target);
      }
    }
    outgoing.push(edges);
  }

  const incoming: number[][] = [];
  for (let index = 0; index < nodes.length; index += 1) incoming.push([]);
  for (let index = 0; index < outgoing.length; index += 1) {
    for (let edge = 0; edge < outgoing[index].length; edge += 1) {
      incoming[outgoing[index][edge]].push(index);
    }
  }

  const reach = (start: number, adjacency: readonly number[][]): Set<number> => {
    const seen = new Set<number>();
    const stack: number[] = adjacency[start].slice();
    while (stack.length > 0) {
      const next = stack.pop() as number;
      if (seen.has(next)) continue;
      seen.add(next);
      const onward = adjacency[next];
      for (let edge = 0; edge < onward.length; edge += 1) stack.push(onward[edge]);
    }
    return seen;
  };

  const cyclic: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    if (outgoing[index].length === 0) continue;
    const forward = reach(index, outgoing);
    if (!forward.has(index)) continue;
    const backward = reach(index, incoming);
    if (backward.has(index)) cyclic.push(index);
  }
  return cyclic;
}

/**
 * The observed nodes a claim ultimately rests on, or null when it rests on
 * nothing resolvable.
 *
 * This is the executable form of decision 1: for any graph `checkEvidenceGraph`
 * accepts, this returns a non-empty list for every node. Returning null rather
 * than throwing on an unresolvable or cyclic graph keeps the function usable as
 * the *assertion* in that property test — a version that threw would make the
 * property untestable except by catching, and a caught throw is indistinguishable
 * from a bug in the test.
 *
 * Roots come back in `graph.nodes` order, deduplicated, for determinism without
 * a string comparator (see `checkEvidenceGraph`).
 */
export function resolveEvidenceRoots(
  graph: EvidenceGraph,
  nodeId: EvidenceNodeId,
): readonly ObservedEvidence[] | null {
  const indexById = new Map<EvidenceNodeId, number>();
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const candidate = graph.nodes[index];
    if (!indexById.has(candidate.nodeId)) indexById.set(candidate.nodeId, index);
  }
  const start = indexById.get(nodeId);
  if (start === undefined) return null;

  const rootIndices = new Set<number>();
  const visiting = new Set<number>();
  const settled = new Set<number>();

  const walk = (index: number): boolean => {
    if (settled.has(index)) return true;
    if (visiting.has(index)) return false;
    visiting.add(index);
    const node = graph.nodes[index];
    if (node.kind === 'observed') {
      rootIndices.add(index);
    } else {
      for (let edge = 0; edge < node.derivedFrom.length; edge += 1) {
        const parent = indexById.get(node.derivedFrom[edge]);
        if (parent === undefined) return false;
        if (!walk(parent)) return false;
      }
    }
    visiting.delete(index);
    settled.add(index);
    return true;
  };

  if (!walk(start)) return null;

  const roots: ObservedEvidence[] = [];
  for (let index = 0; index < graph.nodes.length; index += 1) {
    if (rootIndices.has(index)) roots.push(graph.nodes[index] as ObservedEvidence);
  }
  return roots.length > 0 ? roots : null;
}

/* ── Whole-recommendation checking ───────────────────────────────── */

/**
 * Every evidence reference a recommendation makes outside the graph's own edges.
 *
 * Collected in one place so the checker cannot cover three of the four kinds of
 * reference and read as complete. The fourth — `Confidence.basis` — is the one a
 * hand-written checker forgets, because it is nested two levels down and the
 * other three are at the top of their objects.
 */
function collectExternalReferences(
  recommendation: Recommendation,
): readonly { readonly id: EvidenceNodeId; readonly optionIndex: number | null; readonly where: string }[] {
  const refs: { id: EvidenceNodeId; optionIndex: number | null; where: string }[] = [];

  const addReasonRefs = (
    reasons: readonly EvidenceBackedReason<RecommendationReasonCode>[],
    optionIndex: number | null,
    where: string,
  ): void => {
    for (let index = 0; index < reasons.length; index += 1) {
      const reason = reasons[index];
      for (let edge = 0; edge < reason.supportedBy.length; edge += 1) {
        refs.push({ id: reason.supportedBy[edge], optionIndex, where: `${where} #${index}` });
      }
    }
  };

  if (recommendation.outcome === 'withheld') {
    addReasonRefs(recommendation.reasons, null, 'withholding reason');
    return refs;
  }

  const options = offeredOptions(recommendation.options);
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    addReasonRefs(option.support, index, 'support reason');
    for (let edge = 0; edge < option.confidence.basis.length; edge += 1) {
      refs.push({ id: option.confidence.basis[edge], optionIndex: index, where: 'confidence basis' });
    }
  }
  const summary = summarizeOptionSet(recommendation.options);
  for (let index = 0; index < summary.excluded.length; index += 1) {
    addReasonRefs(summary.excluded[index].exclusion, null, `exclusion reason on excluded candidate #${index}`);
  }
  if (recommendation.options.kind === 'only_candidate') {
    const attested = recommendation.options.attested;
    for (let edge = 0; edge < attested.length; edge += 1) {
      refs.push({ id: attested[edge], optionIndex: null, where: 'only-candidate attestation' });
    }
  }
  return refs;
}

/**
 * The full structural check: the graph, plus every reference into it, plus the
 * offer's own invariants.
 *
 * Reports; never throws. This is what #34 runs before emitting and what #35 runs
 * before rendering — both, deliberately. A check run only by the producer is a
 * check the consumer trusts on the producer's word, and Sprint 05's rule is that
 * a check owned by the thing it checks is not a check.
 */
export function checkRecommendation(recommendation: Recommendation): readonly RecommendationDefect[] {
  const defects: RecommendationDefect[] = checkEvidenceGraph(recommendation.evidence).slice();

  const known = new Set<EvidenceNodeId>();
  for (let index = 0; index < recommendation.evidence.nodes.length; index += 1) {
    const node = recommendation.evidence.nodes[index];
    if (!isBlank(node.nodeId)) known.add(node.nodeId);
  }

  const refs = collectExternalReferences(recommendation);
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index];
    if (!known.has(ref.id)) {
      defects.push({
        code: 'UNKNOWN_EVIDENCE_NODE',
        nodeId: null,
        optionIndex: ref.optionIndex,
        detail: `${ref.where} names an evidence node that is not in this graph`,
      });
    }
  }

  if (recommendation.outcome === 'withheld') return defects;

  const options = offeredOptions(recommendation.options);
  if (options.length > RECOMMENDATION_OPTION_POLICY.maxOptions) {
    defects.push({
      code: 'OPTION_CAP_EXCEEDED',
      nodeId: null,
      optionIndex: null,
      detail: `${options.length} options offered against a cap of ${RECOMMENDATION_OPTION_POLICY.maxOptions}`,
    });
  }

  const firstPositionByAction = new Map<string, number>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option.optionIndex !== index) {
      defects.push({
        code: 'OPTION_INDEX_MISMATCH',
        nodeId: null,
        optionIndex: index,
        detail: `option at position #${index} states index ${option.optionIndex}`,
      });
    }
    const expectedBand = bandForConfidence(option.confidence.value);
    if (expectedBand === null) {
      defects.push({
        code: 'CONFIDENCE_OUT_OF_RANGE',
        nodeId: null,
        optionIndex: index,
        detail: `option #${index} carries a confidence outside the 0..1 range`,
      });
    } else if (expectedBand !== option.confidence.band) {
      defects.push({
        code: 'CONFIDENCE_BAND_MISMATCH',
        nodeId: null,
        optionIndex: index,
        detail: `option #${index} states a band its confidence value does not map to`,
      });
    }
    const key = actionKey(option.action);
    const first = firstPositionByAction.get(key);
    if (first === undefined) {
      firstPositionByAction.set(key, index);
    } else {
      defects.push({
        code: 'DUPLICATE_OPTION_ACTION',
        nodeId: null,
        optionIndex: index,
        detail: `option #${index} proposes the same action as option #${first}`,
      });
    }
  }

  const summary = summarizeOptionSet(recommendation.options);
  for (let index = 0; index < summary.excluded.length; index += 1) {
    const key = actionKey(summary.excluded[index].action);
    const offeredAt = firstPositionByAction.get(key);
    if (offeredAt !== undefined) {
      defects.push({
        code: 'EXCLUDED_OPTION_ALSO_OFFERED',
        nodeId: null,
        optionIndex: offeredAt,
        detail: `excluded candidate #${index} proposes the same action as offered option #${offeredAt}`,
      });
    }
  }

  return defects;
}

/* ── Staleness ───────────────────────────────────────────────────── */

/**
 * Why a recommendation is no longer offerable.
 *
 * - `EXPIRED`                 — `now >= validity.expiresAt`. Exclusive bound.
 * - `NOT_YET_VALID`           — `now < validity.basisAt`. A replay or a clock
 *                               defect. It is stale rather than fresh because
 *                               the alternative answers "yes, still good" to a
 *                               question about a time the run had not yet seen.
 * - `EXPIRY_NOT_AFTER_BASIS`  — `expiresAt <= basisAt`: the recommendation is
 *                               valid at no instant at all. Reported separately
 *                               from `EXPIRED` because "it aged out" and "it was
 *                               built broken" are different bugs, and reporting
 *                               the first for the second sends a reader looking
 *                               at TTL policy for a construction defect.
 * - `INVALID_INSTANT`         — a validity bound, or `now`, that does not parse.
 *                               Reported, not thrown, per
 *                               `RECOMMENDATION_INPUT_POLICY`.
 * - `SOURCE_CHANGED`          — an observed node's current fingerprint differs
 *                               from the one recorded. The state moved under the
 *                               recommendation. This is the invalidator that
 *                               matters; wall-clock expiry is the backstop.
 * - `SOURCE_REMOVED`          — the caller reports the source no longer exists
 *                               (`null` fingerprint).
 * - `SOURCE_UNVERIFIABLE`     — the caller supplied no entry for an observed
 *                               node. **Fails closed**, and this is the single
 *                               most important line in this section: the
 *                               opposite default makes the freshness check pass
 *                               most confidently exactly when the caller has
 *                               lost track of a source, and every test written
 *                               against a complete fingerprint map would still
 *                               pass. `undefined` is not `unchanged`.
 */
export type StalenessReasonCode =
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'EXPIRY_NOT_AFTER_BASIS'
  | 'INVALID_INSTANT'
  | 'SOURCE_CHANGED'
  | 'SOURCE_REMOVED'
  | 'SOURCE_UNVERIFIABLE';

export const STALENESS_REASON_CODES = Object.freeze([
  'EXPIRED',
  'NOT_YET_VALID',
  'EXPIRY_NOT_AFTER_BASIS',
  'INVALID_INSTANT',
  'SOURCE_CHANGED',
  'SOURCE_REMOVED',
  'SOURCE_UNVERIFIABLE',
] as const) satisfies readonly StalenessReasonCode[];

/**
 * `field` names which instant was malformed, by field name rather than by value:
 * echoing the offending string back would put unvalidated caller input into a
 * human-readable message, which is the leak `EvidenceBackedReason.detail`
 * forbids.
 */
export interface StalenessReason {
  readonly code: StalenessReasonCode;
  readonly nodeId: EvidenceNodeId | null;
  /** `'now' | 'basisAt' | 'expiresAt'` for `INVALID_INSTANT`, else null. */
  readonly field: 'now' | 'basisAt' | 'expiresAt' | null;
  readonly detail: string;
}

/**
 * What the caller must supply to ask whether a recommendation is still good.
 *
 * `now` is required and explicit. Nothing in this module reads a clock — see
 * `RECOMMENDATION_PERSISTENCE_POLICY.noAmbientClock` — because an expiry check
 * that reads the clock is untestable at the boundary and unreplayable in an
 * audit, and both are the point of having an expiry.
 *
 * `currentFingerprints` maps observed `nodeId` to the fingerprint the source
 * carries *now*, or `null` if the source is gone. A missing key is not "gone"
 * and not "unchanged" — it is unverifiable, and it fails closed. The map is
 * keyed by node id rather than by source because two nodes may observe different
 * fields of one record and change independently.
 */
export interface StalenessCheckInput {
  readonly recommendation: Recommendation;
  readonly now: Instant;
  readonly currentFingerprints: Readonly<Record<EvidenceNodeId, string | null>>;
}

export type StalenessVerdict =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly reasons: readonly [StalenessReason, ...StalenessReason[]] };

/**
 * Epoch millis for an instant, or null when it does not parse.
 *
 * Numeric comparison of parsed instants, never lexicographic comparison of the
 * strings. Lexicographic ordering of ISO-8601 is only sound for identically
 * formatted strings, and `2026-01-01T00:00:00Z` versus
 * `2026-01-01T00:00:00.000+00:00` denote the same instant while comparing
 * unequal — a recommendation would expire an arbitrary amount early or late
 * depending on which producer wrote the field.
 */
function instantToMillis(value: Instant): number | null {
  if (typeof value !== 'string' || isBlank(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Is this recommendation still offerable at `now`?
 *
 * Not fresh if there is **any** reason. There is no severity ordering and no
 * "soft" staleness: the acceptance criterion is that stale recommendations are
 * rejected, and a verdict a caller can weigh is a verdict a caller can overrule.
 *
 * **The ordering consequence, matching `PLANNING_INPUT_POLICY`:** the validity
 * window is judged before anything derived from it is computed, and the
 * fingerprint pass runs regardless of what the window pass found. The two borrow
 * nothing from each other — a malformed `expiresAt` says nothing about whether a
 * commitment was completed — so suppressing the second would hide a real
 * invalidation behind a formatting bug. What *is* suppressed is `EXPIRED` and
 * `NOT_YET_VALID` when the instants they compare did not parse, because those
 * findings borrow their bounds from the malformed field.
 *
 * Reasons come back in a fixed order — window findings first, then observed
 * nodes in `graph.nodes` order — so two callers checking the same recommendation
 * get byte-identical output. No string comparator is involved; see
 * `checkEvidenceGraph`.
 */
export function evaluateRecommendationStaleness(input: StalenessCheckInput): StalenessVerdict {
  const reasons: StalenessReason[] = [];
  const validity = input.recommendation.validity;

  const nowMillis = instantToMillis(input.now);
  const basisMillis = instantToMillis(validity.basisAt);
  const expiresMillis = instantToMillis(validity.expiresAt);

  if (nowMillis === null) {
    reasons.push({
      code: 'INVALID_INSTANT',
      nodeId: null,
      field: 'now',
      detail: 'the supplied evaluation instant does not parse',
    });
  }
  if (basisMillis === null) {
    reasons.push({
      code: 'INVALID_INSTANT',
      nodeId: null,
      field: 'basisAt',
      detail: 'the recommendation basis instant does not parse',
    });
  }
  if (expiresMillis === null) {
    reasons.push({
      code: 'INVALID_INSTANT',
      nodeId: null,
      field: 'expiresAt',
      detail: 'the recommendation expiry instant does not parse',
    });
  }

  if (basisMillis !== null && expiresMillis !== null && expiresMillis <= basisMillis) {
    reasons.push({
      code: 'EXPIRY_NOT_AFTER_BASIS',
      nodeId: null,
      field: null,
      detail: 'the validity window ends at or before it begins, so it is valid at no instant',
    });
  }

  if (nowMillis !== null && basisMillis !== null && nowMillis < basisMillis) {
    reasons.push({
      code: 'NOT_YET_VALID',
      nodeId: null,
      field: null,
      detail: 'the evaluation instant precedes the instant this recommendation was computed against',
    });
  }

  if (nowMillis !== null && expiresMillis !== null && nowMillis >= expiresMillis) {
    reasons.push({
      code: 'EXPIRED',
      nodeId: null,
      field: null,
      detail: 'the evaluation instant is at or after the exclusive expiry bound',
    });
  }

  const nodes = input.recommendation.evidence.nodes;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.kind !== 'observed') continue;
    if (!Object.prototype.hasOwnProperty.call(input.currentFingerprints, node.nodeId)) {
      reasons.push({
        code: 'SOURCE_UNVERIFIABLE',
        nodeId: node.nodeId,
        field: null,
        detail: `no current fingerprint was supplied for observed evidence node #${index}`,
      });
      continue;
    }
    const current = input.currentFingerprints[node.nodeId];
    if (current === null) {
      reasons.push({
        code: 'SOURCE_REMOVED',
        nodeId: node.nodeId,
        field: null,
        detail: `the source behind observed evidence node #${index} no longer exists`,
      });
      continue;
    }
    if (current !== node.valueFingerprint) {
      reasons.push({
        code: 'SOURCE_CHANGED',
        nodeId: node.nodeId,
        field: null,
        detail: `the source behind observed evidence node #${index} changed after it was read`,
      });
    }
  }

  if (reasons.length === 0) return { fresh: true };
  return { fresh: false, reasons: reasons as [StalenessReason, ...StalenessReason[]] };
}

/* ── User control: decisions ─────────────────────────────────────── */

/**
 * A ruling on one option.
 *
 * **Superset of the pilot's `NextStepDecisionContract`, by exactly one field,
 * and that field is the whole point.** The pilot carries
 * `{ proposalId, decision, editedTitle?, decidedAt }` and its `NextStepDecision`
 * is the same five verdicts. It has no way to say *which* option was accepted,
 * because its `NextStepRecommendationContract` has only a `primaryStep` — so
 * "the user chose the second suggestion" is not expressible on that wire format
 * at all. `optionIndex` is what makes alternatives actionable rather than
 * decorative: without it, offering three options and accepting one is
 * indistinguishable from offering one.
 *
 * There is deliberately no `choose_alternative` verdict. Accepting option #2
 * *is* choosing an alternative, and a separate verdict would create two spellings
 * of one user act — the aggregation over feedback events would then have to know
 * that `accept@2` and `choose_alternative@2` mean the same thing, and one of the
 * two readers would eventually not know it.
 *
 * `optionIndex` refers to the position in the offer, which is why
 * `OPTION_INDEX_MISMATCH` is a defect: a decision is targeted by index and an
 * index that has drifted retargets a user's accept onto a different action.
 */
export type RecommendationDecisionVerdict = 'accept' | 'edit' | 'defer' | 'dismiss' | 'done';

export interface RecommendationDecision {
  readonly version: typeof RECOMMENDATION_CONTRACT_VERSION;
  readonly recommendationId: string;
  /** Position in the offered list. Null only when dismissing the whole offer. */
  readonly optionIndex: number | null;
  readonly verdict: RecommendationDecisionVerdict;
  /** Present for `edit`: what the user wrote instead. */
  readonly editedTitle?: string;
  /** Supplied by the caller. This module never reads a clock. */
  readonly decidedAt: Instant;
}

/* ── Policy ──────────────────────────────────────────────────────── */

/**
 * How many options an offer may carry.
 *
 * `maxOptions` is 3 rather than unbounded because "here are eight things" is a
 * list, and the acceptance criterion about preserving user control is about a
 * choice a person can hold in their head — an unbounded list restores the
 * paralysis the product exists to remove. `minOptionsForChoice` is 2 by
 * definition and is stated as data so the `choice` variant's tuple arity and the
 * policy cannot drift apart.
 */
export const RECOMMENDATION_OPTION_POLICY = Object.freeze({
  maxOptions: 3,
  minOptionsForChoice: 2,
});

/**
 * The total order options are offered in.
 *
 * Data rather than code, for the reason `PLAN_ORDERING_KEYS` is: #34 produces
 * the order and #35 and the cross-track test check it, and a comparator living
 * inside the selector is a comparator only the selector can be wrong about.
 * Applied in sequence, each key breaking the previous key's ties.
 *
 * `-confidence` and `-priority` sort higher first. The final key is
 * `commitmentId`, which is unique among a scope's commitments, so the order is
 * total and no implementation detail — map iteration, input array order, sort
 * stability — can leak into it.
 *
 * **`commitmentId` is compared by code unit, never with `localeCompare`.** The
 * comparator to use is `compareByCodePoint` in `lib/planning/shared/compare.ts`;
 * it is named here rather than copied, because a contract must not import `lib/`
 * and a second copy of an ordering is a second copy of arithmetic. `localeCompare`
 * depends on the runtime's ICU data and default locale, so an offer's order — and
 * therefore every `optionIndex` a decision targets — would change with `LANG`.
 */
export const RECOMMENDATION_ORDERING_KEYS = Object.freeze([
  '-confidence',
  '-priority',
  'earliestDeadline',
  'commitmentId',
] as const);

/**
 * What a recommendation entry point may do with input it cannot use.
 *
 * The same rule `PLANNING_INPUT_POLICY` states, carried here rather than
 * imported so that a reader of this contract does not have to know Sprint 07's
 * to know the rule — and stated as its own value because the *extra* clause is
 * this module's own.
 *
 * `unverifiableSourceIsStale` is that clause. It is not a restatement of "report
 * what the taxonomy names": it decides which way an *absence* resolves, and the
 * comfortable direction is the wrong one. A freshness check that treats a
 * missing fingerprint as unchanged is a check that gets more confident as the
 * caller loses track of more sources.
 */
export const RECOMMENDATION_INPUT_POLICY = Object.freeze({
  reportWhatTheTaxonomyNames: true,
  throwOnlyWhenNoCodeApplies: true,
  digestAfterStaticPass: true,
  unverifiableSourceIsStale: true,
});

/**
 * The persistence boundary, on the same terms every intelligence module in this
 * repo has one.
 *
 * `NEXT_STEP_PRODUCT_POLICY` in `nextStepContracts` states the product-surface
 * form of several of these (`modelMayPersist: false`,
 * `confirmationRequiredBeforePersistence: true`, `maximumPrimarySteps: 1`).
 * Same concept at module scope, with two differences worth naming:
 *
 *   - `maximumPrimarySteps: 1` is a product decision about one screen.
 *     `RECOMMENDATION_OPTION_POLICY.maxOptions` is about how many alternatives
 *     the module may carry, which is a different number for a good reason: the
 *     pilot's single step is the lead option of an offer that still knows what
 *     it excluded.
 *   - The pilot's policy has no clock clause and no staleness clause, because
 *     the pilot recomputes on every request and never stores a proposal. This
 *     module's output is meant to be held — by #35's review surface, by an audit
 *     record — which is exactly why it needs an expiry at all.
 */
export const RECOMMENDATION_PERSISTENCE_POLICY = Object.freeze({
  /** A recommendation is a proposal. It is never canonical user state. */
  recommendationCanPersist: false,
  confirmationRequired: true,
  adapterOwnsCanonicalWrites: true,
  rawInputInAudit: false,
  /** Recommending never edits the commitment it is about. */
  originalCommitmentRemainsCanonical: true,
  /** Every instant comes from an explicit input; no `Date.now()`, ever. */
  noAmbientClock: true,
  /** Every claim resolves to an observation of trusted state. */
  everyClaimIsSourced: true,
  /** A stale recommendation is not offerable, and staleness fails closed. */
  staleRecommendationIsNotOfferable: true,
});
