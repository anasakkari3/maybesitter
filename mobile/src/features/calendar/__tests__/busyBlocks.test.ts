/**
 * The one function in this app that ever touches a calendar event (UC-3.2, #186).
 *
 * ── Why this file is a privacy test before it is a scheduling test ──
 *
 * UC-3.1 (#185) could promise that no event title reached this app because the
 * platform enforced it: the app wrote events and asked "is this one still
 * there", and nothing else. Reading busy time changes that. `expo-calendar`
 * hands whole events to JavaScript — title, notes, location, the attendee list
 * — and the only thing standing between "you are busy at 14:00" and "you are at
 * Oncology with Dr Haddad" is that this function keeps four fields and drops
 * everything else.
 *
 * So the first test asserts the *key set* of the output rather than the absence
 * of a field somebody remembered. A test for `expect(block.title).toBeUndefined()`
 * passes for `location` too, right up until the day it doesn't.
 *
 * ── Recurring instances share an id ──────────────────────────────
 *
 * On iOS every occurrence of a weekly event comes back with the same `id`. A
 * mapper that deduplicated on the id alone would turn a weekly lecture into one
 * block and let the planner schedule work during every other week of term. The
 * identity of a block is therefore the pair (id, start), which is also what
 * makes the server's `blockId` hash — source, native id, start — collision-free.
 *
 * ── The clock ────────────────────────────────────────────────────
 *
 * Every instant here is derived from the `now` the test passes in, which is
 * derived from the clock this process is running on. A fixture pinned to a
 * literal is a fixture that means something different in another zone, and this
 * suite runs in both the developer's zone and CI's UTC.
 */
import { describe, expect, it } from '@jest/globals';
import {
  BUSY_BLOCK_KEYS,
  OWN_EVENT_URL_PREFIX,
  toBusyBlocks,
  type CalendarEventLike,
} from '../busyBlocks';

const NOW = new Date();
const MINUTE = 60_000;

/** `at(90)` — ninety minutes from now, the way a calendar reports it. */
function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * MINUTE).toISOString();
}

/**
 * An event shaped the way `expo-calendar` actually hands one over.
 *
 * With a title, notes, a location and an attendee list, because an event
 * without them would make every assertion below vacuous: the point is not that
 * the mapper copies nothing, it is that it copies nothing *of these*.
 */
function event(over: Partial<CalendarEventLike> = {}): CalendarEventLike {
  return {
    id: 'evt-1',
    title: 'Oncology — Dr Haddad',
    notes: 'Bring the referral letter and last month\'s blood work.',
    location: 'Rambam, floor 4',
    organizer: { name: 'Dr Haddad', email: 'haddad@example.org' },
    calendarId: 'cal-1',
    timeZone: 'Asia/Jerusalem',
    startDate: at(60),
    endDate: at(120),
    allDay: false,
    availability: 'busy',
    status: 'confirmed',
    ...over,
  } as CalendarEventLike;
}

function map(events: CalendarEventLike[], over: Partial<Parameters<typeof toBusyBlocks>[1]> = {}) {
  return toBusyBlocks(events, { ownEventIds: new Set(), declinedEventIds: new Set(), now: NOW, ...over });
}

/* ── The allowlist ───────────────────────────────────────────────── */

describe('nothing but start, end and all-day leaves this function', () => {
  it('produces exactly the four allowed keys, whatever the event carried', () => {
    const [block] = map([event()]);
    expect(Object.keys(block!).sort()).toEqual([...BUSY_BLOCK_KEYS].sort());
  });

  it('keeps no title, notes, location, organizer or attendee under any name', () => {
    const [block] = map([event()]);
    const serialised = JSON.stringify(block);
    for (const secret of ['Oncology', 'Haddad', 'referral', 'Rambam', 'haddad@example.org']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('drops a field the platform adds tomorrow, because the allowlist is positive', () => {
    const [block] = map([event({ conferenceUrl: 'https://meet.example.org/abc' } as Partial<CalendarEventLike>)]);
    expect(Object.keys(block!).sort()).toEqual([...BUSY_BLOCK_KEYS].sort());
  });

  it('carries the times and the all-day flag through unchanged', () => {
    const [block] = map([event({ startDate: at(60), endDate: at(120) })]);
    expect(block).toEqual({ nativeId: 'evt-1', startAt: at(60), endAt: at(120), allDay: false });
  });

  it('accepts a Date as well as a string, because the platforms differ', () => {
    const [block] = map([event({ startDate: new Date(NOW.getTime() + 60 * MINUTE), endDate: at(120) })]);
    expect(block!.startAt).toBe(at(60));
  });
});

/* ── What is not busy ────────────────────────────────────────────── */

describe('the events that are not somebody being busy', () => {
  it('skips an event this app wrote, so a commitment does not collide with itself', () => {
    expect(map([event({ id: 'ours' })], { ownEventIds: new Set(['ours']) })).toEqual([]);
  });

  it('skips one this app wrote on iOS, recognised by its url', () => {
    expect(map([event({ url: `${OWN_EVENT_URL_PREFIX}cmt-7` })])).toEqual([]);
  });

  it('keeps an event whose url points somewhere else entirely', () => {
    expect(map([event({ url: 'https://meet.example.org/abc' })])).toHaveLength(1);
  });

  it('skips an event marked free', () => {
    expect(map([event({ availability: 'free' })])).toEqual([]);
  });

  it('keeps a tentative event, because tentative is not free', () => {
    expect(map([event({ availability: 'tentative' })])).toHaveLength(1);
  });

  it('skips a cancelled event', () => {
    expect(map([event({ status: 'canceled' })])).toEqual([]);
  });

  it('skips one the user declined, where the platform can say so', () => {
    expect(map([event({ id: 'declined-1' })], { declinedEventIds: new Set(['declined-1']) })).toEqual([]);
  });

  it('skips an event that is already over', () => {
    expect(map([event({ startDate: at(-120), endDate: at(-60) })])).toEqual([]);
  });

  it('keeps an event that started before now and has not finished', () => {
    expect(map([event({ startDate: at(-30), endDate: at(30) })])).toHaveLength(1);
  });

  it('skips an event with no length, which blocks nothing', () => {
    expect(map([event({ startDate: at(60), endDate: at(60) })])).toEqual([]);
  });

  it('skips an event whose dates the platform could not give', () => {
    expect(map([event({ startDate: 'not a date' })])).toEqual([]);
    expect(map([event({ id: '' })])).toEqual([]);
  });
});

/* ── All-day ─────────────────────────────────────────────────────── */

describe('all-day entries', () => {
  it('keeps an all-day entry and says so, rather than dropping it', () => {
    const [block] = map([event({ allDay: true, startDate: at(0), endDate: at(60 * 24) })]);
    expect(block!.allDay).toBe(true);
  });

  it('keeps today\'s all-day entry even though it began before now', () => {
    expect(map([event({ allDay: true, startDate: at(-600), endDate: at(840) })])).toHaveLength(1);
  });
});

/* ── Recurrence ──────────────────────────────────────────────────── */

describe('a weekly event', () => {
  it('yields one block per occurrence even though iOS gives them all one id', () => {
    const weekly = [0, 7, 14, 21].map((days) => event({
      id: 'weekly-lecture',
      startDate: at(days * 24 * 60 + 600),
      endDate: at(days * 24 * 60 + 690),
    }));
    expect(map(weekly)).toHaveLength(4);
  });

  it('still collapses a true duplicate, which is the same event listed twice', () => {
    const twice = [event(), event()];
    expect(map(twice)).toHaveLength(1);
  });
});

/* ── Order ───────────────────────────────────────────────────────── */

it('answers in time order, so two syncs of one calendar are the same list', () => {
  const blocks = map([
    event({ id: 'c', startDate: at(300), endDate: at(330) }),
    event({ id: 'a', startDate: at(100), endDate: at(130) }),
    event({ id: 'b', startDate: at(200), endDate: at(230) }),
  ]);
  expect(blocks.map((block) => block.nativeId)).toEqual(['a', 'b', 'c']);
});
