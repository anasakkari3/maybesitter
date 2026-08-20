/**
 * Personalization contracts (Sprint 10, issue #41).
 *
 * A personalization profile answers one question — **how does this person
 * prefer to be spoken to and scheduled** — and answers it as a bounded, typed,
 * enumerable object derived from feedback aggregates. It is never learned from
 * raw text, never persisted, and never allowed to change hard behaviour below
 * a confidence floor. #42 builds the visibility/correction/export surface on
 * it; #43 compares it against a baseline; both read this file as the source of
 * what a profile can possibly contain.
 *
 * ── Relationship to runtime memory: two systems, one named seam ──────────
 *
 * `memoryContracts.RuntimeMemoryKind` includes `'preference'`, so the overlap
 * has to be examined rather than inherited. The decision: **two systems.**
 *
 *   - A runtime memory `preference` record is something the user *said*, in
 *     their own words: free-text `content`, stored, revocable, supersedable,
 *     exportable. The store is the system of record for statements.
 *   - A personalization profile is something the product *derived*: a closed
 *     vocabulary of dimensions and levels, recomputed from the feedback log on
 *     every read, persisted nowhere. It is a read model in exactly the sense
 *     `FeedbackAggregates` is — same non-revoked events, same profile.
 *
 * The seam between them is named, not ambient. Both honour revocation
 * upstream of themselves (the store via `revoke()`, the profile via
 * `aggregateFeedback` excluding events with `revokedAt`); both share the
 * export stance — `PERSONALIZATION_PERSISTENCE_POLICY.profileExportPolicy` is
 * `memoryContracts.ExportPolicy`'s `'personal_never_export'`, stated with a
 * `satisfies` so the two vocabularies cannot drift apart silently. And v1
 * deliberately does **not** read `user_stated` preference memories as a
 * derivation input: a free-text record entering the deriver would be raw
 * personal text entering the one pipeline this contract promises it never
 * enters. If a later sprint wants stated preferences to inform the profile,
 * it must add a typed rung to `PersonalizationDerivationInput`, where the
 * boundary test can see it — not an ambient store read.
 *
 * ── Five structural decisions ────────────────────────────────────────────
 *
 *  1. **Low confidence cannot reach hard behaviour, in the type.** A
 *     `PreferenceReading` is a three-variant verdict — `inconclusive`,
 *     `suggestion`, `operative` — and only `operative` may alter behaviour.
 *     `operative` requires a non-empty evidence tuple, so an operative
 *     preference without evidence is a compile error, not a number a consumer
 *     is trusted to check. `operativeReadings()` is the one read path for
 *     hard-behaviour consumers, and it returns `[]` for a disabled profile by
 *     construction. The untyped boundary (`JSON.parse`) is covered by
 *     `OPERATIVE_WITHOUT_EVIDENCE` / `OPERATIVE_BELOW_CONFIDENCE_FLOOR`,
 *     because a tuple type is a hole precisely there — the lesson
 *     `safetyContracts` records on `CandidateClaim.supportedBy`.
 *
 *  2. **The profile is total over a closed dimension vocabulary.** `readings`
 *     is a record keyed by `PreferenceDimension`, so every dimension appears
 *     exactly once, a dimension a UI cannot inventory cannot exist, and
 *     "we learned nothing about this yet" is a typed `inconclusive` reading
 *     rather than an absence. That totality is what makes #42's controls and
 *     #43's small-sample verdicts buildable: an absence renders as nothing,
 *     an `inconclusive` renders as a row saying why. The dimensions are
 *     derived from knobs consumers actually have — `pressureService`
 *     intensity and tone, `adaptiveService` suggestion style, `agendaService`
 *     item density — not from what a model might enjoy predicting.
 *
 *  3. **Decay is quantized to a window ladder, and that is a privacy design,
 *     not an approximation shortfall.** The deriver reads
 *     `FeedbackAggregates` — counts per outcome per window — and never the
 *     event rows. Recency weighting therefore comes from nested windows
 *     (`PERSONALIZATION_WINDOW_LADDER_DAYS`) with per-rung weights, instead of
 *     per-event exponential decay: an event in the newest window sits in all
 *     three rungs and weighs 4+2+1, one only in the oldest weighs 1. Finer
 *     decay would require per-event instants in the derivation input, and a
 *     per-event instant is the door response-latency walks through — the
 *     exact signal issue #107 forbids optimising on. The input's shape *is*
 *     the enforcement: latency is not representable in `OutcomeCounts`.
 *     Reproducibility rides on `FeedbackAggregates.inputDigest`
 *     (`computeFeedbackInputDigest`, Sprint 03), carried per rung in
 *     `PersonalizationBasis` rather than re-derived here — same non-revoked
 *     events, same digests, byte-identical profile, and `now` is always an
 *     explicit input because every instant in this file is.
 *
 *  4. **Consent is a variant, not a flag.** `PersonalizationProfile` is a
 *     discriminated union on `consent`, and the `disabled` variant has
 *     `readings: null` and `basis: null` — there is no field a consumer can
 *     read a preference off when consent is off, so "disable takes effect
 *     immediately" is a shape, not a discipline. The safe reading is the easy
 *     one: destructure the consent, get nothing otherwise.
 *     `PERSONALIZATION_CONSENT_POLICY` states the rest — the default state is
 *     `disabled` (personalization is opt-in for this cohort), an unreadable
 *     consent is a disabled consent, and no consumer may cache a profile past
 *     a consent check because the profile is never persisted to cache from.
 *     `DISABLED_PROFILE_NOT_INERT` covers the untyped boundary. Deletion is
 *     verifiable rather than promised: a `PersonalizationDeletionReceipt`
 *     carries remainder counts #42 can recount and a post-deletion digest #42
 *     can recompute — everything in the receipt is checkable against the
 *     store, which is what "verifiable" has to mean for a UI.
 *
 *  5. **The #107 constraint is carried in the vocabulary, not appended as a
 *     comment.** The shipped `adaptiveService` classifier maps avoidance
 *     signals to *more* pressure through unexamined thresholds; issue #107
 *     names the loop (pressure → anxiety → fast compliance → reward). This
 *     contract encodes the refusal three ways:
 *
 *       - Every `FeedbackOutcome` is classified `explicit_judgement`
 *         (accept/edit/reject/undo — the user judged a suggestion) or
 *         `behavioral_inference` (complete/defer/ignore — the user lived
 *         their life). Pressure-bearing dimensions admit **only** explicit
 *         evidence (`admissibleOutcomesFor`, `INADMISSIBLE_EVIDENCE_OUTCOME`).
 *         A deliberate skip is still classified behavioural: it is an act
 *         about the task, not a statement about how the product should speak,
 *         and reading it as one is precisely the inference #107 audits.
 *       - Escalation is asymmetric. Every level has an intrusiveness rank and
 *         every dimension a product baseline; a level above baseline demands
 *         at least one explicit-judgement evidence entry
 *         (`ESCALATION_WITHOUT_EXPLICIT_EVIDENCE`), while de-escalation is
 *         reachable from behaviour alone. Many ignores may make the product
 *         quieter; they can never make it louder.
 *       - What the types cannot carry is named data a test can enumerate:
 *         `PERSONALIZATION_INVARIANTS` and `FORBIDDEN_DERIVATION_SIGNALS`,
 *         including #43's release-gate rule — no gate may rest on engagement
 *         alone, because a signal that a user responded faster is not
 *         evidence that the product helped them.
 *
 *     The relation to the shipped classifier is **deliberately different,
 *     to be reconciled at integration**: `adaptiveService.getAdaptiveBehavior`
 *     escalates on behavioural inference and this contract forbids that
 *     derivation. This file does not import or modify `lib/services/**`; the
 *     #107 audit decides whether the classifier conforms to this contract or
 *     is retired, and this contract is written so that "conforms" is
 *     checkable.
 *
 * ── What is reused rather than rebuilt ───────────────────────────────────
 *
 *   - `Instant`, `isInstant`, `millisBetweenInstants` — Sprint 08/09's time
 *     judgement, imported via `safetyContracts` rather than re-spelled.
 *   - `PressureIntensityLevel` and its rank — the pressure-ceiling dimension
 *     speaks the same four spellings the safety gateway's `PressureBudget`
 *     enforces, so the ceiling can flow into `maxIntensity` without a
 *     translation table, which is where translations are wrong.
 *   - `FeedbackOutcome`, `FeedbackAggregates` — Sprint 03's shapes, imported;
 *     a second outcome vocabulary here would be two copies of one dataset.
 *   - The digest itself stays `lib/feedback`'s. This contract carries digest
 *     *values* as data and deliberately owns no hashing: a contract must not
 *     import `lib/`, and a second sha256 preimage spelling would drift.
 *
 * `moduleContracts` is imported for `MODULE_CONTRACT_VERSION` only, so the
 * chain is `personalization → safety → recommendation → moduleContracts` with
 * no reverse edge — the TDZ hazard recorded on the `decomposition` descriptor
 * is the reverse edge, and it is why the module descriptor (added at
 * integration, not here) must spell `'personalization-v1'` as a literal.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import {
  PRESSURE_INTENSITY_LEVELS,
  PRESSURE_INTENSITY_RANK,
  isInstant,
  millisBetweenInstants,
  type Instant,
  type PressureIntensityLevel,
} from './safetyContracts';
import type { ExportPolicy } from './memoryContracts';
import type { FeedbackAggregates, FeedbackOutcome } from './feedbackContracts';

export const PERSONALIZATION_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const PERSONALIZATION_SCHEMA_VERSION = 'personalization-v1' as const;

/**
 * Re-exported so a consumer of this contract does not have to know which
 * sprint built the time judgement or the pressure vocabulary in order to use a
 * profile. The pressure imports are *value* imports on purpose: the ceiling
 * dimension's vocabulary IS the safety gateway's list, one copy, and a
 * type-only edge would let this file quietly grow its own.
 */
export type { ExportPolicy, FeedbackAggregates, FeedbackOutcome, Instant, PressureIntensityLevel };
export { PRESSURE_INTENSITY_LEVELS, PRESSURE_INTENSITY_RANK, isInstant, millisBetweenInstants };

/* ── The dimension vocabulary ────────────────────────────────────── */

/**
 * Every dimension a profile can express, with its closed set of levels.
 *
 * Closed on both axes because a profile a UI cannot inventory is a profile
 * #42 cannot build controls for, and a free-text preference value is raw
 * personal text wearing a preference label. Each dimension is a knob a shipped
 * consumer can actually turn:
 *
 *   - `pressure_ceiling`      → `pressureService` intensity and the safety
 *                               gateway's `PressureBudget.maxIntensity`. Same
 *                               four spellings as `PressureIntensityLevel`,
 *                               imported rather than restated.
 *   - `pressure_tone`         → `pressureService.PressureTone`, same two
 *                               spellings (`soft`/`firm`), restated here
 *                               because a contract must not import `lib/` —
 *                               the duplication is named, and the contract
 *                               test pins the spellings so a divergence fails
 *                               rather than drifts.
 *   - `suggestion_directness` → `adaptiveService.AdaptiveSuggestionStyle`,
 *                               same three spellings. This is the knob the
 *                               #107 classifier sets today from behavioural
 *                               inference; putting it in this vocabulary is
 *                               what brings it under the escalation rule.
 *   - `reminder_density`      → `agendaService` item count (`maxItems`,
 *                               1..7). Levels are coarse on purpose: the
 *                               profile expresses a preference, the consumer
 *                               owns the mapping to a number.
 */
export type PreferenceLevelsByDimension = {
  readonly pressure_ceiling: PressureIntensityLevel;
  readonly pressure_tone: 'soft' | 'firm';
  readonly suggestion_directness: 'minimal' | 'supportive' | 'direct';
  readonly reminder_density: 'lean' | 'standard' | 'rich';
};

export type PreferenceDimension = keyof PreferenceLevelsByDimension;

export type PreferenceLevel<D extends PreferenceDimension = PreferenceDimension> =
  PreferenceLevelsByDimension[D];

export const PREFERENCE_DIMENSIONS = Object.freeze([
  'pressure_ceiling',
  'pressure_tone',
  'suggestion_directness',
  'reminder_density',
] as const) satisfies readonly PreferenceDimension[];

type _DimensionsCovered =
  Exclude<PreferenceDimension, (typeof PREFERENCE_DIMENSIONS)[number]> extends never ? true : never;
const _dimensionsAreExhaustive: _DimensionsCovered = true;
export const PREFERENCE_DIMENSION_COVERAGE = _dimensionsAreExhaustive;

/**
 * The level vocabulary per dimension, as one frozen value a test can
 * `deepEqual` and a UI can render a picker from. `pressure_ceiling` is the
 * imported safety list itself — one copy, per the header.
 */
export const PREFERENCE_LEVEL_VOCABULARY: {
  readonly [D in PreferenceDimension]: readonly PreferenceLevelsByDimension[D][];
} = Object.freeze({
  pressure_ceiling: PRESSURE_INTENSITY_LEVELS,
  pressure_tone: Object.freeze(['soft', 'firm'] as const),
  suggestion_directness: Object.freeze(['minimal', 'supportive', 'direct'] as const),
  reminder_density: Object.freeze(['lean', 'standard', 'rich'] as const),
});

/**
 * How much a level asks of the person, ascending. Exported as data so the
 * escalation judgement (`isEscalation`) is not re-derived by each consumer,
 * which is where two orderings of one scale would come from.
 * `pressure_ceiling` reuses `PRESSURE_INTENSITY_RANK` — same rationale as the
 * vocabulary above.
 */
export const PREFERENCE_LEVEL_INTRUSIVENESS: {
  readonly [D in PreferenceDimension]: Readonly<Record<PreferenceLevelsByDimension[D], number>>;
} = Object.freeze({
  pressure_ceiling: PRESSURE_INTENSITY_RANK,
  pressure_tone: Object.freeze({ soft: 0, firm: 1 }),
  suggestion_directness: Object.freeze({ minimal: 0, supportive: 1, direct: 2 }),
  reminder_density: Object.freeze({ lean: 0, standard: 1, rich: 2 }),
});

/**
 * What the product does when it knows nothing about this person.
 *
 * These are the shipped defaults for a user in good standing —
 * `adaptiveService.behaviorFor('disciplined')` is `low` pressure and
 * `minimal` style, `pressureService` opens `soft`, the agenda ships a
 * standard density — and they are the reference point for the escalation
 * rule: a level ranked **above** its baseline is an escalation and demands
 * explicit evidence; a level at or below is not. Stated as data so the
 * asymmetry is checkable rather than folkloric.
 */
export const PRODUCT_BASELINE_LEVELS: {
  readonly [D in PreferenceDimension]: PreferenceLevelsByDimension[D];
} = Object.freeze({
  pressure_ceiling: 'low',
  pressure_tone: 'soft',
  suggestion_directness: 'minimal',
  reminder_density: 'standard',
});

/**
 * Which dimensions are pressure-bearing.
 *
 * `pressure_bearing` covers every dimension that changes how hard or how
 * directly the product pushes — the ceiling, the tone, and the directness the
 * #107 classifier pairs with its pressure level. These admit only explicit
 * evidence. `presentation` covers layout-of-help dimensions (density), where
 * behaviour may legitimately inform the *quieter* direction.
 */
export type PreferenceDimensionClass = 'pressure_bearing' | 'presentation';

export const PREFERENCE_DIMENSION_CLASSES: Readonly<
  Record<PreferenceDimension, PreferenceDimensionClass>
> = Object.freeze({
  pressure_ceiling: 'pressure_bearing',
  pressure_tone: 'pressure_bearing',
  suggestion_directness: 'pressure_bearing',
  reminder_density: 'presentation',
});

/* ── Evidence classes: the #107 partition ────────────────────────── */

/**
 * The full outcome vocabulary this contract can cite as evidence — Sprint
 * 03's `FeedbackOutcome`, enumerated here as a value with a coverage check so
 * an eighth outcome added there fails to typecheck here until it is
 * classified. An unclassified outcome would be silently exempt from the
 * admissibility rule, which is the ideal place for a compliance signal to
 * hide.
 */
export const PERSONALIZATION_EVIDENCE_OUTCOMES = Object.freeze([
  'accept',
  'edit',
  'reject',
  'defer',
  'complete',
  'ignore',
  'undo',
] as const) satisfies readonly FeedbackOutcome[];

type _OutcomesCovered =
  Exclude<FeedbackOutcome, (typeof PERSONALIZATION_EVIDENCE_OUTCOMES)[number]> extends never
    ? true
    : never;
const _outcomesAreExhaustive: _OutcomesCovered = true;
export const PERSONALIZATION_EVIDENCE_OUTCOME_COVERAGE = _outcomesAreExhaustive;

/**
 * `explicit_judgement` — the user judged a *suggestion*: accepted it, edited
 * it, rejected it, undid it. These are statements about how the product
 * behaved, and they are the only admissible ground for turning anything up.
 *
 * `behavioral_inference` — the user lived their life: completed, deferred,
 * ignored. `defer` and `ignore` are classified behavioural even where the
 * product records them from a deliberate tap (`postpone`/`skip` dual-write),
 * because they are acts about the *task*, not about how the product should
 * speak — reading a skipped errand as "push me harder" is the precise
 * inference #107 exists to forbid. `complete` is behavioural for the same
 * reason in the other direction: compliance is not a preference statement,
 * and a vocabulary that rewards it optimises for compliance.
 */
export type FeedbackOutcomeClass = 'explicit_judgement' | 'behavioral_inference';

export const FEEDBACK_OUTCOME_CLASSES: Readonly<Record<FeedbackOutcome, FeedbackOutcomeClass>> =
  Object.freeze({
    accept: 'explicit_judgement',
    edit: 'explicit_judgement',
    reject: 'explicit_judgement',
    undo: 'explicit_judgement',
    defer: 'behavioral_inference',
    complete: 'behavioral_inference',
    ignore: 'behavioral_inference',
  });

/** Derived from the class table, never listed twice. */
export const EXPLICIT_JUDGEMENT_OUTCOMES = Object.freeze(
  PERSONALIZATION_EVIDENCE_OUTCOMES.filter(
    (outcome) => FEEDBACK_OUTCOME_CLASSES[outcome] === 'explicit_judgement',
  ),
);

export const BEHAVIORAL_INFERENCE_OUTCOMES = Object.freeze(
  PERSONALIZATION_EVIDENCE_OUTCOMES.filter(
    (outcome) => FEEDBACK_OUTCOME_CLASSES[outcome] === 'behavioral_inference',
  ),
);

/**
 * Which outcomes may support a reading on this dimension.
 *
 * Pressure-bearing dimensions admit explicit judgements only; presentation
 * dimensions admit everything (the escalation rule still applies on top — a
 * `rich` density needs an explicit judgement somewhere in its evidence).
 * Derived from the two class tables so the rule cannot be stated a second
 * time differently.
 */
export function admissibleOutcomesFor(dimension: PreferenceDimension): readonly FeedbackOutcome[] {
  return PREFERENCE_DIMENSION_CLASSES[dimension] === 'pressure_bearing'
    ? EXPLICIT_JUDGEMENT_OUTCOMES
    : PERSONALIZATION_EVIDENCE_OUTCOMES;
}

/**
 * Is this level an escalation above the product baseline for its dimension?
 *
 * Null rather than false at the untyped boundary: an unknown dimension or
 * level supports no claim in either direction, and `false` would read as
 * "not an escalation", which is the permissive answer. The checker reports
 * `LEVEL_NOT_IN_VOCABULARY` for that case; this function only refuses to
 * guess.
 */
export function isEscalation(dimension: PreferenceDimension, level: string): boolean | null {
  const ranks = PREFERENCE_LEVEL_INTRUSIVENESS[dimension] as
    | Readonly<Record<string, number>>
    | undefined;
  if (ranks === undefined) return null;
  const rank = ranks[level];
  if (typeof rank !== 'number') return null;
  return rank > ranks[PRODUCT_BASELINE_LEVELS[dimension]];
}

/* ── Decay: the window ladder ────────────────────────────────────── */

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The nested windows a profile is derived over, in days, newest first.
 *
 * The innermost rung is deliberately `DEFAULT_FEEDBACK_WINDOW_DAYS` (14): the
 * two describe the same span of the same user's recent behaviour, and a
 * reader comparing them should see one number. Each rung is 4× the previous,
 * so three rungs reach roughly seven months and the oldest rung *is* the
 * evidence horizon — behaviour older than it contributes nothing, which is
 * the decay-to-zero the acceptance criterion asks for.
 */
export const PERSONALIZATION_WINDOW_LADDER_DAYS = Object.freeze([14, 56, 224] as const);

/**
 * Per-rung weights, positionally aligned with the ladder.
 *
 * The windows are nested, so an event occurring in the last 14 days is
 * counted by all three rungs and carries effective weight 4+2+1 = 7; one
 * older than 56 days appears only in the outermost rung and carries 1. The
 * halving per rung approximates an exponential decay with a half-life of
 * about one rung — quantized, and quantized on purpose: computing a smooth
 * decay would need per-event instants in the derivation input, and per-event
 * instants are how response-latency signals would enter it (see decision 3 in
 * the header). `now` and the window instants are explicit inputs; nothing in
 * this file reads a clock.
 */
export const PERSONALIZATION_RUNG_WEIGHTS = Object.freeze([4, 2, 1] as const);

/** Derived from the ladder, never stated twice. */
export const PERSONALIZATION_EVIDENCE_HORIZON_DAYS: number =
  PERSONALIZATION_WINDOW_LADDER_DAYS[PERSONALIZATION_WINDOW_LADDER_DAYS.length - 1];

/* ── Floors and limits ───────────────────────────────────────────── */

/**
 * The confidence below which a reading may not be `operative`.
 *
 * Deliberately this contract's own number, **not**
 * `CONFIDENCE_BAND_THRESHOLDS.high` from `recommendationContracts`, though the
 * values are near each other today. That threshold is a *display* decision —
 * where the UI draws the "high" band — and this one is a *behaviour* decision:
 * the point at which the product may treat an inference about a person as
 * settled enough to act on. Coupling them would let a UI retune quietly move
 * the hard-behaviour floor, which is the wrong thing to inherit by accident.
 * `OPERATIVE_BELOW_CONFIDENCE_FLOOR` makes the floor reachable by a test.
 */
export const OPERATIVE_CONFIDENCE_FLOOR = 0.7;

/**
 * The smallest evidence base an `operative` reading may rest on, counted in
 * contributing events. Five is small on purpose — the point is not
 * statistical power, it is that a single tap can never flip hard behaviour.
 * #43's small-sample rule starts here: below this, the strongest legal claim
 * is a suggestion. `OPERATIVE_BELOW_SAMPLE_FLOOR` reaches it.
 */
export const MIN_OPERATIVE_SAMPLE_EVENTS = 5;

/**
 * Below this, not even a suggestion: the reading must be `inconclusive` with
 * `insufficient_sample`. One event is an anecdote, and a suggestion surfaced
 * from an anecdote teaches the user that the product jumps to conclusions.
 * `SUGGESTION_BELOW_SAMPLE_FLOOR` reaches it.
 */
export const MIN_SUGGESTION_SAMPLE_EVENTS = 2;

/**
 * Structural bounds, one frozen object on the `SAFETY_LIMITS` pattern: the
 * name is derived from the keys, the finding carries the key, and the
 * contract test iterates the keys and demands a finding for each — a limit no
 * test can name is documentation of an intention.
 *
 * `maxEvidencePerPreference` is generous by construction: three rungs times
 * seven outcomes is 21 legitimate entries, so 32 stops only a pathological
 * producer from turning the checker quadratic, and expresses no opinion about
 * how much evidence is persuasive.
 */
export const PERSONALIZATION_LIMITS = Object.freeze({
  maxEvidencePerPreference: 32,
});

export type PersonalizationLimitName = keyof typeof PERSONALIZATION_LIMITS;

export const PERSONALIZATION_LIMIT_NAMES = Object.freeze(
  Object.keys(PERSONALIZATION_LIMITS) as PersonalizationLimitName[],
);

/* ── Consent ─────────────────────────────────────────────────────── */

export type PersonalizationConsentState = 'enabled' | 'disabled';

export const PERSONALIZATION_CONSENT_STATES = Object.freeze([
  'enabled',
  'disabled',
] as const) satisfies readonly PersonalizationConsentState[];

/**
 * The consent record the deriver takes as input.
 *
 * Two states, no third: "paused", "partial" and friends are how a consent
 * surface becomes inert (#96's removed controls are the recorded cost).
 * `changedAt` is required-and-nullable — null means never explicitly set,
 * which resolves to the default state, which is `disabled`: personalization
 * for this cohort is opt-in, and the product earns the profile rather than
 * assumes it.
 */
export interface PersonalizationConsent {
  readonly state: PersonalizationConsentState;
  readonly changedAt: Instant | null;
}

/* ── Readings: the three-variant verdict ─────────────────────────── */

export type PreferenceStatus = 'inconclusive' | 'suggestion' | 'operative';

export const PREFERENCE_STATUSES = Object.freeze([
  'inconclusive',
  'suggestion',
  'operative',
] as const) satisfies readonly PreferenceStatus[];

/**
 * Why a dimension is inconclusive. Closed, because #43 renders these and a
 * free string would make "why can't you tell" a sentence the deriver
 * improvises per call.
 *
 * - `insufficient_sample`    — fewer contributing events than
 *                              `MIN_SUGGESTION_SAMPLE_EVENTS`.
 * - `conflicting_evidence`   — the evidence pulls to different levels without
 *                              a stable majority.
 * - `no_admissible_evidence` — evidence exists but none of it is admissible
 *                              for this dimension: the pressure-bearing case
 *                              where the window holds only behavioural
 *                              outcomes. Named separately from
 *                              `insufficient_sample` because "we saw nothing"
 *                              and "we saw plenty and are not allowed to use
 *                              it" are different answers, and #43's baseline
 *                              comparison needs to distinguish them.
 */
export type InconclusiveReason =
  | 'insufficient_sample'
  | 'conflicting_evidence'
  | 'no_admissible_evidence';

export const INCONCLUSIVE_REASONS = Object.freeze([
  'insufficient_sample',
  'conflicting_evidence',
  'no_admissible_evidence',
] as const) satisfies readonly InconclusiveReason[];

/**
 * One evidence entry: a windowed count read off one basis rung.
 *
 * `rungIndex` is a **position** into `PersonalizationBasis.rungs`, never a
 * digest or an id — the locator rule `safetyContracts` states: an index
 * cannot carry content. `outcome` is closed vocabulary and `count` is a
 * number, so no field of an evidence entry can hold raw personal text, which
 * is the acceptance criterion "no raw personal text is fine-tuned" made
 * structural at the evidence level.
 */
export interface PreferenceEvidence {
  readonly rungIndex: number;
  readonly outcome: FeedbackOutcome;
  readonly count: number;
}

/**
 * The three variants. Fields are required-and-nullable rather than optional
 * throughout: a producer that forgets `reason` or `level` must be told by the
 * compiler, not defaulted into meaning something.
 *
 * `inconclusive` carries `level: null` and `confidence: null` *in the type*,
 * so an inconclusive dimension cannot leak a level into any consumer — there
 * is nothing to read.
 */
export interface InconclusiveReading<D extends PreferenceDimension = PreferenceDimension> {
  readonly status: 'inconclusive';
  readonly dimension: D;
  readonly reason: InconclusiveReason;
  readonly level: null;
  readonly confidence: null;
  readonly sampleEventCount: number;
  readonly evidence: readonly PreferenceEvidence[];
}

/**
 * A suggestion may inform soft surfaces — phrasing offered for confirmation,
 * a #42 correction prompt — and nothing else. It is the strongest claim
 * derivable below the operative floors, and it exists as its own variant so
 * "not confident enough" is a *shape* a hard-behaviour consumer cannot
 * receive, rather than a number it is trusted to compare.
 */
export interface SuggestionReading<D extends PreferenceDimension = PreferenceDimension> {
  readonly status: 'suggestion';
  readonly dimension: D;
  readonly reason: null;
  readonly level: PreferenceLevelsByDimension[D];
  /** 0..1 inclusive. Below `OPERATIVE_CONFIDENCE_FLOOR` by definition of the variant. */
  readonly confidence: number;
  readonly sampleEventCount: number;
  readonly evidence: readonly PreferenceEvidence[];
}

/**
 * The only variant that may alter hard behaviour, and the type forbids it
 * arriving bare: `evidence` is a non-empty tuple, so `operative` without
 * evidence does not compile. This is a producer contract, so the tuple is the
 * right tool here — the untyped boundary is covered by
 * `OPERATIVE_WITHOUT_EVIDENCE`, per the `safetyContracts` note on where
 * tuples are and are not holes.
 */
export interface OperativeReading<D extends PreferenceDimension = PreferenceDimension> {
  readonly status: 'operative';
  readonly dimension: D;
  readonly reason: null;
  readonly level: PreferenceLevelsByDimension[D];
  /** 0..1 inclusive; `>= OPERATIVE_CONFIDENCE_FLOOR`, checker-enforced at the boundary. */
  readonly confidence: number;
  /** `>= MIN_OPERATIVE_SAMPLE_EVENTS`, checker-enforced at the boundary. */
  readonly sampleEventCount: number;
  readonly evidence: readonly [PreferenceEvidence, ...PreferenceEvidence[]];
}

export type PreferenceReading<D extends PreferenceDimension = PreferenceDimension> =
  | InconclusiveReading<D>
  | SuggestionReading<D>
  | OperativeReading<D>;

/**
 * Total over the dimension vocabulary — see decision 2 in the header. A
 * mapped type rather than an array, so a dimension cannot appear twice and
 * cannot be absent, and each key carries its own level vocabulary.
 */
export type PreferenceReadings = {
  readonly [D in PreferenceDimension]: PreferenceReading<D>;
};

/* ── The basis: reproducibility as data ──────────────────────────── */

/**
 * One rung of the derivation basis: which window, and the digest of exactly
 * what was aggregated over it.
 *
 * `inputDigest` is `FeedbackAggregates.inputDigest` for this rung, carried
 * rather than re-derived — the preimage spelling belongs to
 * `lib/feedback/feedbackAggregation.ts` and exists once. Same non-revoked
 * events ⇒ same digests ⇒ byte-identical profile; a replay proves it by
 * recomputing the aggregates and comparing rung digests, which is the
 * "reproducible from non-revoked events" criterion with a mechanism attached.
 *
 * `revokedCount` is carried per rung so the profile states what it *excluded*
 * as well as what it read: #42's surface can show "3 corrections honoured"
 * without touching the event log.
 */
export interface PersonalizationBasisRung {
  readonly windowDays: number;
  readonly windowStart: Instant;
  readonly inputDigest: string;
  readonly revokedCount: number;
}

/**
 * The full basis. `rungs` must match `PERSONALIZATION_WINDOW_LADDER_DAYS`
 * exactly, in order — `WINDOW_LADDER_MISMATCH` reports a profile derived over
 * windows this schema version does not define, because a profile whose decay
 * schedule is private to its producer is not reproducible by anyone else.
 */
export interface PersonalizationBasis {
  readonly scopeId: string;
  readonly rungs: readonly PersonalizationBasisRung[];
}

/* ── The profile ─────────────────────────────────────────────────── */

/**
 * The enabled variant: consent on, readings total, basis present.
 * `derivedAt` is the caller's `now` — every rung aggregate was computed at
 * this same instant, and `RUNG_WINDOW_INCOHERENT` checks the arithmetic
 * (`windowStart + windowDays·day = derivedAt`) so a basis assembled from
 * mismatched aggregations cannot claim coherence.
 */
export interface EnabledPersonalizationProfile {
  readonly version: typeof PERSONALIZATION_CONTRACT_VERSION;
  readonly schemaVersion: typeof PERSONALIZATION_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly consent: 'enabled';
  /** From the derivation input. This module never reads a clock. */
  readonly derivedAt: Instant;
  readonly basis: PersonalizationBasis;
  readonly readings: PreferenceReadings;
}

/**
 * The disabled variant is *inert by shape*: `readings` and `basis` are null,
 * so there is no preference to read and no evidence to inspect. "Disable
 * takes effect immediately" is this type plus
 * `PERSONALIZATION_PERSISTENCE_POLICY.profileCanPersist: false` — with no
 * stored profile anywhere, the next read after a consent flip *is* the flip.
 */
export interface InertPersonalizationProfile {
  readonly version: typeof PERSONALIZATION_CONTRACT_VERSION;
  readonly schemaVersion: typeof PERSONALIZATION_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly consent: 'disabled';
  readonly derivedAt: Instant;
  readonly basis: null;
  readonly readings: null;
}

export type PersonalizationProfile = EnabledPersonalizationProfile | InertPersonalizationProfile;

/**
 * The inert profile for a scope: what the deriver returns whenever consent is
 * not affirmatively `enabled`, and the baseline arm #43 compares against —
 * the "no personalization" condition is a value, not an absence, so the
 * comparison has two concrete sides.
 *
 * Pure and deterministic: same arguments, byte-identical result.
 */
export function inertPersonalizationProfile(
  scopeId: string,
  derivedAt: Instant,
): InertPersonalizationProfile {
  return {
    version: PERSONALIZATION_CONTRACT_VERSION,
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    scopeId,
    consent: 'disabled',
    derivedAt,
    basis: null,
    readings: null,
  };
}

/**
 * The one read path for hard-behaviour consumers.
 *
 * Returns only `operative` readings, in `PREFERENCE_DIMENSIONS` order, and
 * returns `[]` for an inert profile, an unreadable profile, or a profile
 * whose consent is anything but `'enabled'` — the fail-closed direction at
 * the untyped boundary. It selects by shape and does not judge validity;
 * pairing it with `checkPersonalizationProfile` is the integration gateway's
 * job, stated here so no consumer assumes this function did it.
 */
export function operativeReadings(
  profile: PersonalizationProfile,
): readonly OperativeReading[] {
  if (profile === null || profile === undefined || typeof profile !== 'object') return [];
  if ((profile as { consent?: unknown }).consent !== 'enabled') return [];
  const readings = (profile as { readings?: unknown }).readings;
  if (readings === null || readings === undefined || typeof readings !== 'object') return [];
  const found: OperativeReading[] = [];
  for (const dimension of PREFERENCE_DIMENSIONS) {
    const reading = (readings as Record<string, { status?: unknown }>)[dimension];
    if (reading !== null && reading !== undefined && reading.status === 'operative') {
      found.push(reading as OperativeReading);
    }
  }
  return found;
}

/* ── The derivation seam ─────────────────────────────────────────── */

/**
 * Everything the deriver may read, and therefore everything it can possibly
 * optimise on.
 *
 * `rungAggregates` carries one `FeedbackAggregates` per ladder rung — counts
 * per outcome per window, revoked events already excluded by Sprint 03's
 * aggregation. There is no events field, no latency field, no session field:
 * the #107 rule "no derivation input may carry response-latency or
 * compliance-timing signals" is enforced by this type having nowhere to put
 * one. A future field added here is a review event, and
 * `FORBIDDEN_DERIVATION_SIGNALS` is the list the reviewer holds it against.
 *
 * `now` is the only instant the deriver has; each rung aggregate's
 * `computedAt` must equal it. Consent travels in the input so the deriver
 * cannot be called "around" it — a disabled consent yields
 * `inertPersonalizationProfile(scopeId, now)` and nothing else.
 */
export interface PersonalizationDerivationInput {
  readonly scopeId: string;
  readonly now: Instant;
  readonly consent: PersonalizationConsent;
  /** One per `PERSONALIZATION_WINDOW_LADDER_DAYS` member, in ladder order. */
  readonly rungAggregates: readonly FeedbackAggregates[];
}

/**
 * The deriver's shape, named so #42 and #43 can depend on the seam before the
 * implementation phase fills it. Pure: same input, byte-identical profile.
 */
export type PersonalizationDeriver = (
  input: PersonalizationDerivationInput,
) => PersonalizationProfile;

/* ── Deletion receipt ────────────────────────────────────────────── */

/**
 * Proof of deletion for one scope, in terms #42 can verify rather than
 * relay.
 *
 * Every field is recomputable from the post-deletion stores: the three
 * remainder counts are recounts (feedback events for the scope, runtime
 * memory records in the scope, persisted profiles — always zero, and the
 * field exists so the receipt *proves* the never-persisted claim instead of
 * asserting it), and `emptyStateDigest` is `computeFeedbackInputDigest` over
 * the post-deletion input `{ events: [], baseline: null, scopeId,
 * now: deletedAt, windowDays: PERSONALIZATION_EVIDENCE_HORIZON_DAYS }` — a
 * verifier recomputes it against the live store and a mismatch means events
 * still exist. A receipt whose contents cannot be recomputed is a promise;
 * this one is a check.
 */
export interface PersonalizationDeletionReceipt {
  readonly version: typeof PERSONALIZATION_CONTRACT_VERSION;
  readonly schemaVersion: typeof PERSONALIZATION_SCHEMA_VERSION;
  readonly scopeId: string;
  /** From the caller. This module never reads a clock. */
  readonly deletedAt: Instant;
  readonly remainingFeedbackEventCount: number;
  readonly remainingRuntimeMemoryRecordCount: number;
  readonly remainingPersistedProfileCount: number;
  readonly emptyStateDigest: string;
}

/* ── Defect taxonomy ─────────────────────────────────────────────── */

/**
 * What can be structurally wrong with a profile. Partitioned from the receipt
 * codes because the two are owned by different producers — the deriver writes
 * profiles, the store writes receipts — and one flat list lets a checker
 * report the wrong owner (the `planningContracts` static/attempt rule).
 *
 * - `PROFILE_UNREADABLE`          — not a profile-shaped object at all.
 * - `SCOPE_BLANK`                 — no scope to attribute the profile to.
 * - `DERIVED_AT_INVALID`          — `derivedAt` is not an `Instant`.
 * - `CONSENT_UNKNOWN`             — a consent state this version does not
 *                                   recognise. Per-variant checks are
 *                                   suppressed after it: each would be a
 *                                   claim about a shape the profile does not
 *                                   have. Consumers treat it as disabled —
 *                                   fail-closed.
 * - `DISABLED_PROFILE_NOT_INERT`  — consent `disabled` with readings or basis
 *                                   present. The untyped-boundary half of
 *                                   "disable takes effect immediately".
 * - `ENABLED_PROFILE_NOT_DERIVED` — consent `enabled` with readings or basis
 *                                   missing.
 * - `MISSING_DIMENSION`           — the readings record is not total.
 * - `UNKNOWN_DIMENSION`           — a readings key outside the vocabulary.
 *                                   Reported, not ignored: every pass below
 *                                   iterates the known dimensions, so an
 *                                   unknown key is otherwise exempt from all
 *                                   of them.
 * - `READING_DIMENSION_MISMATCH`  — a reading whose `dimension` disagrees
 *                                   with the key it sits under.
 * - `STATUS_UNKNOWN`              — a reading status this version does not
 *                                   recognise; per-status checks suppressed.
 * - `INCONCLUSIVE_REASON_UNKNOWN` — an inconclusive reading with a reason
 *                                   outside the vocabulary.
 * - `INCONCLUSIVE_NOT_LEVEL_FREE` — an inconclusive reading carrying a level
 *                                   or confidence. The quiet failure: the
 *                                   deriver decided and labelled it undecided.
 * - `LEVEL_NOT_IN_VOCABULARY`     — a level outside its dimension's closed
 *                                   set. Free-text preference values are this
 *                                   code.
 * - `CONFIDENCE_OUT_OF_RANGE`     — confidence not a finite number in 0..1.
 *                                   The floor check is suppressed after it: a
 *                                   comparison against an unusable number
 *                                   reports a fact about the number.
 * - `SAMPLE_COUNT_INVALID`        — `sampleEventCount` not a non-negative
 *                                   integer; both sample floors suppressed.
 * - `SUGGESTION_BELOW_SAMPLE_FLOOR`
 *                                 — a suggestion resting on fewer events than
 *                                   `MIN_SUGGESTION_SAMPLE_EVENTS`.
 * - `OPERATIVE_WITHOUT_EVIDENCE`  — the tuple's untyped-boundary twin.
 * - `OPERATIVE_BELOW_CONFIDENCE_FLOOR`
 *                                 — operative below
 *                                   `OPERATIVE_CONFIDENCE_FLOOR`. The
 *                                   acceptance criterion "low-confidence
 *                                   preferences do not change hard behaviour"
 *                                   at the boundary the types cannot guard.
 * - `OPERATIVE_BELOW_SAMPLE_FLOOR`
 *                                 — operative resting on fewer events than
 *                                   `MIN_OPERATIVE_SAMPLE_EVENTS`.
 * - `EVIDENCE_EXCEEDS_LIMIT`      — more evidence entries than
 *                                   `PERSONALIZATION_LIMITS` allows; carries
 *                                   the key it broke.
 * - `EVIDENCE_RUNG_OUT_OF_RANGE`  — an evidence entry naming a rung position
 *                                   the basis does not have. Suppressed when
 *                                   the basis itself is missing, because the
 *                                   bound it borrows is the thing already
 *                                   reported.
 * - `EVIDENCE_COUNT_NOT_POSITIVE` — an evidence count that is not a positive
 *                                   integer. Zero is not evidence; it is the
 *                                   absence being dressed as some.
 * - `UNKNOWN_EVIDENCE_OUTCOME`    — an outcome this version does not know, or
 *                                   an entry that is not evidence-shaped.
 * - `INADMISSIBLE_EVIDENCE_OUTCOME`
 *                                 — a behavioural outcome cited on a
 *                                   pressure-bearing dimension. The #107 rule
 *                                   "pressure derives from explicit feedback
 *                                   only", as a reportable event.
 * - `ESCALATION_WITHOUT_EXPLICIT_EVIDENCE`
 *                                 — a level above the product baseline with no
 *                                   explicit-judgement evidence anywhere
 *                                   behind it. The asymmetry: behaviour may
 *                                   quiet the product, never sharpen it.
 * - `BASIS_SCOPE_MISMATCH`        — the basis names a different scope than
 *                                   the profile.
 * - `WINDOW_LADDER_MISMATCH`      — the basis rungs do not match
 *                                   `PERSONALIZATION_WINDOW_LADDER_DAYS`
 *                                   exactly, in order.
 * - `BASIS_DIGEST_MISSING`        — a blank rung digest. Blank digests
 *                                   compare equal, so a replay over them can
 *                                   never show two profiles read different
 *                                   events — the `AUDIT_DIGEST_MISSING` /
 *                                   `EMPTY_FINGERPRINT` defect, here.
 * - `RUNG_WINDOW_INCOHERENT`      — `windowStart + windowDays·day` is not
 *                                   `derivedAt`: the rung was not aggregated
 *                                   at this profile's instant, so the basis
 *                                   describes a different derivation than the
 *                                   one it is attached to. Suppressed when
 *                                   `derivedAt` is invalid, whose bound it
 *                                   borrows.
 */
export type PersonalizationProfileDefectCode =
  | 'PROFILE_UNREADABLE'
  | 'SCOPE_BLANK'
  | 'DERIVED_AT_INVALID'
  | 'CONSENT_UNKNOWN'
  | 'DISABLED_PROFILE_NOT_INERT'
  | 'ENABLED_PROFILE_NOT_DERIVED'
  | 'MISSING_DIMENSION'
  | 'UNKNOWN_DIMENSION'
  | 'READING_DIMENSION_MISMATCH'
  | 'STATUS_UNKNOWN'
  | 'INCONCLUSIVE_REASON_UNKNOWN'
  | 'INCONCLUSIVE_NOT_LEVEL_FREE'
  | 'LEVEL_NOT_IN_VOCABULARY'
  | 'CONFIDENCE_OUT_OF_RANGE'
  | 'SAMPLE_COUNT_INVALID'
  | 'SUGGESTION_BELOW_SAMPLE_FLOOR'
  | 'OPERATIVE_WITHOUT_EVIDENCE'
  | 'OPERATIVE_BELOW_CONFIDENCE_FLOOR'
  | 'OPERATIVE_BELOW_SAMPLE_FLOOR'
  | 'EVIDENCE_EXCEEDS_LIMIT'
  | 'EVIDENCE_RUNG_OUT_OF_RANGE'
  | 'EVIDENCE_COUNT_NOT_POSITIVE'
  | 'UNKNOWN_EVIDENCE_OUTCOME'
  | 'INADMISSIBLE_EVIDENCE_OUTCOME'
  | 'ESCALATION_WITHOUT_EXPLICIT_EVIDENCE'
  | 'BASIS_SCOPE_MISMATCH'
  | 'WINDOW_LADDER_MISMATCH'
  | 'BASIS_DIGEST_MISSING'
  | 'RUNG_WINDOW_INCOHERENT';

/**
 * What can be structurally wrong with a deletion receipt.
 *
 * - `RECEIPT_UNREADABLE`          — not a receipt-shaped object.
 * - `RECEIPT_SCOPE_BLANK`         — no scope: a receipt for nothing proves
 *                                   nothing.
 * - `RECEIPT_INSTANT_INVALID`     — `deletedAt` is not an `Instant`.
 * - `RECEIPT_REMAINDER_NOT_A_COUNT`
 *                                 — a remainder that is not a non-negative
 *                                   integer. Reported separately from
 *                                   non-zero because `NaN > 0` is `false` —
 *                                   an unreadable remainder would otherwise
 *                                   *pass* the deletion check, which is the
 *                                   fail-open this taxonomy exists to close.
 * - `RECEIPT_REMAINDER_NOT_ZERO`  — something remains; the deletion is not
 *                                   what the receipt claims.
 * - `RECEIPT_DIGEST_MISSING`      — a blank empty-state digest; nothing for a
 *                                   verifier to recompute against.
 */
export type PersonalizationReceiptDefectCode =
  | 'RECEIPT_UNREADABLE'
  | 'RECEIPT_SCOPE_BLANK'
  | 'RECEIPT_INSTANT_INVALID'
  | 'RECEIPT_REMAINDER_NOT_A_COUNT'
  | 'RECEIPT_REMAINDER_NOT_ZERO'
  | 'RECEIPT_DIGEST_MISSING';

export type PersonalizationDefectCode =
  | PersonalizationProfileDefectCode
  | PersonalizationReceiptDefectCode;

export const PERSONALIZATION_PROFILE_DEFECT_CODES = Object.freeze([
  'PROFILE_UNREADABLE',
  'SCOPE_BLANK',
  'DERIVED_AT_INVALID',
  'CONSENT_UNKNOWN',
  'DISABLED_PROFILE_NOT_INERT',
  'ENABLED_PROFILE_NOT_DERIVED',
  'MISSING_DIMENSION',
  'UNKNOWN_DIMENSION',
  'READING_DIMENSION_MISMATCH',
  'STATUS_UNKNOWN',
  'INCONCLUSIVE_REASON_UNKNOWN',
  'INCONCLUSIVE_NOT_LEVEL_FREE',
  'LEVEL_NOT_IN_VOCABULARY',
  'CONFIDENCE_OUT_OF_RANGE',
  'SAMPLE_COUNT_INVALID',
  'SUGGESTION_BELOW_SAMPLE_FLOOR',
  'OPERATIVE_WITHOUT_EVIDENCE',
  'OPERATIVE_BELOW_CONFIDENCE_FLOOR',
  'OPERATIVE_BELOW_SAMPLE_FLOOR',
  'EVIDENCE_EXCEEDS_LIMIT',
  'EVIDENCE_RUNG_OUT_OF_RANGE',
  'EVIDENCE_COUNT_NOT_POSITIVE',
  'UNKNOWN_EVIDENCE_OUTCOME',
  'INADMISSIBLE_EVIDENCE_OUTCOME',
  'ESCALATION_WITHOUT_EXPLICIT_EVIDENCE',
  'BASIS_SCOPE_MISMATCH',
  'WINDOW_LADDER_MISMATCH',
  'BASIS_DIGEST_MISSING',
  'RUNG_WINDOW_INCOHERENT',
] as const) satisfies readonly PersonalizationProfileDefectCode[];

type _ProfileDefectCodesCovered =
  Exclude<PersonalizationProfileDefectCode, (typeof PERSONALIZATION_PROFILE_DEFECT_CODES)[number]> extends never
    ? true
    : never;
const _profileDefectCodesAreExhaustive: _ProfileDefectCodesCovered = true;
export const PERSONALIZATION_PROFILE_DEFECT_CODE_COVERAGE = _profileDefectCodesAreExhaustive;

export const PERSONALIZATION_RECEIPT_DEFECT_CODES = Object.freeze([
  'RECEIPT_UNREADABLE',
  'RECEIPT_SCOPE_BLANK',
  'RECEIPT_INSTANT_INVALID',
  'RECEIPT_REMAINDER_NOT_A_COUNT',
  'RECEIPT_REMAINDER_NOT_ZERO',
  'RECEIPT_DIGEST_MISSING',
] as const) satisfies readonly PersonalizationReceiptDefectCode[];

type _ReceiptDefectCodesCovered =
  Exclude<PersonalizationReceiptDefectCode, (typeof PERSONALIZATION_RECEIPT_DEFECT_CODES)[number]> extends never
    ? true
    : never;
const _receiptDefectCodesAreExhaustive: _ReceiptDefectCodesCovered = true;
export const PERSONALIZATION_RECEIPT_DEFECT_CODE_COVERAGE = _receiptDefectCodesAreExhaustive;

/**
 * The two partitions as one value, so a test can iterate them and assert they
 * are disjoint — which they are, checkably, unlike a shared prefix would
 * make them.
 */
export const PERSONALIZATION_DEFECT_PARTITIONS = Object.freeze({
  profile: PERSONALIZATION_PROFILE_DEFECT_CODES,
  receipt: PERSONALIZATION_RECEIPT_DEFECT_CODES,
});

/**
 * One structural finding.
 *
 * Every locator is a position or a closed-vocabulary name, never a
 * caller-chosen identifier, and `detail` carries static prose plus numbers
 * derived from the input — the Sprint 07 leak rule, inherited whole. No field
 * of a defect can reproduce profile content because no field of a *profile*
 * holds free text to reproduce (the one caller-chosen string, `scopeId`, is
 * never quoted in a detail).
 */
export interface PersonalizationDefect {
  readonly code: PersonalizationDefectCode;
  readonly dimension: PreferenceDimension | null;
  /** Position in the reading's `evidence`, or null. */
  readonly evidenceIndex: number | null;
  /** Position in the basis `rungs`, or null. */
  readonly rungIndex: number | null;
  /** The bound that was broken, for `EVIDENCE_EXCEEDS_LIMIT`; null otherwise. */
  readonly limitName: PersonalizationLimitName | null;
  readonly detail: string;
}

/* ── Checkers: report, never throw ───────────────────────────────── */

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function defect(
  code: PersonalizationDefectCode,
  detail: string,
  locators: Partial<Pick<PersonalizationDefect, 'dimension' | 'evidenceIndex' | 'rungIndex' | 'limitName'>> = {},
): PersonalizationDefect {
  return {
    code,
    dimension: locators.dimension ?? null,
    evidenceIndex: locators.evidenceIndex ?? null,
    rungIndex: locators.rungIndex ?? null,
    limitName: locators.limitName ?? null,
    detail,
  };
}

/**
 * Structural check over a profile. Returns findings; **it does not throw, for
 * any input** — a checker that raises hands the decision to whichever caller
 * forgot the try/catch, and the default behaviour of an uncaught throw is not
 * "treat the profile as inert".
 *
 * Ordering is by input position — profile-level findings first, then basis
 * rungs in order, then dimensions in `PREFERENCE_DIMENSIONS` order with
 * evidence in array order. No string comparison is involved, so no locale and
 * no second copy of `compareByCodePoint`.
 *
 * The suppression rule, matching `planningContracts`: a finding is suppressed
 * only when it borrows a bound from something already reported malformed. An
 * unknown consent suppresses the per-variant checks; an invalid `derivedAt`
 * suppresses rung coherence; an invalid confidence or sample count suppresses
 * the floor comparisons against it; a missing basis suppresses rung-index
 * range checks. Nothing else is suppressed — a bad level says nothing about
 * whether the evidence is admissible, so both are reported.
 */
export function checkPersonalizationProfile(
  profile: PersonalizationProfile,
): readonly PersonalizationDefect[] {
  if (profile === null || profile === undefined || typeof profile !== 'object') {
    return [defect('PROFILE_UNREADABLE', 'a profile was checked that is not a profile-shaped object')];
  }

  const defects: PersonalizationDefect[] = [];
  const record = profile as unknown as Record<string, unknown>;

  if (isBlank(record.scopeId)) {
    defects.push(defect('SCOPE_BLANK', 'the profile names no scope it belongs to'));
  }

  const derivedAtValid = isInstant(record.derivedAt);
  if (!derivedAtValid) {
    defects.push(defect('DERIVED_AT_INVALID', 'the profile states a derivation time that is not a well-formed instant'));
  }

  const consent = record.consent;
  if (!(PERSONALIZATION_CONSENT_STATES as readonly unknown[]).includes(consent)) {
    defects.push(defect('CONSENT_UNKNOWN', 'the profile states a consent state this contract version does not recognise'));
    return defects;
  }

  if (consent === 'disabled') {
    if (record.readings !== null || record.basis !== null) {
      defects.push(
        defect('DISABLED_PROFILE_NOT_INERT', 'a profile with consent disabled carries readings or a basis'),
      );
    }
    return defects;
  }

  /* consent === 'enabled' */

  const basis = record.basis;
  const basisReadable = basis !== null && basis !== undefined && typeof basis === 'object';
  if (!basisReadable) {
    defects.push(defect('ENABLED_PROFILE_NOT_DERIVED', 'a profile with consent enabled carries no basis'));
  }

  let rungCount: number | null = null;
  if (basisReadable) {
    const basisRecord = basis as unknown as Record<string, unknown>;
    if (basisRecord.scopeId !== record.scopeId) {
      defects.push(defect('BASIS_SCOPE_MISMATCH', 'the basis names a different scope than the profile'));
    }
    const rungs = asArray<Record<string, unknown>>(basisRecord.rungs);
    rungCount = rungs.length;

    const ladder = PERSONALIZATION_WINDOW_LADDER_DAYS;
    const ladderMatches =
      rungs.length === ladder.length &&
      ladder.every((days, index) => {
        const rung = rungs[index];
        return rung !== null && rung !== undefined && rung.windowDays === days;
      });
    if (!ladderMatches) {
      defects.push(
        defect(
          'WINDOW_LADDER_MISMATCH',
          `the basis carries ${rungs.length} rungs; the schema defines ${ladder.length} and fixes their windows`,
        ),
      );
    }

    for (let index = 0; index < rungs.length; index += 1) {
      const rung = rungs[index];
      if (rung === null || rung === undefined || typeof rung !== 'object') continue;
      if (isBlank(rung.inputDigest)) {
        defects.push(
          defect('BASIS_DIGEST_MISSING', 'a basis rung carries no digest of what it aggregated', {
            rungIndex: index,
          }),
        );
      }
      // Coherence borrows its bound from `derivedAt`; suppressed when that is
      // already reported malformed. A non-numeric `windowDays` was already
      // reported by the ladder check, whose fixed values are the bound here.
      if (derivedAtValid && typeof rung.windowDays === 'number' && Number.isFinite(rung.windowDays)) {
        const span = millisBetweenInstants(rung.windowStart, record.derivedAt);
        if (span === null || span !== rung.windowDays * MS_PER_DAY) {
          defects.push(
            defect(
              'RUNG_WINDOW_INCOHERENT',
              'a basis rung window does not end at the profile derivation instant',
              { rungIndex: index },
            ),
          );
        }
      }
    }
  }

  const readings = record.readings;
  const readingsReadable = readings !== null && readings !== undefined && typeof readings === 'object';
  if (!readingsReadable) {
    defects.push(defect('ENABLED_PROFILE_NOT_DERIVED', 'a profile with consent enabled carries no readings'));
    return defects;
  }
  const readingsRecord = readings as Record<string, unknown>;

  for (const key of Object.keys(readingsRecord)) {
    if (!(PREFERENCE_DIMENSIONS as readonly string[]).includes(key)) {
      defects.push(
        defect('UNKNOWN_DIMENSION', 'the readings carry a dimension this contract version does not recognise'),
      );
    }
  }

  for (const dimension of PREFERENCE_DIMENSIONS) {
    const reading = readingsRecord[dimension] as Record<string, unknown> | null | undefined;
    if (reading === null || reading === undefined || typeof reading !== 'object') {
      defects.push(
        defect('MISSING_DIMENSION', 'the readings are not total over the dimension vocabulary', { dimension }),
      );
      continue;
    }

    if (reading.dimension !== dimension) {
      defects.push(
        defect('READING_DIMENSION_MISMATCH', 'a reading disagrees with the key it sits under', { dimension }),
      );
    }

    const status = reading.status;
    if (!(PREFERENCE_STATUSES as readonly unknown[]).includes(status)) {
      defects.push(
        defect('STATUS_UNKNOWN', 'a reading states a status this contract version does not recognise', {
          dimension,
        }),
      );
      continue;
    }

    const sampleValid = isCount(reading.sampleEventCount);
    if (!sampleValid) {
      defects.push(
        defect('SAMPLE_COUNT_INVALID', 'a reading states a sample size that is not a non-negative integer', {
          dimension,
        }),
      );
    }

    const evidence = asArray<Record<string, unknown>>(reading.evidence);
    if (evidence.length > PERSONALIZATION_LIMITS.maxEvidencePerPreference) {
      defects.push(
        defect(
          'EVIDENCE_EXCEEDS_LIMIT',
          `a reading carries ${evidence.length} evidence entries; the cap is ${PERSONALIZATION_LIMITS.maxEvidencePerPreference}`,
          { dimension, limitName: 'maxEvidencePerPreference' },
        ),
      );
    }

    const admissible = admissibleOutcomesFor(dimension);
    let citesExplicitJudgement = false;
    for (let index = 0; index < evidence.length; index += 1) {
      const entry = evidence[index];
      if (entry === null || entry === undefined || typeof entry !== 'object') {
        defects.push(
          defect('UNKNOWN_EVIDENCE_OUTCOME', 'an evidence entry is not an evidence-shaped object', {
            dimension,
            evidenceIndex: index,
          }),
        );
        continue;
      }
      const outcome = entry.outcome;
      if (!(PERSONALIZATION_EVIDENCE_OUTCOMES as readonly unknown[]).includes(outcome)) {
        defects.push(
          defect('UNKNOWN_EVIDENCE_OUTCOME', 'an evidence entry states an outcome this contract version does not recognise', {
            dimension,
            evidenceIndex: index,
          }),
        );
      } else {
        if (!(admissible as readonly unknown[]).includes(outcome)) {
          defects.push(
            defect(
              'INADMISSIBLE_EVIDENCE_OUTCOME',
              'a behavioural outcome is cited as evidence on a pressure-bearing dimension',
              { dimension, evidenceIndex: index },
            ),
          );
        }
        if (FEEDBACK_OUTCOME_CLASSES[outcome as FeedbackOutcome] === 'explicit_judgement') {
          citesExplicitJudgement = true;
        }
      }
      // Range borrows its bound from the basis; suppressed when the basis is
      // already reported missing.
      if (rungCount !== null) {
        const rungIndex = entry.rungIndex;
        if (typeof rungIndex !== 'number' || !Number.isInteger(rungIndex) || rungIndex < 0 || rungIndex >= rungCount) {
          defects.push(
            defect('EVIDENCE_RUNG_OUT_OF_RANGE', `an evidence entry names a rung position the basis does not have; it carries ${rungCount} rungs`, {
              dimension,
              evidenceIndex: index,
            }),
          );
        }
      }
      const count = entry.count;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        defects.push(
          defect('EVIDENCE_COUNT_NOT_POSITIVE', 'an evidence entry states a count that is not a positive integer', {
            dimension,
            evidenceIndex: index,
          }),
        );
      }
    }

    if (status === 'inconclusive') {
      if (!(INCONCLUSIVE_REASONS as readonly unknown[]).includes(reading.reason)) {
        defects.push(
          defect('INCONCLUSIVE_REASON_UNKNOWN', 'an inconclusive reading states a reason this contract version does not recognise', {
            dimension,
          }),
        );
      }
      if (reading.level !== null || reading.confidence !== null) {
        defects.push(
          defect('INCONCLUSIVE_NOT_LEVEL_FREE', 'an inconclusive reading carries a level or a confidence', {
            dimension,
          }),
        );
      }
      continue;
    }

    /* status is 'suggestion' or 'operative' */

    const vocabulary = PREFERENCE_LEVEL_VOCABULARY[dimension] as readonly string[];
    const levelKnown = typeof reading.level === 'string' && vocabulary.includes(reading.level);
    if (!levelKnown) {
      defects.push(
        defect('LEVEL_NOT_IN_VOCABULARY', "a reading states a level outside its dimension's closed set", {
          dimension,
        }),
      );
    }

    const confidence = reading.confidence;
    const confidenceValid =
      typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
    if (!confidenceValid) {
      defects.push(
        defect('CONFIDENCE_OUT_OF_RANGE', 'a reading states a confidence that is not a finite number in 0..1', {
          dimension,
        }),
      );
    }

    if (levelKnown && isEscalation(dimension, reading.level as string) === true && !citesExplicitJudgement) {
      defects.push(
        defect(
          'ESCALATION_WITHOUT_EXPLICIT_EVIDENCE',
          'a level above the product baseline rests on no explicit judgement by the user',
          { dimension },
        ),
      );
    }

    if (status === 'suggestion') {
      if (sampleValid && (reading.sampleEventCount as number) < MIN_SUGGESTION_SAMPLE_EVENTS) {
        defects.push(
          defect(
            'SUGGESTION_BELOW_SAMPLE_FLOOR',
            `a suggestion rests on ${reading.sampleEventCount} events; the floor is ${MIN_SUGGESTION_SAMPLE_EVENTS}`,
            { dimension },
          ),
        );
      }
      continue;
    }

    /* status === 'operative' */

    if (evidence.length === 0) {
      defects.push(
        defect('OPERATIVE_WITHOUT_EVIDENCE', 'an operative reading cites no evidence at all', { dimension }),
      );
    }
    if (confidenceValid && (confidence as number) < OPERATIVE_CONFIDENCE_FLOOR) {
      defects.push(
        defect(
          'OPERATIVE_BELOW_CONFIDENCE_FLOOR',
          `an operative reading states confidence ${confidence}; the floor is ${OPERATIVE_CONFIDENCE_FLOOR}`,
          { dimension },
        ),
      );
    }
    if (sampleValid && (reading.sampleEventCount as number) < MIN_OPERATIVE_SAMPLE_EVENTS) {
      defects.push(
        defect(
          'OPERATIVE_BELOW_SAMPLE_FLOOR',
          `an operative reading rests on ${reading.sampleEventCount} events; the floor is ${MIN_OPERATIVE_SAMPLE_EVENTS}`,
          { dimension },
        ),
      );
    }
  }

  return defects;
}

/**
 * The remainder fields, in fixed emission order so two checks of one receipt
 * produce byte-identical findings. Listed once, here, so the checker and the
 * doc cannot disagree about which fields a receipt proves.
 */
const RECEIPT_REMAINDER_FIELDS = Object.freeze([
  'remainingFeedbackEventCount',
  'remainingRuntimeMemoryRecordCount',
  'remainingPersistedProfileCount',
] as const);

/**
 * Structural check over a deletion receipt. Reports; never throws.
 *
 * An unreadable remainder is its own code rather than folded into
 * "not zero", because `NaN > 0` is `false`: folding them would make the
 * unreadable receipt *pass*, and a deletion check that passes exactly when it
 * stops understanding its input is a check any bug can satisfy.
 */
export function checkPersonalizationDeletionReceipt(
  receipt: PersonalizationDeletionReceipt,
): readonly PersonalizationDefect[] {
  if (receipt === null || receipt === undefined || typeof receipt !== 'object') {
    return [defect('RECEIPT_UNREADABLE', 'a receipt was checked that is not a receipt-shaped object')];
  }

  const defects: PersonalizationDefect[] = [];
  const record = receipt as unknown as Record<string, unknown>;

  if (isBlank(record.scopeId)) {
    defects.push(defect('RECEIPT_SCOPE_BLANK', 'the receipt names no scope it proves deletion for'));
  }
  if (!isInstant(record.deletedAt)) {
    defects.push(defect('RECEIPT_INSTANT_INVALID', 'the receipt states a deletion time that is not a well-formed instant'));
  }
  for (const field of RECEIPT_REMAINDER_FIELDS) {
    const value = record[field];
    if (!isCount(value)) {
      defects.push(
        defect('RECEIPT_REMAINDER_NOT_A_COUNT', `the receipt's ${field} is not a non-negative integer`),
      );
    } else if ((value as number) > 0) {
      defects.push(
        defect('RECEIPT_REMAINDER_NOT_ZERO', `the receipt's ${field} is ${value}; a deletion receipt must prove zero`),
      );
    }
  }
  if (isBlank(record.emptyStateDigest)) {
    defects.push(defect('RECEIPT_DIGEST_MISSING', 'the receipt carries no digest a verifier can recompute'));
  }

  return defects;
}

/* ── Policy ──────────────────────────────────────────────────────── */

/**
 * The derivation seam's input rules, on the terms every intelligence module
 * in this repo states them, with the clauses that are this module's own.
 *
 * `derivationReadsCountsNeverEvents` is decision 3 in the header: the input
 * is `FeedbackAggregates`, never event rows, so latency and per-event timing
 * are unrepresentable in it. `unreadableConsentIsDisabled` is the fail-closed
 * direction for the one input whose misreading would be a privacy failure
 * rather than a correctness one.
 */
export const PERSONALIZATION_INPUT_POLICY = Object.freeze({
  reportWhatTheTaxonomyNames: true,
  noAmbientClock: true,
  derivationReadsCountsNeverEvents: true,
  digestsComeFromFeedbackAggregation: true,
  unreadableConsentIsDisabled: true,
});

/**
 * Where a profile may live: nowhere.
 *
 * `profileCanPersist: false` is the mechanism behind "disable takes effect
 * immediately" — a profile that exists only as the return value of a pure
 * function over the log cannot be stale with respect to consent, because
 * there is no stored copy for a consent flip to race.
 *
 * `profileExportPolicy` is `memoryContracts.ExportPolicy`'s spelling, held by
 * `satisfies` so the two systems' export vocabularies cannot drift — the
 * named seam from the header. `personal_never_export` here means: the profile
 * never reaches fine-tuning data, aggregate sharing, or any path out of the
 * user's own scope. The user's own data export (#42) is the *other* path and
 * deliberately includes everything, exactly as `MemoryExport` does.
 */
export const PERSONALIZATION_PERSISTENCE_POLICY = Object.freeze({
  profileCanPersist: false,
  profileRecomputedPerRead: true,
  deriverPerformsNoWrites: true,
  rawTextInProfile: false,
  profileNeverFineTuned: true,
  profileExportPolicy: 'personal_never_export' satisfies ExportPolicy,
});

/**
 * The consent rules #42 builds controls against, as data.
 */
export const PERSONALIZATION_CONSENT_POLICY = Object.freeze({
  /** Opt-in: absent an explicit grant, the state is disabled. */
  defaultState: 'disabled' satisfies PersonalizationConsentState,
  disabledConsentYieldsInertProfile: true,
  /** No stored profile exists to outlive a consent check. */
  profileMustNotOutliveConsentCheck: true,
  deletionProducesVerifiableReceipt: true,
});

/* ── The #107 invariants, enumerable ─────────────────────────────── */

/**
 * Signals that must never appear in the derivation input vocabulary, as
 * things that increase any dimension's level, or as optimisation targets for
 * any weight in the deriver. The list exists so #43's gate review and the
 * contract test have names to hold a diff against — the types already make
 * these unrepresentable in `PersonalizationDerivationInput`, and this is the
 * rule stated for the field someone will one day propose adding.
 *
 * The failure mode is #107's, verbatim: pressure that produces anxiety
 * produces quick responses, and a loop that rewards quick responses learns to
 * produce anxiety.
 */
export const FORBIDDEN_DERIVATION_SIGNALS = Object.freeze([
  'response_latency',
  'time_to_acknowledge',
  'compliance_rate',
  'engagement_frequency',
  'session_length',
  'notification_open_rate',
] as const);

/**
 * The named invariants of this contract, each carried by a mechanism stated
 * in its comment. Exported as a closed list so the contract test enumerates
 * them — an invariant that exists only in prose is documentation of an
 * intention, and this file's whole design is that the intentions with teeth
 * are the ones that survive.
 *
 * - `NO_ENGAGEMENT_OPTIMIZATION`  — no dimension, weight, or derivation input
 *                                   is optimised for engagement, response
 *                                   speed, or compliance. Carried by:
 *                                   `FORBIDDEN_DERIVATION_SIGNALS`, the shape
 *                                   of `PersonalizationDerivationInput`, and
 *                                   the behavioural classification of
 *                                   `complete`.
 * - `NO_LATENCY_SIGNAL_IN_INPUT`  — the derivation input carries counts per
 *                                   window, never per-event instants.
 *                                   Carried by: `FeedbackAggregates` being
 *                                   the only data field of the input.
 * - `PRESSURE_DIMENSIONS_EXPLICIT_ONLY`
 *                                 — pressure-bearing dimensions derive from
 *                                   explicit judgements only. Carried by:
 *                                   `admissibleOutcomesFor`,
 *                                   `INADMISSIBLE_EVIDENCE_OUTCOME`.
 * - `BEHAVIORAL_INFERENCE_NEVER_ESCALATES`
 *                                 — behaviour alone may only move a dimension
 *                                   at or below its product baseline. Carried
 *                                   by: `PREFERENCE_LEVEL_INTRUSIVENESS`,
 *                                   `PRODUCT_BASELINE_LEVELS`,
 *                                   `ESCALATION_WITHOUT_EXPLICIT_EVIDENCE`.
 * - `LOW_CONFIDENCE_NEVER_OPERATIVE`
 *                                 — below the floor, the strongest legal
 *                                   claim is a suggestion. Carried by: the
 *                                   three-variant `PreferenceReading`,
 *                                   `OPERATIVE_BELOW_CONFIDENCE_FLOOR`,
 *                                   `OPERATIVE_BELOW_SAMPLE_FLOOR`.
 * - `SMALL_SAMPLE_IS_INCONCLUSIVE`
 *                                 — #43's rule: below the suggestion floor
 *                                   the reading is typed `inconclusive`, and
 *                                   the comparison harness must render it as
 *                                   "cannot tell", never as a weak effect.
 *                                   Carried by: `InconclusiveReading`,
 *                                   `SUGGESTION_BELOW_SAMPLE_FLOOR`.
 * - `DISABLED_CONSENT_YIELDS_INERT_PROFILE`
 *                                 — carried by: the discriminated profile
 *                                   union, `inertPersonalizationProfile`,
 *                                   `DISABLED_PROFILE_NOT_INERT`.
 * - `PROFILE_REPRODUCIBLE_FROM_NON_REVOKED_EVENTS`
 *                                 — carried by: `PersonalizationBasis` rung
 *                                   digests over Sprint 03's aggregation,
 *                                   which already excludes revoked events;
 *                                   `noAmbientClock`.
 * - `NO_RAW_TEXT_IN_PROFILE`     — carried by: closed vocabularies for every
 *                                   value-bearing field; the only free
 *                                   strings in a profile are `scopeId` and
 *                                   digests.
 * - `DELETION_IS_VERIFIABLE`     — carried by:
 *                                   `PersonalizationDeletionReceipt` holding
 *                                   only recomputable facts, and its checker.
 * - `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE`
 *                                 — #43's gate rule: no release gate over
 *                                   personalization may rest solely on
 *                                   engagement-class measures (the
 *                                   `FORBIDDEN_DERIVATION_SIGNALS` classes);
 *                                   a gate must cite at least one
 *                                   user-judgement measure — explicit
 *                                   corrections, revocations, reported
 *                                   helpfulness. Carried here as data for
 *                                   #43's harness to enforce; this contract
 *                                   owns the vocabulary, #43 owns the gate.
 */
export const PERSONALIZATION_INVARIANTS = Object.freeze([
  'NO_ENGAGEMENT_OPTIMIZATION',
  'NO_LATENCY_SIGNAL_IN_INPUT',
  'PRESSURE_DIMENSIONS_EXPLICIT_ONLY',
  'BEHAVIORAL_INFERENCE_NEVER_ESCALATES',
  'LOW_CONFIDENCE_NEVER_OPERATIVE',
  'SMALL_SAMPLE_IS_INCONCLUSIVE',
  'DISABLED_CONSENT_YIELDS_INERT_PROFILE',
  'PROFILE_REPRODUCIBLE_FROM_NON_REVOKED_EVENTS',
  'NO_RAW_TEXT_IN_PROFILE',
  'DELETION_IS_VERIFIABLE',
  'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE',
] as const);

export type PersonalizationInvariant = (typeof PERSONALIZATION_INVARIANTS)[number];
