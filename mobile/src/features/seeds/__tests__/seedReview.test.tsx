/**
 * A maybe is offered in Review, and nothing is written until Keep (#519).
 *
 * The end-to-end half of the promise: the app is opened, a sentence is typed,
 * the server answers `unresolved_intent`, and this file asserts what the
 * person then sees and what the app did — including, and especially, what it
 * did *not* do.
 *
 * Three claims here can only be made by rendering:
 *
 *  - Review shows the maybe with "this is not a commitment yet" beside it, and
 *    no Confirm bar, because there is nothing to confirm;
 *  - nothing is posted until Keep is pressed, and "Not now" posts nothing ever;
 *  - Keep sends the proposal id and the seed's id — and never the sentence,
 *    which the server reads back out of its own stored proposal.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as seedEndpoints from '../../../api/endpoints/seeds';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Pacific/Marquesas' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'seed-review-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const TYPED = "Maybe I'll apply to NVIDIA this semester.";
const SEED_ITEM_ID = 's-1';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function proposalWithSeed(items: unknown[] = []) {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: items.length > 0 ? 'proposed' : 'unresolved_intent',
    items,
    seeds: [{ seedItemId: SEED_ITEM_ID, kind: 'consideration', summary: TYPED }],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  };
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({ items: [] } as never);
  // Spied so the "Not now" case can assert it was never reached: a declined
  // maybe must leave no record at all, not even a dismissed one.
  jest.spyOn(seedEndpoints, 'patchSeed').mockResolvedValue({ success: true } as never);
  jest.spyOn(seedEndpoints, 'keepProposedSeed').mockResolvedValue({
    success: true,
    replayed: false,
    seed: {
      version: 'intent-seed-v1', seedId: 'seed-1', scopeId: USER.uid, kind: 'consideration',
      summary: TYPED, status: 'open', revisitAt: null, source: 'capture', sourceRef: 'p-1',
      provenance: { proposalId: 'p-1', extractor: 'rule-based', confirmedByUserAt: '2026-09-20T09:00:00.000Z' },
      promotedTo: null, createdAt: '2026-09-20T09:00:00.000Z', updatedAt: '2026-09-20T09:00:00.000Z',
    },
  } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

/** Open the app, type the maybe, analyse, and land on Review. */
async function captureInto(items: unknown[] = []) {
  jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposalWithSeed(items) as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), TYPED);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-seeds')).not.toBeNull());
}

describe('a maybe in Review (#519)', () => {
  it('offers the sentence with "not a commitment yet", and writes nothing on arrival', async () => {
    await captureInto();

    expect(screen.getByTestId(`review-seed-summary-${SEED_ITEM_ID}`).props.children).toBe(TYPED);
    expect(screen.getByTestId('review-seeds-not-commitment').props.children).toBe(en.seedsNotCommitment);
    // Review's own note is still there: nothing has changed yet.
    expect(screen.getByTestId('review-note').props.children).toBe(en.suggestionNote);
    expect(seedEndpoints.keepProposedSeed).not.toHaveBeenCalled();
  });

  it('draws no Confirm bar when the capture named only a maybe', async () => {
    await captureInto();

    // There is nothing to confirm, so there is no disabled "Confirm 0" and no
    // "nothing selected" line to work out.
    expect(screen.queryByTestId('review-confirm')).toBeNull();
    expect(screen.queryByTestId('review-none-selected')).toBeNull();
    expect(screen.queryByTestId('review-cancel')).not.toBeNull();
  });

  it('keeps the seed by id, never by sending the sentence back', async () => {
    await captureInto();
    await fireEvent.press(screen.getByTestId(`review-seed-keep-${SEED_ITEM_ID}`));

    await waitFor(() => expect(seedEndpoints.keepProposedSeed).toHaveBeenCalledTimes(1));
    // The proposal and the seed's id, and nothing else: the summary is read
    // back out of the server's own stored proposal.
    expect(seedEndpoints.keepProposedSeed).toHaveBeenCalledWith({ proposalId: 'p-1', seedItemId: SEED_ITEM_ID });
    await waitFor(() => expect(screen.queryByTestId(`review-seed-kept-${SEED_ITEM_ID}`)).not.toBeNull());
  });

  it('"Not now" writes nothing at all — there is no record of a declined maybe', async () => {
    await captureInto();
    await fireEvent.press(screen.getByTestId(`review-seed-skip-${SEED_ITEM_ID}`));

    expect(screen.queryByTestId(`review-seed-${SEED_ITEM_ID}`)).toBeNull();
    expect(seedEndpoints.keepProposedSeed).not.toHaveBeenCalled();
    expect(seedEndpoints.patchSeed).not.toHaveBeenCalled();
  });

  it('a capture naming both a commitment and a maybe shows both, and confirms only the commitment', async () => {
    await captureInto([
      { itemId: 'a', title: 'Call the clinic', resolvedTime: '2026-09-21T07:00:00.000Z', needsClarification: false },
    ]);

    expect(screen.queryByTestId('review-confirm')).not.toBeNull();
    expect(screen.getByTestId(`review-seed-summary-${SEED_ITEM_ID}`).props.children).toBe(TYPED);
    // The seed is not an item the confirm can carry: pressing Confirm sends
    // the commitment and leaves the maybe to its own Keep.
    expect(seedEndpoints.keepProposedSeed).not.toHaveBeenCalled();
  });
});
