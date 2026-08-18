/**
 * The default Priority scoring policy (Sprint 04, #18).
 *
 * Weights, base scores and caps live here as data rather than as literals in
 * the scorer, so a policy change is a config change carrying a version rather
 * than an edit to the arithmetic. `policyVersion` travels on every
 * `PriorityScore`, which is what lets a stored ranking say which policy
 * produced it.
 *
 * Every number below is a transcription of `lib/utils/agendaScoring.ts`, not a
 * fresh judgement about what commitments matter. That file is live — it feeds
 * `agendaService` and Sprint 02's `loadView` — and it delegates to this scorer
 * at merge time, so the delegation is only behaviour-preserving if these
 * defaults reproduce its numbers exactly. `tests/priority/priorityScorerEquivalence.test.ts`
 * is the proof; `tests/priority/priorityPolicy.test.ts` pins the table itself
 * so that changing a weight has to be a deliberate act with a red test.
 *
 * The policy is frozen because it is a shared module-level singleton: a caller
 * that mutated it in place would silently change the ranking every other caller
 * sees, and the version it carries would no longer describe it.
 */
import type { PriorityPolicy } from '../../src/contracts/v1/priorityContracts';

export const PRIORITY_POLICY_VERSION = 'priority-policy-v1';

/**
 * Note the band arithmetic these weights imply: the four band components reach
 * 420 + 180 + (270 + 160 + 80) + 240 = 1350 against a band cap of 999. The cap
 * therefore binds on the most overdue, highest-priority, most-repeatedly-delayed
 * items — which is exactly why `band_clamp` is an explicit component rather
 * than an invisible `Math.min` inside the scorer.
 */
export const DEFAULT_PRIORITY_POLICY: PriorityPolicy = Object.freeze({
  version: PRIORITY_POLICY_VERSION,
  /**
   * Bands are 2000 points apart and the band score is capped at 999, so a band
   * can never overtake the one above it. Ordering between bands is structural,
   * not a matter of how the weights happen to be tuned.
   */
  reasonBase: Object.freeze({
    overdue: 7_000,
    due_soon: 5_000,
    active: 3_000,
    pending: 1_000,
  }),
  bandCap: 999,
  totalCap: 9_999,
  weights: Object.freeze({
    /** 6 points per hour overdue, saturating after 70 hours. */
    urgencyOverduePerHour: 6,
    urgencyOverdueMax: 420,
    /** Full marks at the deadline, zero at the far edge of the due-soon window. */
    urgencyDueSoonMax: 420,
    importanceHigh: 180,
    importanceNormal: 80,
    /** Three snoozes saturate the snooze term; further snoozes add nothing. */
    latenessPerSnooze: 90,
    latenessSnoozeMax: 270,
    latenessPostponed: 160,
    latenessDeferred: 80,
    /** A single recency step, matching the legacy 24h ignored window. */
    userPressureRecent: 240,
    userPressureStale: 120,
  }),
});
