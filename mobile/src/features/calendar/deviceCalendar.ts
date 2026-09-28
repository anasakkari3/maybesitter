/**
 * The only module in this app that imports `expo-calendar` (UC-3.1, #185).
 *
 * Everything above it — the mapper, the sync service, the settings screen, and
 * UC-3.2 (#186) when it reads busy time — talks to the `DeviceCalendar`
 * interface below and never to the native module. That is what makes any of it
 * testable: a calendar is a device with seeded data, and Jest has neither, so
 * the seam has to be an *interface a test can implement* rather than a module a
 * test has to mock. The single import also means the answer to "what can this
 * app do to somebody's calendar" is one file long.
 *
 * ── Full access, not write-only ──────────────────────────────────
 *
 * iOS 17 split calendar permission in two. Write-only access can add an event
 * and can never look one up again — so `update`, `delete` and "is this event
 * still there?" are all impossible under it, and those are three of this
 * feature's acceptance criteria. UC-3.2 (#186) additionally reads busy time.
 * So the app asks for full access and the purpose string says what it does with
 * it, which is the honest trade rather than the quiet one.
 *
 * ── The class API, not the legacy function API ───────────────────
 *
 * `expo-calendar@57` ships both. The legacy surface warns and is on its way
 * out; `ExpoCalendarEvent.get(id)` / `event.update(…)` / `event.delete()` and
 * `ExpoCalendar.get(id).createEvent(…)` are the current ones, and they are also
 * the only ones that express "fetch this event by id" — the operation the whole
 * update-and-delete story rests on.
 *
 * ── Failures are four words, not an exception from a native module ──
 *
 * Every caller has to distinguish "the user said no" from "the event is gone"
 * from "this calendar is read-only". A raw native error distinguishes none of
 * them, and its message is not something to match on. So every method answers
 * with a `DeviceCalendarError` carrying one of four reasons, and the sync
 * service switches on the reason.
 *
 * `not_found` in particular is a *normal* outcome and not a failure: it is what
 * the app sees when the user deleted the event in their Calendar app, which is
 * the signal that puts the link into `detached`.
 *
 * ── The one read that is not "is this event still there?" ────────
 *
 * UC-3.2 (#186) added `fetchBusyBlocks`. It is the only method here that looks
 * at a calendar entry this app did not write, and it is deliberately not
 * `listEvents`: what it returns is `DeviceBusyBlock[]`, four fields each, with
 * the events themselves never escaping this module. `busyBlocks.ts` does the
 * narrowing and says at length why the guarantee had to move from the platform
 * into this code when the Flutter bridge was replaced.
 */
import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import { toBusyBlocks, type DeviceBusyBlock } from './busyBlocks';

export type CalendarAccess = 'granted' | 'denied' | 'undetermined';

/** A calendar this app could write into, as the picker shows it. */
export interface WritableCalendar {
  id: string;
  title: string;
  /** For the picker's dot. Null when the platform does not give one. */
  color: string | null;
  /** Android's per-account primary calendar. Always false on iOS. */
  isPrimary: boolean;
  /** "iCloud", "Google", the account name — what tells two "Calendar"s apart. */
  sourceName: string | null;
}

/**
 * A calendar on this phone, for the settings list of what busy time is read
 * from (first iPhone run, L7). Every event calendar — the accounts added in
 * the phone's own settings (Google, Outlook, iCloud) arrive here through the
 * OS, which is why the user never has to type anything in.
 */
export interface DeviceEventCalendar {
  id: string;
  title: string;
  color: string | null;
  /** The account it belongs to: what the list is grouped by. */
  sourceName: string | null;
}

/** One event, as this app writes it. Nothing here is ever read back out. */
export interface CalendarEventDraft {
  title: string;
  notes: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  /** IANA zone. An all-day entry is a day *somewhere*, and this says where. */
  timeZone: string;
  /** `maybesitter://commitments/{id}`, so the event points back. iOS only. */
  url?: string;
}

export type DeviceCalendarFailure =
  /** The user has not granted calendar access, or took it away. */
  | 'permission_denied'
  /** The event or calendar is not there — usually because the user removed it. */
  | 'not_found'
  /** A subscribed or holiday calendar: it exists and cannot be written to. */
  | 'calendar_read_only'
  /** The native module answered in a way this wrapper has no word for. */
  | 'unavailable';

export class DeviceCalendarError extends Error {
  constructor(readonly reason: DeviceCalendarFailure, message: string) {
    super(message);
    this.name = 'DeviceCalendarError';
  }
}

/**
 * What the rest of the app may do to a calendar.
 *
 * Deliberately small. There is no "list every event", no "read an event's
 * title", and no way to reach a calendar the user did not pick: a function that
 * cannot see somebody's appointments cannot leak one, and UC-3.2 (#186) adds
 * its own narrow read — busy *intervals*, no titles — rather than widening
 * these.
 */
export interface DeviceCalendar {
  /** What the OS currently says, without prompting. */
  getAccess(): Promise<CalendarAccess>;
  /** Prompts once; afterwards the OS answers from its own record. */
  requestAccess(): Promise<CalendarAccess>;
  /** The calendars the picker may offer: event calendars this app can modify. */
  listWritableCalendars(): Promise<WritableCalendar[]>;
  /** Every event calendar on the phone, writable or not, with its account. */
  listEventCalendars(): Promise<DeviceEventCalendar[]>;
  /** Creates the event and answers with its id. */
  createEvent(calendarId: string, draft: CalendarEventDraft): Promise<string>;
  /** Moves or retitles an existing event. `not_found` when it is gone. */
  updateEvent(eventId: string, draft: CalendarEventDraft): Promise<void>;
  /** Removes it. Removing one that is already gone is not an error. */
  deleteEvent(eventId: string): Promise<void>;
  /** Whether the event is still in the calendar. Never throws `not_found`. */
  eventExists(eventId: string): Promise<boolean>;
  /**
   * When the user is busy over the next few weeks (UC-3.2, #186).
   *
   * Intervals, not events. Nothing a caller receives from this has ever held a
   * title, a note, a location or a guest — see `busyBlocks.ts`.
   */
  fetchBusyBlocks(options?: BusyReadOptions): Promise<DeviceBusyBlock[]>;
}

/**
 * How far ahead busy time is read.
 *
 * Twenty-eight days rather than the Flutter build's fourteen. The daily plan
 * (UC-3.10a, #194) only needs today, but a conflict hint on a capture is worth
 * having for anything somebody would say out loud — "the dentist next month" is
 * a sentence people say — and a month is where a device calendar stops being
 * cheap to page through.
 */
export const BUSY_LOOK_AHEAD_DAYS = 28;

/**
 * How many events one sync may ask about the attendees of.
 *
 * `getAttendees()` is a round trip into EventKit per event, on the JS thread,
 * and a sync runs when the app comes back to the front. Somebody with a
 * thousand entries in the month would pay a thousand of them every resume. Past
 * the cap the answer is "busy", which is the conservative direction: a
 * redundant conflict hint rather than a meeting the user declined being missed
 * from their day.
 */
export const ATTENDEE_LOOKUP_LIMIT = 300;

export interface BusyReadOptions {
  /** Defaults to `BUSY_LOOK_AHEAD_DAYS`. */
  lookAheadDays?: number;
  /** From `calendar.writtenEventIds.v1`; this app's own entries are not busy. */
  ownEventIds?: ReadonlySet<string>;
  /** Injected so a test is not at the mercy of the second it runs in. */
  now?: Date;
  /** Calendars the user switched off in Calendar settings; never read. */
  excludedCalendarIds?: ReadonlySet<string>;
}

/**
 * `PermissionResponse` → one of three words.
 *
 * `granted` is the only thing that lets a write proceed. Everything else is
 * `denied` unless the OS says it has not asked yet, because a screen that
 * showed "allow in Settings" to somebody who was never prompted would be
 * sending them to a switch that is not there.
 */
function accessFrom(response: { granted: boolean; status: string; canAskAgain?: boolean }): CalendarAccess {
  if (response.granted) return 'granted';
  if (response.status === 'undetermined') return 'undetermined';
  return 'denied';
}

/**
 * Whatever the native module threw, as something a caller can switch on.
 *
 * The message is matched only for the two cases the platforms genuinely
 * distinguish by wording and by nothing else. Where it does not match, the
 * answer is `unavailable` rather than a guess — a wrong `not_found` would tell
 * the sync service the user had deleted an event they had not, and detach a
 * link that is perfectly good.
 */
function failureFrom(error: unknown, fallback: DeviceCalendarFailure): DeviceCalendarError {
  if (error instanceof DeviceCalendarError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied|not authori[sz]ed/i.test(message)) {
    return new DeviceCalendarError('permission_denied', message);
  }
  if (/not found|no event|does not exist|doesn't exist/i.test(message)) {
    return new DeviceCalendarError('not_found', message);
  }
  if (/read[- ]only|immutable|cannot be modified|allowsModifications/i.test(message)) {
    return new DeviceCalendarError('calendar_read_only', message);
  }
  return new DeviceCalendarError(fallback, message);
}

/** The event fields this app sets, and the complete list of them. */
function eventFrom(draft: CalendarEventDraft): Record<string, unknown> {
  return {
    title: draft.title,
    notes: draft.notes,
    startDate: draft.startDate,
    endDate: draft.endDate,
    allDay: draft.allDay,
    timeZone: draft.timeZone,
    ...(draft.url === undefined ? {} : { url: draft.url }),
  };
}

/**
 * The events the user themselves declined, as far as the platform will say.
 *
 * `isCurrentUser` is iOS-only. On Android the flag is never true, so this set
 * comes back empty and a declined meeting counts as busy — conservative, and
 * said out loud in the Trust Center copy rather than hidden.
 *
 * The whole lookup is skipped off iOS: it would be one round trip per event to
 * learn something the platform cannot tell us.
 */
async function declinedBy(events: readonly { id?: unknown; getAttendees?: unknown }[]): Promise<ReadonlySet<string>> {
  const declined = new Set<string>();
  if (Platform.OS !== 'ios') return declined;
  for (const event of events.slice(0, ATTENDEE_LOOKUP_LIMIT)) {
    const id = typeof event.id === 'string' ? event.id : '';
    if (id === '' || typeof event.getAttendees !== 'function') continue;
    try {
      const attendees = await (event.getAttendees as () => Promise<{ isCurrentUser?: boolean; status?: string }[]>)();
      if (attendees.some((attendee) => attendee.isCurrentUser === true && attendee.status === 'declined')) {
        declined.add(id);
      }
    } catch {
      // A lookup that fails is not evidence of a refusal. Leaving the event out
      // of this set keeps it busy, which is the direction that costs a
      // redundant hint rather than an hour of somebody's day.
    }
  }
  return declined;
}

export const deviceCalendar: DeviceCalendar = {
  async getAccess() {
    try {
      return accessFrom(await Calendar.getCalendarPermissions());
    } catch {
      // A module that cannot answer is not a module that said yes.
      return 'denied';
    }
  },

  async requestAccess() {
    try {
      // No argument: `writeOnly` defaults to false, which is full access.
      return accessFrom(await Calendar.requestCalendarPermissions());
    } catch {
      return 'denied';
    }
  },

  async listWritableCalendars() {
    try {
      const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
      return calendars
        // A holiday feed or a subscribed calendar is in the list and refuses
        // every write. Offering one is offering a choice that fails later.
        .filter((calendar) => calendar.allowsModifications)
        .map((calendar) => ({
          id: calendar.id,
          title: calendar.title,
          color: calendar.color ?? null,
          isPrimary: calendar.isPrimary === true,
          // Two calendars called "Calendar" are told apart by their account.
          sourceName: calendar.source?.name ?? calendar.ownerAccount ?? null,
        }));
    } catch (error) {
      throw failureFrom(error, 'permission_denied');
    }
  },

  async listEventCalendars() {
    try {
      const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
      return calendars.map((calendar) => ({
        id: calendar.id,
        title: calendar.title,
        color: calendar.color ?? null,
        sourceName: calendar.source?.name ?? calendar.ownerAccount ?? null,
      }));
    } catch (error) {
      throw failureFrom(error, 'permission_denied');
    }
  },

  async createEvent(calendarId, draft) {
    try {
      const calendar = await Calendar.ExpoCalendar.get(calendarId);
      if (!calendar.allowsModifications) {
        throw new DeviceCalendarError('calendar_read_only', 'that calendar cannot be written to');
      }
      const event = await calendar.createEvent(eventFrom(draft));
      return event.id;
    } catch (error) {
      throw failureFrom(error, 'unavailable');
    }
  },

  async updateEvent(eventId, draft) {
    try {
      const event = await Calendar.ExpoCalendarEvent.get(eventId);
      await event.update(eventFrom(draft));
    } catch (error) {
      throw failureFrom(error, 'not_found');
    }
  },

  async deleteEvent(eventId) {
    try {
      const event = await Calendar.ExpoCalendarEvent.get(eventId);
      await event.delete();
    } catch (error) {
      const failure = failureFrom(error, 'not_found');
      // Removing an event that is already gone is the outcome the caller asked
      // for. Anything else — no permission, a read-only calendar — is not.
      if (failure.reason === 'not_found') return;
      throw failure;
    }
  },

  async fetchBusyBlocks(options = {}) {
    const now = options.now ?? new Date();
    if ((await this.getAccess()) !== 'granted') {
      // A throw rather than an empty list. "No calendar access" and "nothing in
      // your calendar" are the same list and completely different facts, and
      // the caller has to be able to tell them apart before it decides whether
      // to overwrite a cache that still holds yesterday's answer.
      throw new DeviceCalendarError('permission_denied', 'calendar access has not been granted');
    }
    try {
      // Every event calendar, not only the writable ones. A subscribed work
      // calendar and a holiday feed are both time somebody is spoken for, and
      // UC-3.1's picker filter exists for a different question — which calendar
      // may be written into.
      const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
      // Less the ones the user switched off in Calendar settings (L7): an
      // excluded calendar is not read at all, not read and then dropped.
      const excluded = options.excludedCalendarIds ?? new Set<string>();
      const ids = calendars.map((calendar) => calendar.id).filter((id) => !excluded.has(id));
      if (ids.length === 0) return [];

      const start = new Date(now);
      // Local midnight: the window a person means by "the next four weeks"
      // starts at the beginning of today, not at this moment, or an event that
      // began an hour ago and runs until noon would be invisible.
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + (options.lookAheadDays ?? BUSY_LOOK_AHEAD_DAYS));

      const events = await Calendar.listEvents(ids, start, end);
      return toBusyBlocks(events as never, {
        ownEventIds: options.ownEventIds ?? new Set(),
        declinedEventIds: await declinedBy(events),
        now,
      });
    } catch (error) {
      throw failureFrom(error, 'unavailable');
    }
  },

  async eventExists(eventId) {
    try {
      await Calendar.ExpoCalendarEvent.get(eventId);
      return true;
    } catch (error) {
      const failure = failureFrom(error, 'not_found');
      // A permission problem is not evidence that the event is gone, and
      // answering `false` to it is how the sync service would detach every link
      // on the day somebody revoked access in Settings.
      if (failure.reason === 'permission_denied') throw failure;
      return false;
    }
  },
};
