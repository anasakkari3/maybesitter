/**
 * Whether an appointment is over (owner decision 2026-11-12, spec Part 1,
 * lane E1).
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * #383 rolls unfinished work into Today until the person acts on it, and that
 * is right for a task. It was never meant for a meeting: nothing read when an
 * event *ends*, so a lecture three weeks ago that nobody marked done stayed on
 * Today, ranked first as an "overdue" next step, and was floated into the
 * morning plan as a thirty-minute task. An appointment that is over is not
 * work anybody still owes. It leaves every active surface — the lists, the
 * next step, the day and week plans, the widget — and stays in history.
 *
 * This is the one answer every one of those surfaces asks. It changes no
 * status: closing an event, or asking what came of it, is lane E2's place
 * («ما اتصرّفت فيها»), which reads this same predicate.
 *
 * ── What counts as an event ──────────────────────────────────────
 *
 * `timeSpec.kind === 'scheduled_event'`, timed or all-day. That one kind covers
 * every producer the spec names:
 *
 *   - capture writes it for "at" a time (CL1) and for an appointment on a day
 *     with no hour (FY1 N4: an all-day `scheduled_event`);
 *   - every football fixture is created as one (`timeSpecFor` in
 *     `lib/football/projectFixtures.ts`), and an edit keeps the kind;
 *   - a calendar feed's sessions never become commitments at all — they are
 *     busy time (`lib/calendar/icsFeeds.ts`); what a feed does turn into a
 *     commitment is a *deadline*, written as `due_by`, which is a task.
 *
 * A `due_by` is never an event, however late, and neither is an all-day
 * deadline or a prep window (`isTimedWindow`, whose end is a deadline): they
 * keep #383 and roll into Today until the person acts on them.
 *
 * ── When it ends ─────────────────────────────────────────────────
 *
 *   - `endAt`, when it has one;
 *   - otherwise an hour after it starts (`ASSUMED_EVENT_MINUTES`), for an event
 *     with an hour;
 *   - otherwise — a day with no hour — at the midnight that closes that day, in
 *     the zone the day was named in (`latenessDeadline`'s rule for an all-day
 *     item, and the phone's `dayHasEnded`).
 *
 * An event the person put off («لسّا») is not over before the time they put it
 * off to: from there it keeps its own length (an hour for an all-day one,
 * which has a time again once postponed — `isAllDayEvent` in the day plan).
 *
 * "Ended" is `end <= now`: the instant of the end is already past it, the same
 * comparison the football closure has always used.
 *
 * Pure and clock-free: the caller hands in `now`. The day plan's mapping is
 * pinned clock-free by `tests/dailyPlan/dailyPlanBoundaries.test.ts`, and it
 * imports this.
 */
import type { Commitment } from '../../../src/domain/stateMachine';
import { addLocalDays } from '../mobile/time';

/** How long an event with a start and no end is taken to last. */
export const ASSUMED_EVENT_MINUTES = 60;

const MINUTE_MS = 60_000;

type EventShape = Pick<Commitment, 'timeSpec'> & { readonly postponedUntil?: string | null };

/** An appointment or meeting: something that happens at a time, not work to be done by one. */
export function isEventCommitment(commitment: Pick<Commitment, 'timeSpec'>): boolean {
  return commitment.timeSpec.kind === 'scheduled_event';
}

function parsed(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The instant an event is over, or `null` when it is not an event or names no
 * readable start. `null` is never "over": nothing without a time is hidden.
 */
export function eventEndsAt(commitment: EventShape): string | null {
  if (!isEventCommitment(commitment)) return null;
  const { timeSpec } = commitment;
  const startRaw = timeSpec.dueAt ?? timeSpec.remindAt;
  const start = parsed(startRaw);
  if (start === null || !startRaw) return null;

  const ownEnd = parsed(timeSpec.endAt);
  let end: number;
  if (ownEnd !== null && ownEnd > start) end = ownEnd;
  else if (timeSpec.allDay) end = Date.parse(addLocalDays(startRaw, 1, timeSpec.timezone));
  else end = start + ASSUMED_EVENT_MINUTES * MINUTE_MS;

  const postponed = parsed(commitment.postponedUntil);
  if (postponed !== null) {
    const length = timeSpec.allDay ? ASSUMED_EVENT_MINUTES * MINUTE_MS : end - start;
    end = Math.max(end, postponed + length);
  }
  return new Date(end).toISOString();
}

/** Whether `commitment` is an event that is already over at `now`. Never true for a task. */
export function hasEventEnded(commitment: EventShape, now: Date | string): boolean {
  const end = eventEndsAt(commitment);
  if (end === null) return false;
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
  return Number.isFinite(nowMs) && Date.parse(end) <= nowMs;
}
