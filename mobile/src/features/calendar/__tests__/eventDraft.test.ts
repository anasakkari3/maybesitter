/**
 * One commitment, as a calendar entry (UC-3.1, #185).
 *
 * The four shapes, and the three ways the mapping could be quietly wrong: an
 * all-day entry on the wrong day, an all-day entry with no width, and an
 * undated commitment given an hour nobody chose.
 *
 * Every case runs under `withHermesIntl`. `draftFor` is the only new caller of
 * `offsetMinutes`, and the defect that helper exists for — Hermes reporting a
 * zone offset in parts Node does not — is invisible on the host's `Intl`. An
 * all-day test that passed on Node and put somebody's day off on the wrong date
 * on their phone is exactly the failure #382 and the 2026-09-14 audit describe.
 *
 * The zone is `Pacific/Chatham`: +12:45 in winter, +13:45 in summer. It is
 * chosen because no host this suite runs on is set to it, because its offset is
 * not a whole hour — so arithmetic that silently rounds to the hour fails — and
 * because a day there begins twelve hours away from UTC, so "midnight" is never
 * accidentally right.
 */
import { describe, expect, it } from '@jest/globals';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { DEFAULT_MINUTES, EVENT_NOTES, contentHashOf, draftFor } from '../eventDraft';
import type { Commitment } from '../../../api/schemas/common';

const CHATHAM = 'Pacific/Chatham';
/** The device's zone, deliberately different from every commitment's below. */
const DEVICE = 'America/New_York';

function commitment(timeSpec: Partial<Commitment['timeSpec']>, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'cmt-1',
    kind: 'task',
    title: 'Dentist',
    description: null,
    person: null,
    status: 'active',
    category: null,
    categorySource: 'inferred',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: {
      kind: 'due_by',
      dueAt: null,
      endAt: null,
      remindAt: null,
      allDay: false,
      timezone: CHATHAM,
      ...timeSpec,
    },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    confirmedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

describe('the four shapes', () => {
  it('gives a commitment with only a start a block of its own, not a point', () => {
    const start = '2026-06-15T02:00:00.000Z';
    const draft = withHermesIntl(() => draftFor(commitment({ dueAt: start }), DEVICE));
    expect(draft?.allDay).toBe(false);
    expect(draft?.startDate.toISOString()).toBe(start);
    // A calendar cannot draw a point: an event whose end equals its start is
    // either invisible or given an arbitrary width by the OS.
    expect(draft!.endDate.getTime() - draft!.startDate.getTime()).toBe(DEFAULT_MINUTES * 60_000);
  });

  it('gives a range exactly its own end, not the default block', () => {
    const draft = withHermesIntl(() => draftFor(
      commitment({ dueAt: '2026-06-15T02:00:00.000Z', endAt: '2026-06-15T04:30:00.000Z' }),
      DEVICE,
    ));
    expect(draft?.endDate.toISOString()).toBe('2026-06-15T04:30:00.000Z');
    expect(draft!.endDate.getTime() - draft!.startDate.getTime()).not.toBe(DEFAULT_MINUTES * 60_000);
  });

  it('puts an all-day entry on the day the user is in, not the day UTC is in', () => {
    // 2026-06-15T23:00Z is already the 16th in Chatham (+12:45) and still the
    // 15th in New York. The entry belongs on the 16th.
    const draft = withHermesIntl(() => draftFor(
      commitment({ dueAt: '2026-06-15T23:00:00.000Z', allDay: true }),
      DEVICE,
    ));
    expect(draft?.allDay).toBe(true);
    const localDay = (instant: Date) => new Intl.DateTimeFormat('en-CA', {
      timeZone: CHATHAM, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(instant);
    expect(localDay(draft!.startDate)).toBe('2026-06-16');
    // Midnight to midnight: one whole day wide, and the end is the *next*
    // midnight rather than the same instant.
    expect(draft!.endDate.getTime() - draft!.startDate.getTime()).toBe(24 * 60 * 60_000);
  });

  it('writes nothing at all for a commitment with no time', () => {
    expect(withHermesIntl(() => draftFor(commitment({ kind: 'unscheduled' }), DEVICE))).toBeNull();
  });
});

describe('what the entry says', () => {
  it('uses the commitment title untranslated, and says who added it', () => {
    const draft = withHermesIntl(() => draftFor(
      commitment({ dueAt: '2026-06-15T02:00:00.000Z' }, { title: 'موعد الدكتور' }),
      DEVICE,
    ));
    expect(draft?.title).toBe('موعد الدكتور');
    expect(draft?.notes).toBe(EVENT_NOTES);
  });

  it('points back at the commitment it came from', () => {
    const draft = withHermesIntl(() => draftFor(
      commitment({ dueAt: '2026-06-15T02:00:00.000Z' }, { id: 'a b/c' }),
      DEVICE,
    ));
    expect(draft?.url).toBe('maybesitter://commitments/a%20b%2Fc');
  });

  it('keeps the commitment’s own zone, not the phone’s', () => {
    const draft = withHermesIntl(() => draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z' }), DEVICE));
    // A commitment made in one place is at that hour there, whatever airport
    // its owner reads it in.
    expect(draft?.timeZone).toBe(CHATHAM);
  });

  it('falls back to the device zone only when the commitment carries none', () => {
    const draft = withHermesIntl(() => draftFor(
      commitment({ dueAt: '2026-06-15T02:00:00.000Z', timezone: '' }),
      DEVICE,
    ));
    expect(draft?.timeZone).toBe(DEVICE);
  });
});

describe('across a clock change', () => {
  /**
   * Chatham moves from +13:45 to +12:45 on 2026-04-05, and back on 2026-09-27.
   * An all-day entry on the day of a transition is the case where "add 24 hours
   * to midnight" gives 23:00 or 01:00 and the entry either loses an hour off
   * its day or spills into the next one.
   */
  it('gives the day of a clock change a whole day, not 23 or 25 hours', () => {
    for (const day of ['2026-04-04T20:00:00.000Z', '2026-09-26T20:00:00.000Z']) {
      const draft = withHermesIntl(() => draftFor(commitment({ dueAt: day, allDay: true }), DEVICE));
      const localMidnight = (instant: Date) => new Intl.DateTimeFormat('en-GB', {
        timeZone: CHATHAM, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(instant);
      expect(`${day}:start:${localMidnight(draft!.startDate)}`).toBe(`${day}:start:00:00`);
      expect(`${day}:end:${localMidnight(draft!.endDate)}`).toBe(`${day}:end:00:00`);
      // And they are different days, so the entry has a width.
      expect(draft!.endDate.getTime()).toBeGreaterThan(draft!.startDate.getTime());
    }
  });
});

describe('an all-day span', () => {
  /**
   * `endAt` is exclusive, everywhere (#185).
   *
   * `defaultTimeSpec` fixes `[start, end)` — "a zero-length range is the empty
   * set" — which is the same convention `lib/planning/shared/time.ts` settled
   * for the whole product, and it is also the only convention `endAt` *can*
   * follow here: the domain refuses an end that is not strictly after its
   * start, so a one-day all-day commitment cannot say "ends on the day it
   * starts". Its only legal spelling is the next midnight.
   *
   * Reading that as the last *included* day therefore did not add a day to
   * multi-day spans only. It made the one encoding a one-day commitment is
   * allowed to have render as two days, while the same fact written with
   * `endAt: null` rendered as one — two spellings of one day, two different
   * entries in a calendar other people can see.
   */
  function localDay(instant: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: CHATHAM, dateStyle: 'short' }).format(instant);
  }

  /**
   * The instant local midnight of `day` falls at in Chatham, asked of the zone
   * rather than written down.
   *
   * Chatham is +12:45 for most of the year and +13:45 under daylight saving,
   * and the first draft of these cases hard-coded the wrong one — the dates
   * below then named the evening before and the span still counted three days,
   * so the arithmetic looked right while every boundary was off by one. A
   * literal offset in a fixture is a second, silent claim about the zone.
   */
  function localMidnight(day: string): string {
    const naive = Date.parse(`${day}T00:00:00.000Z`);
    const offsetAt = (epochMs: number): number => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CHATHAM, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(epochMs));
      const at = (type: string) => Number(parts.find((part) => part.type === type)!.value);
      return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second')) - epochMs;
    };
    // Resolved against the offset at the answer rather than at the guess, the
    // same two steps `startOfLocalDay` takes for the same reason.
    return new Date(naive - offsetAt(naive - offsetAt(naive))).toISOString();
  }

  const SEP20 = localMidnight('2026-09-20');
  const SEP21 = localMidnight('2026-09-21');
  const SEP23 = localMidnight('2026-09-23');

  function span(dueAt: string, endAt: string | null) {
    const draft = withHermesIntl(() => draftFor(commitment({ dueAt, endAt, allDay: true }), DEVICE))!;
    return {
      from: localDay(draft.startDate),
      to: localDay(draft.endDate),
      days: Math.round((draft.endDate.getTime() - draft.startDate.getTime()) / 86_400_000),
      hash: draft.contentHash,
    };
  }

  it('agrees with the zone about which day each instant is', () => {
    // The fixture checking itself: if `localMidnight` were wrong, every case
    // below would be about the evening before and would still look plausible.
    expect(localDay(new Date(SEP20))).toBe('2026-09-20');
    expect(localDay(new Date(SEP23))).toBe('2026-09-23');
  });

  it('reads one day written as a range exactly like one day written with no end', () => {
    const asRange = span(SEP20, SEP21);
    const asNoEnd = span(SEP20, null);
    expect(asRange.days).toBe(1);
    expect(asRange).toEqual(asNoEnd);
    // Same fact, same entry, therefore the same hash — so switching between the
    // two spellings never rewrites the event and never notifies a shared
    // calendar about a change that did not happen.
    expect(asRange.hash).toBe(asNoEnd.hash);
  });

  it('covers exactly the days between the start and the exclusive end', () => {
    // 20th and 21st and 22nd, ending at the 23rd's midnight.
    const three = span(SEP20, SEP23);
    expect(three.days).toBe(3);
    expect(three.from).toBe('2026-09-20');
    expect(three.to).toBe('2026-09-23');
  });

  it('is a fact the entry actually carries, so a longer span is a different event', () => {
    // The mutation this kills: ignoring `endAt` in the all-day branch. Every
    // all-day case in this file used to pass `endAt: null`, so dropping the
    // field entirely left the whole suite green.
    expect(span(SEP20, SEP23).hash).not.toBe(span(SEP20, SEP21).hash);
  });

  it('never collapses to nothing, whatever the stored end says', () => {
    // An end inside the first day cannot describe a day. It is not reachable
    // through the domain, which refuses an all-day end that is not a midnight,
    // but a calendar entry with no width is invisible on both platforms and is
    // not a thing to render from a record nobody can explain.
    const sameDayAfternoon = new Date(Date.parse(SEP20) + 12 * 60 * 60 * 1000).toISOString();
    expect(span(SEP20, sameDayAfternoon).days).toBe(1);
  });
});

describe('the content hash', () => {
  it('is the same for the same entry, so an unchanged event is not rewritten', () => {
    const first = withHermesIntl(() => draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z' }), DEVICE));
    const again = withHermesIntl(() => draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z' }), DEVICE));
    expect(first?.contentHash).toBe(again?.contentHash);
  });

  it('changes when anything the calendar can see changes', () => {
    const base = withHermesIntl(() => draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z' }), DEVICE))!;
    const variants = [
      draftFor(commitment({ dueAt: '2026-06-15T03:00:00.000Z' }), DEVICE),
      draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z', endAt: '2026-06-15T05:00:00.000Z' }), DEVICE),
      draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z', allDay: true }), DEVICE),
      draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z' }, { title: 'Dentist again' }), DEVICE),
    ].map((draft) => withHermesIntl(() => draft));
    for (const variant of variants) {
      expect(variant!.contentHash).not.toBe(base.contentHash);
    }
  });

  it('does not change when something the calendar cannot see changes', () => {
    const base = withHermesIntl(() => draftFor(commitment({ dueAt: '2026-06-15T02:00:00.000Z' }), DEVICE))!;
    const edited = withHermesIntl(() => draftFor(
      commitment({ dueAt: '2026-06-15T02:00:00.000Z', remindAt: '2026-06-15T01:00:00.000Z' }, {
        description: 'ask about the filling',
        priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
      }),
      DEVICE,
    ))!;
    // Rewriting the event for a priority change would notify everybody who
    // shares the calendar, about nothing.
    expect(edited.contentHash).toBe(base.contentHash);
  });

  /**
   * FNV-1a, done in 32-bit arithmetic.
   *
   * `Math.imul` is load-bearing and `*` looks identical: the product of a
   * 32-bit hash and the FNV prime exceeds 2^53 by the third character, so `*`
   * silently starts doing float maths and the low bits are lost. The result is
   * still a hash and still stable, so nothing looks wrong — every event would
   * simply be compared against a digest computed by a different function than
   * the one that wrote it, and the mismatch would be permanent.
   *
   * A golden value is the only thing that catches it, because both versions are
   * deterministic and both differ for any two different inputs. `'a'` and
   * `'ab'` agree between the two — the overflow has not happened yet — so the
   * case is stated at a length where it has.
   */
  it('is FNV-1a in 32-bit arithmetic, not in floating point', () => {
    expect(contentHashOf(['MaybeSitter'])).toBe('dd87b580');
    expect(contentHashOf(['Added by MaybeSitter.'])).toBe('d5cec6a5');
    // And it is still a hash: eight hex digits, and different for different
    // inputs at a length no title will reach.
    const long = 'x'.repeat(5000);
    expect(contentHashOf([long])).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHashOf([long])).not.toBe(contentHashOf([`${long}y`]));
  });
});
