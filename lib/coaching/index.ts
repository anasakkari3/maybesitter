/**
 * The public surface of the Coaching planner and realizer (Sprint 09, #38).
 *
 * `planCoaching` → `realizeCoachingPlan` → `deliverCoaching` is the whole path:
 * an approved recommendation becomes a plan, the plan becomes prose, and the
 * prose is delivered only if it passes two independent gates.
 *
 * ## What this module is, next to the shipped response engine
 *
 * `lib/services/responseEngine/` (1571 lines) already ships a response planner,
 * an intent selector, a realizer and a validator, plus `personalityService.ts`
 * for tone. Those are this issue's deliverable names almost verbatim, at
 * product scope, behind the assistant turn a user sees today.
 *
 * This module does not replace them, **does not import them**, and changes
 * nothing they return. The resolution is the one Sprint 08 settled for
 * `lib/recommendation/` beside the V03 pilot: build the roadmap module *beside*
 * the product surface, forbid a runtime edge in either direction, and use the
 * product surface as an independent second reader rather than as something to
 * replace. `tests/coaching/coachingBoundaries.test.ts` pins both directions.
 *
 * The two answer different questions from different inputs. The engine's input
 * is a `SemanticEvent` about something that already happened in capture; this
 * module's input is a `Recommendation` about something that has not happened.
 * Every place the two decide the same thing carries a comment saying whether
 * the rule is the same, deliberately stricter, or a superset — the summary:
 *
 * | Decision | Engine | This module |
 * |---|---|---|
 * | Intent vocabulary | 9, keyed to events | 6, keyed to offers — disjoint on purpose |
 * | Strategy | 10, rotates on conversation state | 5, pure function of the offer |
 * | Sentence cap | 1 or 2 | **same**, 1 or 2 |
 * | Realization | candidates scored, `Math.random` tie-break | one template per claim, no entropy |
 * | Text assembly | interpolates `plan.facts` | selects from a closed table |
 * | Shame lexicon | `SHAME_PATTERNS` | **identical, verbatim** |
 * | Persistence verbs | forbidden when `stateChange === 'completed'` | **superset**, forbidden always |
 * | No candidate validates | falls back to a safe message | **refuses**, with a `SafeUserPath` |
 *
 * The one-line version: **everything the engine forbids, this module forbids.**
 * The reverse does not hold. A cross-track comparison finding this module
 * *saying* something the engine's validator would reject is a defect; finding
 * it refusing where the engine would emit a fallback is the risk policy working
 * as designed.
 *
 * ## What was reused rather than rebuilt
 *
 * The claim-to-evidence problem is the one Sprint 08 already solved.
 * `checkEvidenceGraph`, `resolveEvidenceRoots` and `isInstant` are **called**,
 * not reimplemented — there is no graph traversal, no cycle detection, no id
 * resolution and no instant pattern anywhere under `lib/coaching/**`. #39's
 * `safetyContracts` reuses the same three, so the sprint ships one evidence
 * graph and one definition of an instant.
 *
 * What is genuinely new is narrower and is the whole of `validator/claimSupport.ts`:
 * Sprint 08 validates a recommendation **against itself**, and this validates a
 * **derived artefact against the recommendation it came from**. The failure it
 * exists to catch is invisible to Sprint 08 by construction — a coaching claim
 * citing a perfectly valid node of a perfectly valid graph that its source
 * reason never cited.
 *
 * ## Determinism
 *
 * Same input, same output, byte for byte. Nothing here reads a clock, mints an
 * identifier, or uses a random source; `basisAt` and `candidateId` are supplied
 * by the caller. Nothing here sorts, either — the plan preserves the order the
 * selector already put the reasons in — so there is no comparator to get wrong
 * and no `localeCompare` to ban, which the boundary test checks anyway.
 *
 * ## Migration and rollback
 *
 * **Migration: none.** This track is additive and pure. It adds
 * `src/contracts/v1/coachingContracts.ts`, files under `lib/coaching/` and
 * `tests/coaching/`. There is no schema change, no stored row, no file written,
 * no route, no background job, and no change to any existing module's
 * behaviour. Nothing calls `planCoaching` in production.
 *
 * The `coaching` descriptor in `src/contracts/v1/moduleContracts.ts` is
 * **deliberately still the Sprint 00 placeholder**. #39 owns that file this
 * sprint (it is flipping `safety`), and two tracks editing one descriptor table
 * is the merge conflict Sprint 02's lesson was written about. Flipping it is a
 * one-line follow-up whose pin lives in
 * `tests/contract/intelligenceModuleBoundaries.test.ts`, and it must be done by
 * whichever single track owns that file at the time.
 *
 * **Rollback: `git revert` of the sprint merge, and nothing else.** There is no
 * data to migrate back because this module persists nothing —
 * `COACHING_PERSISTENCE_POLICY.coachingCanPersist` is false and a coaching turn
 * is prose about a proposal, never canonical user state. No descriptor moves,
 * because none was flipped.
 *
 * **The couplings a revert must look at**, both forward:
 *
 *   - `src/contracts/v1/coachingContracts.ts` imports Sprint 08's
 *     `recommendationContracts` (values) and #39's `safetyContracts` (types
 *     only). A revert of either that landed *after* this one would dangle those
 *     imports. The reverse direction cannot happen: #39's contract mentions
 *     coaching only in prose, and `coachingBoundaries.test.ts` pins that
 *     nothing under `lib/safety/**` reaches `lib/coaching/**`.
 *   - `#37`'s evaluation set is built against `CoachingPlan` and
 *     `CoachingOutput`. Reverting this track without reverting #37 leaves an
 *     evaluation set with nothing to evaluate — it fails loudly at import
 *     rather than silently passing, which is the direction that wants checking.
 *
 * **Forward compatibility.** Every code this module emits comes from the
 * contract's frozen lists, and the exported shapes are additive over the
 * contract rather than a second copy of it: `CoachingPlannerInput`,
 * `CoachingRealizationInput` and `CoachingDeliveryInput` describe a *request*,
 * which the contract deliberately does not model.
 *
 * Three producibility sweeps keep a new vocabulary member from being silently
 * unemittable — over `COACHING_INTENTS`, `COACHING_STRATEGIES` and
 * `COACHING_CLAIM_KINDS`, in `tests/coaching/plannerPolicy.test.ts`. They exist
 * because Sprint 08 shipped two *unreachable outcomes behind reachable code
 * paths* and neither was visible to any assertion about the thing itself. The
 * one named exclusion in this module is `CoachingRealizationMode.model`, listed
 * in `COACHING_REALIZATION_POLICY.excludedModes` so that it is a decision
 * someone recorded rather than an omission nothing notices.
 *
 * ## Known gap, with its deletion condition
 *
 * The forbidden-language lexicons are **English**. An Arabic or Hebrew template
 * that described tracking would pass `checkCoachingLanguage`. What holds in all
 * three locales is structural — `COACHING_TEMPLATES` interpolates nothing, and
 * every string in it is scanned in every locale — so the gap is "a bad
 * translation could be added and this file would not notice", not "user text
 * could flow through". **Revisit when** #37 lands per-locale lexicons;
 * `checkCoachingLanguage` already takes them as data for that reason.
 */

export {
  claimKindForReason,
  claimKindForVerdict,
  intentFor,
  isPermittedPair,
  maxSentencesFor,
  shapeOf,
  strategyFor,
  type PlanShape,
} from './planner/policy';

export {
  planCoaching,
  type CoachingPlannerInput,
  type CoachingPlanningOutcome,
} from './planner/plan';

export {
  COACHING_TEMPLATES,
  COACHING_TEMPLATE_IDS,
  templateText,
  type CoachingTemplateId,
} from './realizer/templates';

export {
  realizeCoachingPlan,
  templateIdFor,
  type CoachingRealizationInput,
  type CoachingRealizationOutcome,
} from './realizer/realize';

export {
  COACHING_MODEL_ADAPTER,
  type CoachingModelAdapter,
} from './realizer/modelAdapter';

export { checkClaimSupport, type ClaimSupportInput } from './validator/claimSupport';

export {
  DEFAULT_COACHING_LEXICONS,
  MIN_SCANNED_IDENTIFIER_LENGTH,
  checkCoachingLanguage,
  containsToken,
  type CoachingLexicons,
} from './validator/language';

export {
  COACHING_PROPOSED_EFFECTS,
  deliverCoaching,
  identifiersOf,
  toSafetyCandidate,
  type CoachingDeliveryInput,
} from './deliver';
