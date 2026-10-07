/**
 * M2B-A-R2-REVIEW-004: a share's or a meeting's review keeps a seed on the
 * same revision protocol as the chat's — the revision on screen goes with the
 * keep, and a 409 brings the current version back with a note instead of a
 * generic failure that every retry repeats.
 */
import React, { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { CaptureProvider, useCaptureFlow } from '../CaptureProvider';
import { ReviewScreen } from '../../../screens/ReviewScreen';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import type { CaptureProposal } from '../../../api/schemas/capture';
import { ProposalChangedError } from '../../../api/errors';
import * as seedEndpoints from '../../../api/endpoints/seeds';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'share-seed-user', email: 'p@example.com', emailVerified: true, displayName: null, providerIds: ['password'] };
const SEED = 'share-seed-1';

function proposal(revision: number): CaptureProposal {
  return {
    version: 'v1', proposalId: 'share-proposal-1', revision, status: 'unresolved_intent', items: [],
    seeds: [{ seedItemId: SEED, kind: 'idea', summary: 'Try the pottery class' }],
  } as CaptureProposal;
}

function Mount({ shared }: { shared: CaptureProposal }) {
  const { adoptProposal } = useCaptureFlow();
  useEffect(() => { adoptProposal(shared, 'share'); }, [adoptProposal, shared]);
  return <ReviewScreen />;
}

let client: QueryClient;
beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent').mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
});
afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function renderReview(shared: CaptureProposal) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider><AppProvider><CaptureProvider><Mount shared={shared} /></CaptureProvider></AppProvider></AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId(`review-seed-keep-${SEED}`)).not.toBeNull());
}

it('the keep carries the revision on screen', async () => {
  const keep = jest.spyOn(seedEndpoints, 'keepProposedSeed').mockResolvedValue({ success: true, replayed: false, seed: { id: 's1' } } as never);
  await renderReview(proposal(3));
  await act(async () => { await fireEvent.press(screen.getByTestId(`review-seed-keep-${SEED}`)); });
  await waitFor(() => expect(keep).toHaveBeenCalledTimes(1));
  expect(keep.mock.calls[0]![0]).toEqual({ proposalId: 'share-proposal-1', seedItemId: SEED, revision: 3 });
});

it('a 409 brings the current version back with a note, and the next keep carries its revision', async () => {
  const keep = jest.spyOn(seedEndpoints, 'keepProposedSeed')
    .mockRejectedValueOnce(new ProposalChangedError({ kind: 'proposal', proposal: proposal(4), state: 'open' }))
    .mockResolvedValue({ success: true, replayed: false, seed: { id: 's1' } } as never);
  await renderReview(proposal(3));
  await act(async () => { await fireEvent.press(screen.getByTestId(`review-seed-keep-${SEED}`)); });
  await waitFor(() => expect(screen.queryByTestId('review-conflict-note')).not.toBeNull());
  expect(screen.queryByTestId(`review-seed-failed-${SEED}`)).toBeNull();
  await act(async () => { await fireEvent.press(screen.getByTestId(`review-seed-keep-${SEED}`)); });
  await waitFor(() => expect(keep).toHaveBeenCalledTimes(2));
  expect(keep.mock.calls[1]![0]).toEqual(expect.objectContaining({ revision: 4 }));
});
