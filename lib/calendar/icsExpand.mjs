/**
 * Recurrence expansion, the one part of reading a calendar that can fail to
 * terminate (UC-3.4, #188; review of #445, B1).
 *
 * Plain JavaScript on purpose. `classifyIcsBounded` runs this in a
 * `worker_threads` Worker loaded from a file on disk, and a Next.js standalone
 * build neither emits a usable worker chunk for `new Worker(new URL(...))` nor
 * can a worker execute the app's TypeScript. `classifyIcs` imports the same
 * function for its in-thread path, so there is one implementation.
 *
 * ical.js 2.2.1 can loop for ever inside a single `RecurIterator.next()` call
 * (`FREQ=DAILY;INTERVAL=7;BYDAY=MO;BYMONTHDAY=1` starting on a Thursday). The
 * step budgets below cannot stop that — they are checked between calls — which
 * is exactly why this runs where a wall clock can terminate it.
 *
 * What comes back is wall-clock fields and indexes, never text.
 */

export const MAX_STEPS_PER_EVENT = 2000;
export const MAX_STEPS_PER_CALENDAR = 20000;

/** Fourteen hours: the widest UTC offset, so a wall-clock comparison never stops early. */
const MAX_OFFSET_MS = 14 * 60 * 60 * 1000;

export function parseCalendar(ICAL, text) {
  const jcal = ICAL.parse(text);
  return new ICAL.Component(Array.isArray(jcal[0]) ? jcal[0] : jcal);
}

/** A UID as the grouping key, or '' when there is none (such an item has no overrides). */
export function uidKey(component) {
  const value = component.getFirstPropertyValue('uid');
  return typeof value === 'string' ? value.trim().slice(0, 512) : '';
}

function fields(ICAL, time) {
  return {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
    isDate: time.isDate,
    utc: time.zone === ICAL.Timezone.utcTimezone,
  };
}

/**
 * Occurrences of the VEVENTs at `masters` (indexes into the calendar's VEVENT
 * list), up to `horizonMs`.
 *
 * @returns {Record<number, { occurrences: Array<{ recurrence: object, start: object, end: object | null, item: number }>, limited: boolean }>}
 */
export function expandRecurrences(ICAL, text, request) {
  const events = parseCalendar(ICAL, text).getAllSubcomponents('vevent');
  const indexOf = new Map(events.map((event, index) => [event, index]));
  const overrides = new Map();
  for (const event of events) {
    if (!event.hasProperty('recurrence-id')) continue;
    const key = uidKey(event);
    if (!key) continue;
    if (!overrides.has(key)) overrides.set(key, []);
    overrides.get(key).push(event);
  }

  const result = {};
  let total = 0;
  for (const index of request.masters) {
    const master = events[index];
    if (!master) continue;
    const key = uidKey(master);
    // Named explicitly and strictly: left to itself ical.js relates every
    // RECURRENCE-ID in the file to whichever master it is building.
    const event = new ICAL.Event(master, {
      strictExceptions: true,
      exceptions: key && master.hasProperty('rrule') ? overrides.get(key) ?? [] : [],
    });
    const occurrences = [];
    let limited = false;
    let steps = 0;
    const iterator = event.iterator();
    for (let next = iterator.next(); next; next = iterator.next()) {
      steps += 1;
      total += 1;
      if (steps > MAX_STEPS_PER_EVENT || total > MAX_STEPS_PER_CALENDAR) {
        limited = true;
        break;
      }
      const wall = Date.UTC(next.year, next.month - 1, next.day, next.hour, next.minute, next.second);
      if (wall - MAX_OFFSET_MS > request.horizonMs) break;
      const details = event.getOccurrenceDetails(next);
      occurrences.push({
        recurrence: fields(ICAL, next),
        start: fields(ICAL, details.startDate),
        end: details.endDate ? fields(ICAL, details.endDate) : null,
        item: indexOf.get(details.item.component) ?? index,
      });
    }
    result[index] = { occurrences, limited };
  }
  return result;
}
