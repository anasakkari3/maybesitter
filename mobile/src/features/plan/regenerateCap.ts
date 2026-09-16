/**
 * How many more times today's plan may be rebuilt (UC-3.10b, #195).
 *
 * ── Five generations, four rebuilds ──────────────────────────────
 *
 * The server caps *documents per day*, not rebuilds:
 * `lib/services/dailyPlan/planSettings.ts` sets
 * `MAX_PLAN_GENERATIONS_PER_DAY = 5`, and `regeneratePlan` in
 * `lib/services/dailyPlan/planActions.ts` refuses once
 * `current.generation >= MAX_PLAN_GENERATIONS_PER_DAY`. The morning build is
 * generation 1, so a user gets **four** rebuilds — which is exactly what
 * `MAX_PLAN_REBUILDS_PER_DAY = MAX_PLAN_GENERATIONS_PER_DAY - 1` says, and
 * what the 429 body now quotes.
 *
 * #195's own text says "disabled after 5 uses in a day". That is the older
 * number, from when the 429 said five about a limit that allowed four. The
 * enforced number is the one a user meets, so it is the one this file mirrors.
 *
 * ── Why mirrored at all ──────────────────────────────────────────
 *
 * The button has to be disabled *before* the request, and the only thing the
 * client is given is `generation`. `planCopy.test.ts` pins both constants to the
 * server's source text, so the day the server changes its cap the mobile suite
 * says so rather than a user meeting a 429 behind an enabled button.
 *
 * The 429 is still handled: another device can spend a rebuild between this
 * screen's read and its tap.
 */

/** `MAX_PLAN_GENERATIONS_PER_DAY` in `lib/services/dailyPlan/planSettings.ts`. */
export const MAX_PLAN_GENERATIONS_PER_DAY = 5;

/** What the user is actually offered: the morning build is not a rebuild. */
export const MAX_PLAN_REBUILDS_PER_DAY = MAX_PLAN_GENERATIONS_PER_DAY - 1;

/**
 * Rebuilds still available, from the generation the plan carries.
 *
 * Clamped at zero: a plan built by a server with a higher cap must not produce
 * a negative count on an older client.
 */
export function rebuildsLeft(generation: number): number {
  return Math.max(0, MAX_PLAN_GENERATIONS_PER_DAY - generation);
}

export function canRegenerate(generation: number): boolean {
  return rebuildsLeft(generation) > 0;
}
