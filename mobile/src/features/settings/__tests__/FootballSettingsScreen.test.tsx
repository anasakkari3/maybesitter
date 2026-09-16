/**
 * Settings → Football (football fixtures MVP, Task 11).
 *
 * The three claims that matter most:
 *
 *  - a club's name comes from the curated list in the active language, never
 *    the provider's own Latin-script name (#football-fixtures owner request:
 *    "if I love Barcelona, I want to see all of the games", read in Arabic);
 *  - tapping a club saves the whole follow list immediately, the same
 *    save-on-tap shape `calendarSettingsScreen.test.tsx` already asserts for
 *    the calendar picker;
 *  - the provider attribution its free tier requires is actually on screen,
 *    not only in a code comment.
 *
 * Arabic is mocked at the module boundary (`expo-localization`), the same
 * mechanism `noCommitmentArabic.test.tsx` and `hebrewUi.test.tsx` use — there
 * is no `arabicWrapper`/`wrapperWith` helper anywhere in this codebase to
 * reuse (checked before writing this file), so this follows the pattern
 * those two sibling files already established instead of inventing a new one.
 *
 * RNTL v14: `render()` returns a Promise and `fireEvent` must be awaited. An
 * un-awaited event leaves later renders mounting nothing, and the assertions
 * then pass against an empty tree -- a green test that checked nothing.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import ar from '../../../i18n/locales/ar.json';
import { FootballSettingsScreen } from '../FootballSettingsScreen';
import * as footballEndpoints from '../../../api/endpoints/football';
import type { FootballSettingsResponse } from '../../../api/schemas/football';

// Same mechanism as noCommitmentArabic.test.tsx / hebrewUi.test.tsx: pin the
// device locale so `AppContext`'s 'system' default resolves to Arabic,
// rather than depending on whatever the test runner's own locale happens to
// be. Hoisted above the other imports so `src/i18n` sees it before anything
// reads a language.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Amman' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'football-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const CLUBS = [
  { clubId: 'barcelona', providerTeamId: '81', competition: 'PD', names: { ar: 'برشلونة', he: 'ברצלונה', en: 'FC Barcelona' } },
  { clubId: 'real-madrid', providerTeamId: '86', competition: 'PD', names: { ar: 'ريال مدريد', he: 'ריאל מדריד', en: 'Real Madrid CF' } },
];

function settingsResponse(over: Partial<FootballSettingsResponse> = {}): FootballSettingsResponse {
  return {
    success: true,
    clubs: CLUBS,
    followedClubIds: [],
    fixtures: [],
    ...over,
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(async () => {
  cleanup();
  // A real macrotask, not a microtask flush -- see calendarSettingsScreen.test.tsx's
  // identical comment: a save still settling when the tree comes down leaves
  // React work in flight, and RNTL v14's next `render` then mounts nothing.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <FootballSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('club names', () => {
  it('shows the name for the active language, from the curated list', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(settingsResponse());
    await show();
    expect(await screen.findByText('برشلونة')).toBeTruthy();
    // And never the provider's own Latin-script name -- the whole point of
    // `names` being a per-language object rather than a bare string.
    expect(screen.queryByText('FC Barcelona')).toBeNull();
  });

  it('marks a followed club as following', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(settingsResponse({ followedClubIds: ['barcelona'] }));
    await show();
    await waitFor(() => expect(screen.queryByTestId('football-club-barcelona')).not.toBeNull());
    expect(screen.getByText(ar.footballFollowing)).toBeTruthy();
  });
});

describe('following a club', () => {
  it('saves the whole list immediately', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(settingsResponse());
    const put = jest.spyOn(footballEndpoints, 'putFollowedClubs')
      .mockResolvedValue(settingsResponse({ followedClubIds: ['barcelona'] }));
    await show();
    await waitFor(() => expect(screen.queryByTestId('football-club-barcelona')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('football-club-barcelona'));
    await waitFor(() => expect(put).toHaveBeenCalledWith(['barcelona'], 'ar'));
  });

  it('unfollows by sending the list without it', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(settingsResponse({ followedClubIds: ['barcelona'] }));
    const put = jest.spyOn(footballEndpoints, 'putFollowedClubs').mockResolvedValue(settingsResponse());
    await show();
    await waitFor(() => expect(screen.queryByTestId('football-club-barcelona')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('football-club-barcelona'));
    await waitFor(() => expect(put).toHaveBeenCalledWith([], 'ar'));
  });
});

describe('the provider attribution', () => {
  it('is on screen, not only in a code comment', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(settingsResponse());
    await show();
    expect(await screen.findByTestId('football-attribution')).toBeTruthy();
  });
});

describe('dismissing a match', () => {
  const FIXTURE = {
    commitmentId: 'commitment-1',
    homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF',
    kickoffUtc: '2026-10-25T19:00:00.000Z',
  };

  it('is offered on a projected fixture, and calls the dismiss route', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(
      settingsResponse({ followedClubIds: ['barcelona'], fixtures: [{ ...FIXTURE, collisions: [] }] }),
    );
    const dismiss = jest.spyOn(footballEndpoints, 'dismissFixture')
      .mockResolvedValue({ id: FIXTURE.commitmentId, dismissed: true });
    await show();

    await waitFor(() => expect(screen.queryByTestId(`football-dismiss-${FIXTURE.commitmentId}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`football-dismiss-${FIXTURE.commitmentId}`));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(FIXTURE.commitmentId));
  });

  it('names what else is already on the calendar at that time', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(
      settingsResponse({
        followedClubIds: ['barcelona'],
        fixtures: [{
          ...FIXTURE,
          collisions: [{ commitmentId: 'dinner', title: 'Dinner', startsAt: '2026-10-25T19:30:00.000Z', endsAt: '2026-10-25T20:00:00.000Z' }],
        }],
      }),
    );
    await show();
    const line = await screen.findByTestId(`football-collision-${FIXTURE.commitmentId}`);
    // Final review M2: the line said only "something else is on your
    // calendar". It names what that is now.
    expect([line.props.children].flat().join('')).toContain('Dinner');
  });

  // Final review M2: rows printed the provider's Latin names even on an
  // Arabic screen. They use the same title rule as the commitment itself.
  it('titles a match with the curated names in the active language, and the provider name for anyone else', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(
      settingsResponse({
        followedClubIds: ['barcelona'],
        fixtures: [
          { ...FIXTURE, homeTeamId: '81', awayTeamId: '86', collisions: [] },
          { ...FIXTURE, commitmentId: 'commitment-2', homeTeamId: '298', awayTeamId: '81', homeTeamName: 'Girona FC', awayTeamName: 'FC Barcelona', collisions: [] },
        ],
      }),
    );
    await show();
    expect(await screen.findByText('برشلونة – ريال مدريد')).toBeTruthy();
    expect(screen.getByText('Girona FC – برشلونة')).toBeTruthy();
    expect(screen.queryByText('FC Barcelona – Real Madrid CF')).toBeNull();
  });
});

// Final review M3: each tap built the next list from the data on screen, so a
// second tap before the first save came back sent a list without the first
// club, and a failed save was silent.
describe('saving follows reliably', () => {
  it('two quick taps keep both clubs', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(settingsResponse());
    const put = jest.spyOn(footballEndpoints, 'putFollowedClubs').mockImplementation(async (clubIds) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return settingsResponse({ followedClubIds: [...clubIds] });
    });
    await show();
    await waitFor(() => expect(screen.queryByTestId('football-club-barcelona')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('football-club-barcelona'));
    await fireEvent.press(screen.getByTestId('football-club-real-madrid'));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[0]![0]).toEqual(['barcelona']);
    expect(put.mock.calls[1]![0]).toEqual(['barcelona', 'real-madrid']);
  });

  it('says so when a save fails', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(settingsResponse());
    jest.spyOn(footballEndpoints, 'putFollowedClubs').mockRejectedValue(new Error('network down'));
    await show();
    await waitFor(() => expect(screen.queryByTestId('football-club-barcelona')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('football-club-barcelona'));
    const notice = await screen.findByTestId('football-save-failed');
    expect(notice.props.children).toBe(ar.footballSaveFailed);
  });
});
