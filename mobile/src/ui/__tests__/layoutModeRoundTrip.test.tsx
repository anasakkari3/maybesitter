/**
 * Default → AX5 → default lays a mode-switching row out as a fresh open does
 * (simulator 2026-10-23, Q-LIVE-001).
 *
 * Yoga on Fabric keeps a node's computed flex basis across a style change and
 * recomputes a `flex`/`flexBasis` one only while that cache is empty, so a
 * node that came back to `flex: 1` kept the basis of the stacked layout — the
 * tab items their AX5 third of the bar. Jest cannot run Yoga, so what is held
 * here is the style each node commits: after the round trip it is exactly the
 * fresh one, and in the row layout it never carries a `flex` basis — it says
 * `flex: 1` as `fillRow` (grow 1, shrink 0, zero `width`) or, inside a
 * horizontal scroll, `growFromContent` (theme/textScale), whose bases Yoga
 * recomputes on every layout.
 *
 * Real `useWindowDimensions` and `Dimensions.set`, as in
 * understoodLiveTextScale.test; the default reading is restored after each test.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { CalendarScreen } from '../../screens/CalendarScreen';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import { SettingsHeader } from '../../features/settings/SettingsChrome';
import { ProductRow, ProductSection } from '../product';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);

const AX5 = 3.12;
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  setFontScale(1);
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

type Style = Record<string, unknown>;
const flat = (node: { props: { style?: unknown } }) => (StyleSheet.flatten(node.props.style as never) ?? {}) as Style;

/** A row layout's growing node: `flex: 1` without a `flex` basis. */
function expectNoFlexBasis(style: Style) {
  expect(style.flex).toBeUndefined();
  expect(style.flexBasis).toBeUndefined();
}
function expectFillRow(style: Style) {
  expect(style).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 0, width: 0 }));
  expectNoFlexBasis(style);
}

/** Captures `read()` fresh, at AX5 and back at the default size. */
async function roundTrip<T>(read: () => T): Promise<{ fresh: T; ax5: T; back: T }> {
  const fresh = read();
  await act(async () => { setFontScale(AX5); });
  const ax5 = read();
  await act(async () => { setFontScale(1); });
  return { fresh, ax5, back: read() };
}

async function inApp(node: React.ReactElement, lang: 'ar' | 'en' = 'ar') {
  setFontScale(1);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  return render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider>{node}</AppProvider></SafeAreaProvider>);
}

describe('SettingsHeader', () => {
  it('its title box is back to the fresh row layout after default → AX5 → default', async () => {
    await inApp(<SettingsHeader title="Notifications" onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Notifications')).not.toBeNull());
    const header = screen.getByTestId('back-header');
    const titleBox = () => flat(screen.getByText('Notifications').parent!);
    const { fresh, ax5, back } = await roundTrip(() => ({ header: flat(screen.getByTestId('back-header')), title: titleBox() }));
    expect(fresh.header.flexDirection).toBe('row');
    expectFillRow(fresh.title);
    expect(ax5.header.flexDirection).toBe('column');
    expect(ax5.title.width).toBeUndefined();
    expect(back).toEqual(fresh);
    expect(screen.getByTestId('back-header')).toBe(header);
  });
});

describe('ProductRow and ProductSection', () => {
  it('a row\'s words take the fresh row layout after default → AX5 → default, and the row stays mounted', async () => {
    await inApp(<ProductSection title="Section" icon="spark">
      <ProductRow id="product-row" title="Row title" body="Row body" onPress={() => {}} />
    </ProductSection>);
    await waitFor(() => expect(screen.queryByTestId('product-row')).not.toBeNull());
    const row = screen.getByTestId('product-row');
    const read = () => ({
      row: flat(screen.getByTestId('product-row')).flexDirection,
      words: flat(screen.getByText('Row title').parent!),
      section: flat(screen.getByText('Section').parent!),
    });
    const { fresh, ax5, back } = await roundTrip(read);
    expect(fresh.row).toBe('row');
    expectFillRow(fresh.words);
    expectFillRow(fresh.section);
    expect(ax5.row).toBe('column');
    expect(ax5.words.width).toBeUndefined();
    expect(ax5.section).toEqual(expect.objectContaining({ alignSelf: 'stretch' }));
    expect(ax5.section.width).toBeUndefined();
    expect(back).toEqual(fresh);
    expect(screen.getByTestId('product-row')).toBe(row);
  });
});

describe('the calendar week strip', () => {
  async function showCalendar(lang: 'ar' | 'en') {
    setFontScale(1);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const repository = createFakeAuthRepository({
      initialUser: { uid: 'strip-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] },
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
  }

  /** Each day cell's style, and under RTL the style of the wrapper that holds its share. */
  function cells() {
    return screen.getAllByTestId(/^calendar-day-\d/).map((cell) => {
      let wrapper = cell.parent;
      while (wrapper && (wrapper.type !== 'View' || wrapper.props.testID === cell.props.testID)) wrapper = wrapper.parent;
      return { id: String(cell.props.testID), cell: flat(cell), wrapper: flat(wrapper!) };
    });
  }

  it.each(['ar', 'en'] as const)('%s: seven cells, each back to its fresh share after default → AX5 → default', async (lang) => {
    await showCalendar(lang);
    const { fresh, ax5, back } = await roundTrip(cells);
    expect(fresh).toHaveLength(7);
    for (const { cell, wrapper } of fresh) {
      // Grows from its content, as `flex: 1` does in a horizontal scroll —
      // never a `flex` basis the stacked 88 pt could leave behind.
      expect(cell).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 0 }));
      expect(cell.width).toBeUndefined();
      expectNoFlexBasis(cell);
      if (lang === 'ar') {
        expect(wrapper).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 0, direction: 'rtl' }));
        expectNoFlexBasis(wrapper);
      }
    }
    for (const { cell } of ax5) {
      expect(cell.width).toBe(88);
      expect(cell.flexGrow).toBeUndefined();
    }
    expect(back).toEqual(fresh);
  });
});
