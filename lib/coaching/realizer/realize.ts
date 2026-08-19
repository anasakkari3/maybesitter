/**
 * The coaching realizer (Sprint 09, issue #38).
 *
 * Turns a `CoachingPlan` into a `CoachingOutput` by **selecting** one template
 * per claim. It adds no fact, because it is given none to add: a plan carries
 * claim kinds, source positions and evidence node ids, and no user text.
 *
 * ## How this relates to the shipped `realization.ts`
 *
 * `lib/services/responseEngine/realization.ts` is 497 lines and does
 * substantially more: it builds candidate phrasings, scores them against
 * conversation history to avoid repeating a path, and picks among the close
 * ones with `Math.random()` as its default entropy source. Nothing here imports
 * it. The differences are all in one direction and each is deliberate:
 *
 * - **Deliberately stricter: no entropy.** The engine's `chooseCandidate` takes
 *   `entropy: () => number` defaulting to `Math.random`. This module is
 *   replayable — same plan, same locale, byte-identical output — because an
 *   audit of what a user was told is worth nothing if the module cannot
 *   reproduce it. `Math.random` is banned under `lib/coaching/**` and
 *   `tests/coaching/coachingBoundaries.test.ts` enforces it.
 * - **Deliberately stricter: no interpolation.** The engine assembles text from
 *   `plan.facts` — `reminderObject(title)`, `${lead}: ${detail}`. Every one of
 *   those is a place a title reaches prose, which is fine there because the
 *   engine is *about* the thing the user just said. This module selects from a
 *   closed table and interpolates nothing.
 * - **Same rule: validate before emitting.** The engine filters candidates
 *   through `validateResponsePlanAndMessage(plan, item.text).ok`. This module
 *   does the same thing in the same place, with `lib/coaching/validator/`.
 * - **Deliberately different: no `safeFallback`.** The engine always produces a
 *   message, falling back to `"I couldn't do that safely."` when no candidate
 *   validates. This module produces a **refusal** instead, and the refusal
 *   carries a `SafeUserPath`. The engine's fallback is right for a chat surface
 *   where silence is a bug; a coaching turn that cannot be supported must not
 *   be replaced by a shorter unsupported one.
 */

import {
  COACHING_CONTRACT_VERSION,
  COACHING_REALIZATION_POLICY,
  COACHING_SCHEMA_VERSION,
  checkCoachingOutput,
  checkCoachingPlan,
  isEvidenceBackedClaim,
  type CoachingClaim,
  type CoachingDefect,
  type CoachingOutput,
  type CoachingPlan,
  type CoachingRealizationMode,
  type CoachingSentence,
} from '../../../src/contracts/v1/coachingContracts';
import { isInstant, type EvidenceGraph, type Instant } from '../../../src/contracts/v1/recommendationContracts';
import { COACHING_TEMPLATE_IDS, templateText, type CoachingTemplateId } from './templates';

export interface CoachingRealizationInput {
  readonly plan: CoachingPlan;
  /** The recommendation's graph, carried into the output verbatim. */
  readonly evidence: EvidenceGraph;
  /** The instant the turn is computed against. Never a clock reading. */
  readonly basisAt: Instant;
  /** Defaults to `COACHING_REALIZATION_POLICY.defaultMode`. */
  readonly mode?: CoachingRealizationMode;
}

export type CoachingRealizationOutcome =
  | { readonly outcome: 'realized'; readonly output: CoachingOutput }
  | { readonly outcome: 'refused'; readonly defects: readonly [CoachingDefect, ...CoachingDefect[]] };

function defect(
  code: CoachingDefect['code'],
  detail: string,
  claimIndex: number | null = null,
  sentenceIndex: number | null = null,
): CoachingDefect {
  return { code, claimIndex, sentenceIndex, detail };
}

/**
 * The template id for a claim at a position in a plan.
 *
 * Null for a combination this version has no copy for, and null is reported as
 * `PLANNED_CLAIM_NOT_REALIZED` by the caller — never silently skipped. A
 * skipped claim leaves the turn shorter and still validating, which is the
 * quiet failure this whole module is built around: the sentence that *is* read
 * would rest on the remainder, and nothing would say a claim went missing.
 *
 * The `alternative.` family exists only at position 1 of a
 * `name_the_alternatives` turn. That is the one case where the second claim is
 * a *different option* rather than a further reason for the first, so reusing
 * `support.proposed_action` there would render "That is the move this points
 * to." about the runner-up — true of the lead and false of the option the
 * sentence is actually about.
 */
export function templateIdFor(plan: CoachingPlan, claim: CoachingClaim, position: number): CoachingTemplateId | null {
  if (claim === null || claim === undefined) return null;
  if (!isEvidenceBackedClaim(claim)) {
    const candidate = `echo.${claim.kind}`;
    return (COACHING_TEMPLATE_IDS as readonly string[]).includes(candidate) ? (candidate as CoachingTemplateId) : null;
  }
  if (position === 0) {
    const candidate = `lead.${claim.kind}`;
    return (COACHING_TEMPLATE_IDS as readonly string[]).includes(candidate) ? (candidate as CoachingTemplateId) : null;
  }
  const family = plan.strategy === 'name_the_alternatives' ? 'alternative' : 'support';
  const candidate = `${family}.${claim.kind}`;
  return (COACHING_TEMPLATE_IDS as readonly string[]).includes(candidate) ? (candidate as CoachingTemplateId) : null;
}

/**
 * Realize a plan, or say why not.
 *
 * The structural pass runs **before** anything reads a claim's kind, per
 * `COACHING_INPUT_POLICY.digestAfterStaticPass`: decide what is wrong with the
 * input before doing anything that assumes it is well-formed.
 *
 * The output is checked with `checkCoachingOutput` before being returned, which
 * looks redundant against a realizer that constructs it — and is not. The
 * checker is the thing that would catch this function drifting from the
 * contract, and a producer that trusts itself is a producer nothing checks.
 * That is the same argument for `checkRecommendation` running at both ends in
 * Sprint 08, and it cost that sprint a `choice` carrying one option to learn.
 */
export function realizeCoachingPlan(input: CoachingRealizationInput): CoachingRealizationOutcome {
  const safe = input === null || input === undefined || typeof input !== 'object' ? ({} as CoachingRealizationInput) : input;
  const plan = safe.plan === null || safe.plan === undefined ? ({} as CoachingPlan) : safe.plan;

  const planDefects = checkCoachingPlan(plan);
  if (planDefects.length > 0) {
    return { outcome: 'refused', defects: planDefects as [CoachingDefect, ...CoachingDefect[]] };
  }

  const mode = safe.mode ?? COACHING_REALIZATION_POLICY.defaultMode;
  if (!(COACHING_REALIZATION_POLICY.enabledModes as readonly string[]).includes(mode as string)) {
    return {
      outcome: 'refused',
      defects: [
        defect(
          'MODEL_REALIZATION_NOT_ENABLED',
          'the requested realization mode is not enabled; the rules-only path is the only one wired',
        ),
      ],
    };
  }

  if (!isInstant(safe.basisAt)) {
    return { outcome: 'refused', defects: [defect('PLAN_OUTPUT_MISMATCH', 'basisAt is not an instant carrying an explicit offset')] };
  }

  const claims = plan.claims as readonly CoachingClaim[];
  const sentences: CoachingSentence[] = [];
  const defects: CoachingDefect[] = [];

  for (let index = 0; index < claims.length; index += 1) {
    const templateId = templateIdFor(plan, claims[index], index);
    if (templateId === null) {
      defects.push(defect('PLANNED_CLAIM_NOT_REALIZED', 'no template covers this claim at this position', index));
      continue;
    }
    const text = templateText(plan.locale, templateId);
    if (text === null) {
      // A missing translation is reported, never served in English. See
      // `templateText`: an English fallback is a defect that reads as a feature
      // to everyone who reviews it.
      defects.push(defect('UNKNOWN_LOCALE', 'no copy exists for this template in this locale', index));
      continue;
    }
    sentences.push({ sentenceIndex: sentences.length, text, templateId, claimIndices: [index] });
  }

  if (defects.length > 0) {
    return { outcome: 'refused', defects: defects as [CoachingDefect, ...CoachingDefect[]] };
  }
  if (sentences.length === 0) {
    return { outcome: 'refused', defects: [defect('SENTENCE_LIMIT_EXCEEDED', 'the plan realized to no sentences')] };
  }

  const output: CoachingOutput = {
    version: COACHING_CONTRACT_VERSION,
    schema: COACHING_SCHEMA_VERSION,
    recommendationId: plan.recommendationId,
    locale: plan.locale,
    intent: plan.intent,
    strategy: plan.strategy,
    realization: mode,
    sentences: sentences as [CoachingSentence, ...CoachingSentence[]],
    claims: claims as [CoachingClaim, ...CoachingClaim[]],
    evidence: safe.evidence === null || safe.evidence === undefined ? { nodes: [] } : safe.evidence,
    basisAt: safe.basisAt,
  };

  const outputDefects = checkCoachingOutput(output, plan);
  if (outputDefects.length > 0) {
    return { outcome: 'refused', defects: outputDefects as [CoachingDefect, ...CoachingDefect[]] };
  }
  return { outcome: 'realized', output };
}
