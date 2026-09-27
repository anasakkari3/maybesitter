/**
 * The watcher screen with a followed club on it (closure CL7), rendered from
 * the monitor list the server really emits for a club whose last fetch
 * failed (`backgroundActivity.footballRetrying.json`, recorded by
 * `tests/mobile/exportMobileApiFixtures.test.ts`).
 *
 *   - a provider that is down or out of quota is said in words, never silence;
 *   - deleting a followed club is "Stop following", and says the matches ahead
 *     come off the calendar;
 *   - the "more ways" list no longer offers flights or parcels.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import retrying from '../../../api/__fixtures__/backgroundActivity.footballRetrying.json';
import { BackgroundActivityScreen } from '../WatcherScreens';

const mockMutate = jest.fn();

jest.mock('../useWatchers', () => {
  const query = (data: unknown) => () => ({ data, isPending: false, isFetching: false, error: null, refetch: () => undefined });
  const mutation = () => () => ({ mutate: (...args: unknown[]) => mockMutate(...args), isPending: false, error: null });
  return {
    useBackgroundActivity: query(require('../../../api/__fixtures__/backgroundActivity.footballRetrying.json')),
    useBackgroundAttribution: query({ actions: [], orphanCount: 0 }),
    useWatcherAction: mutation(),
    useSetBackgroundActivityPaused: mutation(),
  };
});

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
afterEach(() => { cleanup(); mockMutate.mockClear(); });

async function show() {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><BackgroundActivityScreen /></AppProvider></SafeAreaProvider>);
  return Object.values(strings).find(t => screen.queryAllByText(t.xBackground).length > 0)!;
}

const WATCHER = retrying.monitors[0]!.watcherId;

it('a followed club whose data is unreachable says so, in words', async () => {
  const t = await show();
  expect(screen.getByTestId(`watch-retrying-${WATCHER}`)).toBeTruthy();
  expect(screen.getByText(t.xFootballRetrying)).toBeTruthy();
  // Not a "live" badge, and not "paused": neither is true.
  expect(screen.queryByTestId('availability-LIVE')).toBeNull();
  expect(screen.queryByText(t.xPaused)).toBeNull();
  // Titled as the club the user followed.
  expect(screen.getByText(new RegExp(`${t.xFootball} · .*برشلونة`))).toBeTruthy();
});

it('removing a followed club is "Stop following", and confirming it deletes the watcher', async () => {
  const t = await show();
  const remove = screen.getByTestId(`watch-delete-${WATCHER}`);
  expect(within(remove).getByText(t.xStopFollowing)).toBeTruthy();
  await fireEvent.press(remove);
  expect(screen.getByText(t.xStopFollowingBody)).toBeTruthy();
  const confirm = screen.getAllByText(t.xStopFollowing).at(-1)!;
  await fireEvent.press(confirm);
  expect(mockMutate).toHaveBeenCalledWith({ id: WATCHER, action: 'delete' });
});

it('the "more ways" list offers no flight or parcel', async () => {
  const t = await show();
  expect(screen.getByText(t.xExplore)).toBeTruthy();
  for (const word of ['Flight', 'Package', 'رحلة طيران', 'طرد', 'טיסה', 'חבילה']) expect(screen.queryAllByText(word)).toHaveLength(0);
});
