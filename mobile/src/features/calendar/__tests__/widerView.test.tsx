/**
 * The 4-week view's weekday header (M4a design critique, M4A-R3-REV-004).
 *
 * Every cell already says its full date to a screen reader, so the header is
 * for the eye only. `importantForAccessibility` hides it on Android alone;
 * VoiceOver reads each weekday unless the container is also hidden on iOS
 * (`accessibilityElementsHidden`). RNTL treats either one as hidden, so the
 * iOS property is asserted directly.
 */
import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { WiderView, type WiderCell } from '../WiderView';

/** 2030-03-04 is a Monday. */
const KEYS = Array.from({ length: 28 }, (_, i) => {
  const day = new Date(Date.UTC(2030, 2, 4 + i));
  return day.toISOString().slice(0, 10);
});

const CELLS: WiderCell[] = KEYS.map((key) => ({
  key,
  count: 0,
  free: { state: 'unknown', gaps: [], totalMinutes: null },
  googleUncovered: false,
  windowMinutes: 16 * 60,
}));

async function renderIn(lang: 'en' | 'ar') {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  await render(
    <AppProvider>
      <WiderView cells={CELLS} todayKey={KEYS[0]!} selectedKey={KEYS[0]!} googleNote={null} onPick={() => {}} onClose={() => {}} />
    </AppProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('calendar-wider-weekdays', { includeHiddenElements: true })).toBeTruthy());
}

describe('the weekday header', () => {
  it('is hidden from VoiceOver as well as TalkBack', async () => {
    await renderIn('en');
    const header = screen.getByTestId('calendar-wider-weekdays', { includeHiddenElements: true });
    expect(header.props.accessibilityElementsHidden).toBe(true);
    expect(header.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(screen.queryByText('Mon')).toBeNull();
  });

  it("names each column's weekday, starting from the first cell", async () => {
    await renderIn('en');
    const header = screen.getByTestId('calendar-wider-weekdays', { includeHiddenElements: true });
    const names = screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/, { includeHiddenElements: true })
      .filter((node) => {
        for (let up = node.parent; up; up = up.parent) if (up === header) return true;
        return false;
      })
      .map((node) => node.props.children);
    expect(names).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });
});
