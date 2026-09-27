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
import { ContextualAssistantScreen } from '../ContextScreens';
import { strings } from '../../../i18n/strings';
import base from '../../../api/__fixtures__/commitments.one.json';

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

afterEach(() => { cleanup(); mockToday = []; mockUpcoming = []; });

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
