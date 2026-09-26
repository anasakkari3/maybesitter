/**
 * «حضّرني», end to end on the phone (closure lane CL5a).
 *
 * The owner found «حضّرني» labelled Coming soon. What PASS means here: from a
 * busy block on the Calendar tab — which has no title — or from a meeting
 * commitment, the person taps «حضّرني», the sheet asks «شو الاجتماع وشو بدك
 * تحضّر؟», the notes go to `/api/mobile/meetings/prepare` with the block's times
 * and nothing else, and the proposal that comes back is reviewed and confirmed
 * through the ordinary capture review — nothing is saved before that.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { CaptureProvider } from '../../capture/CaptureProvider';
import { CaptureFlow } from '../../capture/CaptureFlow';
import { CalendarScreen } from '../../../screens/CalendarScreen';
import { DetailsScreen } from '../../../screens/DetailsScreen';
import { SheetHost } from '../../../screens/Sheets';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { ValidationError } from '../../../api/errors';
import type { Commitment } from '../../../api/schemas/common';
import { meetingPrepResponseSchema, type MeetingPrepResponse } from '../../../api/schemas/meetings';
import { captureConfirmationSchema } from '../../../api/schemas/capture';
import * as meetingEndpoints from '../../../api/endpoints/meetings';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as consentEndpoints from '../../../api/endpoints/consents';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as activityEndpoints from '../../../api/endpoints/activity';
import * as categoryEndpoints from '../../../api/endpoints/categories';
import en from '../../../i18n/locales/en.json';
import preparedFixture from '../../../api/__fixtures__/meetings.preparedGemini.json';
import confirmationFixture from '../../../api/__fixtures__/capture.confirmation.json';
import trustFixture from '../../../api/__fixtures__/trust.state.json';
import consentsFixture from '../../../api/__fixtures__/consents.view.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));
jest.mock('../../../i18n/timezone', () => ({
  ...(jest.requireActual('../../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

const HOUR = 3_600_000;
/** Today, three hours from now: a meeting there is time to prepare for. */
const mockStart = new Date(Math.ceil((Date.now() + 3 * HOUR) / (5 * 60_000)) * 5 * 60_000);
const START = mockStart.toISOString();
const END = new Date(mockStart.getTime() + 45 * 60_000).toISOString();
/** What the phone's calendar hands over: times, never a title. */
const mockBlocks = [
  { nativeId: 'evt-soon', startAt: START, endAt: END, allDay: false },
  { nativeId: 'evt-allday', startAt: new Date(mockStart.getTime() - 2 * HOUR).toISOString(), endAt: new Date(mockStart.getTime() + 20 * HOUR).toISOString(), allDay: true },
];
jest.mock('../../calendar/useBusyCalendar', () => ({ useBusyBlocks: () => mockBlocks }));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'prep-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const NOTES = 'Budget meeting with my manager.\nI need to check the Q3 numbers and print the report.';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

/** The recorded route response, re-timed to this test's block. */
function prepared(): MeetingPrepResponse {
  const fixture = meetingPrepResponseSchema.parse(preparedFixture);
  const remindAt = new Date(mockStart.getTime() - HOUR).toISOString();
  return {
    ...fixture,
    proposal: {
      ...fixture.proposal,
      proposalId: 'p-meeting',
      items: [
        { ...fixture.proposal.items[0]!, itemId: 'prep-1', title: 'Check the Q3 numbers and print the report', resolvedTime: remindAt },
        { ...fixture.proposal.items[1]!, itemId: 'follow-1', title: 'Send the summary to Sami' },
      ],
    },
    prep: { ...fixture.prep, itemId: 'prep-1', remindAt, startAt: START, endAt: END },
  };
}

function meeting(extra: Partial<Commitment> = {}): Commitment {
  return {
    id: 'c-meeting', kind: 'task', title: 'Meeting with Sami', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: START, endAt: null, remindAt: null, allDay: false, timezone: 'Asia/Jerusalem' },
    currentAckState: 'not_seen', postponedUntil: null, createdAt: START, updatedAt: START, confirmedAt: START,
    completedAt: null, droppedAt: null, ...extra,
  } as Commitment;
}

/** Calendar, or the details it opened, with the sheet host over it — and capture when it opens. */
function Stage() {
  const { s } = useApp();
  if (s.screen === 'capture') return <CaptureFlow />;
  return (
    <>
      {s.screen === 'details' ? <DetailsScreen /> : <CalendarScreen />}
      <SheetHost key={s.sheet ?? 'none'} />
    </>
  );
}

async function show(options: { aiGranted?: boolean; today?: Commitment[] } = {}) {
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: options.today ?? [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue({
    ...trustFixture, trust: { ...trustFixture.trust, calendarConsent: true },
  } as never);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
    ...consentsFixture,
    aiProcessing: { ...consentsFixture.aiProcessing, state: options.aiGranted ? 'granted' : 'declined', asked: true },
  } as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider repository={repository} isDevBundle={false}>
          <AppProvider>
            <CaptureProvider>
              <Stage />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryAllByTestId('calendar-busy-row').length).toBeGreaterThan(0));
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent').mockResolvedValue({ success: true, recorded: true } as never);
  jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({ items: [], nextCursor: null } as never);
  jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockResolvedValue({ categoryPreferences: { enabled: [], showFilterBar: false } } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('the entry points', () => {
  it('a timed busy block that has not started offers «حضّرني»; an all-day one does not', async () => {
    await show();
    const rows = screen.getAllByTestId('calendar-busy-row');
    const offered = rows.filter((row) => within(row).queryByTestId('calendar-busy-prepare') !== null);
    expect(offered).toHaveLength(1);
    expect(within(offered[0]!).getByText(en.xPrepare)).toBeTruthy();
  });

  it('the busy block opens the sheet with the question and the meeting time', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-sheet')).toBeTruthy());
    expect(screen.getByText(en.xPrepareQuestion)).toBeTruthy();
    expect(screen.getByTestId('meeting-prep-when')).toBeTruthy();
  });

  it('a meeting commitment offers «حضّرني» on its details; an errand does not', async () => {
    jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: meeting(), etag: null } as never);
    await show({ today: [meeting()] });
    await fireEvent.press(screen.getByTestId('calendar-item-c-meeting'));
    await waitFor(() => expect(screen.getByTestId('details-prepare')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('details-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-sheet')).toBeTruthy());
  });

  it('an errand commitment has no «حضّرني»', async () => {
    const errand = meeting({ id: 'c-errand', title: 'Buy milk' });
    jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: errand, etag: null } as never);
    await show({ today: [errand] });
    await fireEvent.press(screen.getByTestId('calendar-item-c-errand'));
    await waitFor(() => expect(screen.getByTestId('details-title')).toBeTruthy());
    expect(screen.queryByTestId('details-prepare')).toBeNull();
  });
});

describe('the sheet', () => {
  it('cannot be sent empty, and says when AI is off that the first step written is used', async () => {
    await show({ aiGranted: false });
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-sheet')).toBeTruthy());
    expect(screen.getByTestId('meeting-prep-submit').props.accessibilityState?.disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId('meeting-prep-ai-off')).toBeTruthy());
    expect(screen.getByText(en.xPrepareAiOff)).toBeTruthy();
  });

  it('sends the notes with the block times and nothing else', async () => {
    const prepare = jest.spyOn(meetingEndpoints, 'prepareMeeting').mockResolvedValue(prepared());
    await show({ aiGranted: true });
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    expect(screen.queryByTestId('meeting-prep-ai-off')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), `  ${NOTES}  `);
    await fireEvent.press(screen.getByTestId('meeting-prep-submit'));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(prepare.mock.calls[0]![0]).toEqual({ notes: NOTES, startAt: START, endAt: END, timezone: 'Asia/Jerusalem' });
  });

  it('a failure keeps the notes and says why, announced', async () => {
    jest.spyOn(meetingEndpoints, 'prepareMeeting').mockRejectedValue(new ValidationError('refused', 'meeting_too_soon'));
    await show();
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), NOTES);
    await fireEvent.press(screen.getByTestId('meeting-prep-submit'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-problem')).toBeTruthy());
    expect(screen.getByText(en.xPrepareTooSoon)).toBeTruthy();
    expect(screen.getByTestId('meeting-prep-notes').props.value).toBe(NOTES);
  });
});

describe('review and confirm', () => {
  it('the proposal is reviewed in capture, nothing is saved until Confirm, and Confirm sends the proposal\'s items', async () => {
    jest.spyOn(meetingEndpoints, 'prepareMeeting').mockResolvedValue(prepared());
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(captureConfirmationSchema.parse(confirmationFixture));
    await show({ aiGranted: true });
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), NOTES);
    await fireEvent.press(screen.getByTestId('meeting-prep-submit'));

    await waitFor(() => expect(screen.getByTestId('review-source-meeting')).toBeTruthy());
    expect(screen.getByText(en.reviewSourceMeeting)).toBeTruthy();
    expect(screen.getByText('Check the Q3 numbers and print the report')).toBeTruthy();
    expect(screen.getByText('Send the summary to Sami')).toBeTruthy();
    // The rule every proposal carries: nothing has changed yet.
    expect(screen.getByTestId('review-note')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).toMatchObject({ proposalId: 'p-meeting', itemIds: ['prep-1', 'follow-1'] });
  });
});
