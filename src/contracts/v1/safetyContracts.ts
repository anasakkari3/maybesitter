/**
 * Safety policy contracts (Sprint 09, issue #39).
 *
 * The safety gateway answers one question — **may this candidate output be
 * shown to this person right now** — and answers it as a *verdict*, never as a
 * thrown error and never as a silent edit. Coaching (#38) says what it would
 * like to say; this file says what may leave the building, why not, and what the
 * person is offered instead.
 *
 * ── The seam, and why it points this way ─────────────────────────────────
 *
 * This contract is defined over **a candidate output carrying claims and
 * evidence references**, not over a coaching message. Nothing in `lib/safety/**`
 * imports `lib/coaching/**` or `coachingContracts`, and the boundary test
 * `tests/safety/safetyBoundaries.test.ts` enforces the closure. Sprint 05's rule
 * is that a check owned by the thing it checks is not a check; a gateway that
 * imports the module it guards inherits that module's idea of what a claim is,
 * and would then agree with it by construction. #38 conforms to `SafetyCandidate`
 * — the arrow runs from the guarded module to the guard, in one direction only.
 *
 * The practical consequence is that `SafetyCandidate` is deliberately generic:
 * segments of user-visible text, claims, an evidence graph, proposed effects,
 * and a pressure assertion. Any producer that can describe its output in those
 * terms can be gated, which is the property that lets Sprint 11 put the
 * recommendation review surface behind the same check without a second gateway.
 *
 * ── What is reused rather than rebuilt ───────────────────────────────────
 *
 * Sprint 08 already built an evidence graph with claim-to-source tracing, cycle
 * detection and root resolution. "Is this claim sourced" is that problem, so the
 * answer is imported, not reimplemented:
 *
 *   - `checkEvidenceGraph`   → `EVIDENCE_GRAPH_MALFORMED`
 *   - `resolveEvidenceRoots` → `CLAIM_NOT_TRACEABLE`, `FABRICATED_INSTANT`
 *   - `isInstant`            → `INSTANT_MALFORMED`, `EVALUATION_INSTANT_INVALID`
 *
 * `SafetyCandidate.evidence` is `recommendationContracts.EvidenceGraph` itself,
 * not a structurally identical local copy. Sprint 06 paid four review rounds for
 * three copies of one lexicon and two copies of one span limit; Sprint 07 paid
 * two integration rounds pulling three copies of one arithmetic apart. A second
 * evidence graph would be the same defect with a safety label on it.
 *
 * The one place the Sprint 08 machinery does **not** fit, stated rather than
 * silently worked around: `EvidenceBackedReason.supportedBy` and
 * `DerivedEvidence.derivedFrom` are non-empty tuples, and
 * `CandidateClaim.supportedBy` here is a plain array. That is not an oversight
 * and not a weakening — it is the difference between a producer's contract and a
 * guard's. Sprint 08 recorded that "every non-empty tuple in this file is a hole
 * at the untyped boundary", and this file *is* that boundary: an unsourced claim
 * is the exact input the gateway exists to catch, so it must be constructible in
 * a TypeScript red-team test. A tuple type here would make the unsafe case
 * unwritable in the suite while remaining perfectly writable by `JSON.parse`,
 * which is a check that is strongest precisely where nothing attacks it.
 * `UNSOURCED_CLAIM` is the runtime code, and it is where the guarantee lives.
 *
 * ── Five structural decisions ────────────────────────────────────────────
 *
 *  1. **A block carries its way out, in the type.** `SafetyVerdict` is a
 *     discriminated union and the two non-`allow` variants both require a
 *     `SafeUserPath`. There is no field a renderer can drop to turn a refusal
 *     into a dead end, because there is no verdict shape that lacks one. The
 *     acceptance criterion "all blocked actions give a safe user path" is
 *     therefore a type, and `BLOCK_WITHOUT_SAFE_PATH` covers the untyped
 *     boundary where the type is absent. `SAFETY_CODE_RECOVERY` maps **every**
 *     reason code to a path, so no future code can be added without one.
 *
 *  2. **Fail-closed is scoped, and the scope is data.** Refusing is the safe
 *     direction; refusing *everything forever* is a denial of service the user
 *     did not ask for. Every code carries a `SafetyBlockScope` in
 *     `SAFETY_CODE_SCOPES`, no code is allowed to reach `session`, and the
 *     scope table is exported so a test can assert that rather than trust it.
 *     The one `surface`-scoped code is `PRESSURE_BUDGET_EXHAUSTED`, which is by
 *     nature about a surface and by nature refills.
 *
 *  3. **Every locator is a position; no identifier ever reaches prose.** This is
 *     the acceptance criterion "sensitive raw text is not logged", and Sprint
 *     07's leak is why it is stated as a structural rule rather than a habit: a
 *     detail reading `working window call-dr.cohen-about-the-biopsy` passed a
 *     test that checked only that titles were absent, because ids are free
 *     strings people fill with content. So `SafetyFinding` names inputs,
 *     segments, claims and evidence nodes by **index into the input array**, and
 *     `detail` carries static prose plus numbers derived from the input and
 *     nothing else. `SafetyAuditRecord` has no field of any type that can hold
 *     candidate text, and `checkSafetyAudit` is the runtime proof.
 *
 *  4. **Reason codes are partitioned by the stage that may emit them**, the way
 *     `planningContracts` partitions static from attempt codes and for the same
 *     reason: "the request is unsafe to answer" and "the answer is unsafe to
 *     show" are different failures owned by different callers, and one flat list
 *     lets a validator report the wrong owner. `SAFETY_CODE_PARTITIONS` contracts
 *     **which position a code may appear in** — a pre-validator cannot emit
 *     `SHAMING_LANGUAGE` because it has no candidate yet, and a post-validator
 *     cannot emit `INJECTED_INSTRUCTION` because that is a statement about the
 *     request. `SAFETY_CODE_BOUNDARIES` is an *orthogonal* classification onto
 *     the issue's five named boundaries, derived from one table rather than
 *     listed twice, so the two groupings cannot drift.
 *
 *  5. **Every declared bound is enforced and enumerable.** Sprint 08 shipped
 *     `maxEvidenceRefsPerReason` declared beside enforced limits and enforced
 *     nowhere, and a valid request then burned 8.2 seconds of CPU on a public
 *     route and returned 200. `SAFETY_LIMITS` is one frozen object,
 *     `SafetyLimitName` is derived from its keys, `CANDIDATE_EXCEEDS_LIMIT`
 *     carries the key it broke, and `tests/safety/validators.test.ts` iterates
 *     `Object.keys(SAFETY_LIMITS)` and demands a finding for each. A limit that
 *     no test can name is documentation of an intention.
 *
 * ── Relationship to the shipped product validators ───────────────────────
 *
 * `lib/services/responseEngine/validation.ts`, `pressureService.ts` and
 * `personalityService.ts` already enforce part of this at product scope, and
 * this module neither imports them nor changes them. Where the two cover the
 * same ground the relation is stated **at the code** — see the doc comment on
 * each member of `SafetyPostCode` — as one of *same rule*, *deliberately
 * stricter*, *superset*, or *deliberately different*. The summary:
 *
 *   - `SHAMING_LANGUAGE` is a **superset** of `validation.ts`'s `SHAME_PATTERNS`.
 *   - `PERSISTENCE_CLAIMED` is **deliberately stricter** than that file's
 *     `stateChange === 'none'` persistence check.
 *   - `PRESSURE_BUDGET_EXHAUSTED` is the **same rule at module scope** as
 *     `PRESSURE_DELIVERY_COOLDOWN_MS`, with the interval supplied by the caller
 *     rather than re-declared here — there is deliberately no second copy of
 *     that number.
 *   - `FABRICATED_INSTANT` is **deliberately different** from the ISO-date ban in
 *     `LEGACY_AND_INTERNAL_PATTERNS`: that is a presentation rule about how a
 *     time may be written, this is a provenance rule about whether it was read.
 *     A message can satisfy either and fail the other.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import {
  checkEvidenceGraph,
  isInstant,
  resolveEvidenceRoots,
  type EvidenceGraph,
  type EvidenceNodeId,
  type Instant,
} from './recommendationContracts';

export const SAFETY_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const SAFETY_SCHEMA_VERSION = 'safety-v1' as const;

/**
 * Re-exported so a consumer of this contract does not have to know which sprint
 * built the evidence graph in order to hand one to the gateway. The import is a
 * *value* import, deliberately: `checkEvidenceGraph` and `resolveEvidenceRoots`
 * are the reuse this sprint is judged on, and a type-only edge would let a
 * validator quietly grow its own copy of them.
 *
 * `recommendationContracts` imports `MODULE_CONTRACT_VERSION` from
 * `moduleContracts`, and so does this file, so the three form a chain and not a
 * cycle. The TDZ hazard recorded on the `decomposition` descriptor in
 * `moduleContracts.ts` is the reverse edge — `moduleContracts` importing a
 * schema version back — and it is why the `safety` descriptor there spells
 * `'safety-v1'` as a literal instead of importing `SAFETY_SCHEMA_VERSION`.
 */
export type { EvidenceGraph, EvidenceNodeId, Instant };
export { checkEvidenceGraph, isInstant, resolveEvidenceRoots };

/* ── What is being judged ────────────────────────────────────────── */

/**
 * The product surface a candidate is bound for.
 *
 * Closed, because the permitted sensitivity and the pressure budget differ per
 * surface and a free string would make "which rules apply" a decision the
 * producer gets to make about itself.
 */
export type SafetySurface =
  | 'coaching_message'
  | 'recommendation_review'
  | 'pressure_nudge'
  | 'notification'
  | 'audit_note';

export const SAFETY_SURFACES = Object.freeze([
  'coaching_message',
  'recommendation_review',
  'pressure_nudge',
  'notification',
  'audit_note',
] as const) satisfies readonly SafetySurface[];

/**
 * How exposed a piece of content is allowed to be.
 *
 * Ordered by `SENSITIVITY_RANK`, ascending. `personal` is ordinary user content;
 * `sensitive` is content the user marked, or that arrived from a source declared
 * sensitive — health, finance, relationships. The gateway never *infers* the
 * class from the text: inferring sensitivity from content is a classifier, and a
 * classifier that is wrong in the permissive direction is a privacy leak that
 * reports as a pass.
 */
export type SensitivityClass = 'public' | 'personal' | 'sensitive';

export const SENSITIVITY_CLASSES = Object.freeze([
  'public',
  'personal',
  'sensitive',
] as const) satisfies readonly SensitivityClass[];

/** Ascending exposure. Exported as data so the comparison is not re-derived. */
export const SENSITIVITY_RANK: Readonly<Record<SensitivityClass, number>> = Object.freeze({
  public: 0,
  personal: 1,
  sensitive: 2,
});

/** Where a piece of untrusted input came from. */
export type UntrustedOrigin =
  | 'user_text'
  | 'external_calendar'
  | 'shared_note'
  | 'imported_document'
  | 'system_template';

export const UNTRUSTED_ORIGINS = Object.freeze([
  'user_text',
  'external_calendar',
  'shared_note',
  'imported_document',
  'system_template',
] as const) satisfies readonly UntrustedOrigin[];

/**
 * Origins whose text may be treated as instructions to the system.
 *
 * Exactly one, and it is the one the *product* wrote. Everything else is data
 * that happens to be shaped like language. `UNTRUSTED_CONTENT_IN_TRUSTED_SLOT`
 * is what fires when a request claims otherwise.
 */
export const INSTRUCTION_BEARING_ORIGINS = Object.freeze([
  'system_template',
] as const) satisfies readonly UntrustedOrigin[];

/**
 * One span of input the candidate was built from.
 *
 * `text` is the raw thing. It exists on the *request* because the injection
 * check has to read it, and it exists nowhere in the verdict, the findings or
 * the audit record — see `SafetyAuditRecord` and `checkSafetyAudit`. The whole
 * design of this file is that raw text enters at one door and leaves through
 * none.
 *
 * `declaredTrust` is what the caller asserts about the span, and it is separate
 * from `origin` on purpose: the defect this pair exists to catch is a producer
 * that pastes a shared calendar note into a system-instruction slot, which is
 * expressible only when the assertion and the provenance are two fields.
 */
export interface UntrustedInput {
  readonly inputId: string;
  readonly origin: UntrustedOrigin;
  readonly sensitivity: SensitivityClass;
  readonly declaredTrust: 'data' | 'instruction';
  readonly text: string;
}

/**
 * The pressure the caller is permitted to apply, supplied per request.
 *
 * **No number in here is declared by this contract.** `PRESSURE_DELIVERY_COOLDOWN_MS`
 * is one hour and lives in `lib/services/pressureService.ts`; restating it would
 * be a second copy of a product decision, and the copies would drift the first
 * time the product tuned it. The caller passes its own interval, and the gateway
 * enforces whatever it was given — which is also what makes the rule testable
 * without a clock.
 *
 * `lastPressuredAt` is null when this subject has never been pressured. Null is
 * not "long ago" and it is not "now": it means the interval check has nothing to
 * measure from, so it does not fire.
 */
export interface PressureBudget {
  readonly maxIntensity: PressureIntensityLevel;
  readonly minIntervalMinutes: number;
  readonly lastPressuredAt: Instant | null;
  readonly consecutiveUnansweredCount: number;
  readonly maxConsecutiveUnanswered: number;
}

/**
 * How hard a candidate pushes, ordered by `PRESSURE_INTENSITY_RANK`.
 *
 * `none` is a first-class level rather than a null, so "this candidate applies
 * no pressure" is a statement the producer makes and the gateway checks, not an
 * absence the gateway has to interpret. A budget of `none` is how a surface says
 * pressure is switched off for it.
 *
 * **Same three names as `pressureService.PressureIntensity`** (`low`, `medium`,
 * `high`), plus `none`. Deliberately the same spellings: a translation table
 * between two pressure vocabularies is exactly the place the translation is
 * wrong, and the shared spelling lets the merge's cross-track test compare the
 * two on one input without a lookup.
 */
export type PressureIntensityLevel = 'none' | 'low' | 'medium' | 'high';

export const PRESSURE_INTENSITY_LEVELS = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
] as const) satisfies readonly PressureIntensityLevel[];

export const PRESSURE_INTENSITY_RANK: Readonly<Record<PressureIntensityLevel, number>> = Object.freeze({
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
});

/**
 * The request side of the seam: everything decidable before a candidate exists.
 *
 * `now` is the only instant this module has. There is no clock anywhere under
 * `lib/safety/**` — no `Date.now()`, no zero-arg `new Date()`, no
 * `Math.random()`, no `randomUUID` — and `tests/safety/safetyBoundaries.test.ts`
 * scans for all four with comments stripped.
 */
export interface SafetyRequest {
  readonly requestId: string;
  readonly surface: SafetySurface;
  /** Supplied by the caller. This module never reads a clock. */
  readonly now: Instant;
  readonly inputs: readonly UntrustedInput[];
  /** The most exposed class this surface may draw on. */
  readonly permittedSensitivity: SensitivityClass;
  readonly pressureBudget: PressureBudget;
}

/** What a claim asserts, at the granularity the gateway can check. */
export type CandidateClaimKind = 'statement' | 'time' | 'quantity' | 'commitment_state';

export const CANDIDATE_CLAIM_KINDS = Object.freeze([
  'statement',
  'time',
  'quantity',
  'commitment_state',
] as const) satisfies readonly CandidateClaimKind[];

/**
 * One assertion the candidate makes, with the evidence it says it rests on.
 *
 * `supportedBy` is a plain array, not a non-empty tuple. See the header: this is
 * the guard's boundary, and the unsourced case must be constructible in the
 * red-team suite or the check that catches it is never exercised.
 *
 * `statedInstant` is non-null only for `kind: 'time'`. It is the field the
 * hallucinated-time boundary is about: a time the candidate states must be a
 * time some observation actually carried, and `FABRICATED_INSTANT` fires when
 * `resolveEvidenceRoots` reaches no observation asserting it.
 */
export interface CandidateClaim {
  readonly claimId: string;
  readonly kind: CandidateClaimKind;
  /** For `kind: 'time'`; null otherwise. */
  readonly statedInstant: Instant | null;
  readonly supportedBy: readonly EvidenceNodeId[];
}

/**
 * A span of user-visible text the candidate wants to show.
 *
 * Split into segments rather than carried as one string so that redaction has
 * something to name: `allow_with_redaction` drops segments **by index**, which
 * is a decision a renderer can execute without the gateway ever quoting the text
 * it removed.
 */
export interface CandidateSegment {
  readonly role: 'body' | 'question' | 'option_label' | 'footnote';
  readonly text: string;
}

/**
 * Something the candidate proposes to do, beyond saying words.
 *
 * `canonical_write` is present in the vocabulary **so that it can be refused**.
 * `STATE_WRITE_POLICY` in `moduleContracts` already says intelligence modules
 * may not write canonical state directly; a kind that cannot be expressed cannot
 * be caught arriving from a producer that has not read that policy, which is the
 * Sprint 08 lesson about unreachable outcomes applied in the other direction.
 */
export type ProposedEffectKind = 'none' | 'propose_write' | 'notify' | 'canonical_write';

export const PROPOSED_EFFECT_KINDS = Object.freeze([
  'none',
  'propose_write',
  'notify',
  'canonical_write',
] as const) satisfies readonly ProposedEffectKind[];

export interface ProposedEffect {
  readonly effectId: string;
  readonly kind: ProposedEffectKind;
  readonly requiresConfirmation: boolean;
}

/**
 * The candidate output, described generically enough that any producer can be
 * gated and no producer's vocabulary leaks in.
 *
 * This is the seam #38 conforms to. It mentions coaching nowhere.
 */
export interface SafetyCandidate {
  readonly candidateId: string;
  readonly surface: SafetySurface;
  readonly segments: readonly CandidateSegment[];
  readonly claims: readonly CandidateClaim[];
  readonly evidence: EvidenceGraph;
  readonly effects: readonly ProposedEffect[];
  /** What the producer says it is doing; checked against the request's budget. */
  readonly pressure: PressureIntensityLevel;
}

/* ── Limits, all of them enforced ────────────────────────────────── */

/**
 * The bounds a request or candidate must stay inside.
 *
 * One object, because `SafetyLimitName` is derived from its keys and
 * `CANDIDATE_EXCEEDS_LIMIT` carries that key — so a limit added here without an
 * enforcement site fails `tests/safety/validators.test.ts`, which iterates
 * `Object.keys(SAFETY_LIMITS)` and demands a finding naming each one. That test
 * is the whole point of the shape: Sprint 08's `maxEvidenceRefsPerReason` was
 * declared beside enforced limits, enforced nowhere, and cost 8.2 seconds of CPU
 * per crafted request on an unauthenticated route.
 *
 * The numbers are deliberately generous. A bound's job here is to stop a
 * pathological input from turning a linear check into a quadratic one, not to
 * express a product opinion about message length — `maxSentences` in
 * `responseEngine/validation.ts` is the product's opinion and this contract does
 * not restate it.
 */
export const SAFETY_LIMITS = Object.freeze({
  maxUntrustedInputs: 64,
  maxUntrustedInputChars: 8_000,
  maxSegments: 24,
  maxSegmentChars: 2_000,
  maxClaims: 64,
  maxEvidenceNodes: 512,
  maxEvidenceRefsPerClaim: 16,
  maxEffects: 8,
  maxFindings: 128,
});

export type SafetyLimitName = keyof typeof SAFETY_LIMITS;

export const SAFETY_LIMIT_NAMES = Object.freeze(
  Object.keys(SAFETY_LIMITS).sort() as SafetyLimitName[],
);

/**
 * Which side of the seam owns each bound.
 *
 * Total, so a limit added to `SAFETY_LIMITS` without a stage fails to typecheck
 * — and `tests/safety/validators.test.ts` reads this to know whether to demand
 * `REQUEST_EXCEEDS_LIMIT` or `CANDIDATE_EXCEEDS_LIMIT` for each key. Without it
 * the enumeration test would have to hard-code the mapping, which is a second
 * copy of a classification and the Sprint 06 gap in miniature.
 */
export const SAFETY_LIMIT_STAGES: Readonly<Record<SafetyLimitName, SafetyStage>> = Object.freeze({
  maxUntrustedInputs: 'pre',
  maxUntrustedInputChars: 'pre',
  maxSegments: 'post',
  maxSegmentChars: 'post',
  maxClaims: 'post',
  maxEvidenceNodes: 'post',
  maxEvidenceRefsPerClaim: 'post',
  maxEffects: 'post',
  maxFindings: 'post',
});

/* ── The reason taxonomy ─────────────────────────────────────────── */

/**
 * Which validator may emit a code.
 *
 * `pre` runs on a `SafetyRequest` and knows nothing about any candidate. `post`
 * runs on a `SafetyCandidate` and the request it answers. The split is enforced
 * by the types — `checkSafetyFindings` reports `FINDING_CLASSIFICATION_MISMATCH`
 * for a finding whose stage disagrees with `SAFETY_CODE_STAGES` — because a
 * post-validator emitting a pre code is how a caller gets told the wrong thing
 * is wrong, and then fixes the wrong thing.
 */
export type SafetyStage = 'pre' | 'post';

/**
 * Codes decidable about the request alone.
 *
 * - `REQUEST_UNREADABLE`  — the gateway was handed something it cannot read as a
 *                           request at all: null, a non-object, a missing
 *                           `inputs` array. Fail-closed, and this is the code
 *                           that makes "fail closed" a *reported* outcome rather
 *                           than a raised exception. A gateway that throws on
 *                           malformed input hands the decision back to whichever
 *                           caller forgot the try/catch, and the safe default of
 *                           an uncaught throw is whatever the framework does.
 * - `REQUEST_EXCEEDS_LIMIT`
 *                         — a bound in `SAFETY_LIMITS` owned by the request side
 *                           was broken; carries the key. Separate from
 *                           `CANDIDATE_EXCEEDS_LIMIT` because the partition
 *                           contracts which position a code may appear in, and a
 *                           pre-validator that reported a *candidate* limit
 *                           would be reporting about something it has not been
 *                           given. `SAFETY_LIMIT_STAGES` says which side owns
 *                           each bound, so the enumeration test knows which code
 *                           to demand.
 * - `EVALUATION_INSTANT_INVALID`
 *                         — `now` is absent or is not an `Instant` by
 *                           `isInstant`. Everything time-shaped is suppressed
 *                           after this, because a check against an unusable
 *                           bound reports a fact about the bound. The rule is
 *                           `planningContracts`' suppression rule: a finding is
 *                           suppressed only when it borrows a bound from
 *                           something already reported malformed.
 * - `INJECTED_INSTRUCTION`
 *                         — a span of untrusted input carries text addressed to
 *                           the system rather than to a person. This is the
 *                           injection boundary's input half; `INSTRUCTION_ECHOED`
 *                           is its output half, and they are two codes because a
 *                           request that contains an injection attempt and a
 *                           candidate that obeyed one are different events with
 *                           different safe paths.
 * - `UNTRUSTED_CONTENT_IN_TRUSTED_SLOT`
 *                         — a span whose `origin` is not in
 *                           `INSTRUCTION_BEARING_ORIGINS` was submitted with
 *                           `declaredTrust: 'instruction'`. The producer-side
 *                           mistake that makes injection work at all.
 * - `SENSITIVE_SCOPE_NOT_PERMITTED`
 *                         — a span is more exposed than
 *                           `permittedSensitivity` allows for this surface. The
 *                           privacy boundary's input half: a notification that
 *                           may draw on `personal` content must never be built
 *                           from `sensitive` content, and the moment to say so is
 *                           before it is built, not after it is written.
 * - `PRESSURE_BUDGET_EXHAUSTED`
 *                         — pressing again would break the caller's own interval
 *                           or its consecutive-unanswered ceiling.
 *
 *                           **Same rule at module scope as
 *                           `PRESSURE_DELIVERY_COOLDOWN_MS`** in
 *                           `lib/services/pressureService.ts`, which enforces a
 *                           one-hour per-commitment cooldown through a delivery
 *                           store and an ambient `now`. Two differences, both
 *                           deliberate: the interval is an *input* here, so this
 *                           contract holds no second copy of the product's
 *                           number; and this adds a consecutive-unanswered
 *                           ceiling, which the product's cooldown has no shape
 *                           for — a cooldown alone permits an unbounded number
 *                           of hourly nudges to someone who has answered none of
 *                           them, and "harmful pressure" is exactly that
 *                           sequence.
 */
export type SafetyPreCode =
  | 'REQUEST_UNREADABLE'
  | 'REQUEST_EXCEEDS_LIMIT'
  | 'EVALUATION_INSTANT_INVALID'
  | 'INJECTED_INSTRUCTION'
  | 'UNTRUSTED_CONTENT_IN_TRUSTED_SLOT'
  | 'SENSITIVE_SCOPE_NOT_PERMITTED'
  | 'PRESSURE_BUDGET_EXHAUSTED';

/**
 * Codes decidable only about a produced candidate.
 *
 * - `UNKNOWN_CANDIDATE_SHAPE`
 *                        — the candidate is null, not an object, or carries a
 *                          `kind`-like field this version does not recognise.
 *                          Reported rather than ignored for the reason
 *                          `UNKNOWN_NODE_KIND` exists in `recommendationContracts`:
 *                          every pass here is written as
 *                          `if (claim.kind !== 'time') continue`, so an
 *                          unrecognised shape is silently exempt from *all* of
 *                          them, which makes it the ideal place to hide.
 * - `CANDIDATE_EXCEEDS_LIMIT`
 *                        — a bound in `SAFETY_LIMITS` was broken. Carries the
 *                          key, so the finding says which.
 * - `UNSOURCED_CLAIM`    — a claim citing no evidence at all.
 *
 *                          Spelled the same as
 *                          `RecommendationStructureDefectCode.UNSOURCED_CLAIM`
 *                          and meaning the same thing, deliberately. The two are
 *                          not the same value — one is a recommendation defect
 *                          and one is a safety reason — but a reader comparing
 *                          the two taxonomies should not have to discover that
 *                          `UNSOURCED_CLAIM` and, say, `CLAIM_WITHOUT_BASIS` are
 *                          one concept. Sprint 08 made the same choice for
 *                          `SupportReasonCode` mirroring
 *                          `priorityContracts.ReasonCode`.
 * - `EVIDENCE_GRAPH_MALFORMED`
 *                        — `checkEvidenceGraph` returned findings. One safety
 *                          code for the whole Sprint 08 defect list, because the
 *                          safety question is binary — the graph cannot be
 *                          trusted to trace anything — and re-spelling eight
 *                          graph codes into a safety vocabulary would be a
 *                          translation table with nothing to gain.
 * - `CLAIM_NOT_TRACEABLE`
 *                        — `resolveEvidenceRoots` returned null for a cited
 *                          node, or the claim cites a node the graph does not
 *                          have. The claim looks sourced and is not.
 * - `INSTANT_MALFORMED`  — a `statedInstant` that `isInstant` rejects.
 *                          `2026-02-30T00:00:00Z` is the case that motivates
 *                          having a code at all: `Date.parse` reads it as March
 *                          the 2nd, so a candidate can state a day that does not
 *                          exist and every downstream reader will agree on a
 *                          different, real day.
 * - `FABRICATED_INSTANT` — a well-formed stated instant that no observation the
 *                          claim traces to actually carries. The hallucinated-time
 *                          boundary proper.
 *
 *                          **Deliberately different from
 *                          `LEGACY_AND_INTERNAL_PATTERNS`** in
 *                          `responseEngine/validation.ts`, which forbids
 *                          `/\b20\d\d-\d\d-\d\d/` from appearing in user copy.
 *                          That is a *presentation* rule — an ISO date is
 *                          machine scaffolding leaking into prose — and it fires
 *                          on a perfectly well-sourced date. This is a
 *                          *provenance* rule and fires on `next Tuesday at 3` if
 *                          nothing was read that says so. Neither implies the
 *                          other, and the merge's cross-track test should expect
 *                          disagreement on both directions rather than treat it
 *                          as a defect.
 * - `RAW_IDENTIFIER_DISCLOSED`
 *                        — user-visible text carries a caller-chosen identifier:
 *                          a `candidateId`, `claimId`, `inputId`, `effectId`,
 *                          `nodeId` or `requestId`. Redactable rather than
 *                          blocking, because dropping the segment is a real fix.
 * - `SENSITIVE_TEXT_DISCLOSED`
 *                        — a segment reproduces a run of text from a span
 *                          classified `sensitive`. Redactable for the same
 *                          reason.
 * - `SHAMING_LANGUAGE`   — the candidate labels the person rather than the
 *                          situation.
 *
 *                          **Superset of `SHAME_PATTERNS`** in
 *                          `responseEngine/validation.ts`, which lists eight
 *                          English adjectives (`avoidant`, `inconsistent`,
 *                          `lazy`, `fault`, `failed`, `shame`, `guilt`,
 *                          `disappointed`) and applies them to a realized
 *                          `ResponsePlan` message. `lib/safety/` carries those
 *                          eight spellings *again* rather than importing them —
 *                          the restriction on this sprint is that
 *                          `lib/services/**` is not to be modified, and a gateway
 *                          importing the product surface it also guards is the
 *                          coupling this seam exists to avoid. The duplication is
 *                          named where it lives, in `lib/safety/lexicon.ts`, and
 *                          `tests/safety/redTeam.test.ts` pins that every product
 *                          pattern still fires here, so a divergence fails rather
 *                          than drifts.
 * - `COERCIVE_PRESSURE`  — the candidate threatens, issues an ultimatum, or
 *                          removes the person's option to decline. New ground:
 *                          the product surface has no equivalent, and its
 *                          `strategyAlignmentErrors` checks that a pressure
 *                          message matches its *strategy*, never that the
 *                          strategy was permissible.
 * - `PRESSURE_INTENSITY_EXCEEDED`
 *                        — the candidate's declared pressure outranks the
 *                          budget's `maxIntensity`.
 * - `PERSISTENCE_CLAIMED`
 *                        — the text says something was saved, created,
 *                          scheduled or completed while no effect in the
 *                          candidate performs a write.
 *
 *                          **Deliberately stricter** than the product's
 *                          equivalent. `semanticValidationErrors` fires
 *                          `no-change message implies persistence` only when the
 *                          plan explicitly declares `stateChange: 'none'`; a plan
 *                          that declares no `stateChange` at all reaches none of
 *                          those branches. Here the trigger is the absence of a
 *                          writing effect, so a candidate that simply omits the
 *                          field is caught rather than exempted. That gap is the
 *                          Sprint 08 "unreachable outcome" shape: the branch was
 *                          reachable, the condition that selects it was not.
 * - `UNCONFIRMED_WRITE_PROPOSED`
 *                        — an effect of kind `canonical_write`, or a
 *                          `propose_write` with `requiresConfirmation: false`.
 *                          The persistence boundary. `STATE_WRITE_POLICY` says
 *                          intelligence modules may not write canonical state
 *                          directly; this is the code that observes one trying.
 * - `INSTRUCTION_ECHOED` — the candidate reproduces text from a span that
 *                          `INJECTED_INSTRUCTION` fired on. The output half of
 *                          the injection boundary: the request being attacked is
 *                          not the same event as the attack succeeding, and only
 *                          this one means something already went wrong inside
 *                          the producer.
 */
export type SafetyPostCode =
  | 'UNKNOWN_CANDIDATE_SHAPE'
  | 'CANDIDATE_EXCEEDS_LIMIT'
  | 'UNSOURCED_CLAIM'
  | 'EVIDENCE_GRAPH_MALFORMED'
  | 'CLAIM_NOT_TRACEABLE'
  | 'INSTANT_MALFORMED'
  | 'FABRICATED_INSTANT'
  | 'RAW_IDENTIFIER_DISCLOSED'
  | 'SENSITIVE_TEXT_DISCLOSED'
  | 'SHAMING_LANGUAGE'
  | 'COERCIVE_PRESSURE'
  | 'PRESSURE_INTENSITY_EXCEEDED'
  | 'PERSISTENCE_CLAIMED'
  | 'UNCONFIRMED_WRITE_PROPOSED'
  | 'INSTRUCTION_ECHOED';

export type SafetyReasonCode = SafetyPreCode | SafetyPostCode;

export const SAFETY_PRE_CODES = Object.freeze([
  'REQUEST_UNREADABLE',
  'REQUEST_EXCEEDS_LIMIT',
  'EVALUATION_INSTANT_INVALID',
  'INJECTED_INSTRUCTION',
  'UNTRUSTED_CONTENT_IN_TRUSTED_SLOT',
  'SENSITIVE_SCOPE_NOT_PERMITTED',
  'PRESSURE_BUDGET_EXHAUSTED',
] as const) satisfies readonly SafetyPreCode[];

export const SAFETY_POST_CODES = Object.freeze([
  'UNKNOWN_CANDIDATE_SHAPE',
  'CANDIDATE_EXCEEDS_LIMIT',
  'UNSOURCED_CLAIM',
  'EVIDENCE_GRAPH_MALFORMED',
  'CLAIM_NOT_TRACEABLE',
  'INSTANT_MALFORMED',
  'FABRICATED_INSTANT',
  'RAW_IDENTIFIER_DISCLOSED',
  'SENSITIVE_TEXT_DISCLOSED',
  'SHAMING_LANGUAGE',
  'COERCIVE_PRESSURE',
  'PRESSURE_INTENSITY_EXCEEDED',
  'PERSISTENCE_CLAIMED',
  'UNCONFIRMED_WRITE_PROPOSED',
  'INSTRUCTION_ECHOED',
] as const) satisfies readonly SafetyPostCode[];

type _PreCodesCovered =
  Exclude<SafetyPreCode, (typeof SAFETY_PRE_CODES)[number]> extends never ? true : never;
const _preCodesAreExhaustive: _PreCodesCovered = true;
export const SAFETY_PRE_CODE_COVERAGE = _preCodesAreExhaustive;

type _PostCodesCovered =
  Exclude<SafetyPostCode, (typeof SAFETY_POST_CODES)[number]> extends never ? true : never;
const _postCodesAreExhaustive: _PostCodesCovered = true;
export const SAFETY_POST_CODE_COVERAGE = _postCodesAreExhaustive;

/**
 * The two partitions as one value, so a test can iterate them.
 *
 * Unlike `REASON_CODE_PARTITIONS` in `recommendationContracts`, these two **are**
 * disjoint, and that is checkable rather than assumed —
 * `tests/safety/policyContract.test.ts` asserts the intersection is empty. The
 * partition contracts which position a code may appear in: a `SafetyPreFinding`
 * cannot carry a post code and the type says so, which matters because a
 * pre-validator has no candidate and so cannot possibly have observed one.
 */
export const SAFETY_CODE_PARTITIONS = Object.freeze({
  pre: SAFETY_PRE_CODES,
  post: SAFETY_POST_CODES,
});

export const SAFETY_REASON_CODES = Object.freeze([
  ...SAFETY_PRE_CODES,
  ...SAFETY_POST_CODES,
] as const) satisfies readonly SafetyReasonCode[];

/**
 * The five boundaries the issue names, plus two the gateway needs in order to
 * enforce them.
 *
 * `provenance` and `integrity` are additions and are called out rather than
 * folded into a neighbour. `provenance` is the claim-to-evidence boundary — it
 * is where Sprint 08's graph is reused, and it is the boundary #38 submits to;
 * filing `UNSOURCED_CLAIM` under `hallucinated_time` would be wrong, because
 * most unsourced claims are not about time. `integrity` is the gateway's
 * judgement about itself: `REQUEST_UNREADABLE`, `UNKNOWN_CANDIDATE_SHAPE` and
 * `CANDIDATE_EXCEEDS_LIMIT` are the cases where the check cannot be performed,
 * and the fail-closed rule is that a check that cannot run is a check that
 * refuses. Putting them under a content boundary would report a content problem
 * for a plumbing failure.
 *
 * This grouping is **orthogonal** to the stage partition, and it is derived from
 * `SAFETY_CODE_BOUNDARIES` rather than listed again, so the two cannot disagree
 * about which codes exist.
 */
export type SafetyBoundary =
  | 'privacy'
  | 'harmful_pressure'
  | 'injection'
  | 'hallucinated_time'
  | 'persistence'
  | 'provenance'
  | 'integrity';

export const SAFETY_BOUNDARIES = Object.freeze([
  'privacy',
  'harmful_pressure',
  'injection',
  'hallucinated_time',
  'persistence',
  'provenance',
  'integrity',
] as const) satisfies readonly SafetyBoundary[];

/** Total: every code names exactly one boundary. */
export const SAFETY_CODE_BOUNDARIES: Readonly<Record<SafetyReasonCode, SafetyBoundary>> = Object.freeze({
  REQUEST_UNREADABLE: 'integrity',
  REQUEST_EXCEEDS_LIMIT: 'integrity',
  EVALUATION_INSTANT_INVALID: 'hallucinated_time',
  INJECTED_INSTRUCTION: 'injection',
  UNTRUSTED_CONTENT_IN_TRUSTED_SLOT: 'injection',
  SENSITIVE_SCOPE_NOT_PERMITTED: 'privacy',
  PRESSURE_BUDGET_EXHAUSTED: 'harmful_pressure',
  UNKNOWN_CANDIDATE_SHAPE: 'integrity',
  CANDIDATE_EXCEEDS_LIMIT: 'integrity',
  UNSOURCED_CLAIM: 'provenance',
  EVIDENCE_GRAPH_MALFORMED: 'provenance',
  CLAIM_NOT_TRACEABLE: 'provenance',
  INSTANT_MALFORMED: 'hallucinated_time',
  FABRICATED_INSTANT: 'hallucinated_time',
  RAW_IDENTIFIER_DISCLOSED: 'privacy',
  SENSITIVE_TEXT_DISCLOSED: 'privacy',
  SHAMING_LANGUAGE: 'harmful_pressure',
  COERCIVE_PRESSURE: 'harmful_pressure',
  PRESSURE_INTENSITY_EXCEEDED: 'harmful_pressure',
  PERSISTENCE_CLAIMED: 'persistence',
  UNCONFIRMED_WRITE_PROPOSED: 'persistence',
  INSTRUCTION_ECHOED: 'injection',
});

/** Derived, never listed twice. */
export function codesForBoundary(boundary: SafetyBoundary): readonly SafetyReasonCode[] {
  return SAFETY_REASON_CODES.filter((code) => SAFETY_CODE_BOUNDARIES[code] === boundary);
}

/** Total: every code names the stage that may emit it. Derived from the partitions. */
export const SAFETY_CODE_STAGES: Readonly<Record<SafetyReasonCode, SafetyStage>> = Object.freeze(
  Object.fromEntries([
    ...SAFETY_PRE_CODES.map((code) => [code, 'pre' as SafetyStage]),
    ...SAFETY_POST_CODES.map((code) => [code, 'post' as SafetyStage]),
  ]) as Record<SafetyReasonCode, SafetyStage>,
);

/* ── Blast radius and recovery ───────────────────────────────────── */

/**
 * How much a finding is allowed to stop.
 *
 * `candidate` refuses this one output and nothing else — the producer may build
 * another and resubmit. `surface` pauses one surface until the condition that
 * caused it changes. There is deliberately **no `session` and no `user`**: a
 * safety check that can lock a person out of the product is a denial of service
 * with a safety justification, and the acceptance criterion says fail-closed
 * behaviour must be *scoped* and *recoverable*.
 *
 * `tests/safety/policyContract.test.ts` asserts every code maps to `candidate`
 * or `surface`, which is why the table is exported rather than kept private.
 */
export type SafetyBlockScope = 'candidate' | 'surface';

export const SAFETY_BLOCK_SCOPES = Object.freeze([
  'candidate',
  'surface',
] as const) satisfies readonly SafetyBlockScope[];

/**
 * Total. Only `PRESSURE_BUDGET_EXHAUSTED` reaches `surface`, and it is the one
 * condition that is genuinely about the surface rather than about this output:
 * rebuilding the candidate cannot fix it, and waiting can.
 */
export const SAFETY_CODE_SCOPES: Readonly<Record<SafetyReasonCode, SafetyBlockScope>> = Object.freeze({
  REQUEST_UNREADABLE: 'candidate',
  REQUEST_EXCEEDS_LIMIT: 'candidate',
  EVALUATION_INSTANT_INVALID: 'candidate',
  INJECTED_INSTRUCTION: 'candidate',
  UNTRUSTED_CONTENT_IN_TRUSTED_SLOT: 'candidate',
  SENSITIVE_SCOPE_NOT_PERMITTED: 'candidate',
  PRESSURE_BUDGET_EXHAUSTED: 'surface',
  UNKNOWN_CANDIDATE_SHAPE: 'candidate',
  CANDIDATE_EXCEEDS_LIMIT: 'candidate',
  UNSOURCED_CLAIM: 'candidate',
  EVIDENCE_GRAPH_MALFORMED: 'candidate',
  CLAIM_NOT_TRACEABLE: 'candidate',
  INSTANT_MALFORMED: 'candidate',
  FABRICATED_INSTANT: 'candidate',
  RAW_IDENTIFIER_DISCLOSED: 'candidate',
  SENSITIVE_TEXT_DISCLOSED: 'candidate',
  SHAMING_LANGUAGE: 'candidate',
  COERCIVE_PRESSURE: 'candidate',
  PRESSURE_INTENSITY_EXCEEDED: 'candidate',
  PERSISTENCE_CLAIMED: 'candidate',
  UNCONFIRMED_WRITE_PROPOSED: 'candidate',
  INSTRUCTION_ECHOED: 'candidate',
});

/**
 * What a finding does to the verdict.
 *
 * `redactable` means dropping the offending segment is a genuine fix — the rest
 * of the candidate was fine and the person still gets something. `blocking`
 * means it is not: the defect is in what the candidate *claims*, and deleting a
 * sentence does not make an unsourced claim sourced.
 *
 * **A redactable finding with no segment to drop escalates to blocking.** That
 * is the fail-closed direction and it is enforced in
 * `lib/safety/gateway.ts`, not merely documented — a `RAW_IDENTIFIER_DISCLOSED`
 * whose `segmentIndex` is null names nothing a renderer can remove, so
 * "redact it" would resolve to "show it".
 */
export type SafetySeverity = 'blocking' | 'redactable';

export const SAFETY_CODE_SEVERITY: Readonly<Record<SafetyReasonCode, SafetySeverity>> = Object.freeze({
  REQUEST_UNREADABLE: 'blocking',
  REQUEST_EXCEEDS_LIMIT: 'blocking',
  EVALUATION_INSTANT_INVALID: 'blocking',
  INJECTED_INSTRUCTION: 'blocking',
  UNTRUSTED_CONTENT_IN_TRUSTED_SLOT: 'blocking',
  SENSITIVE_SCOPE_NOT_PERMITTED: 'blocking',
  PRESSURE_BUDGET_EXHAUSTED: 'blocking',
  UNKNOWN_CANDIDATE_SHAPE: 'blocking',
  CANDIDATE_EXCEEDS_LIMIT: 'blocking',
  UNSOURCED_CLAIM: 'blocking',
  EVIDENCE_GRAPH_MALFORMED: 'blocking',
  CLAIM_NOT_TRACEABLE: 'blocking',
  INSTANT_MALFORMED: 'blocking',
  FABRICATED_INSTANT: 'blocking',
  RAW_IDENTIFIER_DISCLOSED: 'redactable',
  SENSITIVE_TEXT_DISCLOSED: 'redactable',
  SHAMING_LANGUAGE: 'blocking',
  COERCIVE_PRESSURE: 'blocking',
  PRESSURE_INTENSITY_EXCEEDED: 'blocking',
  PERSISTENCE_CLAIMED: 'blocking',
  UNCONFIRMED_WRITE_PROPOSED: 'blocking',
  INSTRUCTION_ECHOED: 'redactable',
});

/**
 * What the person is offered when something is refused.
 *
 * A closed vocabulary of *kinds*, not rendered sentences. The pilot's
 * `BaselineScore.evidenceLabels` is the cautionary case Sprint 08 recorded: a
 * pre-rendered English fragment is lossy, cannot be localised, and cannot be
 * compared to anything without parsing it back. A `SafeUserPath` is a decision;
 * the words are the surface's job.
 *
 * - `retry_without_sensitive_context` — the request can be rebuilt from less
 *   exposed inputs and answered properly.
 * - `show_evidence_only` — drop the prose, show the facts that were actually
 *   read. Always available, because it makes no claims of its own.
 * - `ask_user_to_confirm` — the action is legitimate but must be a decision the
 *   person makes, not one the system takes.
 * - `offer_neutral_acknowledgement` — say something true and small instead of
 *   the thing that was refused.
 * - `defer_to_user_choice` — hand the choice back untouched.
 * - `surface_nothing_and_explain` — show nothing, and say that something was
 *   withheld and why, in the surface's own words. The last resort, and still a
 *   path: silence with no explanation is what makes a safety system feel like a
 *   malfunction.
 */
export type SafeUserPathKind =
  | 'retry_without_sensitive_context'
  | 'show_evidence_only'
  | 'ask_user_to_confirm'
  | 'offer_neutral_acknowledgement'
  | 'defer_to_user_choice'
  | 'surface_nothing_and_explain';

export const SAFE_USER_PATH_KINDS = Object.freeze([
  'retry_without_sensitive_context',
  'show_evidence_only',
  'ask_user_to_confirm',
  'offer_neutral_acknowledgement',
  'defer_to_user_choice',
  'surface_nothing_and_explain',
] as const) satisfies readonly SafeUserPathKind[];

/**
 * The offered path.
 *
 * `retryAdmissible` is the recoverability half of the acceptance criterion,
 * stated as data: it says whether a corrected resubmission can succeed at all.
 * It is false only for `PRESSURE_BUDGET_EXHAUSTED`, where the fix is time rather
 * than a better candidate — and there `retryAfter` carries the instant, computed
 * from the request's `now` and the caller's own interval.
 *
 * No field here holds free text, so no field here can hold leaked text.
 */
export interface SafeUserPath {
  readonly kind: SafeUserPathKind;
  readonly retryAdmissible: boolean;
  /** Non-null only when waiting is the fix. Derived from the request's `now`. */
  readonly retryAfter: Instant | null;
}

/**
 * Total: every reason code names the path offered when it is the deciding
 * finding.
 *
 * Being total is the mechanism behind "all blocked actions give a safe user
 * path". A new code cannot be added to `SafetyReasonCode` without this record
 * failing to typecheck, so the criterion cannot be quietly outgrown — which is
 * the failure mode Sprint 08 named for vocabularies that are enumerated
 * nowhere.
 */
export const SAFETY_CODE_RECOVERY: Readonly<Record<SafetyReasonCode, SafeUserPathKind>> = Object.freeze({
  REQUEST_UNREADABLE: 'surface_nothing_and_explain',
  REQUEST_EXCEEDS_LIMIT: 'surface_nothing_and_explain',
  EVALUATION_INSTANT_INVALID: 'show_evidence_only',
  INJECTED_INSTRUCTION: 'retry_without_sensitive_context',
  UNTRUSTED_CONTENT_IN_TRUSTED_SLOT: 'retry_without_sensitive_context',
  SENSITIVE_SCOPE_NOT_PERMITTED: 'retry_without_sensitive_context',
  PRESSURE_BUDGET_EXHAUSTED: 'defer_to_user_choice',
  UNKNOWN_CANDIDATE_SHAPE: 'surface_nothing_and_explain',
  CANDIDATE_EXCEEDS_LIMIT: 'surface_nothing_and_explain',
  UNSOURCED_CLAIM: 'show_evidence_only',
  EVIDENCE_GRAPH_MALFORMED: 'show_evidence_only',
  CLAIM_NOT_TRACEABLE: 'show_evidence_only',
  INSTANT_MALFORMED: 'show_evidence_only',
  FABRICATED_INSTANT: 'show_evidence_only',
  RAW_IDENTIFIER_DISCLOSED: 'offer_neutral_acknowledgement',
  SENSITIVE_TEXT_DISCLOSED: 'offer_neutral_acknowledgement',
  SHAMING_LANGUAGE: 'offer_neutral_acknowledgement',
  COERCIVE_PRESSURE: 'defer_to_user_choice',
  PRESSURE_INTENSITY_EXCEEDED: 'defer_to_user_choice',
  PERSISTENCE_CLAIMED: 'ask_user_to_confirm',
  UNCONFIRMED_WRITE_PROPOSED: 'ask_user_to_confirm',
  INSTRUCTION_ECHOED: 'offer_neutral_acknowledgement',
});

/* ── Findings ────────────────────────────────────────────────────── */

/**
 * One policy finding.
 *
 * **Every locator is an index into an input array**, never an identifier. See
 * decision 3 in the header: `inputId`, `claimId`, `candidateId`, `effectId` and
 * `nodeId` are all caller-chosen free strings, and Sprint 07's real leak went
 * out through exactly such a field while a test watched the title. An index
 * cannot carry content.
 *
 * `detail` is for humans and carries static prose plus numbers derived from the
 * input. It does not repeat `code`, does not quote any text, and does not name
 * any identifier. `checkSafetyAudit` proves it for a given decision rather than
 * trusting the convention.
 */
export interface SafetyFinding {
  readonly code: SafetyReasonCode;
  readonly stage: SafetyStage;
  readonly boundary: SafetyBoundary;
  readonly scope: SafetyBlockScope;
  readonly severity: SafetySeverity;
  /** Position in `SafetyRequest.inputs`, or null. */
  readonly inputIndex: number | null;
  /** Position in `SafetyCandidate.segments`, or null. */
  readonly segmentIndex: number | null;
  /** Position in `SafetyCandidate.claims`, or null. */
  readonly claimIndex: number | null;
  /** Position in `SafetyCandidate.evidence.nodes`, or null. */
  readonly nodeIndex: number | null;
  /** Position in `SafetyCandidate.effects`, or null. */
  readonly effectIndex: number | null;
  /** The bound that was broken, for `CANDIDATE_EXCEEDS_LIMIT`; null otherwise. */
  readonly limitName: SafetyLimitName | null;
  readonly detail: string;
}

/* ── The verdict ─────────────────────────────────────────────────── */

export type SafetyDisposition = 'allow' | 'allow_with_redaction' | 'block';

export const SAFETY_DISPOSITIONS = Object.freeze([
  'allow',
  'allow_with_redaction',
  'block',
] as const) satisfies readonly SafetyDisposition[];

/**
 * The central policy decision.
 *
 * Three variants and no `blocked: boolean` field, for the reason `OptionSet` has
 * three variants and no `primary`: a shape a consumer can render correctly while
 * ignoring half of it is a shape whose other half will be ignored. A renderer
 * here must destructure a disposition, and the two that withhold something both
 * carry a `SafeUserPath` — so there is no way to display a refusal without also
 * having the way out in hand.
 *
 * `allow` carries findings too, and they are always empty in practice today; the
 * field exists so that a future advisory severity has somewhere to go that is
 * not "a block nobody meant". `checkSafetyVerdict` reports
 * `ALLOW_WITH_BLOCKING_FINDING` if anything blocking ever appears there.
 *
 * `allow_with_redaction` names the segments to drop **by index**, non-empty —
 * because a redaction that names nothing is an allow wearing a warning label,
 * and that is the exact shape `CHOICE_BELOW_MINIMUM` was added to
 * `recommendationContracts` for.
 */
export type SafetyVerdict =
  | {
      readonly disposition: 'allow';
      readonly findings: readonly SafetyFinding[];
    }
  | {
      readonly disposition: 'allow_with_redaction';
      readonly findings: readonly [SafetyFinding, ...SafetyFinding[]];
      readonly redactedSegmentIndices: readonly [number, ...number[]];
      readonly recovery: SafeUserPath;
    }
  | {
      readonly disposition: 'block';
      readonly findings: readonly [SafetyFinding, ...SafetyFinding[]];
      readonly recovery: SafeUserPath;
    };

/**
 * The audit record.
 *
 * **There is no field of any type here that can hold candidate or input text.**
 * That is the acceptance criterion "sensitive raw text is not logged" expressed
 * structurally: a leak would have to be a `detail` string, and `checkSafetyAudit`
 * scans exactly those.
 *
 * `candidateDigest` is an opaque digest of what was judged, supplied by the
 * caller. Two consequences, both learned elsewhere:
 *
 *   - It is a *digest*, so the audit trail can prove two decisions were about
 *     the same content without storing the content. `ObservedEvidence.valueFingerprint`
 *     is the same device for the same reason.
 *   - It is computed **after** the decision, never before. `PLANNING_INPUT_POLICY`'s
 *     `digestAfterStaticPass` records why: Sprint 07 shipped a canonical digest
 *     computed ahead of the static pass, and it threw on exactly the NaN that
 *     pass existed to report. A gateway that hashes its input first fails on
 *     precisely the malformed inputs its report is for — which is every input a
 *     red team sends.
 */
export interface SafetyAuditRecord {
  readonly version: typeof SAFETY_CONTRACT_VERSION;
  readonly schemaVersion: typeof SAFETY_SCHEMA_VERSION;
  readonly auditId: string;
  /** From the request. This module never reads a clock. */
  readonly decidedAt: Instant;
  readonly surface: SafetySurface;
  readonly disposition: SafetyDisposition;
  readonly findings: readonly SafetyFinding[];
  /** Opaque digest of the judged content, computed after the decision. */
  readonly candidateDigest: string;
  readonly recovery: SafeUserPath | null;
}

/* ── Structural checking ─────────────────────────────────────────── */

/**
 * What can be structurally wrong with a verdict or its audit record.
 *
 * Separate from `SafetyReasonCode` on the terms `planningContracts` separates
 * static from attempt and `recommendationContracts` separates graph defects from
 * structure defects: "the candidate is unsafe" and "the verdict about it is
 * malformed" are different bugs owned by different code, and one flat list lets
 * a checker report the wrong owner.
 *
 * - `BLOCK_WITHOUT_FINDING`     — a refusal with nothing to point at.
 * - `BLOCK_WITHOUT_SAFE_PATH`   — a refusal with no way out. Unconstructible in
 *                                 the type and perfectly constructible by
 *                                 `JSON.parse`, which is why it is a code.
 * - `ALLOW_WITH_BLOCKING_FINDING`
 *                               — an `allow` carrying a finding whose severity
 *                                 is `blocking`. The quiet failure: the check
 *                                 ran, found the problem, and shipped anyway.
 * - `REDACTION_WITHOUT_TARGET`  — `allow_with_redaction` naming no segment.
 * - `REDACTION_TARGET_OUT_OF_RANGE`
 *                               — a redaction index that is not a segment
 *                                 position. A renderer that drops nothing shows
 *                                 everything.
 * - `REDACTION_MISSES_FINDING`  — a redactable finding names a segment the
 *                                 redaction list does not contain. The verdict
 *                                 says it handled something it did not.
 * - `UNKNOWN_SAFETY_CODE`       — a code this version does not know. Reported
 *                                 rather than ignored, so version skew between
 *                                 the gateway and a consumer is visible.
 * - `UNKNOWN_DISPOSITION`       — a disposition this version does not know.
 * - `FINDING_CLASSIFICATION_MISMATCH`
 *                               — a finding whose `stage`, `boundary`, `scope`
 *                                 or `severity` disagrees with the tables. The
 *                                 tables are what tests reason about; a finding
 *                                 that carries its own answer is a second copy
 *                                 of the classification.
 * - `FINDING_CAP_EXCEEDED`      — more findings than `SAFETY_LIMITS.maxFindings`.
 *                                 A bound on the *output*, because a crafted
 *                                 input that produces one finding per character
 *                                 turns a refusal into a payload.
 * - `AUDIT_INSTANT_INVALID`     — `decidedAt` is not an `Instant`.
 * - `AUDIT_DIGEST_MISSING`      — a blank digest. Blank digests compare equal to
 *                                 each other, so an audit trail of them can
 *                                 never show that two decisions were about
 *                                 different content — the same defect
 *                                 `EMPTY_FINGERPRINT` names in
 *                                 `recommendationContracts`.
 * - `AUDIT_DISPOSITION_MISMATCH`— the record disagrees with the verdict it
 *                                 records.
 * - `AUDIT_CONTAINS_RAW_TEXT`   — a `detail` reproduces a run of judged text.
 * - `AUDIT_CONTAINS_IDENTIFIER` — a `detail` contains a caller-chosen id.
 */
export type SafetyVerdictDefectCode =
  | 'BLOCK_WITHOUT_FINDING'
  | 'BLOCK_WITHOUT_SAFE_PATH'
  | 'ALLOW_WITH_BLOCKING_FINDING'
  | 'REDACTION_WITHOUT_TARGET'
  | 'REDACTION_TARGET_OUT_OF_RANGE'
  | 'REDACTION_MISSES_FINDING'
  | 'UNKNOWN_SAFETY_CODE'
  | 'UNKNOWN_DISPOSITION'
  | 'FINDING_CLASSIFICATION_MISMATCH'
  | 'FINDING_CAP_EXCEEDED'
  | 'AUDIT_INSTANT_INVALID'
  | 'AUDIT_DIGEST_MISSING'
  | 'AUDIT_DISPOSITION_MISMATCH'
  | 'AUDIT_CONTAINS_RAW_TEXT'
  | 'AUDIT_CONTAINS_IDENTIFIER';

export const SAFETY_VERDICT_DEFECT_CODES = Object.freeze([
  'BLOCK_WITHOUT_FINDING',
  'BLOCK_WITHOUT_SAFE_PATH',
  'ALLOW_WITH_BLOCKING_FINDING',
  'REDACTION_WITHOUT_TARGET',
  'REDACTION_TARGET_OUT_OF_RANGE',
  'REDACTION_MISSES_FINDING',
  'UNKNOWN_SAFETY_CODE',
  'UNKNOWN_DISPOSITION',
  'FINDING_CLASSIFICATION_MISMATCH',
  'FINDING_CAP_EXCEEDED',
  'AUDIT_INSTANT_INVALID',
  'AUDIT_DIGEST_MISSING',
  'AUDIT_DISPOSITION_MISMATCH',
  'AUDIT_CONTAINS_RAW_TEXT',
  'AUDIT_CONTAINS_IDENTIFIER',
] as const) satisfies readonly SafetyVerdictDefectCode[];

type _VerdictDefectCodesCovered =
  Exclude<SafetyVerdictDefectCode, (typeof SAFETY_VERDICT_DEFECT_CODES)[number]> extends never ? true : never;
const _verdictDefectCodesAreExhaustive: _VerdictDefectCodesCovered = true;
export const SAFETY_VERDICT_DEFECT_CODE_COVERAGE = _verdictDefectCodesAreExhaustive;

/**
 * One structural finding about a verdict.
 *
 * `findingIndex` is a position, on the same terms as every locator on
 * `SafetyFinding`.
 */
export interface SafetyVerdictDefect {
  readonly code: SafetyVerdictDefectCode;
  readonly findingIndex: number | null;
  readonly detail: string;
}

/** Blank, or not a string at all. Total, for the reason `isBlank` is in `recommendationContracts`. */
function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/**
 * Structural check over a verdict.
 *
 * Returns findings; **it does not throw, for any input.** That is
 * `SAFETY_INPUT_POLICY.reportWhatTheTaxonomyNames`, and it matters more here
 * than anywhere else in the repo: a safety checker that raises has not merely
 * failed to report, it has handed the decision to whichever caller forgot the
 * try/catch — and the default behaviour of an uncaught throw is not "refuse".
 *
 * Ordering is by input position, deliberately, and no string comparison is
 * involved. A contract must not import `lib/`, so sorting by code here would
 * mean either a second copy of `compareByCodePoint` (the Sprint 06 gap) or
 * `localeCompare`, whose result depends on the runtime's ICU data.
 *
 * The suppression rule, matching `planningContracts`: a finding is suppressed
 * only when it borrows a bound from something already reported malformed. An
 * unknown disposition suppresses the per-disposition checks, because each would
 * be a claim about a shape the verdict does not have. Nothing else is
 * suppressed.
 */
export function checkSafetyVerdict(
  verdict: SafetyVerdict,
  segmentCount: number,
): readonly SafetyVerdictDefect[] {
  const defects: SafetyVerdictDefect[] = [];
  if (verdict === null || verdict === undefined || typeof verdict !== 'object') {
    return [
      {
        code: 'UNKNOWN_DISPOSITION',
        findingIndex: null,
        detail: 'a verdict was checked that is not a verdict-shaped object',
      },
    ];
  }

  const findings = asArray<SafetyFinding>((verdict as { findings?: unknown }).findings);
  defects.push(...checkSafetyFindings(findings));

  if (findings.length > SAFETY_LIMITS.maxFindings) {
    defects.push({
      code: 'FINDING_CAP_EXCEEDED',
      findingIndex: null,
      detail: `the verdict carries ${findings.length} findings; the cap is ${SAFETY_LIMITS.maxFindings}`,
    });
  }

  const disposition = (verdict as { disposition?: unknown }).disposition;
  if (!(SAFETY_DISPOSITIONS as readonly unknown[]).includes(disposition)) {
    defects.push({
      code: 'UNKNOWN_DISPOSITION',
      findingIndex: null,
      detail: 'the verdict states a disposition this contract version does not recognise',
    });
    return defects;
  }

  const recovery = (verdict as { recovery?: SafeUserPath }).recovery;
  const hasRecovery =
    recovery !== null &&
    recovery !== undefined &&
    (SAFE_USER_PATH_KINDS as readonly unknown[]).includes(recovery.kind);

  if (disposition === 'allow') {
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      const severity = finding === null || finding === undefined ? undefined : finding.severity;
      if (severity === 'blocking') {
        defects.push({
          code: 'ALLOW_WITH_BLOCKING_FINDING',
          findingIndex: index,
          detail: 'the verdict allows the candidate while carrying a finding classified as blocking',
        });
      }
    }
    return defects;
  }

  if (findings.length === 0) {
    defects.push({
      code: 'BLOCK_WITHOUT_FINDING',
      findingIndex: null,
      detail: 'the verdict withholds output without naming a single reason',
    });
  }

  if (!hasRecovery) {
    defects.push({
      code: 'BLOCK_WITHOUT_SAFE_PATH',
      findingIndex: null,
      detail: 'the verdict withholds output without offering a safe path',
    });
  }

  if (disposition === 'block') return defects;

  const redacted = asArray<number>((verdict as { redactedSegmentIndices?: unknown }).redactedSegmentIndices);
  if (redacted.length === 0) {
    defects.push({
      code: 'REDACTION_WITHOUT_TARGET',
      findingIndex: null,
      detail: 'the verdict redacts the candidate while naming no segment to drop',
    });
  }
  for (const index of redacted) {
    if (!Number.isInteger(index) || index < 0 || index >= segmentCount) {
      defects.push({
        code: 'REDACTION_TARGET_OUT_OF_RANGE',
        findingIndex: null,
        detail: `a redaction names a position the candidate does not have; it carries ${segmentCount} segments`,
      });
    }
  }
  const redactedSet = new Set(redacted);
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    if (finding === null || finding === undefined) continue;
    if (finding.severity !== 'redactable') continue;
    if (finding.segmentIndex === null || finding.segmentIndex === undefined) continue;
    if (!redactedSet.has(finding.segmentIndex)) {
      defects.push({
        code: 'REDACTION_MISSES_FINDING',
        findingIndex: index,
        detail: 'a redactable finding names a segment the redaction list does not drop',
      });
    }
  }

  return defects;
}

/**
 * Check that each finding classifies itself the way the tables classify its code.
 *
 * The tables are what every test and every cross-track comparison reasons about.
 * A finding that carries its own `boundary` is a second copy of a
 * classification, and Sprint 06's recorded cost of two copies of one datum is
 * four review rounds — so the copy is checked against the source on every
 * verdict rather than trusted. The fields exist on the finding at all because a
 * consumer reading a serialised audit record should not have to import this
 * contract to know which boundary a code belongs to.
 */
export function checkSafetyFindings(findings: readonly SafetyFinding[]): readonly SafetyVerdictDefect[] {
  const defects: SafetyVerdictDefect[] = [];
  const list = asArray<SafetyFinding>(findings);
  for (let index = 0; index < list.length; index += 1) {
    const finding = list[index];
    if (finding === null || finding === undefined || typeof finding !== 'object') {
      defects.push({
        code: 'UNKNOWN_SAFETY_CODE',
        findingIndex: index,
        detail: 'a finding is not a finding-shaped object',
      });
      continue;
    }
    if (!(SAFETY_REASON_CODES as readonly unknown[]).includes(finding.code)) {
      defects.push({
        code: 'UNKNOWN_SAFETY_CODE',
        findingIndex: index,
        detail: 'a finding states a code this contract version does not recognise',
      });
      continue;
    }
    const code = finding.code;
    if (
      finding.stage !== SAFETY_CODE_STAGES[code] ||
      finding.boundary !== SAFETY_CODE_BOUNDARIES[code] ||
      finding.scope !== SAFETY_CODE_SCOPES[code] ||
      finding.severity !== SAFETY_CODE_SEVERITY[code]
    ) {
      defects.push({
        code: 'FINDING_CLASSIFICATION_MISMATCH',
        findingIndex: index,
        detail: 'a finding classifies its own code differently from the policy tables',
      });
    }
  }
  return defects;
}

/**
 * The strings an audit record must not contain.
 *
 * Passed as data rather than derived from a candidate, so that the check is
 * usable by a caller that holds only the record and the secrets — a log
 * inspector, a retention job — and so that this contract needs no opinion about
 * where the text came from.
 *
 * `minimumRunLength` exists because a leak test with no floor reports every
 * record as leaking: the word `the` appears in most user text and in most static
 * prose. Sprint 08's lesson about instruments applies — a check that always
 * fires and a check that never fires are equally uninformative. Eight is short
 * enough to catch a fragment and long enough that ordinary English does not
 * trip it; it is stated here rather than inside the function so a test can
 * probe both sides of it.
 */
export interface AuditLeakSources {
  /** Raw text that was judged. Never stored; only compared against. */
  readonly texts: readonly string[];
  /** Caller-chosen identifiers of every kind. */
  readonly identifiers: readonly string[];
  readonly minimumRunLength: number;
}

export const AUDIT_LEAK_DEFAULT_RUN_LENGTH = 8;

/**
 * Check an audit record against the content it is about.
 *
 * This is the executable form of "sensitive raw text is not logged". The record
 * type has no field that can hold text, so the only surface a leak can reach is
 * a `detail` string — and Sprint 07's real leak went out through exactly such a
 * field, reading `working window call-dr.cohen-about-the-biopsy`, past a test
 * that checked only that the title was absent. So identifiers are checked too,
 * on equal terms: an id is a free string people fill with content, and a
 * character-class filter does not help because the problem is not the
 * characters.
 *
 * Reports; never throws. Ordering is by finding position.
 */
export function checkSafetyAudit(
  record: SafetyAuditRecord,
  verdict: SafetyVerdict,
  leakSources: AuditLeakSources,
): readonly SafetyVerdictDefect[] {
  const defects: SafetyVerdictDefect[] = [];
  if (record === null || record === undefined || typeof record !== 'object') {
    return [
      {
        code: 'AUDIT_DISPOSITION_MISMATCH',
        findingIndex: null,
        detail: 'an audit record was checked that is not a record-shaped object',
      },
    ];
  }

  if (!isInstant(record.decidedAt)) {
    defects.push({
      code: 'AUDIT_INSTANT_INVALID',
      findingIndex: null,
      detail: 'the audit record states a decision time that is not a well-formed instant',
    });
  }

  if (isBlank(record.candidateDigest)) {
    defects.push({
      code: 'AUDIT_DIGEST_MISSING',
      findingIndex: null,
      detail: 'the audit record carries no digest of what it judged',
    });
  }

  const verdictDisposition =
    verdict === null || verdict === undefined ? undefined : (verdict as { disposition?: unknown }).disposition;
  if (record.disposition !== verdictDisposition) {
    defects.push({
      code: 'AUDIT_DISPOSITION_MISMATCH',
      findingIndex: null,
      detail: 'the audit record states a different disposition from the verdict it records',
    });
  }

  const runLength =
    leakSources === null || leakSources === undefined || !Number.isInteger(leakSources.minimumRunLength)
      ? AUDIT_LEAK_DEFAULT_RUN_LENGTH
      : Math.max(1, leakSources.minimumRunLength);
  const texts = asArray<string>(leakSources === null || leakSources === undefined ? [] : leakSources.texts);
  const identifiers = asArray<string>(
    leakSources === null || leakSources === undefined ? [] : leakSources.identifiers,
  );

  const findings = asArray<SafetyFinding>(record.findings);
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    const detail = finding === null || finding === undefined ? '' : finding.detail;
    if (typeof detail !== 'string' || detail.length === 0) continue;

    for (const identifier of identifiers) {
      if (typeof identifier !== 'string' || identifier.length === 0) continue;
      if (detail.includes(identifier)) {
        defects.push({
          code: 'AUDIT_CONTAINS_IDENTIFIER',
          findingIndex: index,
          detail: 'a finding detail reproduces a caller-chosen identifier',
        });
        break;
      }
    }

    if (sharesTextRunWith(detail, texts, runLength)) {
      defects.push({
        code: 'AUDIT_CONTAINS_RAW_TEXT',
        findingIndex: index,
        detail: 'a finding detail reproduces a run of the text it judged',
      });
    }
  }

  return defects;
}

/**
 * Does `haystack` contain any substring of `length` or more characters that also
 * appears in one of `sources`?
 *
 * Exported because two callers need this judgement and neither should own a
 * second copy of it: `checkSafetyAudit` asks it about a finding detail, and
 * `lib/safety/postValidator.ts` asks it about a user-visible segment against a
 * span classified `sensitive`. They are the same question — "does this text
 * reproduce that text" — and Sprint 06's recorded cost of answering one question
 * in two places is four review rounds.
 *
 * A sliding window over the *source*, which is the direction that matters: the
 * detail is short static prose and the source can be long, so windowing the
 * source and probing the detail keeps the work proportional to the input the
 * caller controls — bounded by `SAFETY_LIMITS.maxUntrustedInputChars`, which is
 * why that limit is enforced before this ever runs.
 *
 * Case-insensitive and whitespace-collapsed, because a leak that survives
 * lowercasing is still a leak and Sprint 08's lesson about instruments is that
 * the comfortable check is the one that finds nothing.
 */
export function sharesTextRunWith(haystack: string, sources: readonly string[], length: number): boolean {
  if (typeof haystack !== 'string' || haystack.length === 0) return false;
  if (!Number.isInteger(length) || length < 1) return false;
  const normalizedHaystack = haystack.toLowerCase().replace(/\s+/g, ' ');
  for (const source of sources) {
    if (typeof source !== 'string') continue;
    const normalized = source.toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length < length) continue;
    for (let start = 0; start + length <= normalized.length; start += 1) {
      if (normalizedHaystack.includes(normalized.slice(start, start + length))) return true;
    }
  }
  return false;
}

/* ── Instant arithmetic ──────────────────────────────────────────── */

/**
 * Epoch millis, or null when the value is not an `Instant`.
 *
 * **The judgement of what a valid instant is stays `isInstant`'s**, which is
 * Sprint 08's and is imported, not re-derived. `Date.parse` is reached only for
 * values `isInstant` has already accepted, so every permissive reading it would
 * otherwise allow is unreachable from here: a bare `'2026'`, a date-time with no
 * offset, and `'2026-02-30T00:00:00Z'` — which `Date.parse` silently repairs to
 * the 2nd of March — are all rejected before this line runs.
 *
 * Writing a second regex here instead would be the exact duplication this sprint
 * was told twice to avoid, and it would be the dangerous half of it: two
 * spellings of "what is a valid instant" agree until one of them is tightened.
 */
function millisOf(value: unknown): number | null {
  if (!isInstant(value)) return null;
  const parsed = Date.parse(value as unknown as string);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Do two instants denote the same moment?
 *
 * Numeric comparison, never string equality. `'2026-01-01T00:00:00Z'` and
 * `'2026-01-01T00:00:00.000+00:00'` are the same moment and different strings,
 * and the hallucinated-time check compares an instant a *candidate* states
 * against an instant an *observation* carries — two fields written by two
 * producers, which is precisely where the formats differ. String equality would
 * report a fabrication for a correctly sourced time, and a suite built around it
 * would then be "fixed" by loosening the check.
 *
 * Returns false when either side is not an instant: "these are equal" is a claim,
 * and an unparseable value supports no claim. `INSTANT_MALFORMED` is the code
 * for that condition, reported separately rather than folded in here.
 */
export function instantsEqual(left: unknown, right: unknown): boolean {
  const leftMillis = millisOf(left);
  if (leftMillis === null) return false;
  const rightMillis = millisOf(right);
  if (rightMillis === null) return false;
  return leftMillis === rightMillis;
}

/**
 * `to - from` in milliseconds, or null when either side is not an instant.
 *
 * Null rather than 0, and that is the fail-closed direction: 0 would read as
 * "no time has passed", which is the answer that makes a cooldown check *pass*
 * on an unreadable timestamp. A caller receiving null must decide explicitly,
 * and `lib/safety/preValidator.ts` decides by reporting
 * `EVALUATION_INSTANT_INVALID` and suppressing the interval judgement, because
 * that judgement borrows its bound from the field that did not parse.
 */
export function millisBetweenInstants(from: unknown, to: unknown): number | null {
  const fromMillis = millisOf(from);
  if (fromMillis === null) return null;
  const toMillis = millisOf(to);
  if (toMillis === null) return null;
  return toMillis - fromMillis;
}

/* ── Policy ──────────────────────────────────────────────────────── */

/**
 * What a safety entry point may do with input it cannot use.
 *
 * The rule `PLANNING_INPUT_POLICY` and `RECOMMENDATION_INPUT_POLICY` state,
 * carried here rather than imported so a reader of this contract does not have
 * to know Sprint 07's or Sprint 08's to know the rule — and stated as its own
 * value because the extra clauses are this module's own.
 *
 * `unreadableInputIsBlocked` is the fail-closed direction. An input the gateway
 * cannot parse resolves to a refusal, never to an allow: a check that becomes
 * permissive exactly when it stops understanding its input is a check that any
 * attacker can disable by malforming the request.
 *
 * `blockScopeNeverExceedsSurface` is the other half of the same criterion, and
 * it points the opposite way. Fail-closed without a scope is a denial of
 * service; `SAFETY_CODE_SCOPES` has no `session` member and the policy contract
 * test asserts it.
 */
export const SAFETY_INPUT_POLICY = Object.freeze({
  reportWhatTheTaxonomyNames: true,
  throwOnlyWhenNoCodeApplies: true,
  digestAfterStaticPass: true,
  unreadableInputIsBlocked: true,
  blockScopeNeverExceedsSurface: true,
  everyBlockOffersASafePath: true,
});

/**
 * The persistence and disclosure boundary, on the same terms every intelligence
 * module in this repo has one.
 *
 * `rawInputInAudit: false` is the one this sprint is judged on, and it is
 * enforced by `checkSafetyAudit` rather than asserted here. Sprint 08 recorded
 * what a policy flag with no enforcement is worth.
 */
export const SAFETY_PERSISTENCE_POLICY = Object.freeze({
  /** A verdict is a decision about an output. It is never canonical user state. */
  verdictCanPersist: false,
  /** The gateway never writes; it can only refuse. */
  gatewayPerformsNoWrites: true,
  adapterOwnsCanonicalWrites: true,
  rawInputInAudit: false,
  /** Every instant comes from an explicit input; no `Date.now()`, ever. */
  noAmbientClock: true,
  /** A candidate the gateway cannot judge is not shown. */
  unjudgeableCandidateIsNotOfferable: true,
  /** Every refusal names a path the person can still take. */
  everyRefusalIsRecoverable: true,
});
