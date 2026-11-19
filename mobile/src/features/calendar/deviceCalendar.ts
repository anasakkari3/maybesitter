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

/**
 * Android sometimes exposes a resource key instead of a calendar name. Keep
 * that implementation detail out of every visible and spoken calendar label.
 */
export function calendarDisplayName(value: string | null, phoneCalendar: string): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const resourceToken = /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(trimmed)
    && trimmed.split('_').some(part => part.includes('displayname'));
  return resourceToken ? phoneCalendar : trimmed;
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
  /**
   * Weekly, on these days (0 = Sunday … 6 = Saturday), from `startDate` on —
   * a weekly fixed block («ثابت أسبوعي»). Absent for a one-off.
   *
   * The days reach the platform only where it can hold them: iOS writes
   * `BYDAY`; `expo-calendar` on Android writes `FREQ=WEEKLY` alone, so there a
   * series recurs on `startDate`'s weekday and a caller wanting several days
   * writes one series per day (`weeklyRuleCarriesDays`).
   */
  recurrence?: { weekdays: number[] };
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
  /** Creates the event and answers with its id — never an empty one. */
  createEvent(calendarId: string, draft: CalendarEventDraft): Promise<string>;
  /**
   * Moves or retitles an existing event. `not_found` when it is gone.
   *
   * `calendarId`, when the caller knows it, is where the event is looked for
   * if the lookup by id does not find it (see `locate`).
   */
  updateEvent(eventId: string, draft: CalendarEventDraft, calendarId?: string): Promise<void>;
  /** Removes it. Removing one that is already gone is not an error. */
  deleteEvent(eventId: string, calendarId?: string): Promise<void>;
  /** Whether the event is still in the calendar. Never throws `not_found`. */
  eventExists(eventId: string, calendarId?: string): Promise<boolean>;
  /**
   * The events in one calendar whose address starts with `urlPrefix` — the ones
   * this app wrote, since it puts `maybesitter://…` on every event and the user
   * never does (QA v3, V3-F18-04). Ids and addresses only: nothing a caller
   * gets from this has a title in it.
   *
   * Optional so a test calendar need not have it; without it a write cannot
   * find an earlier copy of itself, which is how the duplicates were made.
   * iOS only in effect: Android's events carry no url, and answer none.
   */
  findOwnEvents?(calendarId: string, urlPrefix: string, from: Date, to: Date): Promise<OwnCalendarEvent[]>;
  /**
   * When the user is busy over the next few weeks (UC-3.2, #186).
   *
   * Intervals, not events. Nothing a caller receives from this has ever held a
   * title, a note, a location or a guest — see `busyBlocks.ts`.
   */
  fetchBusyBlocks(options?: BusyReadOptions): Promise<DeviceBusyBlock[]>;
}

/** An event this app wrote, as `findOwnEvents` names it. */
export interface OwnCalendarEvent {
  id: string;
  url: string;
}

/**
 * How far an event is looked for when its id alone does not find it: a year
 * back and two ahead. EventKit answers a range of at most four years.
 */
const LOOKUP_DAYS_BACK = 366;
const LOOKUP_DAYS_AHEAD = 731;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** Calendars the user switched off in Calendar settings; never read. A never-enrolled phone only. */
  excludedCalendarIds?: ReadonlySet<string>;
  /**
   * M5a (M5A-001): when present, only these calendars are read — an enrolled
   * phone reads what the person turned on and nothing else, and an empty set
   * reads nothing. Wins over `excludedCalendarIds`.
   */
  includedCalendarIds?: ReadonlySet<string>;
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

/**
 * Whether one recurring event can carry several weekdays on this platform.
 *
 * iOS: yes — `daysOfTheWeek` becomes `BYDAY`. Android: no — expo-calendar 57's
 * `RecurrenceRule.toRuleString()` writes `FREQ`, `INTERVAL`, `UNTIL`/`COUNT`
 * and nothing else, so `daysOfTheWeek` is silently dropped and the series
 * repeats only on its first day's weekday.
 */
export function weeklyRuleCarriesDays(): boolean {
  return Platform.OS === 'ios';
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
    ...(draft.recurrence === undefined ? {} : {
      recurrenceRule: {
        frequency: 'weekly',
        interval: 1,
        // `DayOfTheWeek` is 1 = Sunday … 7 = Saturday. Ignored on Android.
        ...(weeklyRuleCarriesDays() ? { daysOfTheWeek: draft.recurrence.weekdays.map((day) => ({ dayOfTheWeek: day + 1 })) } : {}),
      },
    }),
  };
}

/**
 * The event a change or a removal should act on.
 *
 * `ExpoCalendarEvent.get(id)` answers a recurring event's *first occurrence*
 * with the span `thisEvent`, and on iOS saving or removing it with that span
 * detaches or deletes that one Saturday and leaves the rest of the series. For
 * a series the whole of it is wanted, so it is re-fetched with `futureEvents`
 * from its first occurrence — which is every occurrence. Android acts on the
 * event row either way.
 */
function wholeSeries<T extends { recurrenceRule?: unknown; getOccurrenceSync?: unknown }>(event: T): T {
  if (!event.recurrenceRule || typeof event.getOccurrenceSync !== 'function') return event;
  return (event.getOccurrenceSync as (options: { futureEvents: boolean }) => T)({ futureEvents: true });
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

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface NativeEvent {
  id?: unknown;
  url?: unknown;
  recurrenceRule?: unknown;
  getOccurrenceSync?: unknown;
  update(details: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

/** The events of one calendar in a range, as the class API answers them. */
async function eventsIn(calendarId: string, from: Date, to: Date): Promise<NativeEvent[]> {
  const calendar = await Calendar.ExpoCalendar.get(calendarId);
  return (await calendar.listEvents(from, to)) as unknown as NativeEvent[];
}

/**
 * The event with this id, ready to change or remove.
 *
 * `ExpoCalendarEvent.get(id)` first. On iOS that looks the id up with
 * `event(withIdentifier:)`, which expects an *event* identifier, while the id
 * the class API hands out is the *calendar item* identifier (expo-calendar 57,
 * `CalendarNextModule.swift`). Whether the two agree for a given calendar is
 * the platform's business; if they did not, a linked event would read as one
 * the user deleted and be detached for ever. So when the lookup says "not
 * found" and the caller knows the calendar, the event is looked for there by
 * its id before that answer is believed (QA v3, V3-F18-04).
 */
async function locate(eventId: string, calendarId: string | undefined): Promise<NativeEvent> {
  if (eventId === '') {
    // The defect this guards: `deleteEvent(undefined)` was answered "already
    // gone", so the repair of a refused claim removed nothing and said done.
    throw new DeviceCalendarError('unavailable', 'an event with no id cannot be looked up');
  }
  let failure: DeviceCalendarError;
  try {
    return wholeSeries((await Calendar.ExpoCalendarEvent.get(eventId)) as unknown as NativeEvent);
  } catch (error) {
    failure = failureFrom(error, 'not_found');
  }
  if (failure.reason !== 'not_found' || calendarId === undefined) throw failure;
  const now = Date.now();
  let listed: NativeEvent[];
  try {
    listed = await eventsIn(calendarId, new Date(now - LOOKUP_DAYS_BACK * DAY_MS), new Date(now + LOOKUP_DAYS_AHEAD * DAY_MS));
  } catch (error) {
    // A calendar that will not list is not evidence the event is gone.
    throw failureFrom(error, 'unavailable');
  }
  const match = listed.find((event) => textOf(event.id) === eventId);
  if (!match) throw failure;
  return match;
}

/** The range an event written for this draft is looked for in. */
function rangeOf(draft: CalendarEventDraft): [Date, Date] {
  return [new Date(draft.startDate.getTime() - DAY_MS), new Date(draft.endDate.getTime() + DAY_MS)];
}

/** The ids of the events with this address in the draft's range, or null when the calendar would not list. */
async function idsAt(calendarId: string, draft: CalendarEventDraft): Promise<Set<string> | null> {
  if (draft.url === undefined) return null;
  try {
    const events = await eventsIn(calendarId, ...rangeOf(draft));
    const ids = new Set(events.filter((event) => textOf(event.url) === draft.url).map((event) => textOf(event.id)));
    ids.delete('');
    return ids;
  } catch {
    return null;
  }
}

/**
 * The id of the event just written, when the class API answered it without one.
 *
 * On the QA iPhone simulator `calendar.createEvent(…)` resolved to an event
 * whose `id` was undefined (the app recorded `[null]` for every event it wrote),
 * so the link claim went out with no `eventId` and the server answered 400 every
 * time (QA v3, V3-F18-04). The event is found again by the address written on
 * it, in the range it was written for: the one id that was not there before the
 * write. The weekly blocks share one address, so "the only match" is not enough
 * on its own; it is the answer only when the earlier listing is missing. More
 * than one candidate is no answer — guessing is how a link names the wrong one.
 */
async function idOfNew(calendarId: string, draft: CalendarEventDraft, before: Set<string> | null): Promise<string> {
  const after = await idsAt(calendarId, draft);
  if (after === null) return '';
  const fresh = [...after].filter((id) => before === null || !before.has(id));
  return fresh.length === 1 ? fresh[0]! : '';
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
      // Listed first, so the event this call writes can be told from earlier
      // ones with the same address if the answer comes back without an id.
      const before = await idsAt(calendarId, draft);
      const event = (await calendar.createEvent(eventFrom(draft))) as unknown as Partial<NativeEvent>;
      const answered = textOf(event.id);
      if (answered !== '') return answered;
      const found = await idOfNew(calendarId, draft, before);
      if (found !== '') return found;
      // An event nothing can name cannot be claimed, updated or removed later:
      // take it back out now, through the object that still holds it.
      if (typeof event.delete === 'function') await event.delete();
      throw new DeviceCalendarError('unavailable', 'the calendar did not say which event it wrote');
    } catch (error) {
      throw failureFrom(error, 'unavailable');
    }
  },

  async updateEvent(eventId, draft, calendarId) {
    try {
      const event = await locate(eventId, calendarId);
      await event.update(eventFrom(draft));
    } catch (error) {
      throw failureFrom(error, 'not_found');
    }
  },

  async deleteEvent(eventId, calendarId) {
    try {
      const event = await locate(eventId, calendarId);
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
      const included = options.includedCalendarIds;
      const ids = calendars.map((calendar) => calendar.id)
        .filter((id) => (included ? included.has(id) : !excluded.has(id)));
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

  async findOwnEvents(calendarId, urlPrefix, from, to) {
    try {
      const byId = new Map<string, OwnCalendarEvent>();
      for (const event of await eventsIn(calendarId, from, to)) {
        const id = textOf(event.id);
        const url = textOf(event.url);
        // A recurring event comes back once per occurrence, under one id.
        if (id !== '' && url.startsWith(urlPrefix) && !byId.has(id)) byId.set(id, { id, url });
      }
      return [...byId.values()];
    } catch (error) {
      throw failureFrom(error, 'unavailable');
    }
  },

  async eventExists(eventId, calendarId) {
    try {
      await locate(eventId, calendarId);
      return true;
    } catch (error) {
      const failure = failureFrom(error, 'not_found');
      // A permission problem is not evidence that the event is gone, and
      // answering `false` to it is how the sync service would detach every link
      // on the day somebody revoked access in Settings.
      // Nor is a calendar that would not list, or an id that cannot be looked
      // up: only "not found" detaches, because detaching is permanent.
      if (failure.reason !== 'not_found') throw failure;
      return false;
    }
  },
};
