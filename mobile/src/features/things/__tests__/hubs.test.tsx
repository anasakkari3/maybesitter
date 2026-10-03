/**
 * The two Stitch hubs (2026-10-02) and the avatar that replaced the Settings
 * tab. What is pinned: every row reads real data through the existing
 * queries, nothing is invented when there is none, and each row opens the
 * screen that already owns the thing.
 */
import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import { fill } from '../../../i18n/strings';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as habitEndpoints from '../../../api/endpoints/habits';
import * as seedEndpoints from '../../../api/endpoints/seeds';
import * as intelligenceEndpoints from '../../../api/endpoints/intelligence';
import * as backgroundEndpoints from '../../../api/endpoints/backgroundActivity';
import { FeatureUnavailableError } from '../../../api/errors';
import one from '../../../api/__fixtures__/commitments.one.json';
import retrying from '../../../api/__fixtures__/backgroundActivity.footballRetrying.json';
import { ThingsScreen } from '../ThingsScreen';
import { resetVisitThrottleForTests } from '../../../lib/deviceSettings/visitThrottle';
import { WatchingScreen } from '../../watching/WatchingScreen';
import { AvatarButton, avatarInitial } from '../../../ui/chrome';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'hub-user', email: 'lina@example.com', emailVerified: true, displayName: 'Lina', providerIds: ['password'] };

let client: QueryClient;

const commitment = (id: string, title: string, createdAt: string, timed: boolean, level: 'high' | 'normal' | 'low' = 'normal', status = 'active') => ({
  ...one, id, title, createdAt, status,
  priority: { ...one.priority, level },
  timeSpec: timed ? { ...one.timeSpec, dueAt: '2099-01-01T09:00:00.000Z', remindAt: null } : { ...one.timeSpec, kind: 'unscheduled', dueAt: null, remindAt: null },
});

const suggestion = (id: string, kind: 'question' | 'action' | 'goal', title: string, status = 'pending') => ({
  id, kind, title, reason: `why ${id}`, observationIds: [], confidence: 0.8, durationMinutes: null,
  status, decidedAt: null, linkedEntityId: null, generatedAt: '2026-10-01T08:00:00.000Z',
});

function Probe() {
  const { s } = useApp();
  return <Text testID="probe-screen">{s.screen}</Text>;
}

async function show(node: React.ReactNode, user: AuthUser = USER) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  const repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            {node}
            <Probe />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetVisitThrottleForTests();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('«أشيائي»', () => {
  function seed() {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [
      commitment('c-old', 'Renew passport', '2026-09-01T08:00:00.000Z', true, 'high'),
      commitment('c-dropped', 'Dropped thing', '2026-10-01T09:00:00.000Z', true, 'normal', 'dropped'),
    ] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [
      commitment('c-new', 'Call the dentist', '2026-09-30T08:00:00.000Z', false, 'low'),
      // The same row from both lists is one commitment.
      commitment('c-old', 'Renew passport', '2026-09-01T08:00:00.000Z', true, 'high'),
    ] } as never);
    jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue({ items: [
      { id: 'g1', kind: 'goal', content: 'Learn React' },
      { id: 'p1', kind: 'preference', content: 'mornings' },
    ], suggestions: [], adaptive: null } as never);
    jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([
      { habitId: 'h1', title: 'Walk', status: 'active' },
      { habitId: 'h2', title: 'Old habit', status: 'archived' },
    ] as never);
    jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({ items: [
      { seedId: 's1', summary: 'Maybe learn guitar', status: 'open', kind: 'idea' },
      { seedId: 's2', summary: 'Promoted already', status: 'promoted', kind: 'idea' },
    ] } as never);
  }

  it('counts what is really there and says what each entry holds', async () => {
    seed();
    await show(<ThingsScreen />);
    await waitFor(() => expect(screen.getByTestId('things-commitments-count')).toHaveTextContent('2'));
    // Dropped rows are not "things"; the duplicate across lists is one.
    expect(screen.getByLabelText(`${en.xCommitments}. ${fill(en.thingsCommitmentsSub, { timed: 1, untimed: 1 })}. 2`)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('things-goals-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('things-habits-count')).toHaveTextContent('1');
    expect(screen.getByTestId('things-ideas-count')).toHaveTextContent('1');
    // Newest saved first, dropped left out.
    const recent = screen.getAllByTestId(/^things-recent-c-/).map(node => node.props.testID as string);
    expect(recent).toEqual(['things-recent-c-new', 'things-recent-c-old']);
  });

  it('opens the screens that already own each thing', async () => {
    seed();
    await show(<ThingsScreen />);
    await waitFor(() => expect(screen.queryByTestId('things-recent-c-new')).not.toBeNull());
    for (const [id, target] of [['things-commitments', 'commitments'], ['things-goals', 'goalExecution'], ['things-habits', 'habitDetail'], ['things-ideas', 'seeds']] as const) {
      await fireEvent.press(screen.getByTestId(id));
      expect(screen.getByTestId('probe-screen')).toHaveTextContent(target);
    }
    await fireEvent.press(screen.getByTestId('things-recent-c-new'));
    expect(screen.getByTestId('probe-screen')).toHaveTextContent('details');
  });

  it('searches commitments, goals, habits and ideas, and says when nothing matches', async () => {
    seed();
    await show(<ThingsScreen />);
    await waitFor(() => expect(screen.queryByTestId('things-recent-c-new')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('things-search'), 'learn');
    expect(screen.queryByTestId('things-result-goal-g1')).not.toBeNull();
    expect(screen.queryByTestId('things-result-seed-s1')).not.toBeNull();
    expect(screen.queryByTestId('things-recent-c-new')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('things-search'), 'zzz');
    expect(screen.getByTestId('things-no-results')).toHaveTextContent(en.xNoResults);
  });

  it('invents nothing for an empty account', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue({ items: [], suggestions: [], adaptive: null } as never);
    jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([] as never);
    jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({ items: [] } as never);
    await show(<ThingsScreen />);
    await waitFor(() => expect(screen.queryByTestId('things-recent-empty')).not.toBeNull());
    expect(screen.getByTestId('things-recent-empty')).toHaveTextContent(en.thingsRecentEmpty);
    expect(screen.getByTestId('things-commitments-count')).toHaveTextContent('0');
    await waitFor(() => expect(screen.getByTestId('things-goals-count')).toHaveTextContent('0'));
  });
});

describe('«يتابع لك»', () => {
  it('shows what is waiting, asks for more in the background, and a decision refreshes Today, «أشيائي» and the plan', async () => {
    const observation = { id: 'o1', kind: 'goal', evidence: 'I want to learn React', confidence: 0.9, source: 'manual',
      sourceRef: 'n1', observedAt: '2026-10-01T08:00:00.000Z', review: 'confirmed', reviewedAt: null, linkedMemoryId: null };
    const inbox = {
      success: true, observations: [observation], schedule: [], suggestions: [
        { ...suggestion('q1', 'question', 'Is Tuesday football fixed?'), observationIds: ['o1'] },
        { ...suggestion('a1', 'action', 'A small project for Learn React'), observationIds: ['o1'], durationMinutes: 60 },
        suggestion('a2', 'action', 'Already dismissed', 'dismissed'),
      ],
    };
    const generate = jest.spyOn(intelligenceEndpoints, 'generateIntelligenceSuggestions')
      .mockResolvedValue({ success: true, suggestions: inbox.suggestions, schedule: [], nextVisitAt: '2099-01-01T00:00:00.000Z' } as never);
    const read = jest.spyOn(intelligenceEndpoints, 'getIntelligenceInbox').mockResolvedValue(inbox as never);
    jest.spyOn(intelligenceEndpoints, 'getGmailIntelligenceMonitor').mockResolvedValue({ success: true, enabled: false, lastSuccessAt: null, error: null } as never);
    const decide = jest.spyOn(intelligenceEndpoints, 'decideIntelligenceSuggestion')
      .mockResolvedValue({ success: true, suggestion: { ...inbox.suggestions[1], status: 'dismissed' } } as never);
    jest.spyOn(backgroundEndpoints, 'getBackgroundActivity').mockResolvedValue(retrying as never);
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await show(<WatchingScreen />);
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-a1')).not.toBeNull());
    // Opening the hub is a visit: asked once, in the background.
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate).toHaveBeenCalledWith({ visit: true });
    // Nothing new came back, so the inbox is not read twice.
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('intelligence-suggestion-q1')).not.toBeNull();
    expect(screen.queryByTestId('intelligence-suggestion-a2')).toBeNull();
    const card = within(screen.getByTestId('intelligence-suggestion-a1'));
    expect(card.getByText(new RegExp(`From: .{0,2}${observation.evidence}`))).toBeTruthy();
    // A suggestion says it is one: nothing has changed.
    expect(card.getByText(en.suggestionNote)).toBeTruthy();
    expect(decide).not.toHaveBeenCalled();
    await fireEvent.press(card.getByText(en.xIntelligenceDismiss));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('a1', 'dismiss'));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', USER.uid, 'commitments'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', USER.uid, 'plan'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', USER.uid, 'memory'] });
    expect(screen.queryByTestId('watching-nothing')).toBeNull();
    // The body lifts above the keyboard the app's own way, on Android too.
    expect(screen.queryByTestId('watching-kav')).not.toBeNull();
  });

  it('lists the watches with their last check and opens background activity, the builder and Knows', async () => {
    jest.spyOn(intelligenceEndpoints, 'generateIntelligenceSuggestions').mockRejectedValue(new FeatureUnavailableError('off'));
    jest.spyOn(intelligenceEndpoints, 'getIntelligenceInbox').mockResolvedValue({ success: true, observations: [], schedule: [], suggestions: [] } as never);
    jest.spyOn(backgroundEndpoints, 'getBackgroundActivity').mockResolvedValue(retrying as never);
    await show(<WatchingScreen />);
    const id = `watching-watch-${retrying.monitors[0]!.watcherId}`;
    await waitFor(() => expect(screen.queryByTestId(id)).not.toBeNull());
    // An empty inbox says so in the review itself.
    await waitFor(() => expect(screen.queryByText(en.xIntelligenceNoIdeas)).not.toBeNull());
    expect(screen.getByLabelText(new RegExp(`${en.xLastChecked}: ${en.xNotObserved}`))).toBeTruthy();
    // Its state in words, as Background activity says it (Stitch 05's chip).
    expect(screen.getByTestId(`watching-state-${retrying.monitors[0]!.watcherId}`)).toHaveTextContent(en.xFootballRetrying);
    expect(screen.queryByTestId('watching-pause')).not.toBeNull();
    await fireEvent.press(screen.getByTestId(id));
    expect(screen.getByTestId('probe-screen')).toHaveTextContent('backgroundActivity');
    await fireEvent.press(screen.getByTestId('watching-add'));
    expect(screen.getByTestId('probe-screen')).toHaveTextContent('watchBuilder');
    await fireEvent.press(screen.getByTestId('watching-knows'));
    expect(screen.getByTestId('probe-screen')).toHaveTextContent('knows');
  });

  it('reads a loop switched off on the server as "nothing yet", not as an error to retry', async () => {
    jest.spyOn(intelligenceEndpoints, 'generateIntelligenceSuggestions').mockRejectedValue(new FeatureUnavailableError('off'));
    jest.spyOn(intelligenceEndpoints, 'getIntelligenceInbox').mockRejectedValue(new FeatureUnavailableError('off'));
    jest.spyOn(backgroundEndpoints, 'getBackgroundActivity').mockResolvedValue({ ...retrying, monitors: [] } as never);
    await show(<WatchingScreen />);
    await waitFor(() => expect(screen.queryByTestId('watching-nothing')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('watching-no-watches')).not.toBeNull());
    expect(screen.queryByTestId('query-error')).toBeNull();
    expect(screen.queryByText(en.errorsRetry)).toBeNull();
  });
});

describe('the avatar', () => {
  it('shows the first letter of the name, else of the email', () => {
    expect(avatarInitial({ displayName: 'lina', email: 'x@y.z' })).toBe('L');
    expect(avatarInitial({ displayName: '  ', email: 'sami@y.z' })).toBe('S');
    expect(avatarInitial({ displayName: 'أنس', email: null })).toBe('أ');
    expect(avatarInitial({ displayName: null, email: null })).toBeNull();
  });

  it('is a 44-point control announced as Settings that pushes Settings', async () => {
    await show(<AvatarButton />);
    await waitFor(() => expect(screen.getByTestId('open-settings-initial')).toHaveTextContent('L'));
    const button = screen.getByTestId('open-settings');
    expect(button.props.accessibilityLabel).toBe(en.settingsTitle);
    await fireEvent.press(button);
    expect(screen.getByTestId('probe-screen')).toHaveTextContent('settings');
  });
});
