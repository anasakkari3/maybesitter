/**
 * Settings → Calendar → Calendar links, on the phone (UC-3.4, #188).
 *
 * What the screen must hold, each a case below:
 * - the build flag hides the screen and the entry, and no feed request is made;
 * - without calendar consent there is no paste field, only the switch to allow it;
 * - a pasted link is sent once and then gone: not in the field, not on screen,
 *   not in the query or mutation cache, not in any console call;
 * - a refused link says why, in words;
 * - feeds can be refreshed, removed (after a confirm) and have auto-accept toggled;
 * - a feed that has not been readable shows the banner;
 * - deadlines are suggestions: add or skip, undo what was added for the user,
 *   and a moved deadline waits for "move mine too".
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { IcsFeedRefusedError } from '../../../api/errors';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as language from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import { CalendarFeedsScreen } from '../CalendarFeedsScreen';
import * as feedEndpoints from '../../../api/endpoints/icsFeeds';
import * as trustEndpoints from '../../../api/endpoints/trust';
import listFixture from '../../../api/__fixtures__/icsFeeds.list.json';
import createdFixture from '../../../api/__fixtures__/icsFeeds.created.json';
import type { IcsDeadline, IcsFeed } from '../../../api/schemas/icsFeeds';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'ics-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const SECRET = 'SECRETTOKEN42';
const FEED_URL = `https://moodle.example/calendar/export_execute.php?userid=7&authtoken=${SECRET}`;
const FLAG = 'EXPO_PUBLIC_FEATURE_ICS_FEEDS';
const HOUR = 3_600_000;

const FEED: IcsFeed = { ...(listFixture.feeds[0] as IcsFeed), feedId: 'feed-1', label: 'CS101' };
function deadline(overrides: Partial<IcsDeadline>): IcsDeadline {
  return {
    ...(listFixture.deadlines[0] as IcsDeadline),
    feedId: 'feed-1',
    dueAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    ...overrides,
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
const consoleCalls: unknown[][] = [];
const originalFlag = process.env[FLAG];

function trustBody(calendarConsent: boolean) {
  return { success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent } };
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  process.env[FLAG] = 'true';
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(language, 'systemLanguageTag').mockReturnValue('en-US');
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustBody(true) as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue(trustBody(true) as never);
  jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({ success: true, feeds: [FEED], deadlines: [] } as never);
  jest.spyOn(feedEndpoints, 'createIcsFeed').mockResolvedValue(createdFixture as never);
  jest.spyOn(feedEndpoints, 'refreshIcsFeed').mockResolvedValue({ success: true, outcome: 'updated', feed: FEED } as never);
  jest.spyOn(feedEndpoints, 'updateIcsFeed').mockResolvedValue({ success: true, feed: FEED } as never);
  jest.spyOn(feedEndpoints, 'deleteIcsFeed').mockResolvedValue({ success: true, busyBlocks: 1, proposals: 0 } as never);
  jest.spyOn(feedEndpoints, 'decideIcsDeadline').mockResolvedValue({ success: true, deadline: deadline({}), replayed: false } as never);
  consoleCalls.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); });
  }
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

async function show(lang: 'en' | 'ar' | 'he' = 'en') {
  if (lang !== 'en') await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <CalendarFeedsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  return view;
}

function text(testID: string): string {
  const node = screen.getByTestId(testID);
  const children = node.props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}

describe('the build flag', () => {
  it('shows only "not available" and makes no feed request when the flag is off', async () => {
    process.env[FLAG] = 'false';
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-unavailable')).not.toBeNull());
    expect(screen.queryByTestId('ics-url-input')).toBeNull();
    expect(feedEndpoints.listIcsFeeds).not.toHaveBeenCalled();
  });
});

describe('consent', () => {
  it('offers no paste field without calendar consent, and the switch asks for exactly that consent', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustBody(false) as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-consent')).not.toBeNull());
    expect(screen.queryByTestId('ics-url-input')).toBeNull();
    await fireEvent.press(screen.getByTestId('ics-consent-allow'));
    await waitFor(() => expect(trustEndpoints.updateTrust)
      .toHaveBeenCalledWith({ type: 'set_calendar_consent', granted: true }));
    expect(feedEndpoints.createIcsFeed).not.toHaveBeenCalled();
  });
});

describe('pasting a link', () => {
  it('sends it once with the choices made, shows the preview, and keeps no copy anywhere', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-url-input')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('ics-url-input'), `  ${FEED_URL} `);
    await fireEvent.changeText(screen.getByTestId('ics-name-input'), 'CS101');
    await fireEvent(screen.getByTestId('ics-auto-accept-new'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('ics-subscribe'));

    await waitFor(() => expect(screen.queryByTestId('ics-preview')).not.toBeNull());
    expect(feedEndpoints.createIcsFeed).toHaveBeenCalledTimes(1);
    expect(feedEndpoints.createIcsFeed).toHaveBeenCalledWith({ url: FEED_URL, label: 'CS101', autoAcceptDeadlines: true });
    expect(text('ics-preview-deadlines')).toBe(en.icsFeedsPreviewDeadlines.replace('{n}', '1'));
    expect(text('ics-preview-busy')).toBe(en.icsFeedsPreviewBusy.replace('{n}', '1'));

    // Gone from the field, the screen, both caches and the console.
    expect(screen.getByTestId('ics-url-input').props.value).toBe('');
    expect(JSON.stringify(screen.toJSON())).not.toContain(SECRET);
    const cached = JSON.stringify({
      queries: client.getQueryCache().getAll().map(query => query.state),
      mutations: client.getMutationCache().getAll().map(mutation => mutation.state),
    });
    expect(cached).not.toContain(SECRET);
    expect(JSON.stringify(consoleCalls)).not.toContain(SECRET);
    // The auto-accept switch for the next link starts off again.
    expect(screen.getByTestId('ics-auto-accept-new').props.value).toBe(false);
  });

  it('does nothing with an empty field', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-url-input')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('ics-subscribe'));
    expect(feedEndpoints.createIcsFeed).not.toHaveBeenCalled();
  });

  it.each([
    ['en', en], ['ar', ar], ['he', he],
  ] as const)('explains a refused link in words (%s), keeps the text to fix, and caches nothing', async (lang, bundle) => {
    jest.spyOn(feedEndpoints, 'createIcsFeed').mockRejectedValue(new IcsFeedRefusedError('invalid_url', 'blocked_scheme') as never);
    await show(lang);
    await waitFor(() => expect(screen.queryByTestId('ics-url-input')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('ics-url-input'), FEED_URL.replace('https', 'http'));
    await fireEvent.press(screen.getByTestId('ics-subscribe'));
    await waitFor(() => expect(screen.queryByTestId('ics-subscribe-error')).not.toBeNull());
    expect(text('ics-subscribe-error')).toBe(bundle.icsFeedsErrInvalidUrl);
    expect(screen.getByTestId('ics-url-input').props.value).toContain(SECRET);
    expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain(SECRET);
    expect(JSON.stringify(consoleCalls)).not.toContain(SECRET);
  });
});

describe('the feeds', () => {
  it('refreshes, toggles auto-accept, and removes only after a confirm', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-feed-feed-1')).not.toBeNull());
    expect(JSON.stringify(screen.toJSON())).toContain('CS101');

    await fireEvent.press(screen.getByTestId('ics-refresh-feed-1'));
    await waitFor(() => expect(feedEndpoints.refreshIcsFeed).toHaveBeenCalledWith('feed-1'));

    await fireEvent(screen.getByTestId('ics-auto-accept-feed-1'), 'valueChange', true);
    await waitFor(() => expect(feedEndpoints.updateIcsFeed).toHaveBeenCalledWith('feed-1', { autoAcceptDeadlines: true }));

    await fireEvent.press(screen.getByTestId('ics-remove-feed-1'));
    expect(feedEndpoints.deleteIcsFeed).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('ics-remove-confirm-feed-1'));
    await waitFor(() => expect(feedEndpoints.deleteIcsFeed).toHaveBeenCalledWith('feed-1'));
  });

  it('says a refresh was too soon in words', async () => {
    jest.spyOn(feedEndpoints, 'refreshIcsFeed').mockRejectedValue(new IcsFeedRefusedError('refresh_too_soon', null) as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-refresh-feed-1')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('ics-refresh-feed-1'));
    await waitFor(() => expect(screen.queryByTestId('ics-feed-failure-feed-1')).not.toBeNull());
    expect(text('ics-feed-failure-feed-1')).toBe(en.icsFeedsErrTooSoon);
  });

  it('shows the banner only when a feed is in error, and marks a paused one', async () => {
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({
      success: true,
      feeds: [{ ...FEED, status: 'error', consecutiveFailures: 5 }, { ...FEED, feedId: 'feed-2', status: 'paused' }],
      deadlines: [],
    } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-banner')).not.toBeNull());
    expect(screen.queryByTestId('ics-feed-error-feed-1')).not.toBeNull();
    expect(screen.queryByTestId('ics-feed-paused-feed-2')).not.toBeNull();
  });

  it('has no banner when every feed is fine', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-feed-feed-1')).not.toBeNull());
    expect(screen.queryByTestId('ics-banner')).toBeNull();
  });
});

describe('the deadlines', () => {
  it('are suggestions: add or skip', async () => {
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({
      success: true, feeds: [FEED], deadlines: [deadline({ itemKey: 'k1', state: 'pending' })],
    } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-deadline-k1')).not.toBeNull());
    expect(text('ics-suggestion-note')).toBe(en.suggestionNote);
    expect(screen.queryByTestId('ics-undo-k1')).toBeNull();
    await fireEvent.press(screen.getByTestId('ics-accept-k1'));
    await waitFor(() => expect(feedEndpoints.decideIcsDeadline).toHaveBeenCalledWith('feed-1', 'k1', 'accept'));
    await fireEvent.press(screen.getByTestId('ics-skip-k1'));
    await waitFor(() => expect(feedEndpoints.decideIcsDeadline).toHaveBeenCalledWith('feed-1', 'k1', 'dismiss'));
  });

  it('offers Undo only for what was added on the user\'s behalf', async () => {
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({
      success: true,
      feeds: [FEED],
      deadlines: [
        deadline({ itemKey: 'auto', state: 'accepted', autoAccepted: true, commitmentId: 'c1' }),
        deadline({ itemKey: 'mine', state: 'accepted', autoAccepted: false, commitmentId: 'c2', notice: 'removed' }),
      ],
    } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-deadline-auto')).not.toBeNull());
    expect(screen.queryByTestId('ics-auto-added-auto')).not.toBeNull();
    expect(screen.queryByTestId('ics-undo-mine')).toBeNull();
    expect(text('ics-removed-mine')).toBe(en.icsFeedsRemovedFromSource);
    await fireEvent.press(screen.getByTestId('ics-undo-auto'));
    await waitFor(() => expect(feedEndpoints.decideIcsDeadline).toHaveBeenCalledWith('feed-1', 'auto', 'undo'));
    await fireEvent.press(screen.getByTestId('ics-got-it-mine'));
    await waitFor(() => expect(feedEndpoints.decideIcsDeadline).toHaveBeenCalledWith('feed-1', 'mine', 'acknowledge'));
  });

  it('asks before moving a kept deadline the calendar moved', async () => {
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({
      success: true,
      feeds: [FEED],
      deadlines: [deadline({
        itemKey: 'moved', state: 'accepted', commitmentId: 'c1', notice: 'moved',
        proposedDueAt: new Date(Date.now() + 96 * HOUR).toISOString(),
      })],
    } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('ics-moved-moved')).not.toBeNull());
    expect(feedEndpoints.decideIcsDeadline).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('ics-apply-move-moved'));
    await waitFor(() => expect(feedEndpoints.decideIcsDeadline).toHaveBeenCalledWith('feed-1', 'moved', 'apply_move'));
    await fireEvent.press(screen.getByTestId('ics-keep-time-moved'));
    await waitFor(() => expect(feedEndpoints.decideIcsDeadline).toHaveBeenCalledWith('feed-1', 'moved', 'acknowledge'));
  });

  it('says a deadline that passed meanwhile in words', async () => {
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({
      success: true, feeds: [FEED], deadlines: [deadline({ itemKey: 'late', state: 'pending' })],
    } as never);
    jest.spyOn(feedEndpoints, 'decideIcsDeadline').mockRejectedValue(new IcsFeedRefusedError('past_due', null) as never);
    await show('ar');
    await waitFor(() => expect(screen.queryByTestId('ics-accept-late')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('ics-accept-late'));
    await waitFor(() => expect(screen.queryByTestId('ics-deadline-failure-late')).not.toBeNull());
    expect(text('ics-deadline-failure-late')).toBe(ar.icsFeedsErrPast);
  });
});
