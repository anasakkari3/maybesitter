/**
 * The seam between the habit rule and the dates it implies (#520).
 *
 * Two stores and two pure functions, joined in one place:
 *
 *   `habitStore`           the rule           (domain lane)
 *   `materialize.ts`       rule  -> dates     (domain lane, pure)
 *   `recovery.ts`          a skip -> a replacement date (domain lane, pure)
 *   `habitOccurrenceStore` the dates          (this lane)
 *
 * Nothing here re-decides anything either pure function decides. That is the
 * point of the file: the cadence arithmetic, the canonical weekdays, the period
 * capacity and the recovery rules all have exactly one implementation, and this
 * module's whole job is to hand them what they already hold and write back what
 * they answer. A second opinion about which Wednesday a habit falls on is how
 * the two halves of #520 would come to disagree while both suites stayed green.
 *
 * ── Re-materialization is safe, so it happens on every edit ─────
 *
 * `materializeHabitOccurrences` is idempotent through the deterministic id, and
 * it returns `withdrawn` for untouched rows the rule no longer asks for. So a
 * patch that changes a cadence — or pauses the habit — simply runs it again:
 * new dates are created, withdrawn dates are deleted, and everything the person
 * touched is kept by the merge rather than by a rule written here. "Pausing
 * removes future demand without deleting history" is therefore enforced in the
 * domain lane's merge and merely persisted here.
 *
 * ── The horizon is the caller's, and it is always bounded ───────
 *
 * `HABIT_HORIZON_MAX_DAYS` is 56 and `materializeHabitOccurrences` refuses
 * anything wider rather than truncating it. `DEFAULT_HORIZON_DAYS` below is
 * four weeks: long enough that a weekly cadence has a period to recover inside,
 * short enough that creating a habit is a page of writes. A caller that wants
 * more asks for more and is still refused past the maximum.
 *
 * ── Local dates, not instants ───────────────────────────────────
 *
 * Every date in and out of this module is a `YYYY-MM-DD` civil date in the
 * user's own zone, because that is the only thing a habit's demand is ever
 * expressed in. The conversion from "now" to "today, there" is `localDayKey`,
 * which every other mobile service already uses; nothing here does DST
 * arithmetic and nothing here holds an instant for a habit date.
 */
import {
  HABIT_HORIZON_MAX_DAYS,
  type HabitDefinition,
  type HabitDefinitionInput,
  type HabitHorizon,
  type HabitOccurrence,
  type HabitPatchInput,
  type HabitStore,
} from '../../../src/contracts/v1/habitContracts';
import { addDays } from '../../habits/civilDate';
import { materializeHabitOccurrences, type MaterializationResult } from '../../habits/materialize';
import { recoverSkippedOccurrence, type HabitRecoveryOutcome } from '../../habits/recovery';
import { createStorageHabitStore } from '../../habits/habitStore';
import {
  createStorageHabitOccurrenceStore,
  type HabitOccurrenceOutcome,
  type HabitOccurrenceStore,
  type OccurrenceTransition,
} from './habitOccurrenceStore';
import { localDayKey, normalizeTimezone } from '../mobile/time';
import type { StorageAdapter } from '../../storage';

/**
 * Four weeks. See the header — the number matters less than that the horizon
 * is always finite and always stated.
 */
export const DEFAULT_HORIZON_DAYS = 28;

export interface HabitServices {
  readonly habits: HabitStore;
  readonly occurrences: HabitOccurrenceStore;
}

/**
 * The two stores, over one storage adapter.
 *
 * Built together rather than reached for separately, because every operation
 * below touches both and a caller holding one of them is a caller that can
 * delete a habit and leave its dates behind.
 */
export function createHabitServices(adapter?: StorageAdapter): HabitServices {
  return {
    habits: createStorageHabitStore(adapter),
    occurrences: createStorageHabitOccurrenceStore(adapter),
  };
}

/** `[today, today + days - 1]`, inclusive, as civil dates. */
export function horizonFrom(todayLocalDate: string, days = DEFAULT_HORIZON_DAYS): HabitHorizon {
  const span = Math.min(Math.max(1, Math.trunc(days)), HABIT_HORIZON_MAX_DAYS);
  return { fromLocalDate: todayLocalDate, toLocalDate: addDays(todayLocalDate, span - 1) };
}

/** "Today", where the user is. The one conversion from an instant in this module. */
export function todayLocalDateFor(now: Date | string, timezone?: string): string {
  return localDayKey(now, normalizeTimezone(timezone));
}

/**
 * Brings one habit's stored dates in line with its rule, over a horizon.
 *
 * The result is the domain lane's `MaterializationResult`, unmodified, so a
 * caller can see exactly what was created and what was withdrawn rather than a
 * count this file invented. The writes are the only thing added: `created`
 * rows are written, `withdrawn` rows are deleted, and rows the merge kept are
 * left exactly as they were — including every row outside the horizon, which
 * `materializeHabitOccurrences` passes through untouched.
 */
export async function resyncHabitOccurrences(
  services: HabitServices,
  habit: HabitDefinition,
  horizon: HabitHorizon,
): Promise<MaterializationResult> {
  const existing = await services.occurrences.listForHabit(habit.scopeId, habit.habitId);
  const result = materializeHabitOccurrences(habit, horizon, existing);
  await services.occurrences.putMany(habit.scopeId, result.created);
  await services.occurrences.removeMany(
    habit.scopeId,
    result.withdrawn.map((occurrence) => occurrence.occurrenceId),
  );
  return result;
}

export interface CreatedHabit {
  readonly habit: HabitDefinition;
  readonly materialization: MaterializationResult;
}

/**
 * Creates a habit and the dates it asks for, in that order.
 *
 * The order is not arbitrary: materialization needs the server-minted
 * `habitId` to derive occurrence ids from, so there is no way to produce the
 * dates before the rule exists. A failure between the two leaves a habit with
 * no occurrences, which the next resync fixes — the opposite order would leave
 * occurrences belonging to a habit that does not exist, which nothing fixes.
 */
export async function createHabitWithOccurrences(
  services: HabitServices,
  input: HabitDefinitionInput,
  now: string,
  todayLocalDate: string,
  horizonDays = DEFAULT_HORIZON_DAYS,
): Promise<CreatedHabit> {
  const habit = await services.habits.create(input, now);
  const materialization = await resyncHabitOccurrences(
    services,
    habit,
    horizonFrom(todayLocalDate, horizonDays),
  );
  return { habit, materialization };
}

/**
 * Applies a user patch and re-materializes.
 *
 * Always re-materializes, even for a patch that only changed the title. The
 * alternative is a rule about which fields affect the dates, kept in this file,
 * next to a second rule about the same thing inside `demandDates` — and the
 * run is idempotent, so the cost of being wrong in this direction is two reads.
 */
export async function patchHabitWithOccurrences(
  services: HabitServices,
  scopeId: string,
  habitId: string,
  patch: HabitPatchInput,
  now: string,
  todayLocalDate: string,
  horizonDays = DEFAULT_HORIZON_DAYS,
): Promise<CreatedHabit | null> {
  const habit = await services.habits.patch(scopeId, habitId, patch, now);
  if (habit === null) return null;
  const materialization = await resyncHabitOccurrences(
    services,
    habit,
    horizonFrom(todayLocalDate, horizonDays),
  );
  return { habit, materialization };
}

/**
 * Removes a habit and every date it ever put on the calendar.
 *
 * Both, or the occurrences outlive the rule that explains them: an orphaned row
 * has a title nowhere, a flexibility nowhere, and no definition the adapter
 * could plan it from, so it would be silently dropped every morning for ever.
 * The occurrences go first, because a failure after the habit is gone is
 * exactly the orphan state this is avoiding.
 */
export async function removeHabitWithOccurrences(
  services: HabitServices,
  scopeId: string,
  habitId: string,
): Promise<boolean> {
  const existing = await services.habits.get(scopeId, habitId);
  if (existing === null) return false;
  await services.occurrences.deleteForHabit(scopeId, habitId);
  return services.habits.remove(scopeId, habitId);
}

export interface OccurrenceOutcomeResult {
  readonly transition: OccurrenceTransition;
  /**
   * What recovery decided, or null when it was never consulted — which is
   * every outcome except a newly applied skip. Null and a `none` outcome are
   * different facts and a caller can tell them apart: the first means nothing
   * was asked, the second means it was asked and declined, with a reason.
   */
  readonly recovery: HabitRecoveryOutcome | null;
}

/**
 * Records "I did it" or "not today", and offers a replacement date when the
 * habit's own `recoveryPolicy` asks for one.
 *
 * Recovery runs only on a skip that actually changed something. A retry of a
 * skip already recorded must not produce a *second* replacement date — that is
 * the difference between `applied` and `unchanged` being load-bearing rather
 * than cosmetic, and it is the bug a caller that ignored the distinction would
 * ship as a fortnight of gym sessions after one bad week.
 *
 * Every rule about whether a replacement is allowed — the policy, the period's
 * capacity, whether a date is left — belongs to `recoverSkippedOccurrence`, and
 * this function neither pre-checks nor second-guesses any of them. It hands
 * over what it holds and writes back what comes out.
 */
export async function applyOccurrenceOutcome(
  services: HabitServices,
  scopeId: string,
  habitId: string,
  occurrenceId: string,
  outcome: HabitOccurrenceOutcome,
  todayLocalDate: string,
): Promise<OccurrenceOutcomeResult> {
  const transition = await services.occurrences.transition(scopeId, habitId, occurrenceId, outcome);
  if (transition.kind !== 'applied' || outcome !== 'skipped') {
    return { transition, recovery: null };
  }

  const habit = await services.habits.get(scopeId, habitId);
  // The habit vanished between the two reads. The skip stands — it is the
  // person's answer and is already written — and there is nothing to recover
  // into, which is not an error to report at them.
  if (habit === null) return { transition, recovery: null };

  const occurrences = await services.occurrences.listForHabit(scopeId, habitId);
  const recovery = recoverSkippedOccurrence({
    habit,
    occurrences,
    occurrenceId,
    notBeforeLocalDate: todayLocalDate,
  });
  if (recovery.kind !== 'recovered') return { transition, recovery };

  // Two rows change: the replacement is new, and the skipped row the domain
  // marked `recovered` has to be written back or it would keep reading as
  // outstanding demand. Both come out of `recovery.occurrences`, so neither is
  // reconstructed here.
  const changed = recovery.occurrences.filter((entry) =>
    entry.occurrenceId === recovery.replacement.occurrenceId || entry.occurrenceId === occurrenceId);
  await services.occurrences.putMany(scopeId, changed);
  return { transition, recovery };
}

/**
 * Every occurrence in a date range, with the habits they belong to.
 *
 * What the planner adapter is given. Both halves come from storage in one call
 * because the adapter needs them together — an occurrence without its
 * definition has no title, no duration policy and no flexibility, and is
 * dropped.
 */
export async function loadHabitDemand(
  services: HabitServices,
  scopeId: string,
  fromLocalDate: string,
  toLocalDate: string,
): Promise<{ definitions: readonly HabitDefinition[]; occurrences: readonly HabitOccurrence[] }> {
  const [definitions, occurrences] = await Promise.all([
    services.habits.list(scopeId),
    services.occurrences.listInRange(scopeId, fromLocalDate, toLocalDate),
  ]);
  return { definitions, occurrences };
}
