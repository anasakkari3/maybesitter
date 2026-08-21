/**
 * Shadow pipeline contracts (Sprint 11, issues #45 / #46 / #47).
 *
 * The shadow pipeline answers one question — **what would Capture through
 * Coaching have produced for this scope, had it been allowed to speak** — and
 * answers it as an *inert* object: a result nobody can apply, a trace that
 * explains every part of it, and a bundle a second run can be checked against.
 * #45 builds the orchestrator on these shapes, #46 builds SLOs and the
 * privacy-safe-log reconciliation on them, #47 builds staged exposure, consent
 * and the go/hold/rollback evidence package on them. This file is the only
 * thing the three tracks share, so it carries all three surfaces rather than
 * only the orchestrator's.
 *
 * ── Relationship to `alphaTraceContracts`: two traces, one named seam ────
 *
 * `AlphaTraceSession` already exists and is stage-based, so the overlap has to
 * be examined rather than inherited — an unexamined overlap between two trace
 * systems is the "data shared, rule not shared" defect this repo has already
 * paid for. The decision: **separate systems, one field of seam, arrow in one
 * direction.**
 *
 *   - An `AlphaTraceSession` is a trace of a *person's session*. It is keyed by
 *     `participantId`, its stages are user-visible events
 *     (`recommendation_shown`, `proposal_decided`), and its payloads carry raw
 *     content on purpose: `InputReceivedPayload.inputText`,
 *     `ProposalEditedPayload.originalTitle`. It answers "what did this person
 *     see, and what did they do about it".
 *   - A `ShadowPipelineTrace` is a trace of *one run of the chain*. It is keyed
 *     by `runId`, has exactly one record per module in
 *     `SHADOW_PIPELINE_CHAIN`, and no field of it can hold content: every
 *     value-bearing field is a closed vocabulary, a position, a number, or a
 *     digest. It answers "why did this run produce this outcome".
 *
 * They are not the same trace and merging them would be the expensive mistake
 * in the cheap direction. A shadow run has no `recommendation_shown` stage
 * because nothing is shown — that is what "shadow" means; and #46's acceptance
 * criterion is that *privacy-safe logs reconcile with traces*, which is a
 * criterion about the artifact reconciled against, so folding a stage
 * vocabulary that includes `inputText` into it would put raw content on the one
 * side of the reconciliation that must not have any.
 *
 * The seam is one nullable field, `ShadowPipelineTrace.alphaSessionId`, typed
 * as `AlphaTraceSession['sessionId']` so a change to the alpha identifier's
 * type breaks this file rather than drifting from it. Nothing else crosses: no
 * payload flows either way, and this file imports `alphaTraceContracts` for
 * that one type and nothing else. Once staged exposure passes `shadow_only`
 * (see `SHADOW_EXPOSURE_STAGES`) a shadow run may be attached to a session, and
 * `alphaSessionId` is the whole of the attachment.
 *
 * What is deliberately *not* reconciled and is named rather than hidden: the
 * alpha trace's "raw content never reaches analytics" rule lives in its header
 * as prose, while the same rule lives here as the shape of the types. If a
 * later sprint wants one rule, the direction is to give the alpha trace this
 * file's discipline, not to give this file the alpha trace's payloads.
 *
 * ── Structural decisions ─────────────────────────────────────────────────
 *
 *  1. **A shadow result cannot mutate canonical state, in the type.** Not "we
 *     do not call the writer" — `ShadowPipelineOutcome` is constrained to
 *     `ShadowInertValue`, a recursive type admitting only null, booleans,
 *     numbers, strings, arrays of those, and objects of those. A function is
 *     not assignable to it, so a writer, a store handle, an `apply()`, or a
 *     bound command added to any field of the outcome at any depth is a
 *     **compile error** at `SHADOW_OUTCOME_INERTNESS`, not a review comment.
 *     Every effect the pipeline would have had is a `ShadowEffectProposal`
 *     whose `status` is the literal `'proposed_never_applied'` — there is no
 *     value of that type that says "applied" — and which has no method at all,
 *     because it cannot have one.
 *
 *     This is why the outcome-side shapes in this file are written as `type`
 *     aliases rather than `interface`s, which is a real deviation from house
 *     style and is load-bearing: TypeScript gives an implicit index signature
 *     to an object *type alias* and not to an `interface`, so
 *     `SomeInterface extends ShadowInertValue` is `never` no matter what the
 *     interface contains. Written as interfaces the inertness witness would
 *     fail for correct shapes and would then be "fixed" by deleting it, which
 *     is how a structural guarantee becomes a comment.
 *
 *     `checkShadowInertness` is the untyped-boundary twin: a walker that
 *     reports `OUTCOME_CARRIES_CALLABLE` for a function reachable from any
 *     depth of a value that arrived through `JSON.parse` or an `any`.
 *
 *     **What is still possible, and what guards it instead.** The type says
 *     nothing about the *callee*. `INTELLIGENCE_MODULE_CONTRACTS` names real
 *     entry points — `createFileRuntimeMemoryStore` writes files — and an
 *     orchestrator that invokes one can cause a write regardless of how inert
 *     its return value is. That half is guarded by
 *     `moduleContracts.STATE_WRITE_POLICY`, by `allowsDirectStateWrites: false`
 *     on every descriptor, and by `SHADOW_WRITE_SURFACE` here, which states as
 *     data that a shadow adapter is invoked read-only and that the
 *     enforcement — a boundary test over the adapter set — belongs to the
 *     implementation phase, where there are adapters to enforce it over. A
 *     contract that claimed to close that half would be claiming something no
 *     type in it can check.
 *
 *  2. **Degradation is a variant, at both levels.** Per module,
 *     `ShadowModuleOutcome` is a five-variant union — `completed`,
 *     `fell_back`, `skipped`, `timed_out`, `unavailable` — where only the
 *     first two carry an `outputDigest` and the last three carry
 *     `contributed: false` *in the type*. Per pipeline,
 *     `ShadowPipelineOutcome` is a three-variant union on `completeness`:
 *     `complete` (every chain module contributed; `degradation: null`),
 *     `degraded` (a usable deliverable plus a non-empty tuple of the modules
 *     that did not contribute), and `withheld` (`deliverable: null`). A caller
 *     cannot read a partial result as complete because a `degraded` outcome
 *     has no shape a `complete` reader matches, and `withheld` has nothing to
 *     read.
 *
 *     `withheld` exists because "one module failure degrades safely" is not
 *     the same sentence for every module. `SHADOW_MODULE_FAILURE_STANCE` says
 *     which: seven modules are `degrade_open` — losing memory or planning
 *     costs quality — and `safety` is `fail_closed`, because a run whose
 *     safety gate did not complete has not been gated, and reporting its
 *     coaching output as a merely-degraded deliverable is exactly the failure
 *     the gateway exists to prevent. Degrading safely, for the guard, means
 *     withholding.
 *
 *  3. **The trace explains each downstream decision, and a decision without an
 *     explanation is a reportable defect.** `checkShadowTrace` takes the trace
 *     *and* the outcome and cross-checks them: a chain module with no stage is
 *     `TRACE_STAGE_MISSING`; a stage whose status disagrees with the module
 *     outcome is `TRACE_STAGE_STATUS_MISMATCH`; a non-`completed` status with
 *     `reason: null` is `TRACE_REASON_MISSING`; a reason inadmissible for its
 *     status (a `timed_out` stage blaming `feature_disabled`) is
 *     `TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS`; a proposal in the outcome that
 *     no stage claims is `TRACE_PROPOSAL_UNEXPLAINED`; and a stage that says it
 *     fell back for a reason its own `ModuleRuntimeDecision` contradicts is
 *     `TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION`. The reason vocabulary is
 *     `RulesOnlyFallbackReason` *extended*, not restated — the three runtime
 *     spellings are imported and a fourth added there without being added here
 *     fails to compile at `_FallbackReasonsCovered`.
 *
 *  4. **The replay bundle carries a preimage, not a hash.** A contract must not
 *     import `lib/`, and a second sha256 preimage spelling would drift, so this
 *     file owns the *canonical serialization* (`shadowReplayPreimage`) and the
 *     caller owns the hash. The preimage is emitted **positionally**, from
 *     `SHADOW_REPLAY_PREIMAGE_SECTIONS` and the declared chain order, and never
 *     by sorting object keys — which also means this file needs no comparator
 *     and therefore cannot grow a fifth spelling of one (`compareByCodePoint`
 *     in `lib/planning/shared/compare.ts` is the repo's only one, and
 *     `localeCompare` is banned outright because its answer moves with `LANG`).
 *     Fields are separated by `US`/`RS` control characters that
 *     `SHADOW_SAFE_CODE` and `Instant` cannot contain, so a caller cannot forge
 *     a field boundary out of a `runId` — a preimage a caller can forge is not
 *     a digest, and `RUN_ID_UNSAFE` is the code for the attempt.
 *     `checkShadowReplay` localises a disagreement to the module it happened
 *     in (`REPLAY_MODULE_STATUS_DIVERGED`) rather than only reporting that two
 *     digests differ.
 *
 *  5. **Every declared budget is per-module, named, and reachable.**
 *     `SHADOW_MODULE_TIMEOUT_BUDGET_MS` is total over the chain, each entry
 *     carries its rationale, and `checkShadowTrace` reaches every one from both
 *     sides: `TRACE_COMPLETED_EXCEEDS_BUDGET` for a stage that finished past
 *     its budget and `TRACE_TIMEOUT_WITHIN_BUDGET` for a stage that claims a
 *     timeout it did not reach. `SHADOW_PIPELINE_TOTAL_BUDGET_MS` is a separate
 *     declared ceiling rather than a computed sum, and
 *     `checkShadowBudgetTable` reports `TOTAL_BUDGET_BELOW_SUM_OF_MODULES` when
 *     an edit to one module's budget pushes the sum past it. A limit that
 *     exists only as a number is documentation of an intention.
 *
 *  6. **No go decision may rest on engagement, in the same vocabulary Sprint 10
 *     used.** `SHADOW_RELEASE_GATE_INVARIANT` is
 *     `'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE'` held by `satisfies
 *     PersonalizationInvariant`, so it is #41's invariant reused rather than a
 *     parallel one that agrees until one is edited. A `ShadowEvidencePackage`
 *     carries `Readonly<Record<ShadowEvidencePillar, ShadowEvidenceBundle>>`
 *     over exactly `quality | safety | reliability`, each a non-empty tuple —
 *     so a package missing a pillar does not compile — and a `go` decision
 *     whose support in any pillar is engagement-class only is
 *     `GO_RESTS_ON_ENGAGEMENT_ALONE`.
 *
 * ── What is reused rather than rebuilt ───────────────────────────────────
 *
 *   - `ModuleFeatureFlags`, `ModuleKillSwitches`, `ModuleRuntimeDecision`,
 *     `RulesOnlyFallbackReason` — `runtimeControls`' flags and kill switches
 *     are the flags and kill switches. This file adds no second switch; the
 *     trace *carries* the decision `resolveModuleRuntime` returned.
 *   - `Instant`, `isInstant`, `millisBetweenInstants` — Sprint 08/09's time
 *     judgement, imported through `safetyContracts` rather than re-spelled.
 *     Every instant in this file comes from the caller; nothing reads a clock.
 *   - `PersonalizationDeletionReceipt` and `checkPersonalizationDeletionReceipt`
 *     — Sprint 10's verifiable-deletion pattern, **composed** rather than
 *     copied: `ShadowStudyDeletionReceipt` embeds the personalization receipt
 *     whole and adds the three stores this sprint introduces (traces, replay
 *     bundles, study responses), and its checker delegates, re-coding the inner
 *     findings under `SHADOW_NESTED_RECEIPT_DEFECT` so one deletion vocabulary
 *     covers both. A second receipt would be two answers to "is it gone".
 *   - `PERSONALIZATION_INVARIANTS` — the release-gate invariant, per decision 6.
 *   - `IntelligenceModuleName`, `ContractErrorCode`, `MODULE_CONTRACT_VERSION`
 *     — `moduleContracts` is orchestrator-owned and this file does not edit it.
 *
 * ── What is deliberately restated, and how the restatement is pinned ─────
 *
 * A contract must not import `lib/`; the arrow runs `lib → contracts` and
 * `lib/pilot/pilotAccess.ts` already imports `runtimeControls`, so importing it
 * back would close the cycle whose TDZ crash the `decomposition` descriptor in
 * `moduleContracts` records. So `PilotStopReason`, `PilotExposureDecision`'s
 * shape, the participant-id and safe-code patterns, and
 * `CLOSED_PILOT_MINIMUM`/`MAXIMUM` are restated here — and every restatement is
 * pinned by `tests/contract/shadowPipelineContracts.test.ts`, which *may*
 * import `lib/` and does: the stop-reason list is pinned in both directions by
 * assignability, the caps against the imported constants, and the patterns
 * behaviourally against `requirePilotParticipantId` and `createPilotAuditEvent`.
 * The duplication is named and it fails rather than drifts. Same for
 * `SHADOW_FORBIDDEN_LOG_KEY_CLASSES`, pinned by driving each class through
 * `lib/analytics/privacySafeEvents.validateAnalyticsEvent` and demanding the
 * `private property is forbidden` verdict — #46's reconciliation target
 * enforcing this file's list, rather than the two agreeing by coincidence.
 *
 * ── Versioning and cycles ────────────────────────────────────────────────
 *
 * `SHADOW_PIPELINE_SCHEMA_VERSION` is the literal `'shadow-pipeline-v1'`. When
 * integration adds a `shadowPipeline` descriptor to
 * `INTELLIGENCE_MODULE_CONTRACTS` it must spell that literal there too, for the
 * reason the `decomposition`, `planning`, `recommendation`, `coaching` and
 * `safety` descriptors all record: importing the version back closes a cycle
 * that ESM resolves by evaluating this file before `moduleContracts`' body has
 * run, which is a TDZ `ReferenceError` at import time that `tsc` reports
 * nothing about. The chain here is
 * `shadowPipeline → personalization → safety → recommendation → planning` and
 * `shadowPipeline → runtimeControls → moduleContracts`, with no reverse edge.
 */

import {
  INTELLIGENCE_MODULES,
  MODULE_CONTRACT_VERSION,
  type ContractErrorCode,
  type IntelligenceModuleName,
} from './moduleContracts';
import type {
  ModuleFeatureFlags,
  ModuleKillSwitches,
  ModuleRuntimeDecision,
  RulesOnlyFallbackReason,
  RuntimeControlSnapshot,
} from './runtimeControls';
import {
  SAFETY_DISPOSITIONS,
  isInstant,
  millisBetweenInstants,
  type Instant,
  type SafetyDisposition,
} from './safetyContracts';
import {
  PERSONALIZATION_INVARIANTS,
  checkPersonalizationDeletionReceipt,
  type PersonalizationDefect,
  type PersonalizationDeletionReceipt,
  type PersonalizationInvariant,
} from './personalizationContracts';
import type { AlphaTraceSession } from './alphaTraceContracts';

export const SHADOW_PIPELINE_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const SHADOW_PIPELINE_SCHEMA_VERSION = 'shadow-pipeline-v1' as const;

/**
 * Re-exported so a consumer of this contract does not have to know which sprint
 * built the time judgement or the runtime switches in order to read a trace.
 * `isInstant` and `millisBetweenInstants` are *value* re-exports on purpose:
 * the checkers below use them, and a type-only edge would let a consumer grow
 * its own second answer to "is this a well-formed instant".
 */
export { PERSONALIZATION_INVARIANTS, SAFETY_DISPOSITIONS, isInstant, millisBetweenInstants };
export type {
  Instant,
  ModuleFeatureFlags,
  ModuleKillSwitches,
  ModuleRuntimeDecision,
  PersonalizationDeletionReceipt,
  PersonalizationInvariant,
  RulesOnlyFallbackReason,
  RuntimeControlSnapshot,
  SafetyDisposition,
};

/* ── The chain ───────────────────────────────────────────────────── */

/**
 * The modules a shadow run walks, in execution order.
 *
 * Capture through Coaching, as the issue names it, plus the two the chain
 * cannot honestly skip. `priority` is in the chain although
 * `INTELLIGENCE_MODULE_CONTRACTS` still describes it as
 * `not_implemented_in_sprint_00`: a placeholder in the chain is the honest
 * modelling of where it actually sits, and pretending the chain runs
 * memory → decomposition would hide the gap rather than report it. See
 * `SHADOW_MODULE_ROLES` for how a placeholder is handled — it can never report
 * `completed`.
 *
 * `safety` runs **after** `coaching` and not before it, because the gate is
 * defined over a candidate output and there is no candidate until coaching has
 * produced one (`INTELLIGENCE_MODULE_CONTRACTS.coaching` states the same
 * dependency from the other side: coaching output is "withheld unless the
 * Safety gateway allows it"). It is last in the chain and first in
 * consequence — see `SHADOW_MODULE_FAILURE_STANCE`.
 *
 * **A consequence worth stating rather than discovering:** because `priority`
 * is a placeholder and a placeholder can never report `completed`, no run in
 * this sprint can be `completeness: 'complete'`. The best a Sprint 11 shadow run
 * achieves is `degraded` with `priority` skipped for `module_placeholder` — and
 * that is the honest answer, not a defect. `complete` exists in the union
 * because the chain will one day have no stubs in it, and because a
 * `COMPLETE_WITH_NON_CONTRIBUTOR` finding needs a shape to be about. The
 * contract test pins this: a run that claims completion while the chain contains
 * a placeholder is reported.
 *
 * `lifeState`, `feedback` and `evaluation` are deliberately absent.
 * `lifeState` is a projection a caller reads, not a stage a run walks;
 * `feedback` and `evaluation` are about runs that already happened, and a
 * pipeline that evaluated itself mid-run would be a check owned by the thing it
 * checks — Sprint 05's rule.
 */
export const SHADOW_PIPELINE_CHAIN = Object.freeze([
  'capture',
  'memory',
  'priority',
  'decomposition',
  'planning',
  'recommendation',
  'coaching',
  'safety',
] as const) satisfies readonly IntelligenceModuleName[];

export type ShadowPipelineModule = (typeof SHADOW_PIPELINE_CHAIN)[number];

/**
 * Position in the chain, as data, so the trace's ordering check and the replay
 * preimage's emission order read the same table instead of each re-deriving
 * one. Total over the chain by construction of the mapped type.
 */
export const SHADOW_PIPELINE_CHAIN_POSITION: Readonly<Record<ShadowPipelineModule, number>> =
  Object.freeze({
    capture: 0,
    memory: 1,
    priority: 2,
    decomposition: 3,
    planning: 4,
    recommendation: 5,
    coaching: 6,
    safety: 7,
  });

/**
 * Whether a module has a real implementation behind it in this sprint.
 *
 * Read off `INTELLIGENCE_MODULE_CONTRACTS`' descriptors rather than guessed,
 * and restated here as data rather than derived at runtime, because deriving it
 * would mean calling `execute` on every descriptor to read its `status` — a
 * registry that is a descriptor table by design (`moduleContracts` says so) and
 * a routing hub the moment anyone treats it as one. `MODULE_ROLE_UNKNOWN` is
 * not a defect code because the record is total: a module added to the chain
 * without a role fails to typecheck.
 *
 * A `placeholder` module may **never** report `completed`: it has nothing to
 * complete. `checkShadowPipelineOutcome` reports
 * `PLACEHOLDER_MODULE_CLAIMS_COMPLETION` for the claim, which is the honest
 * handling — the alternative, quietly counting a placeholder as a contributor,
 * would make `completeness: 'complete'` mean "seven modules ran and one
 * returned a stub".
 */
export type ShadowModuleRole = 'implemented' | 'placeholder';

export const SHADOW_MODULE_ROLES: Readonly<Record<ShadowPipelineModule, ShadowModuleRole>> =
  Object.freeze({
    capture: 'implemented',
    memory: 'implemented',
    priority: 'placeholder',
    decomposition: 'implemented',
    planning: 'implemented',
    recommendation: 'implemented',
    coaching: 'implemented',
    safety: 'implemented',
  });

/**
 * What a module's non-contribution costs the run.
 *
 * `degrade_open` — the run continues and the deliverable is poorer. Losing
 * `memory` costs context; losing `planning` costs scheduling quality. The
 * acceptance criterion "one module failure degrades safely" is this stance.
 *
 * `fail_closed` — the run may not report a deliverable at all. `safety` is the
 * only one, and it is not an exception to the criterion but the correct
 * reading of it: a run whose gate did not execute has not been gated, and a
 * deliverable labelled merely `degraded` would be an ungated output wearing a
 * quality caveat. Degrading safely, for a guard, is withholding —
 * `SHADOW_WITHHOLD_REASONS.fail_closed_module_did_not_contribute`.
 */
export type ShadowFailureStance = 'degrade_open' | 'fail_closed';

export const SHADOW_MODULE_FAILURE_STANCE: Readonly<
  Record<ShadowPipelineModule, ShadowFailureStance>
> = Object.freeze({
  capture: 'degrade_open',
  memory: 'degrade_open',
  priority: 'degrade_open',
  decomposition: 'degrade_open',
  planning: 'degrade_open',
  recommendation: 'degrade_open',
  coaching: 'degrade_open',
  safety: 'fail_closed',
});

/* ── Budgets: declared, per-module, reachable ────────────────────── */

/**
 * The wall-clock a module gets before the orchestrator abandons it, in
 * milliseconds, per module and never as one shared number.
 *
 * A shared budget is the shape that makes a slow module invisible: the run
 * times out, the trace says "the pipeline was slow", and nothing names which
 * stage spent the time. Every number below is reached from both sides by
 * `checkShadowTrace` — `TRACE_COMPLETED_EXCEEDS_BUDGET` and
 * `TRACE_TIMEOUT_WITHIN_BUDGET` — and the contract test derives its fixtures
 * from these constants while pinning the values themselves against literals,
 * because a suite that builds its probes out of the constant it is testing
 * proves only that arithmetic works (Sprint 10's review found every floor
 * mutable in both directions that way).
 *
 * The rationale per module, in one sentence each:
 *
 *   - `capture` (1500) — the only module that parses untrusted free text, and
 *     the only one a person is waiting on in the non-shadow path; the shipped
 *     extractor's rules pass plus a model fallback fits here.
 *   - `memory` (400) — a bounded retrieval over a file-backed store. If it is
 *     slower than this the store is the problem, and waiting longer converts a
 *     store problem into a pipeline problem.
 *   - `priority` (250) — a placeholder returning a stub. Deliberately the
 *     smallest budget in the chain: a stub that needs a quarter-second is a
 *     defect, and a generous budget on a placeholder is a budget nobody
 *     revisits when the real implementation lands.
 *   - `decomposition` (1200) — rules detector plus splits over one commitment's
 *     text; the second-largest because it is the second text-shaped stage.
 *   - `planning` (900) — constraint normalisation and placement over a bounded
 *     horizon; arithmetic, not search.
 *   - `recommendation` (800) — candidate selection and evidence-graph
 *     resolution over already-computed inputs.
 *   - `coaching` (1500) — realisation of a message, the other generative stage.
 *   - `safety` (600) — validators over a candidate that already exists. Small
 *     on purpose and small in the direction that matters: this is the
 *     `fail_closed` module, so a budget it routinely misses converts every run
 *     into a withheld one, which is loud rather than silent. A guard that is
 *     slow should stop the line.
 */
export const SHADOW_MODULE_TIMEOUT_BUDGET_MS: Readonly<Record<ShadowPipelineModule, number>> =
  Object.freeze({
    capture: 1_500,
    memory: 400,
    priority: 250,
    decomposition: 1_200,
    planning: 900,
    recommendation: 800,
    coaching: 1_500,
    safety: 600,
  });

/**
 * The whole run's ceiling, in milliseconds.
 *
 * **A declared number, not the sum**, and the difference is the point. The sum
 * of the module budgets is 7,150; this is 8,000. The 850ms of headroom is
 * orchestration — adapter construction, trace assembly, digest computation —
 * and stating it as its own constant means a future edit that raises a module
 * budget is checked against the ceiling rather than silently raising it too.
 * `checkShadowBudgetTable` reports `TOTAL_BUDGET_BELOW_SUM_OF_MODULES` when the
 * headroom goes negative, so the relationship between the two numbers is a
 * test rather than a comment. The contract test reaches it by mutating a copy
 * of the table, which is the only way to reach a limit whose violation is
 * currently impossible.
 */
export const SHADOW_PIPELINE_TOTAL_BUDGET_MS = 8_000;

/**
 * Structural bounds, one frozen object on the `SAFETY_LIMITS` pattern: the name
 * is derived from the keys, `SHADOW_EXCEEDS_LIMIT` carries the key, and the
 * contract test iterates the keys and demands a finding for each. A limit no
 * test can name is documentation of an intention, and Sprint 08's
 * `maxEvidenceRefsPerReason` — declared beside enforced limits, enforced
 * nowhere, 8.2 seconds of CPU on an unauthenticated route — is why.
 *
 * The numbers are generous by construction. Their job is to stop a pathological
 * producer from turning a linear check quadratic, not to express an opinion:
 * `maxProposedEffects` at 64 is eight per chain module, `maxTraceStages` at 32
 * is four times the chain length so a duplicated-stage bug is reported as a
 * duplicate rather than as an overflow, and the two evidence bounds are sized
 * so a real go/hold package is nowhere near them.
 */
export const SHADOW_PIPELINE_LIMITS = Object.freeze({
  maxProposedEffects: 64,
  maxTraceStages: 32,
  maxEvidenceItemsPerPillar: 32,
  maxSloReadingsPerPackage: 64,
});

export type ShadowPipelineLimitName = keyof typeof SHADOW_PIPELINE_LIMITS;

/**
 * Emission order is the declaration order of the object, not a sort: this file
 * owns no comparator (see the header's note on `compareByCodePoint`), and a
 * fixed declared order is deterministic without one.
 */
export const SHADOW_PIPELINE_LIMIT_NAMES = Object.freeze(
  Object.keys(SHADOW_PIPELINE_LIMITS) as ShadowPipelineLimitName[],
);

/* ── Inertness: the shape a shadow result is allowed to have ─────── */

/**
 * Everything a shadow result may be made of: JSON, and nothing else.
 *
 * The recursion is the whole mechanism. A function is not assignable to
 * `{ readonly [key: string]: ShadowInertValue }` at any depth, so a writer, a
 * store handle, a bound command, an `apply()`, a `commit()`, or a class
 * instance with methods placed on any field of a shadow outcome makes
 * `SHADOW_OUTCOME_INERTNESS` fail to compile. "Shadow results cannot mutate
 * canonical state" is therefore a property of the type rather than a promise
 * about the orchestrator's discipline.
 *
 * `undefined` is deliberately absent: this contract uses required-and-nullable
 * throughout, so a producer that forgets a field is told by the compiler rather
 * than defaulted into meaning something, and admitting `undefined` here would
 * quietly re-open optionality for every field of every outcome.
 */
export type ShadowInertValue =
  | null
  | boolean
  | number
  | string
  | readonly ShadowInertValue[]
  | { readonly [key: string]: ShadowInertValue };

/**
 * Adds the implicit index signature an `interface` does not have, for the one
 * place this file must prove inertness about a shape it does not own.
 *
 * Homomorphic and shallow on purpose: it converts the *outer* interface and
 * leaves nested ones alone, so wrapping a type does not launder its contents.
 * Used only on `RuntimeControlSnapshot`, whose two fields are already mapped
 * types over booleans.
 */
export type ShadowInert<T> = { readonly [K in keyof T]: T[K] };

/**
 * What the type does *not* close, stated as data rather than left to be
 * discovered.
 *
 * `outcomeCarriesNoCallable` is closed by `SHADOW_OUTCOME_INERTNESS` and
 * `checkShadowInertness`. The other three are not closed by anything in this
 * file, and saying so is the point: `moduleAdapterMayReachIO` is true because
 * `INTELLIGENCE_MODULE_CONTRACTS` names entry points that write files, and an
 * inert return value says nothing about a callee's side effects. The
 * enforcement named in `adapterEnforcement` belongs to the implementation
 * phase, where there is an adapter set to enforce it over; a contract that
 * asserted it here would be asserting something no type in it can check.
 */
export const SHADOW_WRITE_SURFACE = Object.freeze({
  /** Closed here, in the type. */
  outcomeCarriesNoCallable: true,
  /** Closed here: no shape in this file has an apply/commit/write member. */
  proposalHasNoApplyMethod: true,
  /** Closed here: `ShadowPipelineInput` carries digests, not store handles. */
  inputCarriesNoStoreHandle: true,
  /** NOT closed here — a module's own entry point can perform I/O. */
  moduleAdapterMayReachIO: true,
  /** Where the other half is enforced. */
  adapterEnforcement: 'implementation-phase boundary test over the shadow adapter set',
  /** The repo-level rule this rides on, restated so the seam is named. */
  canonicalWritePath: 'Intelligence -> deterministic service command -> persistence adapter',
});

/* ── Proposed effects: what the run would have done ──────────────── */

/**
 * The canonical stores a shadow run would have touched, had it been live.
 *
 * Closed, because #46 counts proposals by target and #47's evidence package
 * cites them; a free-text target would make "what would this have changed" a
 * sentence the orchestrator improvises per call.
 */
export type ShadowEffectTarget =
  | 'commitment_store'
  | 'proposal_store'
  | 'plan_store'
  | 'runtime_memory'
  | 'notification_queue'
  | 'feedback_log';

export const SHADOW_EFFECT_TARGETS = Object.freeze([
  'commitment_store',
  'proposal_store',
  'plan_store',
  'runtime_memory',
  'notification_queue',
  'feedback_log',
] as const) satisfies readonly ShadowEffectTarget[];

export type ShadowEffectKind = 'create' | 'update' | 'supersede' | 'schedule' | 'notify';

export const SHADOW_EFFECT_KINDS = Object.freeze([
  'create',
  'update',
  'supersede',
  'schedule',
  'notify',
] as const) satisfies readonly ShadowEffectKind[];

/**
 * One effect the pipeline would have caused, as a proposal that cannot be
 * applied.
 *
 * Three things make that structural rather than aspirational. There is no
 * method — the type is an alias constrained to `ShadowInertValue`, so a method
 * cannot be added without breaking `SHADOW_OUTCOME_INERTNESS`. `status` is the
 * literal `'proposed_never_applied'`, so there is no value of this type that
 * says an effect happened; a producer that wants to claim otherwise has to
 * invent a different type, which is a review event. And `payloadDigest` is a
 * digest rather than a payload: the proposal describes *that* a write was
 * proposed and against which target, never the bytes, so a proposal cannot
 * carry raw personal text into #46's logs — the Sprint 07 leak rule, where a
 * detail reading `call-dr.cohen-about-the-biopsy` passed a test that checked
 * only that titles were absent.
 *
 * `proposedBy` is a chain module, so every proposal is attributable to the
 * stage that made it, which is what lets `TRACE_PROPOSAL_UNEXPLAINED` exist.
 */
export type ShadowEffectProposal = {
  readonly status: 'proposed_never_applied';
  readonly proposedBy: ShadowPipelineModule;
  readonly target: ShadowEffectTarget;
  readonly kind: ShadowEffectKind;
  /** Digest of what would have been written. Never the payload itself. */
  readonly payloadDigest: string;
};

/* ── Per-module outcome: degradation as a variant ────────────────── */

export type ShadowModuleStatus =
  | 'completed'
  | 'fell_back'
  | 'skipped'
  | 'timed_out'
  | 'unavailable';

export const SHADOW_MODULE_STATUSES = Object.freeze([
  'completed',
  'fell_back',
  'skipped',
  'timed_out',
  'unavailable',
] as const) satisfies readonly ShadowModuleStatus[];

/**
 * Why a module did not simply complete.
 *
 * The first three spellings are `RulesOnlyFallbackReason` **imported**, not
 * restated: `runtimeControls` owns the taxonomy of why a module ran rules-only,
 * and a second copy here would agree until one of them was extended.
 * `_FallbackReasonsCovered` below is the pin in the other direction — a fourth
 * reason added to `runtimeControls` without being added to
 * `SHADOW_STAGE_REASONS` fails to compile.
 *
 * The five this file adds are the ones a *pipeline* has and a single module
 * does not:
 *
 *   - `module_placeholder`          — the module is `placeholder` in
 *                                     `SHADOW_MODULE_ROLES`. Named separately
 *                                     from `module_unavailable` because "no
 *                                     implementation exists yet" and "the
 *                                     implementation did not answer" are
 *                                     different facts, and #46 alerts on one
 *                                     of them and not the other.
 *   - `upstream_did_not_contribute` — a module skipped because something
 *                                     earlier in the chain it needed did not
 *                                     produce anything. This is the reason that
 *                                     makes a degraded run explicable: one
 *                                     failure at position 1 shows up as one
 *                                     `unavailable` and a run of skips that
 *                                     each name their cause.
 *   - `budget_exhausted`            — the module's own budget in
 *                                     `SHADOW_MODULE_TIMEOUT_BUDGET_MS`.
 *   - `module_error`                — the module answered with a
 *                                     `ModuleErrorResult`.
 *   - `exposure_not_granted`        — `resolveShadowExposure` refused. A stage
 *                                     reason rather than a pipeline-level one
 *                                     because exposure is resolved per module:
 *                                     `shadow_only` runs the chain and shows
 *                                     nobody, which is a different shape from
 *                                     not running it.
 */
export type ShadowStageReason =
  | RulesOnlyFallbackReason
  | 'module_placeholder'
  | 'upstream_did_not_contribute'
  | 'budget_exhausted'
  | 'module_error'
  | 'exposure_not_granted';

export const SHADOW_STAGE_REASONS = Object.freeze([
  'feature_disabled',
  'kill_switch_active',
  'module_unavailable',
  'module_placeholder',
  'upstream_did_not_contribute',
  'budget_exhausted',
  'module_error',
  'exposure_not_granted',
] as const) satisfies readonly ShadowStageReason[];

type _StageReasonsCovered =
  Exclude<ShadowStageReason, (typeof SHADOW_STAGE_REASONS)[number]> extends never ? true : never;
const _stageReasonsAreExhaustive: _StageReasonsCovered = true;
export const SHADOW_STAGE_REASON_COVERAGE = _stageReasonsAreExhaustive;

/**
 * The named seam with `runtimeControls`, as a compile-time assertion rather
 * than a comment: every `RulesOnlyFallbackReason` must be a `ShadowStageReason`.
 * A fourth fallback reason added there and forgotten here is a build failure in
 * this file, which is where someone would otherwise notice it in production.
 */
type _FallbackReasonsCovered =
  Exclude<RulesOnlyFallbackReason, ShadowStageReason> extends never ? true : never;
const _fallbackReasonsAreCovered: _FallbackReasonsCovered = true;
export const SHADOW_FALLBACK_REASON_COVERAGE = _fallbackReasonsAreCovered;

/**
 * Which reasons may explain which status.
 *
 * Total over both axes, so a status added without an admissibility row fails to
 * typecheck. The table is the reason `TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS`
 * can exist: without it, "the module timed out because the feature was
 * disabled" is a sentence a trace can contain and no checker can object to,
 * and a trace that accepts incoherent explanations explains nothing.
 *
 * `completed` admits none — a completed stage that also states a reason is
 * `TRACE_COMPLETED_STAGE_STATES_REASON`, the quiet failure where a module
 * succeeded and the trace says it did not.
 */
export const SHADOW_STAGE_REASON_ADMISSIBILITY: Readonly<
  Record<ShadowModuleStatus, readonly ShadowStageReason[]>
> = Object.freeze({
  completed: Object.freeze([] as const),
  fell_back: Object.freeze([
    'feature_disabled',
    'kill_switch_active',
    'module_unavailable',
    'module_error',
  ] as const),
  skipped: Object.freeze([
    'module_placeholder',
    'upstream_did_not_contribute',
    'exposure_not_granted',
    'feature_disabled',
    'kill_switch_active',
  ] as const),
  timed_out: Object.freeze(['budget_exhausted'] as const),
  unavailable: Object.freeze(['module_unavailable', 'module_error'] as const),
});

/**
 * A module that ran and answered. The only status that may carry a real output
 * digest and claim the module's own semantics.
 */
export type ShadowCompletedModuleOutcome = {
  readonly status: 'completed';
  readonly module: ShadowPipelineModule;
  readonly contributed: true;
  readonly reason: null;
  readonly failureCode: null;
  readonly outputDigest: string;
  readonly elapsedMs: number;
};

/**
 * A module that answered in rules-only mode. Still `contributed: true`: a
 * rules-only answer is an answer, and `RulesOnlyFallbackContract` already
 * states that capture remains available and no model executed. Treating it as
 * non-contribution would make every flag-off run look like a failure, which is
 * how a kill switch stops being usable.
 */
export type ShadowFellBackModuleOutcome = {
  readonly status: 'fell_back';
  readonly module: ShadowPipelineModule;
  readonly contributed: true;
  readonly reason: ShadowStageReason;
  readonly failureCode: null;
  readonly outputDigest: string;
  readonly elapsedMs: number;
};

/** Not run at all. `outputDigest: null` in the type — there is nothing to hash. */
export type ShadowSkippedModuleOutcome = {
  readonly status: 'skipped';
  readonly module: ShadowPipelineModule;
  readonly contributed: false;
  readonly reason: ShadowStageReason;
  readonly failureCode: null;
  readonly outputDigest: null;
  readonly elapsedMs: number;
};

/**
 * Abandoned at its budget. Carries the budget it broke as well as the elapsed
 * time, so a reader of the outcome alone — without the table — can see how far
 * past the line the module went.
 */
export type ShadowTimedOutModuleOutcome = {
  readonly status: 'timed_out';
  readonly module: ShadowPipelineModule;
  readonly contributed: false;
  readonly reason: 'budget_exhausted';
  readonly failureCode: null;
  readonly outputDigest: null;
  readonly elapsedMs: number;
  readonly budgetMs: number;
};

/**
 * Ran and failed. `failureCode` is `moduleContracts.ContractErrorCode` — the
 * repo's one error vocabulary, imported, because a second list of ways a module
 * can fail is a second list to keep in step with the first.
 */
export type ShadowUnavailableModuleOutcome = {
  readonly status: 'unavailable';
  readonly module: ShadowPipelineModule;
  readonly contributed: false;
  readonly reason: ShadowStageReason;
  readonly failureCode: ContractErrorCode;
  readonly outputDigest: null;
  readonly elapsedMs: number;
};

export type ShadowModuleOutcome =
  | ShadowCompletedModuleOutcome
  | ShadowFellBackModuleOutcome
  | ShadowSkippedModuleOutcome
  | ShadowTimedOutModuleOutcome
  | ShadowUnavailableModuleOutcome;

/* ── Pipeline outcome: complete, degraded, or withheld ───────────── */

/**
 * What the run would have produced.
 *
 * Digests rather than content, for the reason `ShadowEffectProposal` carries a
 * `payloadDigest`: this object is the one #46 reconciles logs against, and the
 * reconciliation surface must be the side with no raw text on it. A reviewer
 * who needs the actual message reads it from the module's own store under the
 * module's own access rules; the shadow outcome proves *which* message by
 * digest and says nothing about what it said.
 *
 * `safetyDisposition` is `safetyContracts.SafetyDisposition` imported, not a
 * fourth spelling of allow/redact/block. `wouldHaveBeenShown` is derived from
 * it and from exposure, and it is a separate field rather than a computation
 * because it is the one fact a shadow release exists to learn: the answer is
 * `false` for every run at stage `shadow_only`, and a run that says otherwise
 * is `DELIVERABLE_CLAIMS_EXPOSURE_AT_SHADOW_ONLY`.
 */
export type ShadowDeliverable = {
  readonly coachingDeliveryDigest: string;
  readonly safetyDisposition: SafetyDisposition;
  readonly wouldHaveBeenShown: boolean;
  readonly proposedEffects: readonly ShadowEffectProposal[];
};

/**
 * The modules that did not contribute, as a non-empty tuple.
 *
 * Non-empty because a `degraded` outcome that degraded in no module is a
 * `complete` outcome wearing a caveat — the same defect
 * `allow_with_redaction` avoids by requiring a non-empty
 * `redactedSegmentIndices`. The tuple is a producer's contract and therefore
 * the right tool here; `DEGRADED_WITHOUT_DEGRADATION` covers the untyped
 * boundary, where `JSON.parse` can still write an empty array.
 */
export type ShadowDegradation = {
  readonly nonContributingModules: readonly [ShadowPipelineModule, ...ShadowPipelineModule[]];
  /** True when any non-contributor is `fail_closed` in `SHADOW_MODULE_FAILURE_STANCE`. */
  readonly crossedFailClosedModule: boolean;
};

/**
 * Why a run produced nothing usable.
 *
 * `fail_closed_module_did_not_contribute` is the `safety` case from decision 2.
 * `chain_never_started` is the honest name for a run refused before capture —
 * a global kill switch, or an exposure decision that refused the whole chain —
 * and it is distinguished from the first because #46 alerts on one and not the
 * other: a run withheld because the gate broke is an incident, a run withheld
 * because someone turned the pipeline off is the kill switch working.
 * `total_budget_exhausted` is the orchestration ceiling in
 * `SHADOW_PIPELINE_TOTAL_BUDGET_MS`, which is a different fact from any single
 * module's `timed_out`.
 */
export type ShadowWithholdReason =
  | 'fail_closed_module_did_not_contribute'
  | 'chain_never_started'
  | 'total_budget_exhausted';

export const SHADOW_WITHHOLD_REASONS = Object.freeze([
  'fail_closed_module_did_not_contribute',
  'chain_never_started',
  'total_budget_exhausted',
] as const) satisfies readonly ShadowWithholdReason[];

export type ShadowCompleteness = 'complete' | 'degraded' | 'withheld';

export const SHADOW_COMPLETENESS_STATES = Object.freeze([
  'complete',
  'degraded',
  'withheld',
] as const) satisfies readonly ShadowCompleteness[];

/**
 * The run's result, as three variants a caller must destructure.
 *
 * A caller cannot read a partial result as complete, because there is no field
 * to read it off: `complete` has `degradation: null` in the type, `degraded`
 * has a `ShadowDegradation` and no way to be absent, and `withheld` has
 * `deliverable: null` — so the safe reading is the easy one, which is the
 * property `PersonalizationProfile`'s consent union has and a `partial: boolean`
 * flag would not.
 *
 * `moduleOutcomes` is **total** over the chain in every variant. A module
 * missing from the record does not compile, so "we forgot to record what
 * planning did" is not a representable run; and the totality is what makes the
 * trace cross-check in `checkShadowTrace` a comparison of two complete things
 * rather than a search for absences. `PersonalizationProfile.readings` is total
 * over its dimensions for the same reason: an absence renders as nothing, a
 * typed non-contribution renders as a row saying why.
 */
export type ShadowCompleteOutcome = {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly runId: string;
  readonly completeness: 'complete';
  readonly moduleOutcomes: Readonly<Record<ShadowPipelineModule, ShadowModuleOutcome>>;
  readonly deliverable: ShadowDeliverable;
  readonly degradation: null;
  readonly withheldReason: null;
  readonly totalElapsedMs: number;
};

export type ShadowDegradedOutcome = {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly runId: string;
  readonly completeness: 'degraded';
  readonly moduleOutcomes: Readonly<Record<ShadowPipelineModule, ShadowModuleOutcome>>;
  readonly deliverable: ShadowDeliverable;
  readonly degradation: ShadowDegradation;
  readonly withheldReason: null;
  readonly totalElapsedMs: number;
};

export type ShadowWithheldOutcome = {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly runId: string;
  readonly completeness: 'withheld';
  readonly moduleOutcomes: Readonly<Record<ShadowPipelineModule, ShadowModuleOutcome>>;
  readonly deliverable: null;
  readonly degradation: ShadowDegradation;
  readonly withheldReason: ShadowWithholdReason;
  readonly totalElapsedMs: number;
};

export type ShadowPipelineOutcome =
  | ShadowCompleteOutcome
  | ShadowDegradedOutcome
  | ShadowWithheldOutcome;

/**
 * **The structural guarantee, as one line that either compiles or does not.**
 *
 * If any field of any outcome variant — at any depth — is ever given a function
 * type, a class instance with methods, a store handle, or an `apply()`, this
 * assignment fails with "Type 'true' is not assignable to type 'never'". That
 * is the whole of "shadow results cannot mutate canonical state" on the typed
 * side: the outcome is JSON, and JSON does not write.
 *
 * Exported rather than left as a private `const` so the contract test can name
 * it — an invariant that exists only in a file nobody imports is an invariant
 * nobody notices the deletion of.
 */
type _OutcomeIsInert = ShadowPipelineOutcome extends ShadowInertValue ? true : never;
const _outcomeIsInert: _OutcomeIsInert = true;
export const SHADOW_OUTCOME_INERTNESS = _outcomeIsInert;

/** The same guarantee for a single proposal, so the effect type is pinned alone. */
type _ProposalIsInert = ShadowEffectProposal extends ShadowInertValue ? true : never;
const _proposalIsInert: _ProposalIsInert = true;
export const SHADOW_PROPOSAL_INERTNESS = _proposalIsInert;

/**
 * The modules that contributed, in chain order.
 *
 * Derived from `moduleOutcomes` rather than stored, so it cannot disagree with
 * the thing it summarises — and `checkShadowPipelineOutcome` reports
 * `DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES` when the *stored*
 * `degradation.nonContributingModules` does, which is the field a producer can
 * get wrong. Chain order, from `SHADOW_PIPELINE_CHAIN`, never a sort.
 */
export function contributingModules(
  outcome: ShadowPipelineOutcome,
): readonly ShadowPipelineModule[] {
  const contributed: ShadowPipelineModule[] = [];
  for (const module of SHADOW_PIPELINE_CHAIN) {
    const moduleOutcome = outcome.moduleOutcomes[module];
    if (moduleOutcome !== undefined && moduleOutcome !== null && moduleOutcome.contributed === true) {
      contributed.push(module);
    }
  }
  return Object.freeze(contributed);
}

/** The complement of `contributingModules`, in chain order. */
export function nonContributingModules(
  outcome: ShadowPipelineOutcome,
): readonly ShadowPipelineModule[] {
  const contributed = new Set(contributingModules(outcome));
  return Object.freeze(SHADOW_PIPELINE_CHAIN.filter((module) => !contributed.has(module)));
}

/* ── The trace ───────────────────────────────────────────────────── */

/**
 * One module's stage in the trace.
 *
 * Note that the trace is deliberately **not** constrained to
 * `ShadowInertValue`, and the reason is honest rather than convenient:
 * `runtimeDecision` is `ModuleRuntimeDecision`, whose `rules_only` arm is an
 * `interface` this file does not own, and an interface has no implicit index
 * signature. Wrapping it in `ShadowInert<...>` would make the assertion pass
 * without making it true of the nested shape — laundering, not checking. So the
 * trace's inertness is carried at runtime by `checkShadowInertness`, which
 * walks actual values and reports a callable at any depth, and the typed
 * guarantee is scoped to the thing the acceptance criterion is about: the
 * *result*. Saying which half is typed and which half is walked is the point of
 * the note.
 *
 * `startedAt` and `endedAt` are supplied by the caller — this file reads no
 * clock, ever — and `elapsedMs` is carried rather than derived so that a
 * disagreement between the two is *reportable*
 * (`TRACE_ELAPSED_DISAGREES_WITH_INTERVAL`) instead of
 * impossible-and-therefore-unexamined. A trace whose duration is recomputed
 * from its own timestamps can never show a clock that jumped.
 *
 * `reason` is required-and-nullable: a producer that forgets why a module fell
 * back is told by the compiler that it forgot something, then told by
 * `TRACE_REASON_MISSING` that null was the wrong answer. That pair is the
 * acceptance criterion "a trace explains each downstream decision" — a decision
 * appearing in the outcome with no explanation here is a finding, not a
 * silence.
 *
 * `proposalIndices` are **positions** into `deliverable.proposedEffects`, never
 * identifiers: the locator rule `safetyContracts` states, because ids are free
 * strings people fill with content.
 */
export interface ShadowTraceStageRecord {
  readonly module: ShadowPipelineModule;
  /** Position in `SHADOW_PIPELINE_CHAIN`. */
  readonly position: number;
  readonly runtimeDecision: ModuleRuntimeDecision;
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  readonly status: ShadowModuleStatus;
  readonly reason: ShadowStageReason | null;
  readonly outputDigest: string | null;
  readonly proposalIndices: readonly number[];
}

/**
 * The run's trace.
 *
 * `alphaSessionId` is the entire seam with `alphaTraceContracts`, per the
 * header: typed as `AlphaTraceSession['sessionId']` so the two identifiers
 * cannot drift into different types, and null for every run at stage
 * `shadow_only`, because a run nobody saw belongs to no session.
 */
export interface ShadowPipelineTrace {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly runId: string;
  readonly scopeId: string;
  /** The one field that crosses to `AlphaTraceSession`. Null when unattached. */
  readonly alphaSessionId: AlphaTraceSession['sessionId'] | null;
  readonly recordedAt: Instant;
  readonly stages: readonly ShadowTraceStageRecord[];
}

/**
 * The seam with `alphaTraceContracts`, as data a test can assert against — the
 * decision itself, not a restatement of the header's prose.
 */
export const SHADOW_TRACE_ALPHA_SEAM = Object.freeze({
  relationship: 'separate_systems_one_field_seam',
  /** The shadow trace's field that carries the link. */
  shadowField: 'alphaSessionId',
  /** The alpha trace's field it points at. */
  alphaField: 'sessionId',
  /** Nothing else crosses. No payload flows in either direction. */
  payloadCrossesSeam: false,
  /** A shadow trace cannot hold raw content; an alpha payload can, by design. */
  shadowTraceCarriesRawContent: false,
  /** Null for every `shadow_only` run: nobody saw it, so there is no session. */
  nullAtShadowOnly: true,
});

/* ── Input and replay ────────────────────────────────────────────── */

/**
 * The pattern a caller-chosen identifier must match to appear in a replay
 * preimage.
 *
 * A deliberate **superset** of `lib/pilot/closedPilotControls.ts`'s `SAFE_CODE`
 * — it additionally admits `.` and `:`, because run and scope identifiers in
 * this repo are namespaced and a pilot participant id is not. Restated rather
 * than imported because a contract must not import `lib/` (the header explains
 * the cycle), and the superset relation is pinned by the contract test in the
 * direction that matters: every code the shipped `createPilotAuditEvent`
 * accepts, this pattern accepts. Stating "superset" and testing "identical"
 * would be a comment that is false; stating it and testing the containment is
 * a claim that fails when it stops being true. It exists here for a reason that
 * file does not have: `shadowReplayPreimage` joins
 * fields with control characters, and an identifier permitted to contain one
 * could forge a field boundary and make two different bundles serialise
 * identically. A preimage a caller can forge is not a digest. `RUN_ID_UNSAFE`
 * and `SCOPE_ID_UNSAFE` are the codes for the attempt.
 */
export const SHADOW_SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{1,63}$/;

/**
 * The pattern every digest in this contract must match: lowercase hex, 16 to
 * 128 characters.
 *
 * Constrained for the same reason `SHADOW_SAFE_CODE` is, and it closes the
 * larger half of the hole: digests are the most numerous free strings in a
 * bundle, and an unconstrained one could carry a separator — or, worse, carry
 * content. A hex-only digest cannot hold a name. `DIGEST_MALFORMED` is the
 * code, and it is deliberately separate from `DIGEST_MISSING`: a blank digest
 * and a digest that is prose are different producer bugs, and blank digests
 * compare equal, so a replay over them could never show two runs reading
 * different inputs — the `BASIS_DIGEST_MISSING` lesson, here.
 */
export const SHADOW_DIGEST = /^[0-9a-f]{16,128}$/;

/**
 * Everything a replay needs about what went in.
 *
 * **No store handle, no writer, no adapter, and no raw text.** The orchestrator
 * holds the text; the contract-visible input holds `inputDigest`, which is what
 * a replay compares and what a privacy-safe log line can carry. That is not a
 * gap in the replay: two runs over the same digest that produce different
 * outcomes have diverged, which is exactly what the bundle exists to detect,
 * and a replay harness re-reads the source text from the module's own store
 * under the module's own access rules.
 *
 * `controls` is `RuntimeControlSnapshot` wrapped in `ShadowInert` — the flags
 * and kill switches `runtimeControls` already owns, not a second copy, because
 * the commonest cause of a replay disagreeing is that a flag moved between the
 * two runs, and a bundle that did not record the flags cannot say so.
 * `REPLAY_CONTROLS_DIVERGED` is that finding.
 */
export interface ShadowPipelineInput {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly runId: string;
  readonly scopeId: string;
  readonly startedAt: Instant;
  readonly controls: ShadowInert<RuntimeControlSnapshot>;
  readonly exposure: ShadowExposureDecision;
  /** A digest of the capture text. Never the text. */
  readonly inputDigest: string;
  readonly alphaSessionId: AlphaTraceSession['sessionId'] | null;
}

/**
 * Everything needed to re-derive the same outcome, plus a digest a replay that
 * disagrees can be detected by.
 *
 * `bundleDigest` is **data supplied by the caller**, not computed here: a
 * contract must not import `lib/`, and a second sha256 preimage spelling would
 * drift — the rule `personalizationContracts` states about
 * `computeFeedbackInputDigest`. What this file owns instead is the *preimage*:
 * `shadowReplayPreimage` is the canonical serialization both the recorder and
 * the replayer hash, so agreement between two digests means agreement about the
 * bundle rather than agreement about a hashing convention.
 */
export interface ShadowReplayBundle {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly runId: string;
  readonly recordedAt: Instant;
  readonly input: ShadowPipelineInput;
  readonly trace: ShadowPipelineTrace;
  readonly outcome: ShadowPipelineOutcome;
  /** `sha256(shadowReplayPreimage(bundle))`, computed by the caller. */
  readonly bundleDigest: string;
}

/** What a replaying harness observed, to be checked against a recorded bundle. */
export interface ShadowReplayObservation {
  readonly outcome: ShadowPipelineOutcome;
  readonly trace: ShadowPipelineTrace;
  readonly controls: ShadowInert<RuntimeControlSnapshot>;
  /** `sha256(shadowReplayPreimage(...))` over the replayed bundle. */
  readonly bundleDigest: string;
}

/**
 * The sections of the preimage, in emission order.
 *
 * Exported so the contract test asserts the order rather than infers it, and so
 * a section added without being added to this list is visible in a diff. The
 * order is fixed and declared; nothing here sorts anything.
 */
export const SHADOW_REPLAY_PREIMAGE_SECTIONS = Object.freeze([
  'schema',
  'run',
  'controls',
  'exposure',
  'chain',
  'stage',
  'module',
  'outcome',
  'proposal',
] as const);

export type ShadowReplayPreimageSection = (typeof SHADOW_REPLAY_PREIMAGE_SECTIONS)[number];

/**
 * Unit and record separators, spelled as char codes rather than as literals so
 * they are visible in a diff and cannot be deleted by an editor that strips
 * control characters.
 *
 * ASCII controls, chosen because no field the preimage emits can contain one:
 * closed vocabularies and numbers cannot, `Instant` cannot (`isInstant` is
 * pattern-anchored), `SHADOW_SAFE_CODE` cannot, and `SHADOW_DIGEST` cannot.
 * That closure is what makes the join injective — a caller cannot smuggle a
 * separator into a `runId` and make two different bundles produce one string.
 * The checkers report `RUN_ID_UNSAFE`, `SCOPE_ID_UNSAFE` and `DIGEST_MALFORMED`
 * at the boundary where the patterns are only patterns.
 */
const PREIMAGE_FIELD_SEPARATOR = String.fromCharCode(0x1f);
const PREIMAGE_RECORD_SEPARATOR = String.fromCharCode(0x1e);

/**
 * `~null` rather than the bare word: `~` is outside both `SHADOW_SAFE_CODE` and
 * `SHADOW_DIGEST`, so a null field and a field whose value is the string
 * `"null"` cannot serialise the same way.
 */
function preimageField(value: string | number | boolean | null): string {
  if (value === null) return '~null';
  return String(value);
}

function preimageRecord(
  section: ShadowReplayPreimageSection,
  fields: readonly (string | number | boolean | null)[],
): string {
  return [section, ...fields.map(preimageField)].join(PREIMAGE_FIELD_SEPARATOR);
}

/**
 * The canonical serialization of a replay bundle.
 *
 * **Positional, never sorted.** Fields are emitted in the order declared here
 * and modules in `SHADOW_PIPELINE_CHAIN` / `INTELLIGENCE_MODULES` order, so the
 * function is deterministic without a comparator — which matters twice over:
 * this repo bans `localeCompare` because its answer moves with `LANG`, and its
 * one legitimate comparator (`compareByCodePoint`) lives in
 * `lib/planning/shared/compare.ts`, which a contract may not import. A
 * positional preimage needs neither, and it has the further property that two
 * bundles whose object keys were inserted in different orders serialise
 * identically, which a `JSON.stringify` preimage does not.
 *
 * Reads no clock and allocates no randomness. Same bundle, byte-identical
 * string.
 */
export function shadowReplayPreimage(bundle: ShadowReplayBundle): string {
  const records: string[] = [];
  const input = bundle.input;
  const exposure = input.exposure;

  records.push(preimageRecord('schema', [bundle.schemaVersion, bundle.version]));
  records.push(
    preimageRecord('run', [
      bundle.runId,
      input.scopeId,
      input.startedAt,
      input.inputDigest,
      input.alphaSessionId,
    ]),
  );

  for (const module of INTELLIGENCE_MODULES) {
    records.push(
      preimageRecord('controls', [
        module,
        input.controls.featureFlags[module],
        input.controls.killSwitches[module],
      ]),
    );
  }

  records.push(
    preimageRecord('exposure', [
      exposure.stage,
      exposure.cap,
      exposure.cohortSize,
      exposure.consentState,
      exposure.allowed,
      exposure.reason,
    ]),
  );

  for (const module of SHADOW_PIPELINE_CHAIN) {
    records.push(
      preimageRecord('chain', [
        module,
        SHADOW_PIPELINE_CHAIN_POSITION[module],
        SHADOW_MODULE_ROLES[module],
        SHADOW_MODULE_FAILURE_STANCE[module],
        SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
      ]),
    );
  }

  for (const module of SHADOW_PIPELINE_CHAIN) {
    const stage = bundle.trace.stages.find((candidate) => candidate.module === module) ?? null;
    records.push(
      preimageRecord('stage', [
        module,
        stage === null ? 'absent' : stage.status,
        stage === null ? null : stage.reason,
        stage === null ? null : stage.elapsedMs,
        stage === null ? null : stage.budgetMs,
        stage === null ? null : stage.outputDigest,
        stage === null ? null : stage.runtimeDecision.mode,
        stage === null || stage.runtimeDecision.mode === 'enabled'
          ? null
          : stage.runtimeDecision.reason,
      ]),
    );
  }

  for (const module of SHADOW_PIPELINE_CHAIN) {
    const moduleOutcome = bundle.outcome.moduleOutcomes[module] ?? null;
    records.push(
      preimageRecord('module', [
        module,
        moduleOutcome === null ? 'absent' : moduleOutcome.status,
        moduleOutcome === null ? null : moduleOutcome.contributed,
        moduleOutcome === null ? null : moduleOutcome.reason,
        moduleOutcome === null ? null : moduleOutcome.failureCode,
        moduleOutcome === null ? null : moduleOutcome.outputDigest,
      ]),
    );
  }

  const deliverable = bundle.outcome.deliverable;
  records.push(
    preimageRecord('outcome', [
      bundle.outcome.completeness,
      bundle.outcome.withheldReason,
      deliverable === null ? null : deliverable.safetyDisposition,
      deliverable === null ? null : deliverable.coachingDeliveryDigest,
      deliverable === null ? null : deliverable.wouldHaveBeenShown,
    ]),
  );

  const proposals = deliverable === null ? [] : deliverable.proposedEffects;
  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index];
    records.push(
      preimageRecord('proposal', [
        index,
        proposal.proposedBy,
        proposal.target,
        proposal.kind,
        proposal.status,
        proposal.payloadDigest,
      ]),
    );
  }

  return records.join(PREIMAGE_RECORD_SEPARATOR);
}

/* ── SLOs and the reconciliation surface (#46) ───────────────────── */

/**
 * What an SLO may be measured over.
 *
 * Closed, and every member reads a field that exists in this file — that is the
 * constraint that keeps the list honest. `pipeline_latency_p95_ms` reads
 * `totalElapsedMs`; `module_timeout_rate` and `module_fallback_rate` read
 * `ShadowModuleOutcome.status`; `pipeline_degraded_rate` and
 * `pipeline_withheld_rate` read `completeness`; `safety_block_rate` reads
 * `ShadowDeliverable.safetyDisposition`; `replay_divergence_rate` reads
 * `checkShadowReplay`; `trace_completeness_rate` reads `checkShadowTrace`. A
 * metric naming something no shape here produces would be an alert nobody can
 * compute, which is how a dashboard becomes decorative.
 *
 * **There is deliberately no engagement metric in this list.** Not "we chose
 * not to add one" — the list is the vocabulary, and #47's evidence package
 * classifies each item's `measureClass`, so an engagement measure entering a
 * release decision has to arrive as a `ShadowEvidenceItem` with
 * `measureClass: 'engagement'`, where `GO_RESTS_ON_ENGAGEMENT_ALONE` can see
 * it. Hiding it in the SLO vocabulary would put it somewhere the gate rule does
 * not look.
 */
export type ShadowSloMetric =
  | 'pipeline_latency_p95_ms'
  | 'module_timeout_rate'
  | 'module_fallback_rate'
  | 'pipeline_degraded_rate'
  | 'pipeline_withheld_rate'
  | 'safety_block_rate'
  | 'replay_divergence_rate'
  | 'trace_completeness_rate'
  | 'shadow_cost_micros_per_run';

export const SHADOW_SLO_METRICS = Object.freeze([
  'pipeline_latency_p95_ms',
  'module_timeout_rate',
  'module_fallback_rate',
  'pipeline_degraded_rate',
  'pipeline_withheld_rate',
  'safety_block_rate',
  'replay_divergence_rate',
  'trace_completeness_rate',
  'shadow_cost_micros_per_run',
] as const) satisfies readonly ShadowSloMetric[];

/**
 * Which direction breaches. Two spellings, not a `lowerIsBetter: boolean`: a
 * boolean has to be read together with the metric to mean anything, and the one
 * metric in this list where the intuition inverts (`trace_completeness_rate`,
 * where *higher* is better) is exactly where a reader would get the boolean
 * backwards.
 */
export type ShadowSloComparison = 'at_most' | 'at_least';

export const SHADOW_SLO_COMPARISONS = Object.freeze([
  'at_most',
  'at_least',
] as const) satisfies readonly ShadowSloComparison[];

/**
 * The evaluation window. Closed and coarse: an alert whose window is a free
 * duration string is an alert two people configure differently, and #46's
 * runbook has to name a window a human can reason about at 3am.
 */
export type ShadowSloWindow = 'rolling_1h' | 'rolling_24h' | 'rolling_7d';

export const SHADOW_SLO_WINDOWS = Object.freeze([
  'rolling_1h',
  'rolling_24h',
  'rolling_7d',
] as const) satisfies readonly ShadowSloWindow[];

/** The three tracks of this sprint. An SLO belongs to one of them or to nobody. */
export type ShadowSloOwnerTeam = 'backend' | 'quality' | 'product';

export const SHADOW_SLO_OWNER_TEAMS = Object.freeze([
  'backend',
  'quality',
  'product',
] as const) satisfies readonly ShadowSloOwnerTeam[];

/**
 * Who is woken up, and who is woken up when the first person does not answer.
 *
 * #46's acceptance criterion is "alert ownership is explicit", so ownership is a
 * **required field of the definition** rather than a line in a runbook — an
 * owner recorded in prose beside the alert is an owner nobody updates when the
 * rotation changes. It is an object rather than a string for the same reason
 * `SafetyVerdict` has three variants rather than a `blocked` boolean: a single
 * `owner: string` is satisfiable by `"the team"`, and a required
 * `escalationRotationId` cannot be. Both ids are `SHADOW_SAFE_CODE`, checked by
 * `checkShadowSloDefinition` — an unroutable rotation id is an alert that fires
 * into nothing, which is worse than no alert because it looks like coverage.
 */
export interface ShadowSloOwner {
  readonly team: ShadowSloOwnerTeam;
  readonly rotationId: string;
  readonly escalationRotationId: string;
}

/**
 * The smallest sample any SLO definition may declare as sufficient.
 *
 * A floor under the floor: without it a definition could declare
 * `minimumSampleCount: 1` and turn a single slow run into a paged incident, and
 * the discipline Sprint 10 established — small samples are a *variant*, not a
 * number to be compared — would be satisfiable by declaring the sample large
 * enough. Twenty is small on purpose; the point is not statistical power, it is
 * that one observation can never breach an SLO.
 * `SLO_SAMPLE_FLOOR_TOO_LOW` reaches it.
 */
export const MIN_SLO_SAMPLE_COUNT = 20;

/**
 * One SLO. Everything #46 needs to build an alert query, and nothing it needs
 * to look up elsewhere.
 *
 * `killSwitchModule` is required-and-nullable and names a
 * `IntelligenceModuleName`, so a breach can point at the switch
 * `runtimeControls` already owns rather than at a new one. Null is a real
 * answer — `shadow_cost_micros_per_run` breaching is a budget conversation, not
 * a module to disable — and it is required so that "which switch does this
 * arm" is a question every definition has answered.
 */
export interface ShadowSloDefinition {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly sloId: string;
  readonly metric: ShadowSloMetric;
  readonly comparison: ShadowSloComparison;
  readonly threshold: number;
  readonly window: ShadowSloWindow;
  readonly minimumSampleCount: number;
  readonly owner: ShadowSloOwner;
  /** The kill switch a sustained breach arms, or null when none applies. */
  readonly killSwitchModule: IntelligenceModuleName | null;
}

/**
 * Why a reading could not be taken. Closed, because #46 renders these on a
 * dashboard and a free string would make "why is this panel empty" a sentence
 * the collector improvises.
 *
 * `collector_unavailable` is distinguished from `no_data_in_window` for the
 * reason `no_admissible_evidence` is distinguished from `insufficient_sample`
 * in `personalizationContracts`: "nothing happened" and "we could not look" are
 * different answers, and only one of them is itself an incident.
 */
export type ShadowSloInconclusiveReason =
  | 'insufficient_sample'
  | 'no_data_in_window'
  | 'collector_unavailable';

export const SHADOW_SLO_INCONCLUSIVE_REASONS = Object.freeze([
  'insufficient_sample',
  'no_data_in_window',
  'collector_unavailable',
] as const) satisfies readonly ShadowSloInconclusiveReason[];

/**
 * A reading, as two variants — the Sprint 10 discipline applied to reliability:
 * a small sample is a *shape* a breach-consumer cannot receive, not a number it
 * is trusted to compare.
 *
 * `inconclusive` carries `value: null` and `breached: null` **in the type**, so
 * there is no field an alert rule can read a measurement off when the window was
 * too thin. That is the whole mechanism: the failure mode this prevents is a
 * dashboard that renders `0%` for "we have three data points" and a rollback
 * decision taken on it. `SLO_MEASURED_BELOW_SAMPLE_FLOOR` covers the untyped
 * boundary, where `JSON.parse` can still write a `measured` reading over four
 * samples.
 */
export type ShadowMeasuredSloReading = {
  readonly status: 'measured';
  readonly sloId: string;
  readonly value: number;
  readonly sampleCount: number;
  readonly breached: boolean;
  readonly inconclusiveReason: null;
  readonly windowStart: Instant;
  readonly observedAt: Instant;
};

export type ShadowInconclusiveSloReading = {
  readonly status: 'inconclusive';
  readonly sloId: string;
  readonly value: null;
  readonly sampleCount: number;
  readonly breached: null;
  readonly inconclusiveReason: ShadowSloInconclusiveReason;
  readonly windowStart: Instant;
  readonly observedAt: Instant;
};

export type ShadowSloReading = ShadowMeasuredSloReading | ShadowInconclusiveSloReading;

export const SHADOW_SLO_READING_STATUSES = Object.freeze([
  'measured',
  'inconclusive',
] as const) satisfies readonly ShadowSloReading['status'][];

/**
 * Whether a value breaches a definition. Exported as one function so the
 * recorder, the alert query and the checker all ask the same question — two
 * spellings of a comparison are two thresholds, and the second one is always
 * the lenient one.
 *
 * Returns null for a non-finite value rather than a boolean: `NaN > x` is
 * `false`, so folding an unreadable measurement into "not breached" would make
 * the alert *pass* exactly when the collector stopped working, which is the
 * fail-open this contract exists to close. `SLO_VALUE_NOT_FINITE` is the code.
 */
export function shadowSloBreached(
  definition: ShadowSloDefinition,
  value: number,
): boolean | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (typeof definition.threshold !== 'number' || !Number.isFinite(definition.threshold)) return null;
  return definition.comparison === 'at_most'
    ? value > definition.threshold
    : value < definition.threshold;
}

/**
 * What a privacy-safe log line must carry to be matched against a trace.
 *
 * This is #46's reconciliation surface, and it is deliberately five fields.
 * Every one of them is either a position, a closed vocabulary, a pattern-checked
 * identifier, or an instant — nothing here can hold a sentence, which is what
 * makes "the logs are privacy-safe" and "the logs reconcile with the traces"
 * simultaneously satisfiable rather than a trade.
 *
 * `module` and `stagePosition` are both nullable and both required: a
 * pipeline-level line (the run started, the run finished) has neither, a
 * stage-level line has both, and a line with one but not the other is
 * `LOG_STAGE_LOCATOR_INCOHERENT` — the shape that would otherwise let a log
 * line claim to be about a stage the trace cannot find.
 *
 * `bundleDigest` rather than an outcome summary: it is the field that proves
 * the log line and the trace describe *the same run*, and it is exactly what a
 * replay recomputes. A reconciliation keyed only on `runId` proves that two
 * systems agree about an identifier.
 */
export interface ShadowLogReconciliationKey {
  readonly runId: string;
  readonly module: ShadowPipelineModule | null;
  /** Position into `SHADOW_PIPELINE_CHAIN`, never an identifier. */
  readonly stagePosition: number | null;
  readonly bundleDigest: string;
  readonly occurredAt: Instant;
}

export const SHADOW_LOG_RECONCILIATION_FIELDS = Object.freeze([
  'runId',
  'module',
  'stagePosition',
  'bundleDigest',
  'occurredAt',
] as const) satisfies readonly (keyof ShadowLogReconciliationKey)[];

/**
 * Property-name classes that may never appear on a privacy-safe log line about
 * a shadow run.
 *
 * Restated from `lib/analytics/privacySafeEvents.ts`'s `PRIVATE_KEY` regex,
 * which is not exported and which a contract may not import anyway. The
 * duplication is named, and the contract test pins it the strong way: it drives
 * each class through the shipped `validateAnalyticsEvent` and demands the
 * `private property is forbidden` verdict, so #46's reconciliation target
 * enforces this list rather than the two agreeing by coincidence. A class added
 * there and not here fails that test.
 */
export const SHADOW_FORBIDDEN_LOG_KEY_CLASSES = Object.freeze([
  'raw',
  'message',
  'text',
  'title',
  'description',
  'person',
  'email',
  'phone',
  'prompt',
  'content',
] as const);

/* ── Staged exposure, consent, and the study (#47) ───────────────── */

/**
 * How far the pipeline is exposed, as three stages and no fourth.
 *
 * **`general_availability` is not a member, and that is the mechanism, not an
 * omission.** #47's acceptance criterion is "no general release occurs in this
 * issue", and a boolean `generalRelease: false` is a boolean somebody flips.
 * The stage vocabulary is closed, every consumer switches on it exhaustively,
 * and a general release therefore cannot be *expressed* by this contract — it
 * requires editing this list, which is a reviewed change rather than a config
 * value. The contract test pins the refusal with a `@ts-expect-error` on the
 * spelling.
 *
 *   - `shadow_only`      — the chain runs; nobody sees anything. Cap 0, and
 *                          `wouldHaveBeenShown` must be false for every run.
 *                          This is the stage this sprint actually ships in.
 *   - `internal_dogfood` — the trusted-alpha allowlist
 *                          (`lib/pilot/alphaControls`, 1–10 people).
 *   - `closed_pilot`     — the V03 closed pilot, 25–40 people, whose bounds
 *                          `lib/pilot/closedPilotControls` already owns.
 */
export type ShadowExposureStage = 'shadow_only' | 'internal_dogfood' | 'closed_pilot';

export const SHADOW_EXPOSURE_STAGES = Object.freeze([
  'shadow_only',
  'internal_dogfood',
  'closed_pilot',
] as const) satisfies readonly ShadowExposureStage[];

/**
 * The largest cohort each stage admits.
 *
 * `closed_pilot: 40` is `CLOSED_PILOT_MAXIMUM` and `internal_dogfood: 10` is the
 * alpha allowlist ceiling, both restated as literals because a contract must not
 * import `lib/` — and both pinned by the contract test against the imported
 * constants, so a change to the pilot's bounds fails here rather than drifting.
 * `shadow_only: 0` is not a degenerate case: it is the definition of the stage,
 * and it is what makes `EXPOSURE_CAP_EXCEEDED` fire for any cohort at all in
 * shadow mode.
 */
export const SHADOW_STAGE_PARTICIPANT_CAP: Readonly<Record<ShadowExposureStage, number>> =
  Object.freeze({
    shadow_only: 0,
    internal_dogfood: 10,
    closed_pilot: 40,
  });

/**
 * The smallest cohort each stage is meaningful at.
 *
 * `closed_pilot: 25` is `CLOSED_PILOT_MINIMUM`, whose reason
 * `parseClosedPilotAllowlist` already encodes: a "closed pilot" of four people
 * produces evidence nobody should decide on. Reported rather than thrown —
 * `EXPOSURE_COHORT_BELOW_STAGE_FLOOR` — because this file's checkers report and
 * the shipped parser's throw is the other side of the same seam, and a contract
 * that threw here would hand the decision to whichever caller forgot the
 * try/catch.
 */
export const SHADOW_STAGE_PARTICIPANT_FLOOR: Readonly<Record<ShadowExposureStage, number>> =
  Object.freeze({
    shadow_only: 0,
    internal_dogfood: 1,
    closed_pilot: 25,
  });

/**
 * `lib/pilot/closedPilotControls.PilotStopReason`, restated.
 *
 * The restatement is forced — a contract must not import `lib/`, and
 * `lib/pilot/pilotAccess.ts` already imports `runtimeControls`, so the edge back
 * would close the cycle whose TDZ crash `moduleContracts` records on the
 * `decomposition` descriptor. It is pinned in **both** directions by the
 * contract test, which may import `lib/` and does: a reason added there and not
 * here, or here and not there, fails assignability. That is the difference
 * between a named duplication and a drift.
 */
export type ShadowPilotStopReason =
  | 'not_allowlisted'
  | 'wrong_instance'
  | 'consent_required'
  | 'quiet_mode'
  | 'revoked'
  | 'deleted'
  | 'feature_disabled'
  | 'kill_switch_active';

export const SHADOW_PILOT_STOP_REASONS = Object.freeze([
  'not_allowlisted',
  'wrong_instance',
  'consent_required',
  'quiet_mode',
  'revoked',
  'deleted',
  'feature_disabled',
  'kill_switch_active',
] as const) satisfies readonly ShadowPilotStopReason[];

/**
 * `PilotExposureDecision`'s shape, restated on the same terms and for the same
 * reason as the stop reasons.
 *
 * This is a required **input** to `resolveShadowExposure`, not something it
 * recomputes: the shadow gate is built *on* `resolvePilotAccess` rather than
 * beside it, and the way that is enforced is that the shadow gate has no
 * allowlist, no trust store, and no way to admit anyone the pilot gate refused.
 * `shadowExposureNeverExceedsPilot` in `SHADOW_EXPOSURE_POLICY` is the claim,
 * and the contract test proves it by iterating every stop reason and asserting
 * the shadow decision refuses with the same one.
 */
export interface ShadowPilotDecision {
  readonly allowed: boolean;
  readonly reason: 'authorized' | ShadowPilotStopReason;
}

/**
 * What a participant consents to, separately.
 *
 * Separate scopes rather than one flag because they are separately refusable and
 * a person who agrees to be in the study has not thereby agreed that their
 * traces are kept for a quarter. `trace_retention` is the one #46 depends on and
 * the one most likely to be revoked alone.
 */
export type ShadowConsentScope = 'shadow_execution' | 'feedback_study' | 'trace_retention';

export const SHADOW_CONSENT_SCOPES = Object.freeze([
  'shadow_execution',
  'feedback_study',
  'trace_retention',
] as const) satisfies readonly ShadowConsentScope[];

export type ShadowConsentState = 'granted' | 'withheld' | 'revoked';

export const SHADOW_CONSENT_STATES = Object.freeze([
  'granted',
  'withheld',
  'revoked',
] as const) satisfies readonly ShadowConsentState[];

/**
 * Consent, as three variants where revocation is a *shape*.
 *
 * `granted` requires a non-empty scope tuple and a `grantedAt`; `withheld` and
 * `revoked` both carry `scopes: readonly []` **in the type**, so there is no
 * field a consumer can read a live scope off once consent is gone. Revoking is
 * therefore immediate by construction rather than by discipline — the same
 * mechanism `PersonalizationProfile`'s `disabled` variant uses, and the reason
 * it uses it: the safe reading has to be the easy one.
 *
 * `revoked` keeps `grantedAt` non-null because a revocation of a consent that
 * was never granted is not a revocation, and #47 has to be able to show a
 * participant when they granted and when they withdrew.
 *
 * The default, absent an explicit grant, is `withheld`. Opt-in, as Sprint 10
 * established: the product earns the exposure rather than assumes it.
 */
export type ShadowGrantedConsent = {
  readonly state: 'granted';
  readonly participantId: string;
  readonly scopes: readonly [ShadowConsentScope, ...ShadowConsentScope[]];
  readonly grantedAt: Instant;
  readonly revokedAt: null;
};

export type ShadowWithheldConsent = {
  readonly state: 'withheld';
  readonly participantId: string;
  readonly scopes: readonly [];
  readonly grantedAt: null;
  readonly revokedAt: null;
};

export type ShadowRevokedConsent = {
  readonly state: 'revoked';
  readonly participantId: string;
  readonly scopes: readonly [];
  readonly grantedAt: Instant;
  readonly revokedAt: Instant;
};

export type ShadowStudyConsent =
  | ShadowGrantedConsent
  | ShadowWithheldConsent
  | ShadowRevokedConsent;

/**
 * Why a participant is or is not exposed.
 *
 * The pilot stop reasons are carried through verbatim rather than remapped: a
 * participant refused for `quiet_mode` should see `quiet_mode` in the shadow
 * decision too, because a second vocabulary that says `not_eligible` for all
 * eight of them is how a support conversation becomes unanswerable. The four
 * this file adds are the ones staging introduces and the pilot gate has no
 * opinion about.
 */
export type ShadowExposureReason =
  | 'authorized'
  | ShadowPilotStopReason
  | 'stage_is_shadow_only'
  | 'stage_cap_exceeded'
  | 'study_consent_withheld'
  | 'study_consent_revoked';

export const SHADOW_EXPOSURE_REASONS = Object.freeze([
  'authorized',
  'not_allowlisted',
  'wrong_instance',
  'consent_required',
  'quiet_mode',
  'revoked',
  'deleted',
  'feature_disabled',
  'kill_switch_active',
  'stage_is_shadow_only',
  'stage_cap_exceeded',
  'study_consent_withheld',
  'study_consent_revoked',
] as const) satisfies readonly ShadowExposureReason[];

type _ExposureReasonsCovered =
  Exclude<ShadowExposureReason, (typeof SHADOW_EXPOSURE_REASONS)[number]> extends never
    ? true
    : never;
const _exposureReasonsAreExhaustive: _ExposureReasonsCovered = true;
export const SHADOW_EXPOSURE_REASON_COVERAGE = _exposureReasonsAreExhaustive;

/**
 * One participant's staged exposure decision.
 *
 * `cap` and `cohortSize` are both carried rather than one derived, so a decision
 * read on its own says what bound it was judged against — a decision that
 * refused for `stage_cap_exceeded` without saying what the cap was is a decision
 * nobody can act on.
 */
export type ShadowExposureDecision = {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly participantId: string;
  readonly stage: ShadowExposureStage;
  readonly cap: number;
  readonly cohortSize: number;
  readonly consentState: ShadowConsentState;
  readonly allowed: boolean;
  readonly reason: ShadowExposureReason;
};

/** Everything `resolveShadowExposure` reads. No store, no clock, no allowlist. */
export interface ShadowExposureInput {
  readonly participantId: string;
  readonly stage: ShadowExposureStage;
  readonly cohortSize: number;
  /** From `lib/pilot/pilotAccess.resolvePilotAccess`. Never recomputed here. */
  readonly pilotDecision: ShadowPilotDecision;
  readonly consent: ShadowStudyConsent;
}

/**
 * The staged exposure decision, as a pure function of an already-made pilot
 * decision.
 *
 * **Order is the design.** The pilot gate is consulted first and its refusal is
 * final, so the shadow gate is structurally incapable of being more permissive
 * than the pilot gate — it can only refuse further. Then the stage: at
 * `shadow_only` nobody is exposed regardless of consent, which is what the stage
 * *means* and which is checked before consent so that a granted consent at
 * shadow-only reads as `stage_is_shadow_only` rather than as an authorization.
 * Then consent, then the cap.
 *
 * Consent is checked before the cap because a person who withdrew should be
 * told they withdrew, not that the cohort was full; and the cap is last because
 * it is the only reason that is about the *cohort* rather than the person.
 *
 * Reads no clock and takes no allowlist: the membership judgement is
 * `resolvePilotAccess`'s and stays there. Same input, same decision.
 */
export function resolveShadowExposure(input: ShadowExposureInput): ShadowExposureDecision {
  const cap = SHADOW_STAGE_PARTICIPANT_CAP[input.stage];
  const base = {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    participantId: input.participantId,
    stage: input.stage,
    cap: cap === undefined ? 0 : cap,
    cohortSize: input.cohortSize,
    consentState: input.consent.state,
  } as const;

  if (!input.pilotDecision.allowed) {
    const reason = input.pilotDecision.reason;
    return {
      ...base,
      allowed: false,
      // `authorized` is unreachable here — the decision refused — but a producer
      // at the untyped boundary can write it, and `not_allowlisted` is the
      // fail-closed reading of "refused for a reason it will not name".
      reason: reason === 'authorized' ? 'not_allowlisted' : reason,
    };
  }

  if (input.stage === 'shadow_only') {
    return { ...base, allowed: false, reason: 'stage_is_shadow_only' };
  }

  if (input.consent.state === 'revoked') {
    return { ...base, allowed: false, reason: 'study_consent_revoked' };
  }

  if (input.consent.state !== 'granted') {
    return { ...base, allowed: false, reason: 'study_consent_withheld' };
  }

  if (!input.consent.scopes.includes('shadow_execution')) {
    return { ...base, allowed: false, reason: 'study_consent_withheld' };
  }

  if (!Number.isInteger(input.cohortSize) || input.cohortSize > base.cap) {
    return { ...base, allowed: false, reason: 'stage_cap_exceeded' };
  }

  return { ...base, allowed: true, reason: 'authorized' };
}

/**
 * The staging rules #47 builds tooling against, as data.
 */
export const SHADOW_EXPOSURE_POLICY = Object.freeze({
  /** There is no `general_availability` stage to reach. */
  generalReleaseRepresentable: false,
  /** The shadow gate can only narrow what `resolvePilotAccess` allowed. */
  shadowExposureNeverExceedsPilot: true,
  /** Absent an explicit grant, the state is `withheld`. */
  defaultConsentState: 'withheld' satisfies ShadowConsentState,
  /** A revoked consent carries no scopes, in the type. */
  revocationIsStructural: true,
  /** Nobody is exposed at `shadow_only`, whatever they consented to. */
  shadowOnlyExposesNobody: true,
  deletionProducesVerifiableReceipt: true,
});

/* ── The feedback study (#47) ────────────────────────────────────── */

/**
 * The questions the study asks. Closed, because #47's data model is only as
 * analysable as its question set is fixed, and a free-text question id makes
 * two studies that cannot be compared.
 *
 * `intrusiveness` is present deliberately and is the reason the set is not just
 * "was this good": Sprint 10's #107 work established that a product measuring
 * only helpfulness learns to be louder, and a study without a cost question
 * measures only the benefit side of a trade.
 */
export type ShadowStudyQuestionId =
  | 'helpfulness'
  | 'accuracy'
  | 'intrusiveness'
  | 'trust'
  | 'would_use_again';

export const SHADOW_STUDY_QUESTIONS = Object.freeze([
  'helpfulness',
  'accuracy',
  'intrusiveness',
  'trust',
  'would_use_again',
] as const) satisfies readonly ShadowStudyQuestionId[];

/**
 * The rating scale, as its own frozen object rather than two loose numbers, so
 * a bound check and a UI picker read the same thing.
 */
export const SHADOW_STUDY_RATING_SCALE = Object.freeze({ minimum: 1, maximum: 5 });

/**
 * One answer, as two variants.
 *
 * `declined` is a variant and not an absence, for the reason `inconclusive` is a
 * reading and not a missing key: a person who chose not to answer told you
 * something, and folding that into "no data" loses the only signal a study gets
 * about questions people will not answer. `rating: null` in the type means a
 * declined answer cannot leak a number into an aggregate.
 *
 * `runId` is nullable because a participant may answer about the study rather
 * than about a run, and required because "which run was this about" is a
 * question every response has answered.
 */
export type ShadowStudyRatedResponse = {
  readonly status: 'rated';
  readonly participantId: string;
  readonly runId: string | null;
  readonly question: ShadowStudyQuestionId;
  readonly rating: number;
  readonly respondedAt: Instant;
};

export type ShadowStudyDeclinedResponse = {
  readonly status: 'declined';
  readonly participantId: string;
  readonly runId: string | null;
  readonly question: ShadowStudyQuestionId;
  readonly rating: null;
  readonly respondedAt: Instant;
};

export type ShadowStudyResponse = ShadowStudyRatedResponse | ShadowStudyDeclinedResponse;

/**
 * Proof of deletion for one study participant.
 *
 * **Sprint 10's receipt is embedded whole, not copied.**
 * `PersonalizationDeletionReceipt` already answers "is the personalization
 * substrate gone for this scope" in terms a UI can recompute, and a second
 * receipt would be two answers to one question — the shape this sprint was told
 * twice to avoid. What this sprint adds is three stores Sprint 10 did not have:
 * traces, replay bundles, and study responses. So the receipt composes, and
 * `checkShadowStudyDeletionReceipt` delegates to
 * `checkPersonalizationDeletionReceipt` and re-codes its findings under
 * `SHADOW_NESTED_RECEIPT_DEFECT`, carrying the inner code in the detail — one
 * deletion vocabulary, extended, with the seam named.
 *
 * Every field is recomputable against the post-deletion stores, which is what
 * "verifiable" has to mean: `emptyStateDigest` is the caller's digest over the
 * empty post-deletion input, and a verifier that recomputes it and disagrees has
 * found data that still exists. A receipt whose contents cannot be recomputed is
 * a promise, not a check.
 */
export interface ShadowStudyDeletionReceipt {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly participantId: string;
  /** From the caller. This module never reads a clock. */
  readonly deletedAt: Instant;
  /** Sprint 10's receipt, embedded. */
  readonly personalization: PersonalizationDeletionReceipt;
  readonly remainingTraceCount: number;
  readonly remainingReplayBundleCount: number;
  readonly remainingStudyResponseCount: number;
  readonly emptyStateDigest: string;
}

/* ── The go/hold/rollback evidence package (#47) ─────────────────── */

/**
 * The three things a decision must rest on.
 *
 * #47's acceptance criterion names all three — "decision includes quality,
 * safety, and reliability evidence" — so the package keys a **total record** on
 * this vocabulary rather than carrying three optional fields. A package missing
 * a pillar does not compile, which is the difference between an acceptance
 * criterion and a checklist item.
 */
export type ShadowEvidencePillar = 'quality' | 'safety' | 'reliability';

export const SHADOW_EVIDENCE_PILLARS = Object.freeze([
  'quality',
  'safety',
  'reliability',
] as const) satisfies readonly ShadowEvidencePillar[];

/**
 * What kind of measure an evidence item is.
 *
 * The classification exists for exactly one rule —
 * `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE` — and it is a required field of every
 * item so the rule is computable rather than adjudicated. Sprint 10's reason,
 * verbatim from #107: a signal that a user responded faster is not evidence that
 * the product helped them, and a loop that rewards quick responses learns to
 * produce anxiety.
 *
 *   - `user_judgement`      — the person judged: a study rating, a correction,
 *                             a revocation, a reported problem.
 *   - `safety_outcome`      — a gateway verdict, a red-team result, an incident.
 *   - `reliability_signal`  — an SLO reading, a rollback drill result.
 *   - `engagement`          — opens, sessions, response latency, compliance
 *                             rate. Admissible as *context*, never as the sole
 *                             support for a `go`.
 */
export type ShadowMeasureClass =
  | 'user_judgement'
  | 'safety_outcome'
  | 'reliability_signal'
  | 'engagement';

export const SHADOW_MEASURE_CLASSES = Object.freeze([
  'user_judgement',
  'safety_outcome',
  'reliability_signal',
  'engagement',
] as const) satisfies readonly ShadowMeasureClass[];

/**
 * The classes that cannot carry a `go` on their own, as data rather than as an
 * inline comparison, so the rule has a name a diff can be held against — the
 * `FORBIDDEN_DERIVATION_SIGNALS` pattern.
 */
export const SHADOW_ENGAGEMENT_MEASURE_CLASSES = Object.freeze([
  'engagement',
] as const) satisfies readonly ShadowMeasureClass[];

/** What a decision may be. `hold` is the honest default and the commonest answer. */
export type ShadowReleaseDecision = 'go' | 'hold' | 'rollback';

export const SHADOW_RELEASE_DECISIONS = Object.freeze([
  'go',
  'hold',
  'rollback',
] as const) satisfies readonly ShadowReleaseDecision[];

/** What one item says about the decision. */
export type ShadowEvidenceSupport = 'go' | 'hold' | 'rollback' | 'inconclusive';

export const SHADOW_EVIDENCE_SUPPORTS = Object.freeze([
  'go',
  'hold',
  'rollback',
  'inconclusive',
] as const) satisfies readonly ShadowEvidenceSupport[];

/**
 * One piece of evidence.
 *
 * `citation` is a `SHADOW_SAFE_CODE`, not prose: an evidence package is a
 * document people paste into a decision record, and a free-text field on it is
 * where a participant's name ends up — the Sprint 07 leak, where a detail
 * reading `call-dr.cohen-about-the-biopsy` passed a test that only checked for
 * titles. The narrative belongs in the decision record; this object carries what
 * a checker can verify.
 *
 * `sloReading` is required-and-nullable and carries a whole `ShadowSloReading`
 * rather than a number, so an item resting on an `inconclusive` reading cannot
 * present itself as a measured one — `EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO`
 * is the finding, and it is the small-sample discipline reaching all the way to
 * the release gate.
 */
export type ShadowEvidenceItem = {
  readonly pillar: ShadowEvidencePillar;
  readonly measureClass: ShadowMeasureClass;
  readonly support: ShadowEvidenceSupport;
  readonly sloReading: ShadowSloReading | null;
  readonly citation: string;
};

/**
 * A pillar's evidence: a non-empty tuple, so an empty pillar does not compile.
 * `EVIDENCE_PILLAR_EMPTY` is the untyped-boundary twin — the tuple is a
 * producer's contract and `JSON.parse` is not a producer.
 */
export type ShadowEvidenceBundle = readonly [ShadowEvidenceItem, ...ShadowEvidenceItem[]];

/**
 * The package a go/hold/rollback decision is made from.
 *
 * `evidence` is total over `ShadowEvidencePillar` and each pillar is non-empty,
 * so **a package missing quality, safety, or reliability is unrepresentable** —
 * the acceptance criterion as a type. `checkShadowEvidencePackage` adds the
 * rules the type cannot carry: that a `go` needs non-engagement support in every
 * pillar, that no item may sit under the wrong pillar, and that a `go` alongside
 * an item supporting `rollback` is a contradiction somebody has to resolve
 * before shipping rather than after.
 */
export interface ShadowEvidencePackage {
  readonly version: typeof SHADOW_PIPELINE_CONTRACT_VERSION;
  readonly schemaVersion: typeof SHADOW_PIPELINE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly assembledAt: Instant;
  readonly stage: ShadowExposureStage;
  readonly decision: ShadowReleaseDecision;
  readonly evidence: Readonly<Record<ShadowEvidencePillar, ShadowEvidenceBundle>>;
}

/**
 * The gate rule, **reusing Sprint 10's invariant vocabulary rather than
 * inventing a parallel one.**
 *
 * `satisfies PersonalizationInvariant` is the whole point: this is #41's
 * `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE`, the same string, checked by the
 * compiler to still be a member of `PERSONALIZATION_INVARIANTS`. A second
 * invariant list that said the same thing in different words would agree with
 * the first until one of them was edited, and the one that gets edited is never
 * the one you are reading.
 */
export const SHADOW_RELEASE_GATE_INVARIANT =
  'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE' satisfies PersonalizationInvariant;

/* ── The orchestrator seam ───────────────────────────────────────── */

/**
 * What one module looks like to the orchestrator.
 *
 * Deliberately thin, and deliberately **not filled in here**: the adapter is
 * where the untyped world meets this contract, and its input type is the one
 * place raw text legitimately exists. Declaring it as a seam lets #46 and #47
 * depend on the pipeline's shape before the implementation phase writes the
 * eight adapters, which is what a contract-only phase is for.
 *
 * `budgetMs` is passed in rather than read from the table by the adapter,
 * because an adapter that looks up its own budget is an adapter that can look up
 * a different one. The orchestrator owns the clock and the timer; the adapter
 * owns the call.
 *
 * Note the return type: `ShadowModuleOutcome` and nothing else. An adapter
 * cannot return a store handle, a write receipt, or a promise of a mutation,
 * because there is no variant of the union that carries one.
 */
export type ShadowModuleAdapter = (invocation: {
  readonly module: ShadowPipelineModule;
  readonly runId: string;
  readonly scopeId: string;
  readonly startedAt: Instant;
  readonly budgetMs: number;
  readonly runtimeDecision: ModuleRuntimeDecision;
}) => Promise<ShadowModuleOutcome>;

/**
 * The orchestrator itself, named so #46 and #47 can depend on the seam before
 * the implementation phase fills it.
 *
 * Returns the bundle rather than the outcome: a run that produced a result but
 * no trace is a run nobody can explain, and making the trace part of the return
 * type means it cannot be the thing that gets dropped under time pressure.
 */
export type ShadowPipelineRun = (
  input: ShadowPipelineInput,
  adapters: Readonly<Record<ShadowPipelineModule, ShadowModuleAdapter>>,
) => Promise<ShadowReplayBundle>;

/* ── Defect taxonomy ─────────────────────────────────────────────── */

/**
 * What can be structurally wrong with an outcome.
 *
 * Partitioned by producer, on the `planningContracts` static/attempt rule and
 * `personalizationContracts`' profile/receipt rule: the orchestrator writes
 * outcomes and traces, the recorder writes bundles, #46 writes SLOs and log
 * lines, #47 writes exposure decisions, receipts and packages. One flat list
 * lets a checker report the wrong owner, and an on-call engineer reading a
 * finding needs to know whose bug it is before they need to know what it is.
 *
 * - `OUTCOME_UNREADABLE`      — not an outcome-shaped object at all.
 * - `OUTCOME_VERSION_UNSUPPORTED`
 *                             — a schema version this contract does not know.
 *                               Every other check is suppressed after it: each
 *                               would be a claim about a shape the outcome does
 *                               not have.
 * - `RUN_ID_UNSAFE`           — a `runId` outside `SHADOW_SAFE_CODE`. Not
 *                               cosmetic: the replay preimage joins on control
 *                               characters, so an unconstrained id could forge a
 *                               field boundary.
 * - `COMPLETENESS_UNKNOWN`    — a completeness this version does not recognise;
 *                               variant checks suppressed.
 * - `MODULE_OUTCOME_MISSING`  — the record is not total over the chain. The
 *                               untyped-boundary twin of the total record.
 * - `UNKNOWN_MODULE_OUTCOME`  — a key outside the chain. Reported rather than
 *                               ignored: every pass iterates the chain, so an
 *                               unknown key is otherwise exempt from all of them.
 * - `MODULE_OUTCOME_MODULE_MISMATCH`
 *                             — an entry whose `module` disagrees with its key.
 * - `MODULE_STATUS_UNKNOWN`   — a status this version does not recognise;
 *                               per-status checks suppressed.
 * - `MODULE_CONTRIBUTION_DISAGREES_WITH_STATUS`
 *                             — `contributed` not what the status implies. The
 *                               quiet failure: a timed-out module counted as a
 *                               contributor makes a degraded run read complete.
 * - `MODULE_DIGEST_MISSING`   — a contributing module with no output digest.
 *                               Blank digests compare equal, so a replay over
 *                               them can never show two runs producing different
 *                               output — the `BASIS_DIGEST_MISSING` defect.
 * - `MODULE_DIGEST_MALFORMED` — a digest outside `SHADOW_DIGEST`; separate from
 *                               missing because prose in a digest field is a
 *                               different bug from an empty one, and the prose
 *                               case is the one that can carry content.
 * - `MODULE_DIGEST_PRESENT_WITHOUT_CONTRIBUTION`
 *                             — a non-contributing module carrying a digest: it
 *                               produced nothing, so there is nothing to hash.
 * - `MODULE_ELAPSED_INVALID`  — elapsed time not a non-negative finite number.
 * - `PLACEHOLDER_MODULE_CLAIMS_COMPLETION`
 *                             — a module `SHADOW_MODULE_ROLES` calls a
 *                               placeholder reporting `completed`. The honest
 *                               handling of a stub in the chain: it may be
 *                               `skipped` with `module_placeholder`, never
 *                               "done".
 * - `COMPLETE_WITH_NON_CONTRIBUTOR`
 *                             — `completeness: 'complete'` with a module that
 *                               did not contribute. "A caller must not read a
 *                               partial result as complete", at the boundary
 *                               where the discriminated union is absent.
 * - `DEGRADED_WITHOUT_DEGRADATION`
 *                             — a degraded outcome naming no degraded module.
 *                               The non-empty tuple's untyped twin.
 * - `DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES`
 *                             — the stored non-contributor list is not what
 *                               `moduleOutcomes` says.
 * - `WITHHELD_REASON_UNKNOWN` — a withhold reason outside the vocabulary.
 * - `WITHHELD_WITHOUT_CAUSE`  — `withheld` for
 *                               `fail_closed_module_did_not_contribute` while
 *                               every `fail_closed` module contributed.
 * - `FAIL_CLOSED_MODULE_DELIVERED_ANYWAY`
 *                             — the one that matters: a `fail_closed` module did
 *                               not contribute and the outcome still carries a
 *                               deliverable. An ungated output wearing a quality
 *                               caveat is exactly what the gateway exists to
 *                               prevent, so it is a finding rather than a
 *                               degradation.
 * - `DELIVERABLE_DISPOSITION_UNKNOWN`
 *                             — a safety disposition outside
 *                               `SAFETY_DISPOSITIONS`.
 * - `DELIVERABLE_DIGEST_MALFORMED`
 *                             — the coaching delivery digest is blank or not hex.
 * - `PROPOSAL_CLAIMS_APPLIED`  — a proposal whose `status` is not
 *                               `proposed_never_applied`. The typed guarantee's
 *                               untyped twin, and the single most important code
 *                               in this partition: it is "shadow results cannot
 *                               mutate canonical state" at the one boundary a
 *                               type cannot reach.
 * - `PROPOSAL_TARGET_UNKNOWN` / `PROPOSAL_KIND_UNKNOWN`
 *                             — outside the closed vocabularies.
 * - `PROPOSAL_DIGEST_MALFORMED`
 *                             — a payload digest that is blank or not hex. The
 *                               field where a payload would be smuggled.
 * - `PROPOSAL_FROM_NON_CONTRIBUTING_MODULE`
 *                             — a proposal attributed to a module that did not
 *                               run. Something produced it; the outcome does not
 *                               say what.
 * - `OUTCOME_CARRIES_CALLABLE` — a function reachable at any depth of the
 *                               outcome. `SHADOW_OUTCOME_INERTNESS` makes this
 *                               impossible in TypeScript; this is the same claim
 *                               for a value that arrived through `JSON.parse` or
 *                               an `any`.
 * - `TOTAL_ELAPSED_EXCEEDS_TOTAL_BUDGET`
 *                             — the run outlived `SHADOW_PIPELINE_TOTAL_BUDGET_MS`
 *                               and did not report `total_budget_exhausted`.
 * - `SHADOW_EXCEEDS_LIMIT`    — a bound in `SHADOW_PIPELINE_LIMITS` was broken;
 *                               carries the key.
 */
export type ShadowOutcomeDefectCode =
  | 'OUTCOME_UNREADABLE'
  | 'OUTCOME_VERSION_UNSUPPORTED'
  | 'RUN_ID_UNSAFE'
  | 'COMPLETENESS_UNKNOWN'
  | 'MODULE_OUTCOME_MISSING'
  | 'UNKNOWN_MODULE_OUTCOME'
  | 'MODULE_OUTCOME_MODULE_MISMATCH'
  | 'MODULE_STATUS_UNKNOWN'
  | 'MODULE_CONTRIBUTION_DISAGREES_WITH_STATUS'
  | 'MODULE_DIGEST_MISSING'
  | 'MODULE_DIGEST_MALFORMED'
  | 'MODULE_DIGEST_PRESENT_WITHOUT_CONTRIBUTION'
  | 'MODULE_ELAPSED_INVALID'
  | 'PLACEHOLDER_MODULE_CLAIMS_COMPLETION'
  | 'COMPLETE_WITH_NON_CONTRIBUTOR'
  | 'DEGRADED_WITHOUT_DEGRADATION'
  | 'DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES'
  | 'WITHHELD_REASON_UNKNOWN'
  | 'WITHHELD_WITHOUT_CAUSE'
  | 'FAIL_CLOSED_MODULE_DELIVERED_ANYWAY'
  | 'DELIVERABLE_DISPOSITION_UNKNOWN'
  | 'DELIVERABLE_DIGEST_MALFORMED'
  | 'PROPOSAL_CLAIMS_APPLIED'
  | 'PROPOSAL_TARGET_UNKNOWN'
  | 'PROPOSAL_KIND_UNKNOWN'
  | 'PROPOSAL_DIGEST_MALFORMED'
  | 'PROPOSAL_FROM_NON_CONTRIBUTING_MODULE'
  | 'OUTCOME_CARRIES_CALLABLE'
  | 'TOTAL_ELAPSED_EXCEEDS_TOTAL_BUDGET'
  | 'SHADOW_EXCEEDS_LIMIT';

/**
 * What can be structurally wrong with a trace, judged **against the outcome it
 * explains**.
 *
 * This partition is the acceptance criterion "a trace explains each downstream
 * decision" made reportable. Every code here names a decision that appears
 * somewhere and is unexplained, contradicted, or explained incoherently.
 *
 * - `TRACE_UNREADABLE`        — not a trace-shaped object.
 * - `TRACE_RUN_ID_MISMATCH`   — the trace and the outcome are about different
 *                               runs, which makes every cross-check below a
 *                               comparison of unrelated things; they are
 *                               suppressed after it.
 * - `TRACE_STAGE_MISSING`     — a chain module with no stage record. **The
 *                               criterion, directly**: the outcome says what
 *                               happened to that module and nothing says why.
 * - `TRACE_STAGE_DUPLICATED`  — two records for one module. Reported rather
 *                               than deduplicated: which one explains the
 *                               outcome is a question the trace has to answer.
 * - `TRACE_UNKNOWN_MODULE`    — a stage for a module outside the chain.
 * - `TRACE_STAGE_POSITION_MISMATCH`
 *                             — `position` disagrees with
 *                               `SHADOW_PIPELINE_CHAIN_POSITION`.
 * - `TRACE_STAGE_OUT_OF_ORDER`— stages not in chain order. A trace whose order
 *                               is not the execution order cannot support
 *                               `upstream_did_not_contribute`, which is the
 *                               reason that makes a cascade explicable.
 * - `TRACE_STAGE_STATUS_MISMATCH`
 *                             — the stage and the module outcome disagree about
 *                               what happened.
 * - `TRACE_REASON_MISSING`    — a non-`completed` stage with `reason: null`. The
 *                               criterion at its sharpest: something did not go
 *                               to plan and the trace does not say why.
 * - `TRACE_REASON_UNKNOWN`    — a reason outside the taxonomy.
 * - `TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS`
 *                             — a reason that cannot explain that status, per
 *                               `SHADOW_STAGE_REASON_ADMISSIBILITY`. Without
 *                               this, "timed out because the feature was
 *                               disabled" is a sentence a trace may contain.
 * - `TRACE_COMPLETED_STAGE_STATES_REASON`
 *                             — a completed stage that also excuses itself.
 * - `TRACE_RUNTIME_DECISION_MODULE_MISMATCH`
 *                             — the carried `ModuleRuntimeDecision` is about a
 *                               different module.
 * - `TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION`
 *                             — a stage claiming `kill_switch_active` or
 *                               `feature_disabled` while its own runtime
 *                               decision says `enabled`, or the reverse. The two
 *                               fields are written by one producer from one
 *                               source; a disagreement means the trace is
 *                               narrating rather than recording.
 * - `TRACE_INTERVAL_INVALID`  — `startedAt`/`endedAt` not instants, or ending
 *                               before starting. Every duration check is
 *                               suppressed after it: they borrow their bound
 *                               from the field that did not parse.
 * - `TRACE_ELAPSED_DISAGREES_WITH_INTERVAL`
 *                             — `elapsedMs` is not `endedAt - startedAt`. This
 *                               is why `elapsedMs` is carried rather than
 *                               derived: a recomputed duration can never
 *                               disagree, and therefore can never show a clock
 *                               that jumped.
 * - `TRACE_BUDGET_NOT_DECLARED`
 *                             — `budgetMs` is not this module's declared budget.
 *                               A stage judged against a budget nobody declared
 *                               is a timeout nobody can review.
 * - `TRACE_COMPLETED_EXCEEDS_BUDGET`
 *                             — finished, past its budget, not reported as a
 *                               timeout. One half of reaching every limit.
 * - `TRACE_TIMEOUT_WITHIN_BUDGET`
 *                             — claimed a timeout it never reached. The other
 *                               half, and the direction a suite normally
 *                               forgets.
 * - `TRACE_DIGEST_MISSING` / `TRACE_DIGEST_MALFORMED`
 *                             — as for the outcome's digests.
 * - `TRACE_PROPOSAL_INDEX_OUT_OF_RANGE`
 *                             — a stage citing a proposal position that does not
 *                               exist.
 * - `TRACE_PROPOSAL_ATTRIBUTION_MISMATCH`
 *                             — a stage claiming a proposal another module made.
 * - `TRACE_PROPOSAL_UNEXPLAINED`
 *                             — **a proposal in the outcome that no stage
 *                               claims.** The criterion stated as the issue
 *                               states it: a decision that appears in the
 *                               outcome with no trace entry explaining it is a
 *                               reportable defect.
 * - `TRACE_EXCEEDS_LIMIT`     — a bound in `SHADOW_PIPELINE_LIMITS`; carries the
 *                               key.
 */
export type ShadowTraceDefectCode =
  | 'TRACE_UNREADABLE'
  | 'TRACE_RUN_ID_MISMATCH'
  | 'TRACE_STAGE_MISSING'
  | 'TRACE_STAGE_DUPLICATED'
  | 'TRACE_UNKNOWN_MODULE'
  | 'TRACE_STAGE_POSITION_MISMATCH'
  | 'TRACE_STAGE_OUT_OF_ORDER'
  | 'TRACE_STAGE_STATUS_MISMATCH'
  | 'TRACE_REASON_MISSING'
  | 'TRACE_REASON_UNKNOWN'
  | 'TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS'
  | 'TRACE_COMPLETED_STAGE_STATES_REASON'
  | 'TRACE_RUNTIME_DECISION_MODULE_MISMATCH'
  | 'TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION'
  | 'TRACE_INTERVAL_INVALID'
  | 'TRACE_ELAPSED_DISAGREES_WITH_INTERVAL'
  | 'TRACE_BUDGET_NOT_DECLARED'
  | 'TRACE_COMPLETED_EXCEEDS_BUDGET'
  | 'TRACE_TIMEOUT_WITHIN_BUDGET'
  | 'TRACE_DIGEST_MISSING'
  | 'TRACE_DIGEST_MALFORMED'
  | 'TRACE_PROPOSAL_INDEX_OUT_OF_RANGE'
  | 'TRACE_PROPOSAL_ATTRIBUTION_MISMATCH'
  | 'TRACE_PROPOSAL_UNEXPLAINED'
  | 'TRACE_EXCEEDS_LIMIT';

/**
 * What can be structurally wrong with a replay.
 *
 * - `REPLAY_BUNDLE_UNREADABLE` / `REPLAY_OBSERVATION_UNREADABLE`
 *                             — not bundle- or observation-shaped.
 * - `REPLAY_RUN_ID_MISMATCH`  — the bundle's parts are about different runs.
 * - `SCOPE_ID_UNSAFE`         — a `scopeId` outside `SHADOW_SAFE_CODE`; the
 *                               preimage-forgery argument again.
 * - `REPLAY_INPUT_DIGEST_MALFORMED` / `REPLAY_BUNDLE_DIGEST_MALFORMED`
 *                             — a digest that is blank or not hex.
 * - `REPLAY_DIGEST_DIVERGED`  — the two bundle digests differ. Detection.
 * - `REPLAY_PREIMAGE_DIVERGED`— the two preimages differ, which localises the
 *                               detection to *content* rather than to hashing:
 *                               equal preimages with unequal digests means the
 *                               hashing convention moved, not the run.
 * - `REPLAY_CONTROLS_DIVERGED`— a flag or kill switch moved between the runs.
 *                               The commonest cause, and the one a bundle that
 *                               did not record the controls could not name.
 * - `REPLAY_COMPLETENESS_DIVERGED`
 *                             — the two runs disagree about the run's shape.
 * - `REPLAY_MODULE_STATUS_DIVERGED`
 *                             — **carries the module**, so a disagreement is
 *                               localised rather than merely detected. A replay
 *                               harness that can only say "the digests differ"
 *                               sends someone to read two whole bundles.
 * - `DELIVERABLE_CLAIMS_EXPOSURE_AT_SHADOW_ONLY`
 *                             — `wouldHaveBeenShown` at a stage that shows
 *                               nobody. The one contradiction that would make a
 *                               shadow release not a shadow release.
 * - `ALPHA_SESSION_AT_SHADOW_ONLY`
 *                             — a run at `shadow_only` attached to an alpha
 *                               session. Nobody saw it, so there is no session
 *                               to attach to, and an attachment implies a
 *                               participant surface that does not exist.
 */
export type ShadowReplayDefectCode =
  | 'REPLAY_BUNDLE_UNREADABLE'
  | 'REPLAY_OBSERVATION_UNREADABLE'
  | 'REPLAY_RUN_ID_MISMATCH'
  | 'SCOPE_ID_UNSAFE'
  | 'REPLAY_INPUT_DIGEST_MALFORMED'
  | 'REPLAY_BUNDLE_DIGEST_MALFORMED'
  | 'REPLAY_DIGEST_DIVERGED'
  | 'REPLAY_PREIMAGE_DIVERGED'
  | 'REPLAY_CONTROLS_DIVERGED'
  | 'REPLAY_COMPLETENESS_DIVERGED'
  | 'REPLAY_MODULE_STATUS_DIVERGED'
  | 'DELIVERABLE_CLAIMS_EXPOSURE_AT_SHADOW_ONLY'
  | 'ALPHA_SESSION_AT_SHADOW_ONLY';

/**
 * What can be structurally wrong with an SLO definition or reading (#46).
 *
 * - `SLO_OWNER_MISSING`, `SLO_OWNER_TEAM_UNKNOWN`, `SLO_OWNER_ROTATION_UNSAFE`
 *                             — "alert ownership is explicit" at the untyped
 *                               boundary. An unroutable rotation id is worse
 *                               than no alert, because it looks like coverage.
 * - `SLO_ESCALATION_SAME_AS_PRIMARY`
 *                             — an escalation path that leads back to the person
 *                               who did not answer.
 * - `SLO_SAMPLE_FLOOR_TOO_LOW`— a definition declaring a minimum below
 *                               `MIN_SLO_SAMPLE_COUNT`, which would let the
 *                               small-sample discipline be satisfied by
 *                               declaring the sample large enough.
 * - `SLO_VALUE_NOT_FINITE`    — a measured reading whose value is not a finite
 *                               number. Separate from breach because `NaN > x`
 *                               is `false`: folding them would make the alert
 *                               pass exactly when the collector broke.
 * - `SLO_MEASURED_BELOW_SAMPLE_FLOOR`
 *                             — a `measured` reading over too few samples. The
 *                               Sprint 10 rule: below the floor the only legal
 *                               shape is `inconclusive`.
 * - `SLO_INCONCLUSIVE_NOT_VALUE_FREE`
 *                             — an inconclusive reading carrying a value or a
 *                               breach. The quiet failure: the collector decided
 *                               and labelled it undecided.
 * - `SLO_BREACH_DISAGREES_WITH_THRESHOLD`
 *                             — `breached` is not what `shadowSloBreached` says.
 * - `SLO_READING_WINDOW_INCOHERENT`
 *                             — `windowStart` is not `observedAt` minus the
 *                               declared window, so the reading describes a
 *                               different window than the one it claims.
 */
export type ShadowSloDefectCode =
  | 'SLO_DEFINITION_UNREADABLE'
  | 'SLO_ID_UNSAFE'
  | 'SLO_METRIC_UNKNOWN'
  | 'SLO_COMPARISON_UNKNOWN'
  | 'SLO_WINDOW_UNKNOWN'
  | 'SLO_THRESHOLD_NOT_FINITE'
  | 'SLO_OWNER_MISSING'
  | 'SLO_OWNER_TEAM_UNKNOWN'
  | 'SLO_OWNER_ROTATION_UNSAFE'
  | 'SLO_ESCALATION_SAME_AS_PRIMARY'
  | 'SLO_SAMPLE_FLOOR_TOO_LOW'
  | 'SLO_KILL_SWITCH_MODULE_UNKNOWN'
  | 'SLO_READING_UNREADABLE'
  | 'SLO_READING_ID_MISMATCH'
  | 'SLO_READING_STATUS_UNKNOWN'
  | 'SLO_VALUE_NOT_FINITE'
  | 'SLO_SAMPLE_COUNT_INVALID'
  | 'SLO_MEASURED_BELOW_SAMPLE_FLOOR'
  | 'SLO_INCONCLUSIVE_REASON_UNKNOWN'
  | 'SLO_INCONCLUSIVE_NOT_VALUE_FREE'
  | 'SLO_BREACH_DISAGREES_WITH_THRESHOLD'
  | 'SLO_READING_INSTANT_INVALID'
  | 'SLO_READING_WINDOW_INCOHERENT';

/**
 * What can be structurally wrong with a privacy-safe log line offered for
 * reconciliation against a trace (#46).
 *
 * - `LOG_STAGE_LOCATOR_INCOHERENT`
 *                             — `module` and `stagePosition` half-present. A
 *                               line claiming to be about a stage without saying
 *                               which is a line that cannot be reconciled and
 *                               will be counted as reconciled.
 * - `LOG_STAGE_NOT_IN_TRACE`  — a stage the trace does not have. Either the log
 *                               or the trace is lying; the reconciliation is the
 *                               only thing that can tell you one of them is.
 * - `LOG_DIGEST_MISMATCH`     — the line and the bundle describe different runs
 *                               despite sharing a `runId`.
 * - `LOG_CARRIES_FORBIDDEN_KEY`
 *                             — a property whose name is in
 *                               `SHADOW_FORBIDDEN_LOG_KEY_CLASSES`. Names, not
 *                               values: the Sprint 07 leak went through a field
 *                               nobody thought to scan.
 */
export type ShadowReconciliationDefectCode =
  | 'LOG_KEY_UNREADABLE'
  | 'LOG_RUN_ID_MISMATCH'
  | 'LOG_INSTANT_INVALID'
  | 'LOG_STAGE_LOCATOR_INCOHERENT'
  | 'LOG_STAGE_NOT_IN_TRACE'
  | 'LOG_DIGEST_MISMATCH'
  | 'LOG_CARRIES_FORBIDDEN_KEY';

/**
 * What can be structurally wrong with a consent record or an exposure decision
 * (#47).
 *
 * - `CONSENT_INACTIVE_CARRIES_SCOPES`
 *                             — a withheld or revoked consent with live scopes.
 *                               The untyped twin of "revocation is a shape".
 * - `EXPOSURE_ALLOWED_WITH_STOP_REASON`
 *                             — `allowed: true` alongside a pilot stop reason.
 *                               The shadow gate cannot be more permissive than
 *                               the pilot gate, at the boundary where the
 *                               function is not the one that produced it.
 * - `EXPOSURE_ALLOWED_AT_SHADOW_ONLY`
 *                             — anyone exposed at the stage that exposes nobody.
 * - `EXPOSURE_COHORT_BELOW_STAGE_FLOOR`
 *                             — a "closed pilot" of four people, whose evidence
 *                               nobody should decide on.
 */
export type ShadowExposureDefectCode =
  | 'CONSENT_UNREADABLE'
  | 'CONSENT_STATE_UNKNOWN'
  | 'CONSENT_PARTICIPANT_UNSAFE'
  | 'CONSENT_SCOPE_UNKNOWN'
  | 'CONSENT_GRANTED_WITHOUT_SCOPES'
  | 'CONSENT_INACTIVE_CARRIES_SCOPES'
  | 'CONSENT_INSTANT_INVALID'
  | 'CONSENT_REVOKED_BEFORE_GRANTED'
  | 'EXPOSURE_DECISION_UNREADABLE'
  | 'EXPOSURE_PARTICIPANT_UNSAFE'
  | 'EXPOSURE_STAGE_UNKNOWN'
  | 'EXPOSURE_REASON_UNKNOWN'
  | 'EXPOSURE_CONSENT_STATE_UNKNOWN'
  | 'EXPOSURE_CAP_DISAGREES_WITH_STAGE'
  | 'EXPOSURE_COHORT_INVALID'
  | 'EXPOSURE_COHORT_EXCEEDS_CAP'
  | 'EXPOSURE_COHORT_BELOW_STAGE_FLOOR'
  | 'EXPOSURE_ALLOWED_AT_SHADOW_ONLY'
  | 'EXPOSURE_ALLOWED_WITHOUT_CONSENT'
  | 'EXPOSURE_ALLOWED_WITH_STOP_REASON';

/**
 * What can be structurally wrong with a study deletion receipt (#47).
 *
 * `SHADOW_NESTED_RECEIPT_DEFECT` is the seam with Sprint 10: the embedded
 * `PersonalizationDeletionReceipt` is checked by
 * `checkPersonalizationDeletionReceipt` and its findings are re-coded under this
 * one, carrying the inner code in the detail. One deletion vocabulary, extended,
 * rather than two that agree until one is edited.
 *
 * `SHADOW_RECEIPT_REMAINDER_NOT_A_COUNT` is separate from `..._NOT_ZERO` for the
 * reason Sprint 10 recorded: `NaN > 0` is `false`, so folding them would make an
 * unreadable receipt *pass* the deletion check, and a check that passes exactly
 * when it stops understanding its input is a check any bug can satisfy.
 */
export type ShadowReceiptDefectCode =
  | 'SHADOW_RECEIPT_UNREADABLE'
  | 'SHADOW_RECEIPT_PARTICIPANT_UNSAFE'
  | 'SHADOW_RECEIPT_INSTANT_INVALID'
  | 'SHADOW_RECEIPT_REMAINDER_NOT_A_COUNT'
  | 'SHADOW_RECEIPT_REMAINDER_NOT_ZERO'
  | 'SHADOW_RECEIPT_DIGEST_MISSING'
  | 'SHADOW_RECEIPT_DIGEST_MALFORMED'
  | 'SHADOW_NESTED_RECEIPT_DEFECT';

/**
 * What can be structurally wrong with an evidence package (#47).
 *
 * - `GO_RESTS_ON_ENGAGEMENT_ALONE`
 *                             — a `go` whose support in some pillar is
 *                               engagement-class only. #41's
 *                               `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE`, as a
 *                               computable finding rather than a review
 *                               convention.
 * - `GO_WITHOUT_SUPPORT_IN_PILLAR`
 *                             — a `go` with no item supporting it in some
 *                               pillar. "Includes quality, safety and
 *                               reliability evidence" means evidence *for* the
 *                               decision, not three headings.
 * - `GO_CONTRADICTED_BY_ROLLBACK_EVIDENCE`
 *                             — a `go` alongside an item that says roll back.
 *                               Reported rather than outvoted: a contradiction
 *                               is for a human to resolve before shipping.
 * - `EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO`
 *                             — an item supporting `go` whose only measurement
 *                               is an inconclusive reading. The small-sample
 *                               discipline reaching the release gate: "we cannot
 *                               tell" is not "it is fine".
 * - `EVIDENCE_EXCEEDS_LIMIT`  — a bound in `SHADOW_PIPELINE_LIMITS`; carries the
 *                               key.
 */
export type ShadowEvidenceDefectCode =
  | 'PACKAGE_UNREADABLE'
  | 'PACKAGE_ID_UNSAFE'
  | 'PACKAGE_INSTANT_INVALID'
  | 'PACKAGE_STAGE_UNKNOWN'
  | 'PACKAGE_DECISION_UNKNOWN'
  | 'EVIDENCE_PILLAR_MISSING'
  | 'EVIDENCE_PILLAR_EMPTY'
  | 'EVIDENCE_UNKNOWN_PILLAR'
  | 'EVIDENCE_ITEM_PILLAR_MISMATCH'
  | 'EVIDENCE_MEASURE_CLASS_UNKNOWN'
  | 'EVIDENCE_SUPPORT_UNKNOWN'
  | 'EVIDENCE_CITATION_UNSAFE'
  | 'EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO'
  | 'GO_WITHOUT_SUPPORT_IN_PILLAR'
  | 'GO_RESTS_ON_ENGAGEMENT_ALONE'
  | 'GO_CONTRADICTED_BY_ROLLBACK_EVIDENCE'
  | 'EVIDENCE_EXCEEDS_LIMIT';

/**
 * What can be structurally wrong with this file's own constants.
 *
 * A partition of one-and-a-half, and it exists because
 * `SHADOW_PIPELINE_TOTAL_BUDGET_MS` is a declared ceiling rather than a computed
 * sum: the relationship between it and `SHADOW_MODULE_TIMEOUT_BUDGET_MS` has to
 * be checkable, or an edit that raises one module's budget silently raises the
 * whole run's. `checkShadowBudgetTable` is the only checker here whose subject
 * is the contract rather than a caller's data.
 */
export type ShadowConfigurationDefectCode =
  | 'MODULE_BUDGET_NOT_POSITIVE'
  | 'TOTAL_BUDGET_BELOW_SUM_OF_MODULES';

export type ShadowPipelineDefectCode =
  | ShadowOutcomeDefectCode
  | ShadowTraceDefectCode
  | ShadowReplayDefectCode
  | ShadowSloDefectCode
  | ShadowReconciliationDefectCode
  | ShadowExposureDefectCode
  | ShadowReceiptDefectCode
  | ShadowEvidenceDefectCode
  | ShadowConfigurationDefectCode;

/**
 * One structural finding.
 *
 * Every locator is a **position** or a closed-vocabulary name, never a
 * caller-chosen identifier — the rule `safetyContracts` states, and the reason
 * `readingIndex` exists rather than `sloId`: an id is a free string people fill
 * with content, and a finding is a thing that gets logged. `detail` carries
 * static prose plus numbers derived from the input and nothing else; no
 * caller-chosen string is ever quoted into it.
 */
export interface ShadowPipelineDefect {
  readonly code: ShadowPipelineDefectCode;
  readonly module: ShadowPipelineModule | null;
  /** Position in `SHADOW_PIPELINE_CHAIN`, or in `trace.stages`. */
  readonly stagePosition: number | null;
  /** Position in `deliverable.proposedEffects`. */
  readonly proposalIndex: number | null;
  /** Position in a pillar's evidence bundle. */
  readonly evidenceIndex: number | null;
  readonly pillar: ShadowEvidencePillar | null;
  /** The bound that was broken, for the `*_EXCEEDS_LIMIT` codes. */
  readonly limitName: ShadowPipelineLimitName | null;
  readonly detail: string;
}

export const SHADOW_OUTCOME_DEFECT_CODES = Object.freeze([
  'OUTCOME_UNREADABLE',
  'OUTCOME_VERSION_UNSUPPORTED',
  'RUN_ID_UNSAFE',
  'COMPLETENESS_UNKNOWN',
  'MODULE_OUTCOME_MISSING',
  'UNKNOWN_MODULE_OUTCOME',
  'MODULE_OUTCOME_MODULE_MISMATCH',
  'MODULE_STATUS_UNKNOWN',
  'MODULE_CONTRIBUTION_DISAGREES_WITH_STATUS',
  'MODULE_DIGEST_MISSING',
  'MODULE_DIGEST_MALFORMED',
  'MODULE_DIGEST_PRESENT_WITHOUT_CONTRIBUTION',
  'MODULE_ELAPSED_INVALID',
  'PLACEHOLDER_MODULE_CLAIMS_COMPLETION',
  'COMPLETE_WITH_NON_CONTRIBUTOR',
  'DEGRADED_WITHOUT_DEGRADATION',
  'DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES',
  'WITHHELD_REASON_UNKNOWN',
  'WITHHELD_WITHOUT_CAUSE',
  'FAIL_CLOSED_MODULE_DELIVERED_ANYWAY',
  'DELIVERABLE_DISPOSITION_UNKNOWN',
  'DELIVERABLE_DIGEST_MALFORMED',
  'PROPOSAL_CLAIMS_APPLIED',
  'PROPOSAL_TARGET_UNKNOWN',
  'PROPOSAL_KIND_UNKNOWN',
  'PROPOSAL_DIGEST_MALFORMED',
  'PROPOSAL_FROM_NON_CONTRIBUTING_MODULE',
  'OUTCOME_CARRIES_CALLABLE',
  'TOTAL_ELAPSED_EXCEEDS_TOTAL_BUDGET',
  'SHADOW_EXCEEDS_LIMIT',
] as const) satisfies readonly ShadowOutcomeDefectCode[];


type _ShadowOutcomeDefectCodesCovered =
  Exclude<ShadowOutcomeDefectCode, (typeof SHADOW_OUTCOME_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowOutcomeDefectCodesAreExhaustive: _ShadowOutcomeDefectCodesCovered = true;
export const SHADOW_OUTCOME_DEFECT_CODE_COVERAGE = _shadowOutcomeDefectCodesAreExhaustive;

export const SHADOW_TRACE_DEFECT_CODES = Object.freeze([
  'TRACE_UNREADABLE',
  'TRACE_RUN_ID_MISMATCH',
  'TRACE_STAGE_MISSING',
  'TRACE_STAGE_DUPLICATED',
  'TRACE_UNKNOWN_MODULE',
  'TRACE_STAGE_POSITION_MISMATCH',
  'TRACE_STAGE_OUT_OF_ORDER',
  'TRACE_STAGE_STATUS_MISMATCH',
  'TRACE_REASON_MISSING',
  'TRACE_REASON_UNKNOWN',
  'TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS',
  'TRACE_COMPLETED_STAGE_STATES_REASON',
  'TRACE_RUNTIME_DECISION_MODULE_MISMATCH',
  'TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION',
  'TRACE_INTERVAL_INVALID',
  'TRACE_ELAPSED_DISAGREES_WITH_INTERVAL',
  'TRACE_BUDGET_NOT_DECLARED',
  'TRACE_COMPLETED_EXCEEDS_BUDGET',
  'TRACE_TIMEOUT_WITHIN_BUDGET',
  'TRACE_DIGEST_MISSING',
  'TRACE_DIGEST_MALFORMED',
  'TRACE_PROPOSAL_INDEX_OUT_OF_RANGE',
  'TRACE_PROPOSAL_ATTRIBUTION_MISMATCH',
  'TRACE_PROPOSAL_UNEXPLAINED',
  'TRACE_EXCEEDS_LIMIT',
] as const) satisfies readonly ShadowTraceDefectCode[];


type _ShadowTraceDefectCodesCovered =
  Exclude<ShadowTraceDefectCode, (typeof SHADOW_TRACE_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowTraceDefectCodesAreExhaustive: _ShadowTraceDefectCodesCovered = true;
export const SHADOW_TRACE_DEFECT_CODE_COVERAGE = _shadowTraceDefectCodesAreExhaustive;

export const SHADOW_REPLAY_DEFECT_CODES = Object.freeze([
  'REPLAY_BUNDLE_UNREADABLE',
  'REPLAY_OBSERVATION_UNREADABLE',
  'REPLAY_RUN_ID_MISMATCH',
  'SCOPE_ID_UNSAFE',
  'REPLAY_INPUT_DIGEST_MALFORMED',
  'REPLAY_BUNDLE_DIGEST_MALFORMED',
  'REPLAY_DIGEST_DIVERGED',
  'REPLAY_PREIMAGE_DIVERGED',
  'REPLAY_CONTROLS_DIVERGED',
  'REPLAY_COMPLETENESS_DIVERGED',
  'REPLAY_MODULE_STATUS_DIVERGED',
  'DELIVERABLE_CLAIMS_EXPOSURE_AT_SHADOW_ONLY',
  'ALPHA_SESSION_AT_SHADOW_ONLY',
] as const) satisfies readonly ShadowReplayDefectCode[];


type _ShadowReplayDefectCodesCovered =
  Exclude<ShadowReplayDefectCode, (typeof SHADOW_REPLAY_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowReplayDefectCodesAreExhaustive: _ShadowReplayDefectCodesCovered = true;
export const SHADOW_REPLAY_DEFECT_CODE_COVERAGE = _shadowReplayDefectCodesAreExhaustive;

export const SHADOW_SLO_DEFECT_CODES = Object.freeze([
  'SLO_DEFINITION_UNREADABLE',
  'SLO_ID_UNSAFE',
  'SLO_METRIC_UNKNOWN',
  'SLO_COMPARISON_UNKNOWN',
  'SLO_WINDOW_UNKNOWN',
  'SLO_THRESHOLD_NOT_FINITE',
  'SLO_OWNER_MISSING',
  'SLO_OWNER_TEAM_UNKNOWN',
  'SLO_OWNER_ROTATION_UNSAFE',
  'SLO_ESCALATION_SAME_AS_PRIMARY',
  'SLO_SAMPLE_FLOOR_TOO_LOW',
  'SLO_KILL_SWITCH_MODULE_UNKNOWN',
  'SLO_READING_UNREADABLE',
  'SLO_READING_ID_MISMATCH',
  'SLO_READING_STATUS_UNKNOWN',
  'SLO_VALUE_NOT_FINITE',
  'SLO_SAMPLE_COUNT_INVALID',
  'SLO_MEASURED_BELOW_SAMPLE_FLOOR',
  'SLO_INCONCLUSIVE_REASON_UNKNOWN',
  'SLO_INCONCLUSIVE_NOT_VALUE_FREE',
  'SLO_BREACH_DISAGREES_WITH_THRESHOLD',
  'SLO_READING_INSTANT_INVALID',
  'SLO_READING_WINDOW_INCOHERENT',
] as const) satisfies readonly ShadowSloDefectCode[];


type _ShadowSloDefectCodesCovered =
  Exclude<ShadowSloDefectCode, (typeof SHADOW_SLO_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowSloDefectCodesAreExhaustive: _ShadowSloDefectCodesCovered = true;
export const SHADOW_SLO_DEFECT_CODE_COVERAGE = _shadowSloDefectCodesAreExhaustive;

export const SHADOW_RECONCILIATION_DEFECT_CODES = Object.freeze([
  'LOG_KEY_UNREADABLE',
  'LOG_RUN_ID_MISMATCH',
  'LOG_INSTANT_INVALID',
  'LOG_STAGE_LOCATOR_INCOHERENT',
  'LOG_STAGE_NOT_IN_TRACE',
  'LOG_DIGEST_MISMATCH',
  'LOG_CARRIES_FORBIDDEN_KEY',
] as const) satisfies readonly ShadowReconciliationDefectCode[];


type _ShadowReconciliationDefectCodesCovered =
  Exclude<ShadowReconciliationDefectCode, (typeof SHADOW_RECONCILIATION_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowReconciliationDefectCodesAreExhaustive: _ShadowReconciliationDefectCodesCovered = true;
export const SHADOW_RECONCILIATION_DEFECT_CODE_COVERAGE = _shadowReconciliationDefectCodesAreExhaustive;

export const SHADOW_EXPOSURE_DEFECT_CODES = Object.freeze([
  'CONSENT_UNREADABLE',
  'CONSENT_STATE_UNKNOWN',
  'CONSENT_PARTICIPANT_UNSAFE',
  'CONSENT_SCOPE_UNKNOWN',
  'CONSENT_GRANTED_WITHOUT_SCOPES',
  'CONSENT_INACTIVE_CARRIES_SCOPES',
  'CONSENT_INSTANT_INVALID',
  'CONSENT_REVOKED_BEFORE_GRANTED',
  'EXPOSURE_DECISION_UNREADABLE',
  'EXPOSURE_PARTICIPANT_UNSAFE',
  'EXPOSURE_STAGE_UNKNOWN',
  'EXPOSURE_REASON_UNKNOWN',
  'EXPOSURE_CONSENT_STATE_UNKNOWN',
  'EXPOSURE_CAP_DISAGREES_WITH_STAGE',
  'EXPOSURE_COHORT_INVALID',
  'EXPOSURE_COHORT_EXCEEDS_CAP',
  'EXPOSURE_COHORT_BELOW_STAGE_FLOOR',
  'EXPOSURE_ALLOWED_AT_SHADOW_ONLY',
  'EXPOSURE_ALLOWED_WITHOUT_CONSENT',
  'EXPOSURE_ALLOWED_WITH_STOP_REASON',
] as const) satisfies readonly ShadowExposureDefectCode[];


type _ShadowExposureDefectCodesCovered =
  Exclude<ShadowExposureDefectCode, (typeof SHADOW_EXPOSURE_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowExposureDefectCodesAreExhaustive: _ShadowExposureDefectCodesCovered = true;
export const SHADOW_EXPOSURE_DEFECT_CODE_COVERAGE = _shadowExposureDefectCodesAreExhaustive;

export const SHADOW_RECEIPT_DEFECT_CODES = Object.freeze([
  'SHADOW_RECEIPT_UNREADABLE',
  'SHADOW_RECEIPT_PARTICIPANT_UNSAFE',
  'SHADOW_RECEIPT_INSTANT_INVALID',
  'SHADOW_RECEIPT_REMAINDER_NOT_A_COUNT',
  'SHADOW_RECEIPT_REMAINDER_NOT_ZERO',
  'SHADOW_RECEIPT_DIGEST_MISSING',
  'SHADOW_RECEIPT_DIGEST_MALFORMED',
  'SHADOW_NESTED_RECEIPT_DEFECT',
] as const) satisfies readonly ShadowReceiptDefectCode[];


type _ShadowReceiptDefectCodesCovered =
  Exclude<ShadowReceiptDefectCode, (typeof SHADOW_RECEIPT_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowReceiptDefectCodesAreExhaustive: _ShadowReceiptDefectCodesCovered = true;
export const SHADOW_RECEIPT_DEFECT_CODE_COVERAGE = _shadowReceiptDefectCodesAreExhaustive;

export const SHADOW_EVIDENCE_DEFECT_CODES = Object.freeze([
  'PACKAGE_UNREADABLE',
  'PACKAGE_ID_UNSAFE',
  'PACKAGE_INSTANT_INVALID',
  'PACKAGE_STAGE_UNKNOWN',
  'PACKAGE_DECISION_UNKNOWN',
  'EVIDENCE_PILLAR_MISSING',
  'EVIDENCE_PILLAR_EMPTY',
  'EVIDENCE_UNKNOWN_PILLAR',
  'EVIDENCE_ITEM_PILLAR_MISMATCH',
  'EVIDENCE_MEASURE_CLASS_UNKNOWN',
  'EVIDENCE_SUPPORT_UNKNOWN',
  'EVIDENCE_CITATION_UNSAFE',
  'EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO',
  'GO_WITHOUT_SUPPORT_IN_PILLAR',
  'GO_RESTS_ON_ENGAGEMENT_ALONE',
  'GO_CONTRADICTED_BY_ROLLBACK_EVIDENCE',
  'EVIDENCE_EXCEEDS_LIMIT',
] as const) satisfies readonly ShadowEvidenceDefectCode[];


type _ShadowEvidenceDefectCodesCovered =
  Exclude<ShadowEvidenceDefectCode, (typeof SHADOW_EVIDENCE_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowEvidenceDefectCodesAreExhaustive: _ShadowEvidenceDefectCodesCovered = true;
export const SHADOW_EVIDENCE_DEFECT_CODE_COVERAGE = _shadowEvidenceDefectCodesAreExhaustive;

export const SHADOW_CONFIGURATION_DEFECT_CODES = Object.freeze([
  'MODULE_BUDGET_NOT_POSITIVE',
  'TOTAL_BUDGET_BELOW_SUM_OF_MODULES',
] as const) satisfies readonly ShadowConfigurationDefectCode[];


type _ShadowConfigurationDefectCodesCovered =
  Exclude<ShadowConfigurationDefectCode, (typeof SHADOW_CONFIGURATION_DEFECT_CODES)[number]> extends never ? true : never;
const _shadowConfigurationDefectCodesAreExhaustive: _ShadowConfigurationDefectCodesCovered = true;
export const SHADOW_CONFIGURATION_DEFECT_CODE_COVERAGE = _shadowConfigurationDefectCodesAreExhaustive;


/**
 * The nine partitions as one value, so a test can iterate them and assert they
 * are disjoint — which they are, checkably, unlike a shared prefix convention
 * would make them. The keys name the producer whose bug each partition reports.
 */
export const SHADOW_DEFECT_PARTITIONS = Object.freeze({
  outcome: SHADOW_OUTCOME_DEFECT_CODES,
  trace: SHADOW_TRACE_DEFECT_CODES,
  replay: SHADOW_REPLAY_DEFECT_CODES,
  slo: SHADOW_SLO_DEFECT_CODES,
  reconciliation: SHADOW_RECONCILIATION_DEFECT_CODES,
  exposure: SHADOW_EXPOSURE_DEFECT_CODES,
  receipt: SHADOW_RECEIPT_DEFECT_CODES,
  evidence: SHADOW_EVIDENCE_DEFECT_CODES,
  configuration: SHADOW_CONFIGURATION_DEFECT_CODES,
});

/**
 * What each status implies about contribution, as data rather than as a
 * comparison written out at each site.
 *
 * `contributed` is a field of the module outcome *and* derivable from its
 * status, which is a redundancy on purpose: the field is what consumers read
 * and the table is what `MODULE_CONTRIBUTION_DISAGREES_WITH_STATUS` holds it
 * against. Removing the field would make the disagreement unrepresentable and
 * therefore unreportable, and a producer that gets it wrong at the untyped
 * boundary is exactly the producer whose degraded run would read as complete.
 */
export const SHADOW_STATUS_CONTRIBUTION: Readonly<Record<ShadowModuleStatus, boolean>> =
  Object.freeze({
    completed: true,
    fell_back: true,
    skipped: false,
    timed_out: false,
    unavailable: false,
  });

/** How long each SLO window is, in milliseconds, for the coherence check. */
export const SHADOW_SLO_WINDOW_MILLIS: Readonly<Record<ShadowSloWindow, number>> = Object.freeze({
  rolling_1h: 60 * 60 * 1_000,
  rolling_24h: 24 * 60 * 60 * 1_000,
  rolling_7d: 7 * 24 * 60 * 60 * 1_000,
});

/* ── Checkers: report, never throw ───────────────────────────────── */

/** Blank, or not a string at all. Total, for the reason `isBlank` is elsewhere. */
function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeCode(value: unknown): boolean {
  return typeof value === 'string' && SHADOW_SAFE_CODE.test(value);
}

function isDigest(value: unknown): boolean {
  return typeof value === 'string' && SHADOW_DIGEST.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

type ShadowDefectLocators = Partial<
  Pick<
    ShadowPipelineDefect,
    'module' | 'stagePosition' | 'proposalIndex' | 'evidenceIndex' | 'pillar' | 'limitName'
  >
>;

function defect(
  code: ShadowPipelineDefectCode,
  detail: string,
  locators: ShadowDefectLocators = {},
): ShadowPipelineDefect {
  return {
    code,
    module: locators.module ?? null,
    stagePosition: locators.stagePosition ?? null,
    proposalIndex: locators.proposalIndex ?? null,
    evidenceIndex: locators.evidenceIndex ?? null,
    pillar: locators.pillar ?? null,
    limitName: locators.limitName ?? null,
    detail,
  };
}

/**
 * The runtime half of the inertness guarantee.
 *
 * `SHADOW_OUTCOME_INERTNESS` makes a callable field impossible in TypeScript;
 * this walks an actual value and reports one at any depth, which is the claim
 * for an outcome that arrived through `JSON.parse`, an `any`, or a boundary
 * where the type was asserted rather than checked. Both halves are needed and
 * neither substitutes for the other — a type cannot see a runtime value and a
 * walker cannot stop a compile.
 *
 * Cycle-safe via a seen set, because a checker that throws on a cyclic input
 * hands the decision to whichever caller forgot the try/catch — and "the
 * outcome was so malformed the check crashed" must not read as "the outcome is
 * inert". Depth is bounded by the seen set rather than by a counter: a counter
 * would silently stop looking, which is the fail-open direction.
 */
export function checkShadowInertness(value: unknown): readonly ShadowPipelineDefect[] {
  const defects: ShadowPipelineDefect[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'function') {
      defects.push(
        defect('OUTCOME_CARRIES_CALLABLE', `a callable is reachable from the outcome at ${path}`),
      );
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) walk(node[index], `${path}[${index}]`);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };

  walk(value, 'outcome');
  return defects;
}

/**
 * Structural check over a pipeline outcome. Returns findings; **it does not
 * throw, for any input.**
 *
 * Suppression follows one rule: a check is suppressed only when it would borrow
 * its bound from a field that has already been reported unusable. An unknown
 * schema version suppresses everything below it because every check below is a
 * claim about a shape this version believes the outcome has; an unknown status
 * suppresses that module's per-status checks and nothing else.
 */
export function checkShadowPipelineOutcome(
  outcome: ShadowPipelineOutcome,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(outcome)) {
    return [defect('OUTCOME_UNREADABLE', 'an outcome was checked that is not an outcome-shaped object')];
  }
  const record = outcome as unknown as Record<string, unknown>;

  if (
    record.schemaVersion !== SHADOW_PIPELINE_SCHEMA_VERSION ||
    record.version !== SHADOW_PIPELINE_CONTRACT_VERSION
  ) {
    return [
      defect(
        'OUTCOME_VERSION_UNSUPPORTED',
        'the outcome states a schema or contract version this contract does not recognise',
      ),
    ];
  }

  const defects: ShadowPipelineDefect[] = [];

  if (!isSafeCode(record.runId)) {
    defects.push(defect('RUN_ID_UNSAFE', 'the outcome names a run identifier outside the safe-code pattern'));
  }

  defects.push(...checkShadowInertness(record));

  const completeness = record.completeness;
  const completenessKnown = SHADOW_COMPLETENESS_STATES.includes(completeness as ShadowCompleteness);
  if (!completenessKnown) {
    defects.push(
      defect('COMPLETENESS_UNKNOWN', 'the outcome states a completeness this contract version does not recognise'),
    );
  }

  const moduleOutcomes = isRecord(record.moduleOutcomes) ? record.moduleOutcomes : {};
  const contributed = new Set<ShadowPipelineModule>();

  for (const key of Object.keys(moduleOutcomes)) {
    if (!SHADOW_PIPELINE_CHAIN.includes(key as ShadowPipelineModule)) {
      defects.push(
        defect('UNKNOWN_MODULE_OUTCOME', `the outcome carries a module entry that is not in the chain`),
      );
    }
  }

  for (const module of SHADOW_PIPELINE_CHAIN) {
    const position = SHADOW_PIPELINE_CHAIN_POSITION[module];
    const entry = moduleOutcomes[module];
    if (!isRecord(entry)) {
      defects.push(
        defect('MODULE_OUTCOME_MISSING', 'the outcome records nothing for a module in the chain', {
          module,
          stagePosition: position,
        }),
      );
      continue;
    }

    if (entry.module !== module) {
      defects.push(
        defect('MODULE_OUTCOME_MODULE_MISMATCH', 'a module entry names a different module than its key', {
          module,
          stagePosition: position,
        }),
      );
    }

    const status = entry.status;
    if (!SHADOW_MODULE_STATUSES.includes(status as ShadowModuleStatus)) {
      defects.push(
        defect('MODULE_STATUS_UNKNOWN', 'a module reports a status this contract version does not recognise', {
          module,
          stagePosition: position,
        }),
      );
      continue;
    }

    const expected = SHADOW_STATUS_CONTRIBUTION[status as ShadowModuleStatus];
    if (entry.contributed !== expected) {
      defects.push(
        defect(
          'MODULE_CONTRIBUTION_DISAGREES_WITH_STATUS',
          `a ${String(status)} module claims contribution ${String(entry.contributed)}; the status implies ${String(expected)}`,
          { module, stagePosition: position },
        ),
      );
    }
    if (expected) contributed.add(module);

    if (!isCount(entry.elapsedMs)) {
      defects.push(
        defect('MODULE_ELAPSED_INVALID', 'a module reports an elapsed time that is not a non-negative integer', {
          module,
          stagePosition: position,
        }),
      );
    }

    if (expected) {
      if (isBlank(entry.outputDigest)) {
        defects.push(
          defect('MODULE_DIGEST_MISSING', 'a contributing module carries no output digest a replay could compare', {
            module,
            stagePosition: position,
          }),
        );
      } else if (!isDigest(entry.outputDigest)) {
        defects.push(
          defect('MODULE_DIGEST_MALFORMED', 'a module output digest is not lowercase hex of the declared length', {
            module,
            stagePosition: position,
          }),
        );
      }
    } else if (entry.outputDigest !== null && entry.outputDigest !== undefined) {
      defects.push(
        defect(
          'MODULE_DIGEST_PRESENT_WITHOUT_CONTRIBUTION',
          'a module that produced nothing carries an output digest',
          { module, stagePosition: position },
        ),
      );
    }

    if (SHADOW_MODULE_ROLES[module] === 'placeholder' && status === 'completed') {
      defects.push(
        defect(
          'PLACEHOLDER_MODULE_CLAIMS_COMPLETION',
          'a placeholder module reports completion; a stub may be skipped, never done',
          { module, stagePosition: position },
        ),
      );
    }
  }

  const nonContributors = SHADOW_PIPELINE_CHAIN.filter((module) => !contributed.has(module));
  const failClosedGap = nonContributors.filter(
    (module) => SHADOW_MODULE_FAILURE_STANCE[module] === 'fail_closed',
  );

  const deliverable = isRecord(record.deliverable) ? record.deliverable : null;
  const degradation = isRecord(record.degradation) ? record.degradation : null;

  if (completenessKnown) {
    if (completeness === 'complete' && nonContributors.length > 0) {
      defects.push(
        defect(
          'COMPLETE_WITH_NON_CONTRIBUTOR',
          `a complete outcome carries ${nonContributors.length} modules that did not contribute`,
        ),
      );
    }

    if (completeness !== 'complete') {
      const listed = Array.isArray(degradation?.nonContributingModules)
        ? (degradation?.nonContributingModules as unknown[])
        : [];
      if (degradation === null || listed.length === 0) {
        defects.push(
          defect('DEGRADED_WITHOUT_DEGRADATION', 'a non-complete outcome names no module that failed to contribute'),
        );
      } else {
        const listedSet = new Set(listed as ShadowPipelineModule[]);
        const sameMembers =
          listedSet.size === nonContributors.length &&
          nonContributors.every((module) => listedSet.has(module));
        if (!sameMembers) {
          defects.push(
            defect(
              'DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES',
              `the outcome lists ${listedSet.size} non-contributing modules; the module outcomes show ${nonContributors.length}`,
            ),
          );
        } else if (degradation.crossedFailClosedModule !== (failClosedGap.length > 0)) {
          defects.push(
            defect(
              'DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES',
              'the outcome disagrees with its own module outcomes about whether a fail-closed module was crossed',
            ),
          );
        }
      }
    }

    if (completeness === 'withheld') {
      const withheldReason = record.withheldReason;
      if (!SHADOW_WITHHOLD_REASONS.includes(withheldReason as ShadowWithholdReason)) {
        defects.push(
          defect('WITHHELD_REASON_UNKNOWN', 'a withheld outcome states a reason this contract version does not recognise'),
        );
      } else if (
        withheldReason === 'fail_closed_module_did_not_contribute' &&
        failClosedGap.length === 0
      ) {
        defects.push(
          defect(
            'WITHHELD_WITHOUT_CAUSE',
            'the outcome blames a fail-closed module, and every fail-closed module contributed',
          ),
        );
      }
    }
  }

  if (deliverable !== null && failClosedGap.length > 0) {
    for (const module of failClosedGap) {
      defects.push(
        defect(
          'FAIL_CLOSED_MODULE_DELIVERED_ANYWAY',
          'a fail-closed module did not contribute and the outcome still carries a deliverable',
          { module, stagePosition: SHADOW_PIPELINE_CHAIN_POSITION[module] },
        ),
      );
    }
  }

  if (deliverable !== null) {
    if (!SAFETY_DISPOSITIONS.includes(deliverable.safetyDisposition as SafetyDisposition)) {
      defects.push(
        defect('DELIVERABLE_DISPOSITION_UNKNOWN', 'the deliverable states a safety disposition outside the safety vocabulary'),
      );
    }
    if (!isDigest(deliverable.coachingDeliveryDigest)) {
      defects.push(
        defect('DELIVERABLE_DIGEST_MALFORMED', 'the deliverable carries no well-formed coaching delivery digest'),
      );
    }

    const proposals = Array.isArray(deliverable.proposedEffects)
      ? (deliverable.proposedEffects as unknown[])
      : [];
    if (proposals.length > SHADOW_PIPELINE_LIMITS.maxProposedEffects) {
      defects.push(
        defect(
          'SHADOW_EXCEEDS_LIMIT',
          `the deliverable carries ${proposals.length} proposed effects; the cap is ${SHADOW_PIPELINE_LIMITS.maxProposedEffects}`,
          { limitName: 'maxProposedEffects' },
        ),
      );
    }

    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      if (!isRecord(proposal)) {
        defects.push(
          defect('PROPOSAL_CLAIMS_APPLIED', 'a proposed effect is not a proposal-shaped object', {
            proposalIndex: index,
          }),
        );
        continue;
      }
      if (proposal.status !== 'proposed_never_applied') {
        defects.push(
          defect(
            'PROPOSAL_CLAIMS_APPLIED',
            'a proposed effect does not state that it was never applied; a shadow effect has no other legal status',
            { proposalIndex: index },
          ),
        );
      }
      if (!SHADOW_EFFECT_TARGETS.includes(proposal.target as ShadowEffectTarget)) {
        defects.push(
          defect('PROPOSAL_TARGET_UNKNOWN', 'a proposed effect names a target outside the closed vocabulary', {
            proposalIndex: index,
          }),
        );
      }
      if (!SHADOW_EFFECT_KINDS.includes(proposal.kind as ShadowEffectKind)) {
        defects.push(
          defect('PROPOSAL_KIND_UNKNOWN', 'a proposed effect names a kind outside the closed vocabulary', {
            proposalIndex: index,
          }),
        );
      }
      if (!isDigest(proposal.payloadDigest)) {
        defects.push(
          defect('PROPOSAL_DIGEST_MALFORMED', 'a proposed effect carries no well-formed payload digest', {
            proposalIndex: index,
          }),
        );
      }
      const proposedBy = proposal.proposedBy as ShadowPipelineModule;
      if (!contributed.has(proposedBy)) {
        defects.push(
          defect(
            'PROPOSAL_FROM_NON_CONTRIBUTING_MODULE',
            'a proposed effect is attributed to a module that did not contribute',
            {
              proposalIndex: index,
              module: SHADOW_PIPELINE_CHAIN.includes(proposedBy) ? proposedBy : null,
            },
          ),
        );
      }
    }
  }

  if (
    isFiniteNumber(record.totalElapsedMs) &&
    (record.totalElapsedMs as number) > SHADOW_PIPELINE_TOTAL_BUDGET_MS &&
    record.withheldReason !== 'total_budget_exhausted'
  ) {
    defects.push(
      defect(
        'TOTAL_ELAPSED_EXCEEDS_TOTAL_BUDGET',
        `the run took ${record.totalElapsedMs}ms; the declared ceiling is ${SHADOW_PIPELINE_TOTAL_BUDGET_MS}ms and the outcome does not report it`,
      ),
    );
  }

  return defects;
}

/**
 * Structural check over a trace, **against the outcome it explains**.
 *
 * Taking both is the whole design: a trace checked alone can be internally
 * consistent and explain a different run, and the acceptance criterion is about
 * the relationship between the two artifacts, not about either one.
 */
export function checkShadowTrace(
  trace: ShadowPipelineTrace,
  outcome: ShadowPipelineOutcome,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(trace) || !Array.isArray((trace as unknown as Record<string, unknown>).stages)) {
    return [defect('TRACE_UNREADABLE', 'a trace was checked that is not a trace-shaped object')];
  }
  if (!isRecord(outcome)) {
    return [defect('TRACE_UNREADABLE', 'a trace was checked against something that is not an outcome')];
  }
  if (trace.runId !== (outcome as unknown as Record<string, unknown>).runId) {
    return [
      defect(
        'TRACE_RUN_ID_MISMATCH',
        'the trace and the outcome describe different runs; every cross-check below would compare unrelated things',
      ),
    ];
  }

  const defects: ShadowPipelineDefect[] = [];
  const stages = trace.stages;

  if (stages.length > SHADOW_PIPELINE_LIMITS.maxTraceStages) {
    defects.push(
      defect(
        'TRACE_EXCEEDS_LIMIT',
        `the trace carries ${stages.length} stages; the cap is ${SHADOW_PIPELINE_LIMITS.maxTraceStages}`,
        { limitName: 'maxTraceStages' },
      ),
    );
  }

  const deliverable = (outcome as unknown as Record<string, unknown>).deliverable;
  const proposals: readonly ShadowEffectProposal[] =
    isRecord(deliverable) && Array.isArray(deliverable.proposedEffects)
      ? (deliverable.proposedEffects as readonly ShadowEffectProposal[])
      : [];
  const explained = new Set<number>();

  const seenModules = new Set<ShadowPipelineModule>();
  let previousPosition = -1;

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (!isRecord(stage) || !SHADOW_PIPELINE_CHAIN.includes(stage.module as ShadowPipelineModule)) {
      defects.push(
        defect('TRACE_UNKNOWN_MODULE', 'a stage names a module that is not in the chain', {
          stagePosition: index,
        }),
      );
      continue;
    }
    const module = stage.module;
    const position = SHADOW_PIPELINE_CHAIN_POSITION[module];

    if (seenModules.has(module)) {
      defects.push(
        defect('TRACE_STAGE_DUPLICATED', 'the trace carries more than one stage for one module', {
          module,
          stagePosition: index,
        }),
      );
    }
    seenModules.add(module);

    if (stage.position !== position) {
      defects.push(
        defect(
          'TRACE_STAGE_POSITION_MISMATCH',
          `a stage states position ${String(stage.position)}; the chain places this module at ${position}`,
          { module, stagePosition: index },
        ),
      );
    }
    if (position < previousPosition) {
      defects.push(
        defect('TRACE_STAGE_OUT_OF_ORDER', 'a stage appears before one that runs earlier in the chain', {
          module,
          stagePosition: index,
        }),
      );
    }
    previousPosition = position;

    const declaredBudget = SHADOW_MODULE_TIMEOUT_BUDGET_MS[module];
    if (stage.budgetMs !== declaredBudget) {
      defects.push(
        defect(
          'TRACE_BUDGET_NOT_DECLARED',
          `a stage was judged against ${String(stage.budgetMs)}ms; this module's declared budget is ${declaredBudget}ms`,
          { module, stagePosition: index },
        ),
      );
    }

    const elapsedFromInstants = millisBetweenInstants(stage.startedAt, stage.endedAt);
    const intervalUsable = elapsedFromInstants !== null && elapsedFromInstants >= 0;
    if (!intervalUsable) {
      defects.push(
        defect(
          'TRACE_INTERVAL_INVALID',
          'a stage does not state a well-formed interval; every duration judgement about it borrows that bound',
          { module, stagePosition: index },
        ),
      );
    } else if (stage.elapsedMs !== elapsedFromInstants) {
      defects.push(
        defect(
          'TRACE_ELAPSED_DISAGREES_WITH_INTERVAL',
          `a stage reports ${String(stage.elapsedMs)}ms elapsed; its own instants are ${elapsedFromInstants}ms apart`,
          { module, stagePosition: index },
        ),
      );
    }

    const status = stage.status;
    const statusKnown = SHADOW_MODULE_STATUSES.includes(status as ShadowModuleStatus);
    const moduleOutcome = isRecord((outcome as unknown as Record<string, unknown>).moduleOutcomes)
      ? ((outcome as unknown as Record<string, unknown>).moduleOutcomes as Record<string, unknown>)[module]
      : undefined;
    if (isRecord(moduleOutcome) && moduleOutcome.status !== status) {
      defects.push(
        defect(
          'TRACE_STAGE_STATUS_MISMATCH',
          'a stage and the outcome disagree about what happened to this module',
          { module, stagePosition: index },
        ),
      );
    }

    const reason = stage.reason;
    if (statusKnown && status === 'completed') {
      if (reason !== null && reason !== undefined) {
        defects.push(
          defect(
            'TRACE_COMPLETED_STAGE_STATES_REASON',
            'a completed stage also states a reason it did not complete',
            { module, stagePosition: index },
          ),
        );
      }
    } else if (statusKnown) {
      if (reason === null || reason === undefined) {
        defects.push(
          defect(
            'TRACE_REASON_MISSING',
            'a stage that did not complete states no reason; the outcome carries a decision nothing explains',
            { module, stagePosition: index },
          ),
        );
      } else if (!SHADOW_STAGE_REASONS.includes(reason as ShadowStageReason)) {
        defects.push(
          defect('TRACE_REASON_UNKNOWN', 'a stage states a reason this contract version does not recognise', {
            module,
            stagePosition: index,
          }),
        );
      } else if (
        !SHADOW_STAGE_REASON_ADMISSIBILITY[status as ShadowModuleStatus].includes(
          reason as ShadowStageReason,
        )
      ) {
        defects.push(
          defect(
            'TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS',
            'a stage explains its status with a reason that cannot produce that status',
            { module, stagePosition: index },
          ),
        );
      }
    }

    // Read loosely on purpose: `stage` arrived at an untyped boundary, so the
    // narrowing TypeScript would do from the typed union here would be a claim
    // about a shape this checker exists to doubt.
    const decision = stage.runtimeDecision as unknown as Record<string, unknown>;
    if (isRecord(decision)) {
      if (decision.module !== module) {
        defects.push(
          defect(
            'TRACE_RUNTIME_DECISION_MODULE_MISMATCH',
            'a stage carries a runtime decision about a different module',
            { module, stagePosition: index },
          ),
        );
      } else if (decision.mode === 'enabled') {
        if (reason === 'feature_disabled' || reason === 'kill_switch_active') {
          defects.push(
            defect(
              'TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION',
              'a stage blames a switch its own runtime decision says was not thrown',
              { module, stagePosition: index },
            ),
          );
        }
      } else if (decision.mode === 'rules_only') {
        if (status === 'completed') {
          defects.push(
            defect(
              'TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION',
              'a stage reports full completion while its runtime decision restricted it to rules only',
              { module, stagePosition: index },
            ),
          );
        } else if (
          (reason === 'feature_disabled' || reason === 'kill_switch_active') &&
          reason !== decision.reason
        ) {
          defects.push(
            defect(
              'TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION',
              'a stage names a different switch than its own runtime decision recorded',
              { module, stagePosition: index },
            ),
          );
        }
      }
    }

    const contributes =
      statusKnown && SHADOW_STATUS_CONTRIBUTION[status as ShadowModuleStatus] === true;
    if (contributes) {
      if (isBlank(stage.outputDigest)) {
        defects.push(
          defect('TRACE_DIGEST_MISSING', 'a contributing stage carries no output digest', {
            module,
            stagePosition: index,
          }),
        );
      } else if (!isDigest(stage.outputDigest)) {
        defects.push(
          defect('TRACE_DIGEST_MALFORMED', 'a stage output digest is not lowercase hex of the declared length', {
            module,
            stagePosition: index,
          }),
        );
      }
    }

    if (statusKnown && intervalUsable) {
      if (status === 'completed' && (stage.elapsedMs as number) > declaredBudget) {
        defects.push(
          defect(
            'TRACE_COMPLETED_EXCEEDS_BUDGET',
            `a stage completed after ${String(stage.elapsedMs)}ms; its budget is ${declaredBudget}ms and it was not reported as a timeout`,
            { module, stagePosition: index },
          ),
        );
      }
      if (status === 'timed_out' && (stage.elapsedMs as number) < declaredBudget) {
        defects.push(
          defect(
            'TRACE_TIMEOUT_WITHIN_BUDGET',
            `a stage claims a timeout after ${String(stage.elapsedMs)}ms; its budget is ${declaredBudget}ms and had not been reached`,
            { module, stagePosition: index },
          ),
        );
      }
    }

    const indices = Array.isArray(stage.proposalIndices) ? stage.proposalIndices : [];
    for (const cited of indices) {
      if (!Number.isInteger(cited) || (cited as number) < 0 || (cited as number) >= proposals.length) {
        defects.push(
          defect('TRACE_PROPOSAL_INDEX_OUT_OF_RANGE', 'a stage cites a proposal position the outcome does not have', {
            module,
            stagePosition: index,
          }),
        );
        continue;
      }
      explained.add(cited as number);
      if (proposals[cited as number].proposedBy !== module) {
        defects.push(
          defect(
            'TRACE_PROPOSAL_ATTRIBUTION_MISMATCH',
            'a stage claims a proposal the outcome attributes to another module',
            { module, stagePosition: index, proposalIndex: cited as number },
          ),
        );
      }
    }
  }

  for (const module of SHADOW_PIPELINE_CHAIN) {
    if (!seenModules.has(module)) {
      defects.push(
        defect(
          'TRACE_STAGE_MISSING',
          'the outcome records what happened to this module and the trace does not say why',
          { module, stagePosition: SHADOW_PIPELINE_CHAIN_POSITION[module] },
        ),
      );
    }
  }

  for (let index = 0; index < proposals.length; index += 1) {
    if (!explained.has(index)) {
      defects.push(
        defect(
          'TRACE_PROPOSAL_UNEXPLAINED',
          'the outcome proposes an effect that no stage in the trace accounts for',
          { proposalIndex: index },
        ),
      );
    }
  }

  return defects;
}

/**
 * Structural check over a replay: does a second run agree with a recorded one?
 *
 * Reports the *localised* disagreement, not only the fact of one.
 * `REPLAY_MODULE_STATUS_DIVERGED` carries the module, so an on-call engineer is
 * sent to the stage that moved rather than to two whole bundles; and the
 * preimage comparison is reported separately from the digest comparison,
 * because equal preimages with unequal digests means the hashing convention
 * changed and not the run — two facts a single "the digests differ" cannot
 * distinguish.
 */
export function checkShadowReplay(
  bundle: ShadowReplayBundle,
  observation: ShadowReplayObservation,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(bundle) || !isRecord(bundle.input) || !isRecord(bundle.trace) || !isRecord(bundle.outcome)) {
    return [defect('REPLAY_BUNDLE_UNREADABLE', 'a bundle was checked that is not a bundle-shaped object')];
  }
  if (!isRecord(observation) || !isRecord(observation.outcome) || !isRecord(observation.trace)) {
    return [
      defect('REPLAY_OBSERVATION_UNREADABLE', 'a replay observation was checked that is not observation-shaped'),
    ];
  }

  const defects: ShadowPipelineDefect[] = [];
  const input = bundle.input;

  if (
    bundle.runId !== input.runId ||
    bundle.runId !== bundle.trace.runId ||
    bundle.runId !== bundle.outcome.runId ||
    bundle.runId !== observation.outcome.runId
  ) {
    return [
      defect(
        'REPLAY_RUN_ID_MISMATCH',
        'the bundle, its trace, its outcome and the observation do not all describe one run',
      ),
    ];
  }

  if (!isSafeCode(input.scopeId)) {
    defects.push(defect('SCOPE_ID_UNSAFE', 'the bundle names a scope identifier outside the safe-code pattern'));
  }
  if (!isDigest(input.inputDigest)) {
    defects.push(defect('REPLAY_INPUT_DIGEST_MALFORMED', 'the bundle carries no well-formed input digest'));
  }
  if (!isDigest(bundle.bundleDigest) || !isDigest(observation.bundleDigest)) {
    defects.push(defect('REPLAY_BUNDLE_DIGEST_MALFORMED', 'a bundle digest is not lowercase hex of the declared length'));
  }

  for (const module of INTELLIGENCE_MODULES) {
    const recordedFlag = input.controls.featureFlags[module];
    const replayedFlag = observation.controls.featureFlags[module];
    const recordedSwitch = input.controls.killSwitches[module];
    const replayedSwitch = observation.controls.killSwitches[module];
    if (recordedFlag !== replayedFlag || recordedSwitch !== replayedSwitch) {
      defects.push(
        defect(
          'REPLAY_CONTROLS_DIVERGED',
          'a feature flag or kill switch moved between the recorded run and the replay',
          { module: SHADOW_PIPELINE_CHAIN.includes(module as ShadowPipelineModule) ? (module as ShadowPipelineModule) : null },
        ),
      );
    }
  }

  if (bundle.outcome.completeness !== observation.outcome.completeness) {
    defects.push(
      defect(
        'REPLAY_COMPLETENESS_DIVERGED',
        `the recorded run was ${bundle.outcome.completeness} and the replay was ${observation.outcome.completeness}`,
      ),
    );
  }

  for (const module of SHADOW_PIPELINE_CHAIN) {
    const recorded = bundle.outcome.moduleOutcomes[module];
    const replayed = observation.outcome.moduleOutcomes[module];
    const recordedStatus = isRecord(recorded) ? recorded.status : null;
    const replayedStatus = isRecord(replayed) ? replayed.status : null;
    if (recordedStatus !== replayedStatus) {
      defects.push(
        defect(
          'REPLAY_MODULE_STATUS_DIVERGED',
          `this module was ${String(recordedStatus)} when recorded and ${String(replayedStatus)} on replay`,
          { module, stagePosition: SHADOW_PIPELINE_CHAIN_POSITION[module] },
        ),
      );
    }
  }

  const replayedBundle: ShadowReplayBundle = {
    ...bundle,
    input: { ...input, controls: observation.controls },
    trace: observation.trace,
    outcome: observation.outcome,
    bundleDigest: observation.bundleDigest,
  };
  const recordedPreimage = shadowReplayPreimage(bundle);
  const replayedPreimage = shadowReplayPreimage(replayedBundle);
  if (recordedPreimage !== replayedPreimage) {
    defects.push(
      defect('REPLAY_PREIMAGE_DIVERGED', 'the recorded run and the replay do not serialise to the same preimage'),
    );
  }
  if (bundle.bundleDigest !== observation.bundleDigest) {
    defects.push(defect('REPLAY_DIGEST_DIVERGED', 'the recorded and replayed bundle digests differ'));
  }

  const stage = input.exposure.stage;
  if (stage === 'shadow_only') {
    if (bundle.outcome.deliverable !== null && bundle.outcome.deliverable.wouldHaveBeenShown === true) {
      defects.push(
        defect(
          'DELIVERABLE_CLAIMS_EXPOSURE_AT_SHADOW_ONLY',
          'a run at the stage that exposes nobody claims its output would have been shown',
        ),
      );
    }
    if (bundle.trace.alphaSessionId !== null) {
      defects.push(
        defect(
          'ALPHA_SESSION_AT_SHADOW_ONLY',
          'a run at the stage that exposes nobody is attached to a participant session',
        ),
      );
    }
  }

  return defects;
}

/**
 * Structural check over an SLO definition (#46). Reports; never throws.
 *
 * The owner checks are the reason this function exists at all: an SLO whose
 * threshold is wrong produces a bad alert, and an SLO whose rotation id is wrong
 * produces the *appearance* of an alert, which is the failure mode that
 * survives a review.
 */
export function checkShadowSloDefinition(
  definition: ShadowSloDefinition,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(definition)) {
    return [defect('SLO_DEFINITION_UNREADABLE', 'an SLO was checked that is not a definition-shaped object')];
  }
  const defects: ShadowPipelineDefect[] = [];

  if (!isSafeCode(definition.sloId)) {
    defects.push(defect('SLO_ID_UNSAFE', 'the definition names an SLO identifier outside the safe-code pattern'));
  }
  if (!SHADOW_SLO_METRICS.includes(definition.metric)) {
    defects.push(defect('SLO_METRIC_UNKNOWN', 'the definition reads a metric this contract version does not define'));
  }
  if (!SHADOW_SLO_COMPARISONS.includes(definition.comparison)) {
    defects.push(defect('SLO_COMPARISON_UNKNOWN', 'the definition states a comparison this contract version does not recognise'));
  }
  if (!SHADOW_SLO_WINDOWS.includes(definition.window)) {
    defects.push(defect('SLO_WINDOW_UNKNOWN', 'the definition states a window this contract version does not recognise'));
  }
  if (!isFiniteNumber(definition.threshold)) {
    defects.push(defect('SLO_THRESHOLD_NOT_FINITE', 'the definition states a threshold that is not a finite number'));
  }

  const owner = definition.owner;
  if (!isRecord(owner)) {
    defects.push(defect('SLO_OWNER_MISSING', 'the definition names nobody to wake up when it breaches'));
  } else {
    if (!SHADOW_SLO_OWNER_TEAMS.includes(owner.team as ShadowSloOwnerTeam)) {
      defects.push(defect('SLO_OWNER_TEAM_UNKNOWN', 'the definition names an owning team outside the closed vocabulary'));
    }
    if (!isSafeCode(owner.rotationId) || !isSafeCode(owner.escalationRotationId)) {
      defects.push(
        defect('SLO_OWNER_ROTATION_UNSAFE', 'the definition names a rotation an alert router could not resolve'),
      );
    } else if (owner.rotationId === owner.escalationRotationId) {
      defects.push(
        defect(
          'SLO_ESCALATION_SAME_AS_PRIMARY',
          'the escalation path leads back to the rotation that did not answer',
        ),
      );
    }
  }

  if (!isCount(definition.minimumSampleCount) || (definition.minimumSampleCount as number) < MIN_SLO_SAMPLE_COUNT) {
    defects.push(
      defect(
        'SLO_SAMPLE_FLOOR_TOO_LOW',
        `the definition accepts ${String(definition.minimumSampleCount)} samples as sufficient; the floor is ${MIN_SLO_SAMPLE_COUNT}`,
      ),
    );
  }

  if (
    definition.killSwitchModule !== null &&
    !INTELLIGENCE_MODULES.includes(definition.killSwitchModule as IntelligenceModuleName)
  ) {
    defects.push(
      defect('SLO_KILL_SWITCH_MODULE_UNKNOWN', 'the definition arms a kill switch for a module that does not exist'),
    );
  }

  return defects;
}

/**
 * Structural check over a reading against its definition (#46).
 *
 * `readingIndex` is the locator rather than `sloId`, per the finding rule: an id
 * is a caller-chosen free string, and a finding is a thing that gets logged.
 */
export function checkShadowSloReading(
  reading: ShadowSloReading,
  definition: ShadowSloDefinition,
  readingIndex = 0,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(reading)) {
    return [defect('SLO_READING_UNREADABLE', 'a reading was checked that is not a reading-shaped object')];
  }
  const defects: ShadowPipelineDefect[] = [];
  const at = { evidenceIndex: readingIndex };

  if (reading.sloId !== definition.sloId) {
    defects.push(defect('SLO_READING_ID_MISMATCH', 'the reading and the definition are about different SLOs', at));
  }
  if (!SHADOW_SLO_READING_STATUSES.includes(reading.status)) {
    defects.push(
      defect('SLO_READING_STATUS_UNKNOWN', 'the reading states a status this contract version does not recognise', at),
    );
    return defects;
  }
  if (!isCount(reading.sampleCount)) {
    defects.push(defect('SLO_SAMPLE_COUNT_INVALID', 'the reading states a sample count that is not a non-negative integer', at));
  }

  const startMillis = millisBetweenInstants(reading.windowStart, reading.observedAt);
  if (!isInstant(reading.windowStart) || !isInstant(reading.observedAt) || startMillis === null) {
    defects.push(defect('SLO_READING_INSTANT_INVALID', 'the reading does not state well-formed instants', at));
  } else {
    const expected = SHADOW_SLO_WINDOW_MILLIS[definition.window];
    if (expected !== undefined && startMillis !== expected) {
      defects.push(
        defect(
          'SLO_READING_WINDOW_INCOHERENT',
          `the reading spans ${startMillis}ms; its definition's window is ${expected}ms`,
          at,
        ),
      );
    }
  }

  if (reading.status === 'inconclusive') {
    if (!SHADOW_SLO_INCONCLUSIVE_REASONS.includes(reading.inconclusiveReason)) {
      defects.push(
        defect('SLO_INCONCLUSIVE_REASON_UNKNOWN', 'the reading states an inconclusive reason outside the vocabulary', at),
      );
    }
    if (reading.value !== null || reading.breached !== null) {
      defects.push(
        defect(
          'SLO_INCONCLUSIVE_NOT_VALUE_FREE',
          'an inconclusive reading carries a value or a breach; the collector decided and labelled it undecided',
          at,
        ),
      );
    }
    return defects;
  }

  if (!isFiniteNumber(reading.value)) {
    defects.push(
      defect(
        'SLO_VALUE_NOT_FINITE',
        'a measured reading states a value that is not a finite number; an alert over it would pass exactly when the collector broke',
        at,
      ),
    );
    return defects;
  }

  if (isCount(reading.sampleCount) && (reading.sampleCount as number) < definition.minimumSampleCount) {
    defects.push(
      defect(
        'SLO_MEASURED_BELOW_SAMPLE_FLOOR',
        `a measured reading rests on ${reading.sampleCount} samples; its definition requires ${definition.minimumSampleCount}`,
        at,
      ),
    );
  }

  const breached = shadowSloBreached(definition, reading.value);
  if (breached !== null && reading.breached !== breached) {
    defects.push(
      defect(
        'SLO_BREACH_DISAGREES_WITH_THRESHOLD',
        `the reading claims breached=${String(reading.breached)}; the definition's comparison says ${String(breached)}`,
        at,
      ),
    );
  }

  return defects;
}

/**
 * Structural check that a privacy-safe log line reconciles with a trace (#46).
 *
 * Takes the whole line rather than a pre-extracted key, because the forbidden-key
 * scan has to see **every** property and not the ones somebody remembered to
 * pass. That is the Sprint 07 lesson stated as a signature: a scan over a list
 * of fields anyone thought of is a scan that misses the field nobody did.
 */
export function checkShadowLogReconciliation(
  line: Readonly<Record<string, unknown>>,
  trace: ShadowPipelineTrace,
  bundleDigest: string,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(line)) {
    return [defect('LOG_KEY_UNREADABLE', 'a log line was checked that is not an object')];
  }
  const defects: ShadowPipelineDefect[] = [];

  for (const key of Object.keys(line)) {
    const lowered = key.toLowerCase();
    for (const forbidden of SHADOW_FORBIDDEN_LOG_KEY_CLASSES) {
      if (lowered.includes(forbidden)) {
        defects.push(
          defect('LOG_CARRIES_FORBIDDEN_KEY', `the log line carries a property of the forbidden class "${forbidden}"`),
        );
        break;
      }
    }
  }

  if (line.runId !== trace.runId) {
    defects.push(defect('LOG_RUN_ID_MISMATCH', 'the log line and the trace name different runs'));
  }
  if (!isInstant(line.occurredAt)) {
    defects.push(defect('LOG_INSTANT_INVALID', 'the log line does not state a well-formed instant'));
  }
  if (line.bundleDigest !== bundleDigest) {
    defects.push(
      defect('LOG_DIGEST_MISMATCH', 'the log line and the bundle describe different runs despite sharing an identifier'),
    );
  }

  const module = line.module;
  const stagePosition = line.stagePosition;
  const hasModule = module !== null && module !== undefined;
  const hasPosition = stagePosition !== null && stagePosition !== undefined;
  if (hasModule !== hasPosition) {
    defects.push(
      defect(
        'LOG_STAGE_LOCATOR_INCOHERENT',
        'the log line names a module or a position but not both; it cannot be reconciled and would be counted as reconciled',
      ),
    );
  } else if (hasModule) {
    const found = trace.stages.some(
      (stage) => stage.module === module && stage.position === stagePosition,
    );
    if (!found) {
      defects.push(
        defect(
          'LOG_STAGE_NOT_IN_TRACE',
          'the log line describes a stage the trace does not have; one of the two is wrong and only the reconciliation can say so',
          {
            module: SHADOW_PIPELINE_CHAIN.includes(module as ShadowPipelineModule)
              ? (module as ShadowPipelineModule)
              : null,
            stagePosition: typeof stagePosition === 'number' ? stagePosition : null,
          },
        ),
      );
    }
  }

  return defects;
}

/** Structural check over a consent record (#47). Reports; never throws. */
export function checkShadowStudyConsent(
  consent: ShadowStudyConsent,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(consent)) {
    return [defect('CONSENT_UNREADABLE', 'a consent was checked that is not a consent-shaped object')];
  }
  const defects: ShadowPipelineDefect[] = [];

  if (!isSafeCode(consent.participantId)) {
    defects.push(defect('CONSENT_PARTICIPANT_UNSAFE', 'the consent names a participant outside the safe-code pattern'));
  }
  if (!SHADOW_CONSENT_STATES.includes(consent.state)) {
    defects.push(defect('CONSENT_STATE_UNKNOWN', 'the consent states a state this contract version does not recognise'));
    return defects;
  }

  const scopes = Array.isArray(consent.scopes) ? (consent.scopes as unknown[]) : [];
  for (const scope of scopes) {
    if (!SHADOW_CONSENT_SCOPES.includes(scope as ShadowConsentScope)) {
      defects.push(defect('CONSENT_SCOPE_UNKNOWN', 'the consent grants a scope outside the closed vocabulary'));
    }
  }

  if (consent.state === 'granted') {
    if (scopes.length === 0) {
      defects.push(defect('CONSENT_GRANTED_WITHOUT_SCOPES', 'a granted consent grants nothing'));
    }
    if (!isInstant(consent.grantedAt)) {
      defects.push(defect('CONSENT_INSTANT_INVALID', 'a granted consent does not state when it was granted'));
    }
  } else {
    if (scopes.length > 0) {
      defects.push(
        defect(
          'CONSENT_INACTIVE_CARRIES_SCOPES',
          'a consent that is not granted still carries live scopes; revocation must leave nothing to read',
        ),
      );
    }
  }

  if (consent.state === 'revoked') {
    if (!isInstant(consent.grantedAt) || !isInstant(consent.revokedAt)) {
      defects.push(defect('CONSENT_INSTANT_INVALID', 'a revoked consent does not state both when it was granted and when it was withdrawn'));
    } else {
      const elapsed = millisBetweenInstants(consent.grantedAt, consent.revokedAt);
      if (elapsed !== null && elapsed < 0) {
        defects.push(
          defect('CONSENT_REVOKED_BEFORE_GRANTED', 'the consent was withdrawn before it was granted'),
        );
      }
    }
  }

  return defects;
}

/**
 * Structural check over a staged exposure decision, **against the pilot decision
 * it was built on** (#47).
 *
 * Taking the pilot decision is the enforcement of
 * `SHADOW_EXPOSURE_POLICY.shadowExposureNeverExceedsPilot`: a checker that saw
 * only the shadow decision could not tell whether the shadow gate had widened
 * the pilot gate, which is the one thing this pair of gates exists to prevent.
 */
export function checkShadowExposureDecision(
  decision: ShadowExposureDecision,
  pilotDecision: ShadowPilotDecision,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(decision) || !isRecord(pilotDecision)) {
    return [defect('EXPOSURE_DECISION_UNREADABLE', 'an exposure decision was checked that is not decision-shaped')];
  }
  const defects: ShadowPipelineDefect[] = [];

  if (!isSafeCode(decision.participantId)) {
    defects.push(defect('EXPOSURE_PARTICIPANT_UNSAFE', 'the decision names a participant outside the safe-code pattern'));
  }
  const stageKnown = SHADOW_EXPOSURE_STAGES.includes(decision.stage);
  if (!stageKnown) {
    defects.push(defect('EXPOSURE_STAGE_UNKNOWN', 'the decision states a stage this contract version does not recognise'));
  }
  if (!SHADOW_EXPOSURE_REASONS.includes(decision.reason)) {
    defects.push(defect('EXPOSURE_REASON_UNKNOWN', 'the decision states a reason this contract version does not recognise'));
  }
  if (!SHADOW_CONSENT_STATES.includes(decision.consentState)) {
    defects.push(defect('EXPOSURE_CONSENT_STATE_UNKNOWN', 'the decision states a consent state outside the vocabulary'));
  }

  if (stageKnown) {
    const cap = SHADOW_STAGE_PARTICIPANT_CAP[decision.stage];
    const floor = SHADOW_STAGE_PARTICIPANT_FLOOR[decision.stage];
    if (decision.cap !== cap) {
      defects.push(
        defect(
          'EXPOSURE_CAP_DISAGREES_WITH_STAGE',
          `the decision was judged against a cap of ${String(decision.cap)}; this stage's cap is ${cap}`,
        ),
      );
    }
    if (!isCount(decision.cohortSize)) {
      defects.push(defect('EXPOSURE_COHORT_INVALID', 'the decision states a cohort size that is not a non-negative integer'));
    } else {
      if ((decision.cohortSize as number) > cap) {
        defects.push(
          defect(
            'EXPOSURE_COHORT_EXCEEDS_CAP',
            `the cohort holds ${decision.cohortSize} participants; this stage's cap is ${cap}`,
          ),
        );
      }
      if ((decision.cohortSize as number) > 0 && (decision.cohortSize as number) < floor) {
        defects.push(
          defect(
            'EXPOSURE_COHORT_BELOW_STAGE_FLOOR',
            `the cohort holds ${decision.cohortSize} participants; this stage is only meaningful at ${floor}`,
          ),
        );
      }
    }
  }

  if (decision.allowed === true) {
    if (decision.stage === 'shadow_only') {
      defects.push(
        defect('EXPOSURE_ALLOWED_AT_SHADOW_ONLY', 'a participant is exposed at the stage that exposes nobody'),
      );
    }
    if (decision.consentState !== 'granted') {
      defects.push(
        defect('EXPOSURE_ALLOWED_WITHOUT_CONSENT', 'a participant is exposed without a granted consent'),
      );
    }
    if (!pilotDecision.allowed) {
      defects.push(
        defect(
          'EXPOSURE_ALLOWED_WITH_STOP_REASON',
          'the shadow gate admitted a participant the pilot gate refused; the shadow gate may only narrow',
        ),
      );
    }
  }

  return defects;
}

/**
 * The remainder fields, in fixed emission order so two checks of one receipt
 * produce byte-identical findings. Listed once so the checker and the doc cannot
 * disagree about which stores a receipt proves empty.
 */
const SHADOW_RECEIPT_REMAINDER_FIELDS = Object.freeze([
  'remainingTraceCount',
  'remainingReplayBundleCount',
  'remainingStudyResponseCount',
] as const);

/**
 * Structural check over a study deletion receipt (#47).
 *
 * Delegates the embedded personalization receipt to Sprint 10's checker and
 * re-codes its findings under `SHADOW_NESTED_RECEIPT_DEFECT`, carrying the inner
 * code in the detail. One deletion vocabulary, extended — the alternative, a
 * second receipt checker, is two answers to "is it gone" that agree until one is
 * edited.
 */
export function checkShadowStudyDeletionReceipt(
  receipt: ShadowStudyDeletionReceipt,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(receipt)) {
    return [defect('SHADOW_RECEIPT_UNREADABLE', 'a receipt was checked that is not a receipt-shaped object')];
  }
  const defects: ShadowPipelineDefect[] = [];

  if (!isSafeCode(receipt.participantId)) {
    defects.push(
      defect('SHADOW_RECEIPT_PARTICIPANT_UNSAFE', 'the receipt names a participant outside the safe-code pattern'),
    );
  }
  if (!isInstant(receipt.deletedAt)) {
    defects.push(defect('SHADOW_RECEIPT_INSTANT_INVALID', 'the receipt states a deletion time that is not a well-formed instant'));
  }

  for (const field of SHADOW_RECEIPT_REMAINDER_FIELDS) {
    const value = (receipt as unknown as Record<string, unknown>)[field];
    if (!isCount(value)) {
      defects.push(
        defect('SHADOW_RECEIPT_REMAINDER_NOT_A_COUNT', `the receipt's ${field} is not a non-negative integer`),
      );
    } else if ((value as number) > 0) {
      defects.push(
        defect('SHADOW_RECEIPT_REMAINDER_NOT_ZERO', `the receipt's ${field} is ${value}; a deletion receipt must prove zero`),
      );
    }
  }

  if (isBlank(receipt.emptyStateDigest)) {
    defects.push(defect('SHADOW_RECEIPT_DIGEST_MISSING', 'the receipt carries no digest a verifier can recompute'));
  } else if (!isDigest(receipt.emptyStateDigest)) {
    defects.push(defect('SHADOW_RECEIPT_DIGEST_MALFORMED', 'the receipt digest is not lowercase hex of the declared length'));
  }

  const nested: readonly PersonalizationDefect[] = checkPersonalizationDeletionReceipt(
    receipt.personalization,
  );
  for (const inner of nested) {
    defects.push(
      defect(
        'SHADOW_NESTED_RECEIPT_DEFECT',
        `the embedded personalization receipt is defective: ${inner.code}`,
      ),
    );
  }

  return defects;
}

/**
 * Structural check over an evidence package (#47).
 *
 * The type already makes a missing pillar impossible; this adds the rules a type
 * cannot carry, of which one is the whole point:
 * `GO_RESTS_ON_ENGAGEMENT_ALONE`, which is #41's
 * `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE` made computable.
 */
export function checkShadowEvidencePackage(
  evidencePackage: ShadowEvidencePackage,
): readonly ShadowPipelineDefect[] {
  if (!isRecord(evidencePackage) || !isRecord(evidencePackage.evidence)) {
    return [defect('PACKAGE_UNREADABLE', 'a package was checked that is not a package-shaped object')];
  }
  const defects: ShadowPipelineDefect[] = [];
  const evidence = evidencePackage.evidence as unknown as Record<string, unknown>;

  if (!isSafeCode(evidencePackage.packageId)) {
    defects.push(defect('PACKAGE_ID_UNSAFE', 'the package names an identifier outside the safe-code pattern'));
  }
  if (!isInstant(evidencePackage.assembledAt)) {
    defects.push(defect('PACKAGE_INSTANT_INVALID', 'the package states an assembly time that is not a well-formed instant'));
  }
  if (!SHADOW_EXPOSURE_STAGES.includes(evidencePackage.stage)) {
    defects.push(defect('PACKAGE_STAGE_UNKNOWN', 'the package states a stage this contract version does not recognise'));
  }
  const decisionKnown = SHADOW_RELEASE_DECISIONS.includes(evidencePackage.decision);
  if (!decisionKnown) {
    defects.push(defect('PACKAGE_DECISION_UNKNOWN', 'the package states a decision this contract version does not recognise'));
  }

  for (const key of Object.keys(evidence)) {
    if (!SHADOW_EVIDENCE_PILLARS.includes(key as ShadowEvidencePillar)) {
      defects.push(defect('EVIDENCE_UNKNOWN_PILLAR', 'the package carries an evidence pillar outside the vocabulary'));
    }
  }

  let readingCount = 0;

  for (const pillar of SHADOW_EVIDENCE_PILLARS) {
    const items = Array.isArray(evidence[pillar]) ? (evidence[pillar] as unknown[]) : null;
    if (items === null) {
      defects.push(defect('EVIDENCE_PILLAR_MISSING', 'the package carries no evidence for this pillar', { pillar }));
      continue;
    }
    if (items.length === 0) {
      defects.push(defect('EVIDENCE_PILLAR_EMPTY', 'the package carries an empty evidence pillar', { pillar }));
      continue;
    }
    if (items.length > SHADOW_PIPELINE_LIMITS.maxEvidenceItemsPerPillar) {
      defects.push(
        defect(
          'EVIDENCE_EXCEEDS_LIMIT',
          `this pillar carries ${items.length} items; the cap is ${SHADOW_PIPELINE_LIMITS.maxEvidenceItemsPerPillar}`,
          { pillar, limitName: 'maxEvidenceItemsPerPillar' },
        ),
      );
    }

    let supportsGo = false;
    let nonEngagementSupport = false;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const at = { pillar, evidenceIndex: index };
      if (!isRecord(item)) {
        defects.push(defect('EVIDENCE_SUPPORT_UNKNOWN', 'an evidence item is not an item-shaped object', at));
        continue;
      }
      if (item.pillar !== pillar) {
        defects.push(defect('EVIDENCE_ITEM_PILLAR_MISMATCH', 'an evidence item sits under a pillar it does not name', at));
      }
      if (!SHADOW_MEASURE_CLASSES.includes(item.measureClass as ShadowMeasureClass)) {
        defects.push(defect('EVIDENCE_MEASURE_CLASS_UNKNOWN', 'an evidence item states a measure class outside the vocabulary', at));
      }
      if (!SHADOW_EVIDENCE_SUPPORTS.includes(item.support as ShadowEvidenceSupport)) {
        defects.push(defect('EVIDENCE_SUPPORT_UNKNOWN', 'an evidence item states a support outside the vocabulary', at));
      }
      if (!isSafeCode(item.citation)) {
        defects.push(
          defect('EVIDENCE_CITATION_UNSAFE', 'an evidence item cites free text where a safe code is required', at),
        );
      }
      if (item.sloReading !== null && item.sloReading !== undefined) {
        readingCount += 1;
      }

      if (item.support === 'go') {
        supportsGo = true;
        const engagementClasses: readonly ShadowMeasureClass[] = SHADOW_ENGAGEMENT_MEASURE_CLASSES;
        if (!engagementClasses.includes(item.measureClass as ShadowMeasureClass)) {
          nonEngagementSupport = true;
        }
        if (
          isRecord(item.sloReading) &&
          (item.sloReading as unknown as ShadowSloReading).status === 'inconclusive'
        ) {
          defects.push(
            defect(
              'EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO',
              'an item supports a go on a reading that could not be measured; "we cannot tell" is not "it is fine"',
              at,
            ),
          );
        }
      }
      if (item.support === 'rollback' && decisionKnown && evidencePackage.decision === 'go') {
        defects.push(
          defect(
            'GO_CONTRADICTED_BY_ROLLBACK_EVIDENCE',
            'the package decides to go and carries evidence that says roll back',
            at,
          ),
        );
      }
    }

    if (decisionKnown && evidencePackage.decision === 'go') {
      if (!supportsGo) {
        defects.push(
          defect('GO_WITHOUT_SUPPORT_IN_PILLAR', 'the package decides to go with nothing in this pillar supporting it', {
            pillar,
          }),
        );
      } else if (!nonEngagementSupport) {
        defects.push(
          defect(
            'GO_RESTS_ON_ENGAGEMENT_ALONE',
            'the only support for going in this pillar is engagement-class; a user responding faster is not evidence the product helped them',
            { pillar },
          ),
        );
      }
    }
  }

  if (readingCount > SHADOW_PIPELINE_LIMITS.maxSloReadingsPerPackage) {
    defects.push(
      defect(
        'EVIDENCE_EXCEEDS_LIMIT',
        `the package cites ${readingCount} SLO readings; the cap is ${SHADOW_PIPELINE_LIMITS.maxSloReadingsPerPackage}`,
        { limitName: 'maxSloReadingsPerPackage' },
      ),
    );
  }

  return defects;
}

/**
 * Structural check over this contract's own budget table.
 *
 * The only checker whose subject is the contract rather than a caller's data,
 * and it exists because `SHADOW_PIPELINE_TOTAL_BUDGET_MS` is a *declared*
 * ceiling rather than a computed sum: without this, raising one module's budget
 * silently raises the whole run's, and the relationship between the two numbers
 * would be a comment. Parameterised so a test can reach both codes — a limit
 * whose violation is currently impossible is reachable only by handing the
 * checker a table where it is possible.
 */
export function checkShadowBudgetTable(
  budgets: Readonly<Record<ShadowPipelineModule, number>> = SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  totalBudgetMs: number = SHADOW_PIPELINE_TOTAL_BUDGET_MS,
): readonly ShadowPipelineDefect[] {
  const defects: ShadowPipelineDefect[] = [];
  let sum = 0;

  for (const module of SHADOW_PIPELINE_CHAIN) {
    const budget = budgets[module];
    if (!isFiniteNumber(budget) || budget <= 0) {
      defects.push(
        defect('MODULE_BUDGET_NOT_POSITIVE', 'a module declares a budget that is not a positive finite number', {
          module,
          stagePosition: SHADOW_PIPELINE_CHAIN_POSITION[module],
        }),
      );
      continue;
    }
    sum += budget;
  }

  if (isFiniteNumber(totalBudgetMs) && sum > totalBudgetMs) {
    defects.push(
      defect(
        'TOTAL_BUDGET_BELOW_SUM_OF_MODULES',
        `the module budgets sum to ${sum}ms; the declared run ceiling is ${totalBudgetMs}ms`,
      ),
    );
  }

  return defects;
}

/* ── Policy and invariants ───────────────────────────────────────── */

/**
 * The input rules every intelligence module in this repo states, plus the ones
 * that are this contract's own.
 */
export const SHADOW_PIPELINE_INPUT_POLICY = Object.freeze({
  reportWhatTheTaxonomyNames: true,
  noAmbientClock: true,
  /** Every instant, elapsed time and budget comparison comes from the caller. */
  everyInstantSuppliedByCaller: true,
  /** The preimage is positional; nothing in this file sorts anything. */
  preimageIsPositionalNotSorted: true,
  /** Digests are data here; the hashing stays the caller's. */
  digestsComeFromTheCaller: true,
  /** An unreadable consent is a withheld consent. */
  unreadableConsentIsWithheld: true,
  /** A refused pilot decision is final; the shadow gate may only narrow. */
  shadowGateOnlyNarrows: true,
});

/**
 * The named invariants of this contract, each carried by a mechanism stated in
 * its comment. A closed list so the contract test enumerates them — an invariant
 * that exists only in prose is documentation of an intention.
 *
 * - `SHADOW_RESULT_CANNOT_MUTATE_CANONICAL_STATE`
 *                             — carried by: `ShadowInertValue`,
 *                               `SHADOW_OUTCOME_INERTNESS`,
 *                               `checkShadowInertness`,
 *                               `ShadowEffectProposal.status`,
 *                               `PROPOSAL_CLAIMS_APPLIED`. The half this file
 *                               does *not* close is named in
 *                               `SHADOW_WRITE_SURFACE.moduleAdapterMayReachIO`.
 * - `EVERY_DECISION_HAS_A_TRACE_ENTRY`
 *                             — carried by: `checkShadowTrace`'s
 *                               `TRACE_STAGE_MISSING`, `TRACE_REASON_MISSING`,
 *                               `TRACE_PROPOSAL_UNEXPLAINED`.
 * - `TRACE_EXPLANATIONS_ARE_COHERENT`
 *                             — carried by:
 *                               `SHADOW_STAGE_REASON_ADMISSIBILITY`,
 *                               `TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS`,
 *                               `TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION`.
 * - `DEGRADATION_IS_A_VARIANT_NOT_AN_ERROR_CODE`
 *                             — carried by: the five-variant
 *                               `ShadowModuleOutcome`, the three-variant
 *                               `ShadowPipelineOutcome`,
 *                               `COMPLETE_WITH_NON_CONTRIBUTOR`.
 * - `FAIL_CLOSED_MODULES_WITHHOLD_RATHER_THAN_DEGRADE`
 *                             — carried by: `SHADOW_MODULE_FAILURE_STANCE`,
 *                               `ShadowWithheldOutcome`,
 *                               `FAIL_CLOSED_MODULE_DELIVERED_ANYWAY`.
 * - `PLACEHOLDER_MODULES_NEVER_COMPLETE`
 *                             — carried by: `SHADOW_MODULE_ROLES`,
 *                               `PLACEHOLDER_MODULE_CLAIMS_COMPLETION`.
 * - `EVERY_BUDGET_IS_PER_MODULE_AND_REACHABLE`
 *                             — carried by:
 *                               `SHADOW_MODULE_TIMEOUT_BUDGET_MS`,
 *                               `TRACE_COMPLETED_EXCEEDS_BUDGET`,
 *                               `TRACE_TIMEOUT_WITHIN_BUDGET`,
 *                               `checkShadowBudgetTable`.
 * - `REPLAY_DISAGREEMENT_IS_DETECTABLE_AND_LOCALISED`
 *                             — carried by: `shadowReplayPreimage`,
 *                               `REPLAY_PREIMAGE_DIVERGED`,
 *                               `REPLAY_MODULE_STATUS_DIVERGED`,
 *                               `REPLAY_CONTROLS_DIVERGED`.
 * - `NO_RAW_CONTENT_IN_TRACE_OR_OUTCOME`
 *                             — carried by: closed vocabularies for every
 *                               value-bearing field, `SHADOW_DIGEST` on every
 *                               digest, `SHADOW_SAFE_CODE` on every identifier,
 *                               and `LOG_CARRIES_FORBIDDEN_KEY` on the logs.
 * - `ALERT_OWNERSHIP_IS_EXPLICIT`
 *                             — carried by: `ShadowSloDefinition.owner` being
 *                               required, `SLO_OWNER_MISSING`,
 *                               `SLO_OWNER_ROTATION_UNSAFE`,
 *                               `SLO_ESCALATION_SAME_AS_PRIMARY`.
 * - `SMALL_SAMPLES_ARE_INCONCLUSIVE_NOT_ZERO`
 *                             — carried by: the two-variant
 *                               `ShadowSloReading`, `MIN_SLO_SAMPLE_COUNT`,
 *                               `SLO_MEASURED_BELOW_SAMPLE_FLOOR`.
 * - `NO_GENERAL_RELEASE_IS_REPRESENTABLE`
 *                             — carried by: `SHADOW_EXPOSURE_STAGES` having no
 *                               such member, and every consumer switching on it.
 * - `CONSENT_IS_REVOCABLE_AND_REVOCATION_IS_STRUCTURAL`
 *                             — carried by: the three-variant
 *                               `ShadowStudyConsent` whose inactive arms carry
 *                               an empty scope tuple,
 *                               `CONSENT_INACTIVE_CARRIES_SCOPES`.
 * - `DELETION_IS_VERIFIABLE`  — carried by: `ShadowStudyDeletionReceipt`
 *                               holding only recomputable facts, and its checker
 *                               delegating to Sprint 10's rather than restating
 *                               it.
 * - `DECISION_REQUIRES_QUALITY_SAFETY_AND_RELIABILITY`
 *                             — carried by: the total
 *                               `Record<ShadowEvidencePillar, ...>` of non-empty
 *                               tuples, `EVIDENCE_PILLAR_MISSING`,
 *                               `GO_WITHOUT_SUPPORT_IN_PILLAR`.
 * - `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE`
 *                             — #41's invariant, reused rather than restated;
 *                               see `SHADOW_RELEASE_GATE_INVARIANT`. Carried by:
 *                               `ShadowMeasureClass`,
 *                               `SHADOW_ENGAGEMENT_MEASURE_CLASSES`,
 *                               `GO_RESTS_ON_ENGAGEMENT_ALONE`.
 */
export const SHADOW_PIPELINE_INVARIANTS = Object.freeze([
  'SHADOW_RESULT_CANNOT_MUTATE_CANONICAL_STATE',
  'EVERY_DECISION_HAS_A_TRACE_ENTRY',
  'TRACE_EXPLANATIONS_ARE_COHERENT',
  'DEGRADATION_IS_A_VARIANT_NOT_AN_ERROR_CODE',
  'FAIL_CLOSED_MODULES_WITHHOLD_RATHER_THAN_DEGRADE',
  'PLACEHOLDER_MODULES_NEVER_COMPLETE',
  'EVERY_BUDGET_IS_PER_MODULE_AND_REACHABLE',
  'REPLAY_DISAGREEMENT_IS_DETECTABLE_AND_LOCALISED',
  'NO_RAW_CONTENT_IN_TRACE_OR_OUTCOME',
  'ALERT_OWNERSHIP_IS_EXPLICIT',
  'SMALL_SAMPLES_ARE_INCONCLUSIVE_NOT_ZERO',
  'NO_GENERAL_RELEASE_IS_REPRESENTABLE',
  'CONSENT_IS_REVOCABLE_AND_REVOCATION_IS_STRUCTURAL',
  'DELETION_IS_VERIFIABLE',
  'DECISION_REQUIRES_QUALITY_SAFETY_AND_RELIABILITY',
  'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE',
] as const);

export type ShadowPipelineInvariant = (typeof SHADOW_PIPELINE_INVARIANTS)[number];
