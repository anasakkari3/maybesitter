import type { Strings } from '../../i18n/strings';
import { PlanEditRefusedError } from '../../api/errors';

/**
 * Why something is not on today's plan, in words (UC-3.10b, #195 step 2).
 *
 * ── A code is never shown ────────────────────────────────────────
 *
 * `NO_FEASIBLE_SLOT` is a planner's word. What the user is owed is a plain
 * sentence, and one that does not read as an accusation: this product says it
 * has no "overdue" and no failures, only active, done, rearranged and dropped
 * on purpose (AGENTS.md). So nothing here says "failed", "behind", "missed" or
 * "should have", and `planCopy.test.ts` asserts that of all three locales.
 *
 * ── Seventeen codes, seven sentences ─────────────────────────────
 *
 * `PlanningReasonCode` has seventeen members. Seventeen sentences would be
 * seventeen translations of distinctions the user cannot act on — "the
 * prerequisite went unscheduled" and "the prerequisites all finish too late"
 * are one fact to a person: it is waiting on something else. Codes are grouped
 * by what the reader would do about them.
 *
 * ── An unknown code is expected ──────────────────────────────────
 *
 * `UnplacedItemDto` widens the code to `string` on the wire, deliberately, so a
 * new planning reason can reach a shipped app. That falls back to the calm
 * general sentence rather than rendering the code — which is the one outcome
 * this module exists to prevent.
 */

type CopyKey = {
  [K in keyof Strings]: Strings[K] extends string ? K : never;
}[keyof Strings];

const UNPLACED_REASON_COPY: Readonly<Record<string, CopyKey>> = {
  // There was time, but never a long enough run of it.
  NO_FEASIBLE_SLOT: 'planReasonNoRoom',
  EFFORT_EXCEEDS_ITEM_WINDOW: 'planReasonNoRoom',
  HORIZON_EXHAUSTED: 'planReasonNoRoom',
  NO_WORKING_WINDOW: 'planReasonNoRoom',
  // The calendar already owns that time.
  FIXED_EVENT_CONFLICT: 'planReasonCalendarBusy',
  // It waits on something that itself has no place today.
  BLOCKED_BY_DEPENDENCY: 'planReasonWaiting',
  DEPENDENCY_TOO_LATE: 'planReasonWaiting',
  // Its own time is not in this day at all.
  DEADLINE_BEYOND_HORIZON: 'planReasonOutsideDay',
  DEADLINE_BEFORE_EARLIEST_START: 'planReasonOutsideDay',
  // Nobody has said how long it takes.
  EFFORT_UNKNOWN: 'planReasonNoLength',
  EFFORT_NOT_POSITIVE: 'planReasonNoLength',
  INVALID_INTERVAL: 'planReasonNoLength',
  // A clock change swallowed or doubled the hour it wanted.
  NONEXISTENT_LOCAL_TIME: 'planReasonClockChange',
  AMBIGUOUS_LOCAL_TIME: 'planReasonClockChange',
  // Dependency shapes the user did not author and cannot act on.
  SELF_DEPENDENCY: 'planReasonKept',
  CYCLIC_DEPENDENCY: 'planReasonKept',
  UNKNOWN_DEPENDENCY: 'planReasonKept',
};

/** The locale key for one `unscheduled` entry's `reasonCode`. */
export function unplacedReasonKey(reasonCode: string): CopyKey {
  return UNPLACED_REASON_COPY[reasonCode] ?? 'planReasonKept';
}

export function unplacedReason(reasonCode: string, t: Strings): string {
  return t[unplacedReasonKey(reasonCode)] as string;
}

/**
 * Why a move was refused, in words.
 *
 * Every sentence ends by saying the item stayed where it was, because that is
 * the fact the user most needs and the one an optimistic update briefly
 * contradicted on screen.
 */
const EDIT_REFUSAL_COPY: Readonly<Record<PlanEditRefusedError['reason'], CopyKey>> = {
  outside_horizon: 'planEditOutsideDay',
  outside_working_window: 'planEditOutsideHours',
  overlaps_fixed_event: 'planEditBusy',
  overlaps_scheduled_item: 'planEditOverlaps',
  unknown_item: 'planEditGone',
  invalid_instant: 'planEditUnclear',
  invalid_interval: 'planEditUnclear',
  empty_edit: 'planEditUnclear',
};

export function editRefusalKey(reason: PlanEditRefusedError['reason']): CopyKey {
  return EDIT_REFUSAL_COPY[reason] ?? 'planEditUnclear';
}

/**
 * The refusal an edit failure should be shown as, or null when it is not one.
 *
 * Only a `PlanEditRefusedError` gets a sentence of its own. Everything else —
 * no signal, a 5xx — goes through `userFacingMessage` like every other error in
 * this app, because "that time is already taken" would be a lie about a request
 * that never arrived.
 */
export function editRefusalOf(error: unknown): { itemId: string | null; key: CopyKey } | null {
  if (!(error instanceof PlanEditRefusedError)) return null;
  return { itemId: error.itemId, key: editRefusalKey(error.reason) };
}
