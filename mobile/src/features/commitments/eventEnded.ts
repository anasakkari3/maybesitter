/**
 * Whether an appointment is over — the phone's copy of the server's
 * `lib/services/commitments/eventEnded.ts` (lane E1, owner decision
 * 2026-11-12).
 *
 * The server's lists, next step and plans already leave an appointment out
 * once it is over, so most screens need nothing from this file. It exists for
 * the two places that compose from data fetched earlier and drawn later:
 * Today's card (`composeToday`) and the home-screen widget's snapshot. At
 * 10:30 the 09:00–10:00 meeting fetched at 09:30 is still in the cache, and
 * the card must not offer it.
 *
 * The rule is the server's, line for line:
 *
 *   - an event is a `scheduled_event` that is all-day, has an end, or is
 *     titled as one (`namesEvent`, shared with the server). A task given an
 *     hour — «أشتري دوا الساعة 5» — is a `scheduled_event` too and is never
 *     "over": it stays until the person acts on it (#383);
 *   - it is over at its end; an hour after its start when it has no end; for
 *     an all-day one, when its day has ended in the zone it was named in;
 *   - put off («لسّا»), not before the time it was put off to.
 */
import { namesEvent } from '../../../../src/extraction/lexicon/eventTitles';
import { dayKey } from '../../i18n/format';
import { resolveTimeZone } from '../../i18n/timezone';
import type { CommitmentView } from './model';

/** The server's `ASSUMED_EVENT_MINUTES`. */
const ASSUMED_EVENT_MS = 60 * 60_000;

type EventFields = Pick<CommitmentView, 'title' | 'timeKind' | 'dueAt' | 'remindAt' | 'endAt' | 'allDay' | 'postponedUntil' | 'timeZone'>;

const HOUR_MS = 60 * 60_000;

function parsed(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isEventView(view: EventFields): boolean {
  if (view.timeKind !== 'scheduled_event') return false;
  return view.allDay === true || !!view.endAt || namesEvent(view.title);
}

/**
 * `timeZone` is the zone an all-day day was named in (`timeSpec.timezone`,
 * carried on the view as `timeZone`); only an all-day event reads it.
 */
export function hasEventEnded(view: EventFields, now: Date | number, timeZone?: string | null): boolean {
  if (!isEventView(view)) return false;
  const start = parsed(view.dueAt ?? view.remindAt);
  if (start === null) return false;
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const postponed = parsed(view.postponedUntil);

  if (view.allDay === true) {
    const ownEnd = parsed(view.endAt);
    const zone = resolveTimeZone(timeZone ?? view.timeZone);
    const dayOver = ownEnd !== null && ownEnd > start
      ? ownEnd <= nowMs
      : dayKey(new Date(start), zone) < dayKey(new Date(nowMs), zone);
    return dayOver && (postponed === null || postponed + ASSUMED_EVENT_MS <= nowMs);
  }

  return timedEndMs(view, start, postponed) <= nowMs;
}

function timedEndMs(view: EventFields, start: number, postponed: number | null): number {
  const ownEnd = parsed(view.endAt);
  const end = ownEnd !== null && ownEnd > start ? ownEnd : start + ASSUMED_EVENT_MS;
  return postponed === null ? end : Math.max(end, postponed + (end - start));
}

/** The instant an event is over, for scheduling; `null` for a task or an unreadable time. */
function eventEndMs(view: EventFields): number | null {
  if (!isEventView(view)) return null;
  const start = parsed(view.dueAt ?? view.remindAt);
  if (start === null) return null;
  const postponed = parsed(view.postponedUntil);
  if (view.allDay !== true) return timedEndMs(view, start, postponed);
  const ownEnd = parsed(view.endAt);
  let end: number | null = ownEnd !== null && ownEnd > start ? ownEnd : null;
  if (end === null) {
    // The midnight that closes its day: an all-day `dueAt` is a local
    // midnight, so the next one is a whole number of hours on (23, 24 or 25).
    const zone = resolveTimeZone(view.timeZone);
    const startKey = dayKey(new Date(start), zone);
    for (let hours = 1; hours <= 48 && end === null; hours += 1) {
      if (dayKey(new Date(start + hours * HOUR_MS), zone) > startKey) end = start + hours * HOUR_MS;
    }
    if (end === null) return null;
  }
  return postponed === null ? end : Math.max(end, postponed + ASSUMED_EVENT_MS);
}

/**
 * The soonest instant after `nowMs` at which one of these appointments ends,
 * or `null` when none is still to end. Today schedules one recompute there,
 * so a meeting that ends while the screen is open leaves it then — no polling.
 */
export function nextEventEndAfter(views: readonly EventFields[], nowMs: number): number | null {
  let soonest: number | null = null;
  for (const view of views) {
    const end = eventEndMs(view);
    if (end !== null && end > nowMs && (soonest === null || end < soonest)) soonest = end;
  }
  return soonest;
}
