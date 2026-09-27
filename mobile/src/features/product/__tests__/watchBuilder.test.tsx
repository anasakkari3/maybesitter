import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { WatchBuilderScreen } from '../WatcherScreens';
import { strings } from '../../../i18n/strings';
import * as watcherEndpoints from '../../../api/endpoints/watchers';
import * as footballEndpoints from '../../../api/endpoints/football';
import response from '../../../api/__fixtures__/watchers.created.json';
import footballCreated from '../../../api/__fixtures__/watchers.football.created.json';
import footballOff from '../../../api/__fixtures__/football.settings.json';
import footballOn from '../../../api/__fixtures__/football.settings.configured.json';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const user = { uid: 'watch-builder-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  // The real server answer with no match data key — staging and production today.
  jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOff as never);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <WatchBuilderScreen />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

it('creates the readiness watcher, and offers no flight, parcel or «soon» source at all', async () => {
  const create = jest.spyOn(watcherEndpoints, 'createReadinessWatcher').mockResolvedValue(response as never);
  await show();
  const lang = Object.values(strings).find(t => screen.queryAllByText(t.xReadiness).length > 0)!;
  expect(lang).toBeDefined();
  expect(screen.getByTestId('watch-source-readiness').props.accessibilityState.checked).toBe(true);
  // Council ruling (closure CL7): flights and parcels are removed, not
  // labelled, and nothing on the builder says «قريبًا».
  for (const t of Object.values(strings)) expect(screen.queryAllByText(t.xSoon)).toHaveLength(0);
  expect(screen.queryAllByTestId('row-status-COMING_SOON')).toHaveLength(0);
  for (const word of ['Flight', 'Package', 'رحلة طيران', 'طرد', 'טיסה', 'חבילה']) expect(screen.queryAllByText(word)).toHaveLength(0);
  // Without the server's key there is no football row either.
  await waitFor(() => expect(footballEndpoints.getFootballSettings).toHaveBeenCalled());
  expect(screen.queryByTestId('watch-source-football')).toBeNull();

  await fireEvent.press(screen.getByTestId('watch-create'));
  await waitFor(() => expect(create).toHaveBeenCalledWith('notify'));
});

it('saves the choice made at the bottom of the builder, not the default', async () => {
  // The owner's complaint: "the settings at the bottom don't save".
  const create = jest.spyOn(watcherEndpoints, 'createReadinessWatcher').mockResolvedValue(response as never);
  await show();
  await fireEvent.press(screen.getByTestId('watch-effect-replan_if_impacted'));
  expect(screen.getByTestId('watch-effect-replan_if_impacted').props.accessibilityState.checked).toBe(true);
  expect(screen.getByTestId('watch-effect-notify').props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByTestId('watch-create'));
  await waitFor(() => expect(create).toHaveBeenCalledWith('replan_if_impacted'));
});

it('with the key, follows a team found by search, and says what following does before it is confirmed', async () => {
  jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOn as never);
  const follow = jest.spyOn(watcherEndpoints, 'createFootballWatcher').mockResolvedValue(footballCreated as never);
  const create = jest.spyOn(watcherEndpoints, 'createReadinessWatcher');
  await show();
  await waitFor(() => expect(screen.getByTestId('watch-source-football')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('watch-source-football'));
  expect(screen.getByTestId('watch-source-football').props.accessibilityState.checked).toBe(true);

  // Nothing to follow yet: the confirm is off until a team is picked.
  expect(screen.getByTestId('watch-create').props.accessibilityState.disabled).toBe(true);
  // Only the two effects a followed club can have.
  expect(screen.queryByTestId('watch-effect-propose_commitment')).toBeNull();
  expect(screen.queryByTestId('watch-effect-update_context')).toBeNull();

  await fireEvent.changeText(screen.getByTestId('watch-team-search'), 'barc');
  expect(screen.getByTestId('watch-team-barcelona')).toBeTruthy();
  expect(screen.queryByTestId('watch-team-liverpool')).toBeNull();
  await fireEvent.changeText(screen.getByTestId('watch-team-search'), 'zzz');
  expect(screen.getByTestId('watch-team-none')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('watch-team-search'), 'برش');
  await fireEvent.press(screen.getByTestId('watch-team-barcelona'));
  expect(screen.getByTestId('watch-team-barcelona').props.accessibilityState.checked).toBe(true);

  // Said plainly, before the confirm: nothing is written until «تابِع».
  const lang = Object.values(strings).find(t => screen.queryAllByText(t.xFollowTeamNothingYet).length > 0)!;
  expect(lang).toBeDefined();
  for (const t of Object.values(strings)) expect(screen.queryAllByText(t.suggestionNote)).toHaveLength(0);
  expect(screen.getByTestId('watch-create').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(screen.getByTestId('watch-effect-notify'));
  await fireEvent.press(screen.getByTestId('watch-create'));
  await waitFor(() => expect(follow).toHaveBeenCalledTimes(1));
  const [clubId, effect, label] = follow.mock.calls[0]!;
  expect([clubId, effect]).toEqual(['barcelona', 'notify']);
  expect(['برشلونة', 'FC Barcelona', 'ברצלונה']).toContain(label);
  expect(create).not.toHaveBeenCalled();
});

it('sends one create however often the button is pressed while it is in flight', async () => {
  // The owner's repro: each press after a failed-looking create made another
  // watcher. The button is disabled while the create is pending.
  let finish: (value: unknown) => void = () => undefined;
  const create = jest.spyOn(watcherEndpoints, 'createReadinessWatcher')
    .mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
  await show();
  await fireEvent.press(screen.getByTestId('watch-create'));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByTestId('watch-create'));
  await fireEvent.press(screen.getByTestId('watch-create'));
  expect(create).toHaveBeenCalledTimes(1);
  finish(response);
});
