/**
 * «أشيائي» follows a text-size change made while it is open (simulator
 * 2026-10-24, shots 61b, 62 and 63).
 *
 * Growing to AX5 the «آخر ما حفظته» heading and the recent rows' titles were
 * slivers; back at the default size they left a 207 pt gap and 403 pt rows.
 * Nothing about those words changes with the scale, so native kept the old
 * measurement. The heading is said by a view that stays (`HubHeading`,
 * `SaidWords`, still a header for the rotor); the rows' words are replaced
 * by each row's own boundary (`Btn`), the rows stay.
 *
 * Round trip: the heading's box (its direction switches with the mode) and
 * the rows commit what a fresh open commits, with no `flex` basis.
 *
 * Real `useWindowDimensions` and `Dimensions.set`; the default reading is
 * restored after each test.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as habitEndpoints from '../../../api/endpoints/habits';
import * as seedEndpoints from '../../../api/endpoints/seeds';
import one from '../../../api/__fixtures__/commitments.one.json';
import { ThingsScreen } from '../ThingsScreen';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);

const AX5 = 3.12;
const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'things-live-user', email: 'a@b.c', emailVerified: true, displayName: 'Lina', providerIds: ['password'] };

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

const commitment = (id: string, title: string, createdAt: string) => ({
  ...one, id, title, createdAt, status: 'active',
  timeSpec: { ...one.timeSpec, dueAt: '2099-01-01T09:00:00.000Z', remindAt: null },
});

let client: QueryClient;

beforeEach(async () => {
  setFontScale(1);
  await AsyncStorage.clear();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [
    commitment('c-old', 'Renew passport', '2026-09-01T08:00:00.000Z'),
  ] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [
    commitment('c-new', 'Call the dentist', '2026-09-30T08:00:00.000Z'),
  ] } as never);
  jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue({ items: [], suggestions: [], adaptive: null } as never);
  jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([] as never);
  jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({ items: [] } as never);
});

afterEach(async () => {
  await cleanup();
  setFontScale(1);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

type Host = ReturnType<typeof screen.getByTestId>;
type Style = Record<string, unknown>;
const flat = (node: Host | null) => (StyleSheet.flatten(node?.props.style) ?? {}) as Style;
const drawnIn = (id: string) => within(screen.getByTestId(id)).getAllByText(/./, { includeHiddenElements: true });

async function show() {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  const repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><ThingsScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('things-recent-c-new')).not.toBeNull());
}

const ROWS = ['things-recent-c-new', 'things-recent-c-old', 'things-commitments', 'things-goals', 'things-habits', 'things-ideas'];

describe('«أشيائي» after a live text-size change', () => {
  it('the heading is said by a view that stays (a header); every drawn paragraph in it and in the rows is new, the rows the same', async () => {
    await show();
    const said = screen.getByTestId('things-recent-title-said');
    expect(said.props.accessible).toBe(true);
    expect(said.props.accessibilityRole).toBe('header');
    expect(said.props.accessibilityLabel).toBe(screen.getByTestId('things-recent-title').props.children);
    expect(screen.getByTestId('things-recent-title').props.accessible).toBe(false);
    // The rotor still finds it as a heading, by its words.
    expect(screen.getByRole('header', { name: screen.getByTestId('things-recent-title').props.children })).toBe(said);

    const kept = [said, ...ROWS.map((id) => screen.getByTestId(id)), screen.getByTestId('things-search')];
    const regions = ['things-recent-title-said', ...ROWS];
    let drawn = regions.flatMap(drawnIn);
    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      const next = regions.flatMap(drawnIn);
      expect(next).toHaveLength(drawn.length);
      for (const node of next) expect(drawn).not.toContain(node);
      const now = [screen.getByTestId('things-recent-title-said'), ...ROWS.map((id) => screen.getByTestId(id)), screen.getByTestId('things-search')];
      kept.forEach((node, i) => expect(now[i]).toBe(node));
      drawn = next;
    }
  });

  it('default → AX5 → default: the heading\'s box and the rows commit what a fresh open commits, with no flex basis', async () => {
    await show();
    const headingBox = () => flat(screen.getByTestId('things-recent-title-said').parent?.parent ?? null);
    const read = () => ({
      heading: headingBox(),
      said: flat(screen.getByTestId('things-recent-title-said')),
      ...Object.fromEntries(ROWS.map((id) => [id, flat(screen.getByTestId(id))])),
    }) as Record<string, Style>;
    const fresh = read();
    expect(fresh.heading!.flexDirection).toBe('row');
    await act(async () => { setFontScale(AX5); });
    const ax5 = read();
    expect(ax5.heading!.flexDirection).toBe('column');
    await act(async () => { setFontScale(1); });
    expect(read()).toEqual(fresh);
    for (const at of [fresh, ax5]) for (const style of Object.values(at)) {
      expect(style.flex).toBeUndefined();
      expect(style.flexBasis).toBeUndefined();
    }
  });
});
