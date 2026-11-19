/**
 * «فاضي» never says two opposite things at once (CA4.2 / CXA4.4).
 *
 * A fully known day with nothing on it and no 30-minute gap left (today after
 * 21:30 with the 08:00–22:00 window) drew «اليوم كله فاضي» and, right under
 * it, «ما في وقت فاضي هاليوم» (seen at 22:48 on a fresh account). With no gap
 * left the day is not free: only the second line is true.
 */
import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { AppProvider } from '../../../state/AppContext';
import { FreeList } from '../FreeTimeRows';

async function show(gaps: { start: string; end: string }[], empty: boolean) {
  await render(<AppProvider><FreeList day="2026-11-12" gaps={gaps} state="full" empty={empty} /></AppProvider>);
}

describe('the free list on an empty day', () => {
  it('with no gap left says only that there is no free time', async () => {
    await show([], true);
    expect(screen.queryByTestId('calendar-free-none')).not.toBeNull();
    expect(screen.queryByTestId('calendar-free-all')).toBeNull();
  });

  it('with its gaps still ahead says the day is free', async () => {
    await show([{ start: '2026-11-12T18:00:00.000Z', end: '2026-11-12T20:00:00.000Z' }], true);
    expect(screen.queryByTestId('calendar-free-all')).not.toBeNull();
    expect(screen.queryByTestId('calendar-free-none')).toBeNull();
  });
});
