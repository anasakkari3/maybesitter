/**
 * The public surface of the Recommendation selector (Sprint 08, issue #34).
 *
 * `selectRecommendation` is the entry point named by the `recommendation`
 * descriptor in `src/contracts/v1/moduleContracts.ts`. Everything else exported
 * here supports one of the three claims a recommendation makes about itself:
 * `selectorInputDigest` is what makes "these two offers came from the same
 * request" checkable, `currentFingerprints` is what makes
 * `evaluateRecommendationStaleness` answerable rather than guessable, and the
 * policy constants are what let #35 and the merge's cross-track test read the
 * bound without reaching inside the selector for it.
 *
 * ## What this module is, next to the shipped pilot
 *
 * A V03 pilot already answers "what next" on the product surface:
 * `lib/services/nextStepBaseline.ts` behind `/api/next-step`. This module does
 * not replace it, does not import it, and changes nothing it returns. The
 * division of authority is the one `recommendationContracts.ts` states —
 * `nextStepContracts` is authoritative for the deployed wire format, this is
 * authoritative for the intelligence module — and every place the two decide the
 * same question carries a comment saying whether the rule is the same,
 * deliberately stricter, or a superset. The summary table lives at the top of
 * `selector/candidates.ts`.
 *
 * The one-line version: **everything the pilot excludes, this module excludes.**
 * The reverse does not hold. This module additionally excludes a candidate
 * blocked by an unfinished prerequisite, and withholds where the pilot would
 * offer a weakly-supported step. A cross-track comparison finding this module
 * *offering* something the pilot excluded is a defect; finding it withholding
 * where the pilot offers is the risk policy working as designed.
 *
 * ## Determinism
 *
 * Same input and same config produce byte-identical output. Nothing here reads a
 * clock, mints an identifier, or depends on `Map`/`Object` iteration order,
 * input array order, or sort stability: candidates are put in code-point order
 * at the entry, the offer is ordered by `RECOMMENDATION_ORDERING_KEYS` plus two
 * appended keys that make the order total over *actions* rather than
 * commitments, and every array in the digest is sorted by its own encoded
 * content. `tests/recommendation/selectorDeterminism.test.ts` varies the things
 * that must not matter — reversed input arrays, reversed object-key
 * construction order, repeated calls — and asserts the input is not mutated.
 *
 * ## Migration and rollback
 *
 * **Migration: none.** This track is additive and pure. It adds files under
 * `lib/recommendation/` and `tests/recommendation/`, and flips one descriptor in
 * `src/contracts/v1/moduleContracts.ts` from the Sprint 00 placeholder to
 * `implemented`. There is no schema change, no stored row, no file written, no
 * route, no background job, and no change to any existing module's behaviour.
 * Nothing calls `selectRecommendation` in production: the descriptor is a
 * descriptor, and modules are reached through their own entry points rather than
 * through that table.
 *
 * There is in particular **no data migration for the pilot**. `/api/next-step`
 * keeps calling `selectBaselineNextStep` and keeps returning
 * `NextStepRecommendationContract`; this module writes nothing that surface
 * reads. When a later sprint moves the route onto this module, that is a
 * migration with its own note — the two shapes are related but not
 * interchangeable, and the difference is deliberate (`OptionSet` has no
 * `primary` field, which is exactly the shape `primaryStep` is).
 *
 * **Rollback: `git revert` of the sprint merge, and nothing else.** There is no
 * data to migrate back because this module persists nothing —
 * `RECOMMENDATION_PERSISTENCE_POLICY.recommendationCanPersist` is false and a
 * recommendation is a proposal, never canonical user state. The one visible
 * effect of a revert is that `INTELLIGENCE_MODULE_CONTRACTS.recommendation.execute`
 * returns the placeholder shape again; the assertion in
 * `tests/contract/intelligenceModuleBoundaries.test.ts` moves with it, which is
 * why the descriptor and its pin are edited by one track rather than two.
 *
 * **The one coupling a revert must look at** runs forward, not backward. This
 * module imports `lib/planning/shared/compare` and `lib/planning/shared/time` —
 * the repo's single copies of string ordering and instant arithmetic. A revert
 * of Sprint 07 that landed after this one would dangle those imports. The
 * reverse direction cannot happen: `tests/recommendation/selectorBoundaries.test.ts`
 * pins that nothing under `lib/planning/**` is permitted to reach
 * `lib/recommendation/**`, so the dependency can only ever run one way and a
 * revert only ever has one direction to look in.
 *
 * **Forward compatibility.** Every code this module emits comes from the
 * contract's frozen lists, and the exported shapes are additive over the
 * contract rather than a second copy of it: `RecommendationSelectorInput`,
 * `CommitmentSnapshot` and `RecommendationSelectorConfig` describe a *request*,
 * which the contract deliberately does not model.
 *
 * Two coverage sweeps in `tests/recommendation/selectorPolicy.test.ts` keep a
 * new contract code from being silently unemitted: one over
 * `SUPPORT_REASON_CODES` against the confidence weights, and one over
 * `EXCLUSION_REASON_CODES` against the set this module can actually emit. The
 * second exists because an earlier version of this paragraph claimed the first
 * covered both, and it does not — it only ever read the weight table, so
 * `NO_PLANNED_SLOT` and `OUTSIDE_WORKING_WINDOW` sat structurally unemittable
 * with nothing failing. They remain unemittable, deliberately: this module is
 * handed a `Plan` rather than a set of working windows, so it can honestly
 * claim neither. The sweep now names them, so adding a code is a decision
 * someone records rather than an omission nothing notices.
 *
 * ## Output size
 *
 * The evidence graph is linear in the number of candidates — roughly seven
 * nodes each, plus one per distinct unresolved blocker — but the constant is
 * not small: 200 candidates produce about 1,400 nodes and 400 KB of JSON, the
 * same order as a Sprint 07 payload defect. Stated here rather than discovered
 * by #35's review surface. A caller with a large scope should page or
 * pre-filter its candidate list; this module deliberately does not truncate,
 * because dropping candidates silently is what the excluded list exists to
 * prevent.
 */

export {
  CLOSED_COMMITMENT_STATUSES,
  KNOWN_COMMITMENT_STATUSES,
  RecommendationInputError,
  currentFingerprints,
  effectiveTimeSource,
  epochMsOrNull,
  generateCandidates,
  hardExclusionCodes,
  validateSelectorConfig,
  type Candidate,
  type CandidateEvidence,
  type CandidateGenerationOptions,
  type CandidateSet,
  type CommitmentLifecycleStatus,
  type CommitmentSnapshot,
  type RecommendationInputField,
  type RecommendationSelectorInput,
  type ScopeEvidence,
} from './selector/candidates';

export {
  DEFAULT_RECOMMENDATION_SELECTOR_CONFIG,
  RECOMMENDATION_CONFIDENCE_SATURATION,
  RECOMMENDATION_CONFIDENCE_WEIGHTS,
  RECOMMENDATION_DIVERSITY_POLICY,
  RECOMMENDATION_RISK_POLICY,
  applyDiversityPolicy,
  applyRiskPolicy,
  compareOptionCandidates,
  confidenceFor,
  leadClearsRiskFloor,
  rankOptionCandidates,
  type OptionCandidate,
  type PolicyOutcome,
  type PolicyRejection,
  type RecommendationSelectorConfig,
} from './selector/policy';

export {
  RECOMMENDATION_INPUT_DIGEST_VERSION,
  RECOMMENDATION_SELECTOR_SCHEMA,
  canonicalSelectorInput,
  offeredActionKeys,
  selectRecommendation,
  selectorInputDigest,
  type RecommendationSelection,
} from './selector/select';
