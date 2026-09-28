/**
 * «سياق يومك» offers the next useful thing, never one whose time has passed
 * (UAT 2026-09-27, new defect 11).
 *
 * The literal repro: at 15:02 the screen offered «أحضّر الغداء · 27 سبتمبر
 * 14:00» — an active item timed an hour earlier — as the useful next step.
 * The screen sorted every active item by time and took the first, so the
 * earliest one always won, however long ago it was.
 *
 * A passed, still-active item is not hidden anywhere (#383: it stays on Today
 * until the user acts on it, and there is no "overdue" label). It is only not
 * presented here as what comes next.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { ContextualAssistantScreen, nextUsefulItem } from '../ContextScreens';
import { strings } from '../../../i18n/strings';
import { deviceTimeZone } from '../../../i18n/timezone';
import base from '../../../api/__fixtures__/commitments.one.json';
import { toViewModel } from '../../commitments/model';

const HOUR = 60 * 60 * 1000;
let mockToday: unknown[] = [];
let mockUpcoming: unknown[] = [];
const query = (read: () => unknown[]) => () => ({ data: { items: read() }, isPending: false, isFetching: false, error: null, refetch: jest.fn() });

jest.mock('../../../api/queries', () => ({
  useToday: () => query(() => mockToday)(),
  useUpcoming: () => query(() => mockUpcoming)(),
}));

function item(id: string, title: string, at: Date | null) {
  const iso = at ? at.toISOString() : null;
  return {
    ...base, id, title,
    timeSpec: { ...base.timeSpec, kind: at ? 'scheduled_event' : 'none', dueAt: iso, remindAt: iso },
  };
}

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const show = () => render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><ContextualAssistantScreen /></AppProvider></SafeAreaProvider>);

afterEach(async () => { await cleanup(); mockToday = []; mockUpcoming = []; });

describe('the next useful thing', () => {
  it('skips an item whose time passed an hour ago and offers the one still ahead', async () => {
    const now = Date.now();
    mockToday = [item('lunch', 'Make lunch', new Date(now - HOUR)), item('mum', 'Call mum', new Date(now + 2 * HOUR))];
    await show();
    expect(screen.queryByText(/Make lunch/)).toBeNull();
    expect(screen.getByText(/Call mum/)).toBeTruthy();
  });

  it('offers an item with no time over one whose time has passed', async () => {
    const now = Date.now();
    mockToday = [item('lunch', 'Make lunch', new Date(now - HOUR)), item('bill', 'Pay the bill', null)];
    await show();
    expect(screen.queryByText(/Make lunch/)).toBeNull();
    expect(screen.getByText(/Pay the bill/)).toBeTruthy();
  });

  it('still takes the soonest of the items ahead, across today and upcoming', async () => {
    const now = Date.now();
    mockToday = [item('later', 'Later today', new Date(now + 3 * HOUR))];
    mockUpcoming = [item('soon', 'Soon', new Date(now + HOUR)), item('later', 'Later today', new Date(now + 3 * HOUR))];
    await show();
    expect(screen.getByText(/Soon/)).toBeTruthy();
    expect(screen.queryByText(/Later today/)).toBeNull();
  });

  it('with only passed items, offers nothing — and says nothing is coming up, not that nothing exists', async () => {
    mockToday = [item('lunch', 'Make lunch', new Date(Date.now() - HOUR))];
    await show();
    expect(screen.queryByText(/Make lunch/)).toBeNull();
    const shown = Object.values(strings).filter(t => screen.queryAllByText(t.xNoContext).length > 0);
    expect(shown).toHaveLength(1);
    expect(screen.queryByTestId('assistant-detail')).toBeNull();
  });
});

/**
 * Review round 2, I-1: an all-day item's `dueAt` is its day's local midnight
 * (`timeSpec.allDay`), so reading it as an instant made it "passed" from
 * 00:00 — it vanished for the whole day it was due, and the screen said
 * nothing was coming. An all-day item is ahead until its day has ended. It
 * sorts by day: after that day's timed items, before any later day and before
 * items with no time.
 */
describe('all-day items are judged by their day, not their midnight', () => {
  const ZONE = 'Asia/Amman';
  const at = (local: string) => new Date(`${local}+03:00`).toISOString();
  function allDay(id: string, day: string) {
    const midnight = at(`${day}T00:00:00`);
    return { ...base, id, title: id, timeSpec: { ...base.timeSpec, kind: 'due_by', dueAt: midnight, remindAt: null, allDay: true, timezone: ZONE } };
  }
  function timed(id: string, local: string) {
    const iso = at(local);
    return { ...base, id, title: id, timeSpec: { ...base.timeSpec, kind: 'scheduled_event', dueAt: iso, remindAt: iso, allDay: false, timezone: ZONE } };
  }
  function untimed(id: string) {
    return { ...base, id, title: id, timeSpec: { ...base.timeSpec, kind: 'unscheduled', dueAt: null, remindAt: null, allDay: false, timezone: ZONE } };
  }
  const next = (items: unknown[], now: string) => nextUsefulItem(items as never, at(now), ZONE)?.id ?? null;

  it('offers an all-day item due today at 09:00', () => {
    expect(next([allDay('bill', '2026-09-27')], '2026-09-27T09:00:00')).toBe('bill');
  });

  it('still offers it at 23:30 the same day', () => {
    expect(next([allDay('bill', '2026-09-27')], '2026-09-27T23:30:00')).toBe('bill');
  });

  it('drops it once its day is over', () => {
    expect(next([allDay('bill', '2026-09-27')], '2026-09-28T00:10:00')).toBeNull();
  });

  /*
   * POLISH-MOBILE review m1: one rule for "past" on an all-day item — its day
   * has ended in its own zone — here and in `toViewModel`. A traveller in New
   * York at 20:00 on Sunday is at 03:00 Monday in Jerusalem: a Jerusalem
   * all-day item on Sunday is over, though the phone's day is still Sunday.
   */
  it('drops a traveller\u2019s all-day item once its day has ended in its own zone', () => {
    const sunday = { ...base, id: 'doctor', title: 'doctor', timeSpec: { ...base.timeSpec, kind: 'due_by', dueAt: '2026-09-26T21:00:00.000Z', remindAt: null, allDay: true, timezone: 'Asia/Jerusalem' } };
    const nySundayEvening = '2026-09-28T00:00:00.000Z';
    expect(nextUsefulItem([sunday] as never, nySundayEvening, 'America/New_York')).toBeUndefined();
    expect(toViewModel(sunday as never, nySundayEvening).isPast).toBe(true);
    // Still Sunday in Jerusalem (22:00): offered, and not past.
    expect(nextUsefulItem([sunday] as never, '2026-09-27T19:00:00.000Z', 'America/New_York')?.id).toBe('doctor');
  });

  it('offers an all-day item due tomorrow', () => {
    expect(next([allDay('trip', '2026-09-28')], '2026-09-27T15:00:00')).toBe('trip');
  });

  it("puts today's timed item still ahead first, then today's all-day, over a passed one", () => {
    const items = [timed('lunch', '2026-09-27T14:00:00'), allDay('bill', '2026-09-27'), timed('mum', '2026-09-27T17:00:00'), untimed('read')];
    expect(next(items, '2026-09-27T15:02:00')).toBe('mum');
    expect(next(items.filter(item => (item as { id: string }).id !== 'mum'), '2026-09-27T15:02:00')).toBe('bill');
  });

  it("puts today's all-day before tomorrow's timed item, and anything dated before an untimed one", () => {
    expect(next([untimed('read'), timed('dentist', '2026-09-28T09:00:00'), allDay('bill', '2026-09-27')], '2026-09-27T20:00:00')).toBe('bill');
    expect(next([untimed('read'), allDay('trip', '2026-09-28')], '2026-09-27T20:00:00')).toBe('trip');
  });

  it('on screen: an all-day item due today is shown, by its day, with no time', async () => {
    const zone = deviceTimeZone();
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    // The server's shape: that day's local midnight in the item's own zone.
    const midnight = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)));
    const offset = midnight.getTime() - Date.parse(new Date(midnight.toLocaleString('en-US', { timeZone: zone })).toString().replace(/GMT.*$/, 'GMT'));
    mockToday = [{ ...base, id: 'bill', title: 'Pay the bill', timeSpec: { ...base.timeSpec, kind: 'due_by', dueAt: new Date(midnight.getTime() + offset).toISOString(), remindAt: null, allDay: true, timezone: zone } }];
    await show();
    expect(screen.getByText(/Pay the bill/)).toBeTruthy();
    expect(Object.values(strings).filter(t => screen.queryAllByText(t.xNoContext).length > 0)).toHaveLength(0);
    // Its day, never its bookkeeping midnight as a time, and never the day before.
    expect(screen.queryAllByText(/\d{1,2}:\d{2}/)).toHaveLength(0);
    expect(screen.getByText(new RegExp(`\\b${+key.slice(8, 10)}\\b`))).toBeTruthy();
  });
});
