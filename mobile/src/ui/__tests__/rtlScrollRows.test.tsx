/**
 * Sideways rows in Arabic and Hebrew (first iPhone run, L7).
 *
 * Direction is style-only here (`src/i18n/README.md`): the root View sets
 * `direction: 'rtl'` and `I18nManager` is never flipped. A horizontal
 * ScrollView lays its content out left to right under that root, so the
 * category chips and the week strip read from the left in Arabic — "All" and
 * today on the wrong edge. `SetupLifeStep` already had the fix (reverse the
 * children, open scrolled to the end); it now lives in one component and both
 * rows use it.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { CategoryBar } from '../../features/commitments/CategoryBar';
import { CalendarScreen } from '../../screens/CalendarScreen';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import { DirectionalScrollRow } from '../directionalScroll';
import { Txt } from '../primitives';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function inLanguage(lang: 'ar' | 'he' | 'en', node: React.ReactElement) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  return render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider>{node}</AppProvider></SafeAreaProvider>);
}

const CHIPS = ['all', 'work', 'family'] as const;

describe('the category chips', () => {
  it.each([
    ['ar', ['family', 'work', 'all']],
    ['he', ['family', 'work', 'all']],
    ['en', ['all', 'work', 'family']],
  ] as ['ar' | 'he' | 'en', string[]][])('%s: "All" sits where reading starts', async (lang, order) => {
    await inLanguage(lang, <CategoryBar chips={CHIPS} selected="all" onSelect={() => {}} />);
    await waitFor(() => expect(screen.queryAllByTestId(/^category-chip-/).length).toBe(3));
    const ids = screen.getAllByTestId(/^category-chip-/).map(node => String(node.props.testID).replace('category-chip-', ''));
    expect(ids).toEqual(order);
  });

  it('a tap still selects the chip it names after the reversal', async () => {
    const onSelect = jest.fn();
    await inLanguage('ar', <CategoryBar chips={CHIPS} selected="all" onSelect={onSelect} />);
    await waitFor(() => expect(screen.queryByTestId('category-chip-work')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('category-chip-work'));
    expect(onSelect).toHaveBeenCalledWith('work');
  });
});

describe('the week strip', () => {
  async function showCalendar(lang: 'ar' | 'en') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const repository = createFakeAuthRepository({
      initialUser: { uid: 'rtl-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] },
    });
    setAuthRepository(repository);
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <AuthProvider repository={repository} isDevBundle={false}>
            <AppProvider>
              <CalendarScreen />
            </AppProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId(/^calendar-day-\d/).length).toBe(7));
    return screen.getAllByTestId(/^calendar-day-\d/).map(node => String(node.props.testID).replace('calendar-day-', ''));
  }

  it('ar: each day keeps its share of the week (the cells are flex: 1)', async () => {
    await showCalendar('ar');
    for (const cell of screen.getAllByTestId(/^calendar-day-\d/)) {
      let wrapper = cell.parent;
      while (wrapper && (wrapper.type !== 'View' || wrapper.props.testID === cell.props.testID)) wrapper = wrapper.parent;
      expect(StyleSheet.flatten(wrapper?.props.style)).toMatchObject({ flex: 1, direction: 'rtl' });
    }
  });

  it('ar: today is the last child, so it lands on the right', async () => {
    const days = await showCalendar('ar');
    expect(days).toEqual([...days].sort().reverse());
  });

  it('en: today is the first child, on the left', async () => {
    const days = await showCalendar('en');
    expect(days).toEqual([...days].sort());
  });
});

describe('DirectionalScrollRow', () => {
  it.each([
    ['ar', ['c', 'b', 'a'], 1],
    ['en', ['a', 'b', 'c'], 0],
  ] as ['ar' | 'en', string[], number][])('%s: order, and whether it opens at the end', async (lang, order, scrolls) => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => {});
    await inLanguage(lang, (
      <DirectionalScrollRow testID="row">
        {['a', 'b', 'c'].map(id => <Txt key={id} testID={`item-${id}`}>{id}</Txt>)}
      </DirectionalScrollRow>
    ));
    await waitFor(() => expect(screen.queryAllByTestId(/^item-/).length).toBe(3));
    expect(screen.getAllByTestId(/^item-/).map(node => String(node.props.testID).slice(-1))).toEqual(order);
    scrollToEnd.mockClear();
    await fireEvent(screen.getByTestId('row'), 'contentSizeChange', 600, 40);
    expect(scrollToEnd).toHaveBeenCalledTimes(scrolls);
  });
});

describe('a row that fits on screen, and one that does not (review I2)', () => {
  /*
   * Reversing and scrolling to the end only helps a row wider than the screen:
   * a short row cannot scroll, so its reversed chips would sit at the left.
   * Under RTL the content box is therefore laid out explicitly left to right
   * (one flip, not the root's plus the ScrollView's) and packed to the right
   * end, and each item gets its right-to-left direction back inside. Jest has
   * no layout, so this pins the style contract; the device check is owed.
   */
  const contentOf = () => StyleSheet.flatten(screen.getByTestId('row').props.contentContainerStyle) as Record<string, unknown>;

  it('ar, three short chips: packed to the right edge, each item still right-to-left', async () => {
    await inLanguage('ar', (
      <DirectionalScrollRow testID="row" contentContainerStyle={{ gap: 8 }}>
        {['a', 'b', 'c'].map(id => <Txt key={id} testID={`item-${id}`}>{id}</Txt>)}
      </DirectionalScrollRow>
    ));
    await waitFor(() => expect(screen.queryAllByTestId(/^item-/).length).toBe(3));
    expect(contentOf()).toMatchObject({ gap: 8, flexGrow: 1, justifyContent: 'flex-end', direction: 'ltr' });
    for (const id of ['a', 'b', 'c']) {
      // The nearest host View above the item is its wrapper.
      let wrapper = screen.getByTestId(`item-${id}`).parent;
      while (wrapper && (wrapper.type !== 'View' || wrapper.props.testID === `item-${id}`)) wrapper = wrapper.parent;
      expect(StyleSheet.flatten(wrapper?.props.style)).toMatchObject({ direction: 'rtl' });
    }
  });

  it('ar, a row wider than the screen: the same box, opened at its end', async () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => {});
    const ids = Array.from({ length: 12 }, (_, n) => `chip${n}`);
    await inLanguage('ar', (
      <DirectionalScrollRow testID="row">
        {ids.map(id => <Txt key={id} testID={`item-${id}`}>{id}</Txt>)}
      </DirectionalScrollRow>
    ));
    await waitFor(() => expect(screen.queryAllByTestId(/^item-/).length).toBe(12));
    expect(contentOf()).toMatchObject({ flexGrow: 1, justifyContent: 'flex-end', direction: 'ltr' });
    scrollToEnd.mockClear();
    await fireEvent(screen.getByTestId('row'), 'contentSizeChange', 2400, 40);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId(/^item-/)[0]!.props.testID).toBe('item-chip11');
  });

  it('en: left alone — no forced direction, no packing', async () => {
    await inLanguage('en', (
      <DirectionalScrollRow testID="row" contentContainerStyle={{ gap: 8 }}>
        {['a', 'b'].map(id => <Txt key={id} testID={`item-${id}`}>{id}</Txt>)}
      </DirectionalScrollRow>
    ));
    await waitFor(() => expect(screen.queryAllByTestId(/^item-/).length).toBe(2));
    expect(contentOf()).toEqual({ gap: 8 });
  });
});
