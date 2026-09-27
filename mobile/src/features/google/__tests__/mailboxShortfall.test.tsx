/**
 * A Gmail scan the model stopped part-way says so on the review screen
 * (CL6a review I2).
 *
 * The server reads a scan in at most three model calls and stops when the
 * model will not answer; the messages it did not read are counted in
 * `share.metrics`, never folded into "nothing to save". What *was* read still
 * opens in review, and the review says how much of the mail that was.
 *
 * The proposal is the recorded `google.gmailScan` fixture. The partial case
 * changes only its counts, to the combination the route suite records for a
 * scan whose call budget ran out (9 read, 11 not read, 20 found).
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
const partial = shareProposalSchema.parse({
  ...gmailScan,
  share: { ...gmailScan.share, metrics: { ...gmailScan.share.metrics, messagesFound: 20, messagesRead: 9, messagesNotRead: 11 } },
});

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
    expect(mailboxShortfall(partial)).toEqual({ read: 9, total: 20 });
    expect(mailboxShortfall(shareProposalSchema.parse(gmailScanNotRead))).toEqual({ read: 0, total: 1 });
  });

  it('the review of a partly-read scan says how many emails it read', async () => {
    await review(partial);
    expect(screen.getByTestId('review-mailbox-partial').props.children)
      .toBe('Read 9 of 20 emails. Try again soon for the rest.');
    expect(strings.en.googleGmailPartial).toBe('Read {read} of {total} emails. Try again soon for the rest.');
  });

  it('a scan that read everything shows no such line', async () => {
    await review(scanned);
    expect(screen.queryByTestId('review-mailbox-partial')).toBeNull();
  });
});
