/**
 * A Gmail scan the model stopped part-way says so on the review screen
 * (CL6a review I2).
 *
 * The server reads a scan in at most three model calls and stops when the
 * model will not answer; the messages it did not read are counted in
 * `share.metrics`, never folded into "nothing to save". What *was* read still
 * opens in review, and the review says how much of the mail that was.
 *
 * Every proposal here is a recorded fixture, counts and all (CL6a round 2,
 * N4): `google.gmailScanPartial` is a scan the per-minute model cap stopped
 * after one call, and `google.gmailScanBudget` one the three-call budget
 * stopped after nine messages. Only the first is worth pressing again for
 * soon, so only the first says so (N2).
 */
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { CaptureProvider, useCaptureFlow } from '../../capture/CaptureProvider';
import { ReviewScreen } from '../../../screens/ReviewScreen';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { strings } from '../../../i18n/strings';
import type { CaptureProposal } from '../../../api/schemas/capture';
import { shareProposalSchema, type ShareProposal } from '../../../api/schemas/share';
import gmailScan from '../../../api/__fixtures__/google.gmailScan.json';
import gmailScanNotRead from '../../../api/__fixtures__/google.gmailScanNotRead.json';
import gmailScanPartial from '../../../api/__fixtures__/google.gmailScanPartial.json';
import gmailScanBudget from '../../../api/__fixtures__/google.gmailScanBudget.json';
import { mailboxShortfall } from '../mailboxShortfall';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
let client: QueryClient;

function Mount({ proposal }: { proposal: CaptureProposal }) {
  const { adoptProposal } = useCaptureFlow();
  useEffect(() => { adoptProposal(proposal, 'share'); }, [adoptProposal, proposal]);
  return <ReviewScreen />;
}

async function review(proposal: ShareProposal) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AppProvider>
            <CaptureProvider>
              <Mount proposal={proposal as unknown as CaptureProposal} />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('review-source')).toBeTruthy());
}

const scanned = shareProposalSchema.parse(gmailScan);
const partial = shareProposalSchema.parse(gmailScanPartial);
const budgeted = shareProposalSchema.parse(gmailScanBudget);

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'mailbox-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: 'mailbox-user', trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: 'mailbox-user', recorded: true, eventId: 'e-1' } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('how much of the mailbox was read', () => {
  it('counts what the server reported, and nothing for a scan that read everything', () => {
    expect(mailboxShortfall(scanned)).toBeNull();
    expect(mailboxShortfall(partial)).toEqual({ read: 3, total: 20, retryHelps: true });
    expect(mailboxShortfall(budgeted)).toEqual({ read: 9, total: 20, retryHelps: false });
    expect(mailboxShortfall(shareProposalSchema.parse(gmailScanNotRead))).toEqual({ read: 0, total: 1, retryHelps: true });
  });

  it('a scan the model cap stopped says how many it read, and to try again soon for the rest', async () => {
    await review(partial);
    expect(screen.getByTestId('review-mailbox-partial').props.children)
      .toBe('Read 3 of 20 emails. Try again soon for the rest.');
  });

  it('a scan the call budget stopped says how many it read, and does not promise the rest on a retry', async () => {
    await review(budgeted);
    expect(screen.getByTestId('review-mailbox-partial').props.children)
      .toBe('Read the newest 9 of 20 emails.');
  });

  it('a scan that read everything shows no such line', async () => {
    await review(scanned);
    expect(screen.queryByTestId('review-mailbox-partial')).toBeNull();
  });
});
