/**
 * A watcher's «اقترح التزام» on the Watching tab (QA audit de7fcb8, CA6.1).
 *
 * The card shows each open proposal as a suggestion, with the person's title
 * to edit, and sends exactly one answer per tap: accept with the title, or
 * dismiss. Nothing is sent until a button is pressed, and a second tap while
 * the first is on its way sends nothing more.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import * as watcherEndpoints from '../../../api/endpoints/watchers';
import { WatcherProposalsCard } from '../WatcherProposals';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'proposal-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const ID = `wpr_${'c'.repeat(64)}`;
const OPEN = { proposalId: ID, signalKind: 'readiness', proposedAt: '2026-11-15T08:00:00.000Z', state: 'proposed' as const, commitmentId: null };

let client: QueryClient;

beforeEach(async () => {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  jest.spyOn(watcherEndpoints, 'listWatcherProposals').mockResolvedValue({ success: true, proposals: [OPEN] } as never);
  jest.spyOn(watcherEndpoints, 'decideWatcherProposal').mockResolvedValue({ success: true, proposal: { ...OPEN, state: 'accepted', commitmentId: 'wpc_x' } } as never);
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><WatcherProposalsCard /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('watcher proposals on the Watching tab (CA6.1)', () => {
  it('shows an open proposal as a suggestion, and sends nothing until asked', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId(`watcher-proposal-${ID}`)).not.toBeNull());
    expect(screen.getByText(en.suggestionNote)).toBeTruthy();
    expect(screen.getByText(en.xProposalFromReadiness)).toBeTruthy();
    expect(screen.getByTestId(`watcher-proposal-title-${ID}`).props.value).toBe(en.xProposalTitleReadiness);
    expect(watcherEndpoints.decideWatcherProposal).not.toHaveBeenCalled();
  });

  it('accepts with the title the person left in the field, once however fast the taps come', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId(`watcher-proposal-accept-${ID}`)).not.toBeNull());
    fireEvent.changeText(screen.getByTestId(`watcher-proposal-title-${ID}`), '  A walk after lunch ');
    const accept = screen.getByTestId(`watcher-proposal-accept-${ID}`);
    fireEvent.press(accept);
    fireEvent.press(accept);
    await waitFor(() => expect(watcherEndpoints.decideWatcherProposal).toHaveBeenCalledTimes(1));
    expect(watcherEndpoints.decideWatcherProposal).toHaveBeenCalledWith(ID, { decision: 'accept', title: 'A walk after lunch' });
  });

  it('dismisses without a title', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId(`watcher-proposal-dismiss-${ID}`)).not.toBeNull());
    fireEvent.press(screen.getByTestId(`watcher-proposal-dismiss-${ID}`));
    await waitFor(() => expect(watcherEndpoints.decideWatcherProposal).toHaveBeenCalledWith(ID, { decision: 'dismiss' }));
  });

  it('cannot accept an empty title', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId(`watcher-proposal-accept-${ID}`)).not.toBeNull());
    fireEvent.changeText(screen.getByTestId(`watcher-proposal-title-${ID}`), '   ');
    fireEvent.press(screen.getByTestId(`watcher-proposal-accept-${ID}`));
    expect(watcherEndpoints.decideWatcherProposal).not.toHaveBeenCalled();
  });

  it('renders nothing when nothing is waiting', async () => {
    jest.spyOn(watcherEndpoints, 'listWatcherProposals').mockResolvedValue({ success: true, proposals: [] } as never);
    await show();
    await waitFor(() => expect(watcherEndpoints.listWatcherProposals).toHaveBeenCalled());
    expect(screen.queryByTestId('watcher-proposals')).toBeNull();
  });
});
