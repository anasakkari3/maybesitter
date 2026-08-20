/**
 * The model realization seam (Sprint 09, issue #38) — **declared, not wired**.
 *
 * The issue asks for a "template/model realization adapter". This file is the
 * model half: the interface an adapter would satisfy, and nothing that calls
 * one. `COACHING_REALIZATION_POLICY.enabledModes` holds `template` alone, and
 * `MODEL_REALIZATION_NOT_ENABLED` is what a validator reports for an output
 * claiming this path.
 *
 * ## Why a seam and not an implementation
 *
 * The acceptance criterion is "rules-only realization remains available". The
 * shape that satisfies it weakly is a model path with a template fallback; the
 * shape that satisfies it strongly is the one here, where the template path is
 * the *only* path and the model path has to be added to a policy before it can
 * be taken. A fallback is a thing that can be missing, and a fallback nobody
 * exercises is a fallback nobody knows is broken.
 *
 * ## The constraint any adapter inherits
 *
 * `realize` is handed a `CoachingPlan` and returns **text per claim**, in claim
 * order. It is not handed the recommendation, the evidence graph, the
 * commitment, or any identifier — so an adapter cannot introduce a fact,
 * because it is never given one to introduce. What it can still do is *invent*
 * one, which is why the validator runs on the realized output regardless of
 * which adapter produced it and why `PLANNED_CLAIM_NOT_REALIZED`,
 * `FORBIDDEN_LANGUAGE` and `IDENTIFIER_IN_PROSE` are checks on text rather than
 * checks on the adapter.
 *
 * The plan carries no user text, so an adapter given only a plan cannot leak
 * one — that is the property `CoachingPlan.claims` being provenance rather than
 * pre-rendered strings buys, and it is the difference from the shipped
 * `ResponsePlan.facts`, which is pre-rendered strings and could not offer it.
 *
 * ## Sprint 08's rule about declared-but-unreachable members
 *
 * `model` is a member of `CoachingRealizationMode` that no input can produce.
 * That is exactly the shape Sprint 08 shipped twice — a reachable code path
 * with an unreachable outcome, invisible to any assertion about the thing
 * itself. The remedy it recorded is a *named* exclusion rather than an omission
 * nothing notices, which is what `COACHING_REALIZATION_POLICY.excludedModes`
 * is: `tests/coaching/realizer.test.ts` enumerates the modes and demands each
 * be either producible or listed there.
 */

import type { CoachingPlan } from '../../../src/contracts/v1/coachingContracts';

/**
 * What a model adapter would have to satisfy.
 *
 * Returns one string per claim, in claim order, or null to decline. Declining
 * is a first-class outcome rather than an error: an adapter that cannot phrase
 * a plan must be able to say so without the caller catching anything, and the
 * caller's answer is the template path, which is always available.
 */
export interface CoachingModelAdapter {
  readonly id: string;
  realize(plan: CoachingPlan): readonly string[] | null;
}

/**
 * The adapter in use.
 *
 * Null, and this is the whole of v1's model wiring. It is a constant rather
 * than a configurable so that enabling a model is a code change someone
 * reviews, not a flag someone flips.
 */
export const COACHING_MODEL_ADAPTER: CoachingModelAdapter | null = null;
