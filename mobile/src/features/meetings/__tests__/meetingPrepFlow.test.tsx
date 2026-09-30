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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { CaptureProvider, useCaptureFlow } from '../../capture/CaptureProvider';
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
import * as reminderEndpoints from '../../../api/endpoints/reminders';
import * as profileEndpoints from '../../../api/endpoints/profile';
import settingsFixture from '../../../api/__fixtures__/reminders.settingsDefault.json';
import emptyProfileFixture from '../../../api/__fixtures__/profile.empty.json';
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
/**
 * The phone's clock for every case: midday in the device zone (12:00 in
 * Asia/Jerusalem). Calendar shows the busy blocks of *today*, so a meeting
 * three hours after the wall clock left today's list from 21:00 on and 29 cases
 * failed every evening. Pinned, the day and the lead are the same at any hour,
 * in any zone the runner happens to be in.
 */
const NOW = new Date('2026-09-28T09:00:00.000Z');
/** Today, three hours from now: a meeting there is time to prepare for. */
const mockStart = new Date(NOW.getTime() + 3 * HOUR);
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
    prep: { ...fixture.prep, itemId: 'prep-1', remindAt, silentBecause: null, dueAt: START, startAt: START, endAt: END },
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

/** The capture flow, reachable from a test: Review's own edit sheet sets exactly this. */
const flowRef: { current: ReturnType<typeof useCaptureFlow> | null } = { current: null };
function FlowProbe() {
  const flow = useCaptureFlow();
  React.useEffect(() => { flowRef.current = flow; });
  return null;
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
              <FlowProbe />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryAllByTestId('calendar-busy-row').length).toBeGreaterThan(0));
}

beforeEach(async () => {
  // Only `Date` is faked: every timer stays real, so RNTL's `waitFor` and the
  // ring that passes while Review is open (n-2) run as they do on the phone,
  // with the clock moving on from NOW in real time.
  jest.useFakeTimers({
    now: NOW,
    advanceTimers: true,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
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
  jest.useRealTimers();
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
  it('cannot be sent empty, and never says the AI is off — it cannot be (2026-09-30)', async () => {
    // Even an account whose old record still says "declined".
    await show({ aiGranted: false });
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-sheet')).toBeTruthy());
    expect(screen.getByTestId('meeting-prep-submit').props.accessibilityState?.disabled).toBe(true);
    expect(screen.queryByTestId('meeting-prep-ai-off')).toBeNull();
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

describe('an appointment, and a step moved by quiet hours', () => {
  it('a dentist is «the appointment» in the sheet and in review, not «the meeting»', async () => {
    const dentist = meeting({ id: 'c-dentist', title: 'dentist 4pm' });
    jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: dentist, etag: null } as never);
    jest.spyOn(meetingEndpoints, 'prepareMeeting').mockResolvedValue(prepared());
    await show({ today: [dentist], aiGranted: true });
    await fireEvent.press(screen.getByTestId('calendar-item-c-dentist'));
    await waitFor(() => expect(screen.getByTestId('details-prepare')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('details-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-sheet')).toBeTruthy());
    expect(screen.getByText(en.xPrepareQuestionAppointment)).toBeTruthy();
    expect(screen.queryByText(en.xPrepareQuestion)).toBeNull();
    expect(String(screen.getByTestId('meeting-prep-when').props.children)).toMatch(/^Appointment: /);
    await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), NOTES);
    await fireEvent.press(screen.getByTestId('meeting-prep-submit'));
    await waitFor(() => expect(screen.getByTestId('review-source-meeting')).toBeTruthy());
    expect(screen.getByText(en.reviewSourceAppointment)).toBeTruthy();
  });

  it('the meeting sheet never reads "Meeting at Tomorrow"', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-when')).toBeTruthy());
    const when = String(screen.getByTestId('meeting-prep-when').props.children);
    expect(when).toMatch(/^Meeting: /);
    expect(when).not.toMatch(/ at /);
  });

  it('when quiet hours moved the prep step, review says where to, in one line', async () => {
    // Moved earlier by quiet hours, as `schedulePrepAt` moves it when the hour
    // before falls inside them — and still ahead of now: a ring already past
    // reads as too close (n-2). This meeting is three hours away.
    const moved = prepared();
    const eveningBefore = new Date(mockStart.getTime() - 2 * HOUR).toISOString();
    jest.spyOn(meetingEndpoints, 'prepareMeeting')
      .mockResolvedValue({ ...moved, prep: { ...moved.prep, remindAt: eveningBefore, adjustment: 'quiet_hours' } });
    await show({ aiGranted: true });
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), NOTES);
    await fireEvent.press(screen.getByTestId('meeting-prep-submit'));
    await waitFor(() => expect(screen.getByTestId('review-prep-quiet-moved')).toBeTruthy());
    const line = String(screen.getByTestId('review-prep-quiet-moved').props.children);
    expect(line.startsWith(en.reviewPrepQuietMoved.replace('{time}', ''))).toBe(true);
    const hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Jerusalem' }).format(new Date(eveningBefore));
    expect(line).toContain(hhmm);
  });

  /** Prepare through the sheet with this `prep` summary, and land on review. */
  async function reviewWith(prep: Partial<MeetingPrepResponse['prep']>) {
    const base = prepared();
    jest.spyOn(meetingEndpoints, 'prepareMeeting').mockResolvedValue({ ...base, prep: { ...base.prep, ...prep } });
    await show({ aiGranted: true });
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), NOTES);
    await fireEvent.press(screen.getByTestId('meeting-prep-submit'));
    await waitFor(() => expect(screen.getByTestId('review-source-meeting')).toBeTruthy());
  }

  const hhmmOf = (instant: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Jerusalem' }).format(new Date(instant));

  it.each(['short_notice', 'quiet_hours_unavoidable'] as const)('%s with a reminder that rings: review says the reminder moved, and to when (M-8)', async (adjustment) => {
    const soon = new Date(mockStart.getTime() - 20 * 60_000).toISOString();
    await reviewWith({ remindAt: soon, silentBecause: null, adjustment });
    const line = String(screen.getByTestId('review-prep-short-notice').props.children);
    expect(line.startsWith(en.reviewPrepShortNotice.replace('{time}', ''))).toBe(true);
    expect(line).toContain(hhmmOf(soon));
    expect(screen.queryByTestId('review-prep-quiet-moved')).toBeNull();
    expect(screen.queryByTestId('review-prep-no-reminder')).toBeNull();
  });

  it('too close for any reminder: review claims none, and says to start now (I-3)', async () => {
    await reviewWith({ remindAt: null, silentBecause: 'too_close', adjustment: 'short_notice' });
    expect(screen.getByTestId('review-prep-no-reminder').props.children).toBe(en.reviewPrepTooClose);
    expect(screen.queryByTestId('review-prep-short-notice')).toBeNull();
  });

  it('reminders off: review says nothing will ring', async () => {
    await reviewWith({ remindAt: null, silentBecause: 'reminders_off', adjustment: 'none' });
    expect(screen.getByTestId('review-prep-no-reminder').props.children).toBe(en.reviewPrepRemindersOff);
  });

  it('the survey said silent: review says it was their choice, not that reminders are off (n-6)', async () => {
    await reviewWith({ remindAt: null, silentBecause: 'silent_choice', adjustment: 'none' });
    expect(screen.getByTestId('review-prep-no-reminder').props.children).toBe(en.reviewPrepSilentChoice);
  });

  it('quiet hours leave no moment to ring: review says the reminder falls in them — true whether they end just before the meeting or the meeting is inside them (n-6, I-4)', async () => {
    // One `quiet_hours` answer covers both shapes (22:40 now, quiet 22:30–07:30):
    // a meeting at 07:32, two minutes after they end, and one at 06:00 or 00:00,
    // inside them. "Your quiet hours end just before it starts" was false for
    // the second; the line may only say what holds for both.
    await reviewWith({ remindAt: null, silentBecause: 'quiet_hours', adjustment: 'quiet_hours_unavoidable' });
    const line = screen.getByTestId('review-prep-no-reminder').props.children;
    expect(line).toBe(en.reviewPrepQuietHours);
    expect(line).toBe('The reminder would fall in your quiet hours, so nothing will ring.');
  });

  it('a claimed ring that passes while review is open: the line changes to too close then (n-2)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    const shortly = new Date(Date.now() + 1_500).toISOString();
    await reviewWith({ remindAt: shortly, silentBecause: null, adjustment: 'short_notice' });
    expect(screen.getByTestId('review-prep-short-notice')).toBeTruthy();
    await waitFor(
      () => expect(screen.getByTestId('review-prep-no-reminder').props.children).toBe(en.reviewPrepTooClose),
      { timeout: 6_000 },
    );
    expect(screen.queryByTestId('review-prep-short-notice')).toBeNull();
    // The line changed with nobody touching anything: VoiceOver is told
    // (POLISH-MOBILE review m3), once, and not the line Review opened with.
    await waitFor(() => expect(announce).toHaveBeenCalledWith(en.reviewPrepTooClose));
    expect(announce.mock.calls.filter(([text]) => text !== en.reviewPrepTooClose)).toEqual([]);
  });

  it.each(['none', 'short_notice'] as const)('a claimed ring that has already passed (%s): review says it is too close, not a stale time (n-2)', async (adjustment) => {
    // Review sat open past the ring: the phone skips a stage whose moment has
    // passed, so that time would be a reminder that never comes.
    const passed = new Date(Date.now() - 2 * 60_000).toISOString();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    announce.mockClear();
    await reviewWith({ remindAt: passed, silentBecause: null, adjustment });
    await waitFor(() => expect(screen.getByTestId('review-prep-no-reminder').props.children).toBe(en.reviewPrepTooClose));
    expect(screen.queryByTestId('review-prep-short-notice')).toBeNull();
    // That is the line Review opens with, so nothing is announced.
    expect(announce).not.toHaveBeenCalled();
  });

  describe('after the prep step is edited in review (FX1 re-review Minor 5)', () => {
    /** `YYYY-MM-DDTHH:mm` in the device zone, as the edit sheet writes it. */
    const localOf = (ms: number) => {
      const at = new Date(ms);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      return `${day}T${time}`;
    };
    const settingsWith = (extra: Record<string, unknown> = {}) => jest.spyOn(reminderEndpoints, 'getReminderSettings').mockResolvedValue({
      ...settingsFixture, reminderSettings: { ...settingsFixture.reminderSettings, quietHours: null, ...extra },
    } as never);
    const edit = async (localDateTime: string) => {
      await act(async () => { flowRef.current!.editItem('prep-1', { localDateTime }); });
    };

    it('the quiet-hours line goes once the step is moved; moved before the meeting it says it rings at the time shown (N7)', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      await reviewWith({ remindAt: new Date(mockStart.getTime() - 2 * HOUR).toISOString(), adjustment: 'quiet_hours' });
      expect(screen.getByTestId('review-prep-quiet-moved')).toBeTruthy();
      const moved = mockStart.getTime() - 30 * 60_000;
      await edit(localOf(moved));
      await waitFor(() => expect(screen.queryByTestId('review-prep-quiet-moved')).toBeNull());
      await waitFor(() => expect(screen.getByTestId('review-prep-rings-at')).toBeTruthy());
      expect(String(screen.getByTestId('review-prep-rings-at').props.children)).toContain(hhmmOf(new Date(moved).toISOString()));
      expect(screen.queryByTestId('review-prep-no-reminder')).toBeNull();
      expect(screen.queryByTestId('review-prep-after-meeting')).toBeNull();
    });

    it('moved to after the meeting, it says when the reminder really rings: a lead before, like any step', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      await reviewWith({});
      await edit(localOf(mockStart.getTime() + 30 * 60_000));
      await waitFor(() => expect(screen.getByTestId('review-prep-rings-at')).toBeTruthy());
      const line = String(screen.getByTestId('review-prep-rings-at').props.children);
      expect(line.startsWith(en.reviewPrepRingsAt.replace('{time}', ''))).toBe(true);
      expect(line).toContain(hhmmOf(new Date(mockStart.getTime() - 30 * 60_000).toISOString()));
    });

    it('moved to after the meeting, it also says the step is no longer before it, so a ring ahead of the card is not a surprise (N5)', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      await reviewWith({});
      await edit(localOf(mockStart.getTime() + 2 * HOUR));
      await waitFor(() => expect(screen.getByTestId('review-prep-after-meeting').props.children).toBe(en.reviewPrepAfterMeeting));
      await waitFor(() => expect(screen.getByTestId('review-prep-rings-at')).toBeTruthy());
      // The line still says when it really rings: the account's lead before the new time.
      expect(String(screen.getByTestId('review-prep-rings-at').props.children)).toContain(hhmmOf(new Date(mockStart.getTime() + HOUR).toISOString()));
    });

    it('for an appointment, the line says «the appointment», not «the meeting» (N5, review m1)', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      const dentist = meeting({ id: 'c-dentist', title: 'dentist 4pm' });
      jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: dentist, etag: null } as never);
      jest.spyOn(meetingEndpoints, 'prepareMeeting').mockResolvedValue(prepared());
      await show({ today: [dentist], aiGranted: true });
      await fireEvent.press(screen.getByTestId('calendar-item-c-dentist'));
      await waitFor(() => expect(screen.getByTestId('details-prepare')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('details-prepare'));
      await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
      await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), NOTES);
      await fireEvent.press(screen.getByTestId('meeting-prep-submit'));
      await waitFor(() => expect(screen.getByTestId('review-source-meeting')).toBeTruthy());
      await edit(localOf(mockStart.getTime() + 2 * HOUR));
      await waitFor(() => expect(screen.getByTestId('review-prep-after-meeting').props.children).toBe(en.reviewPrepAfterAppointment));
      expect(en.reviewPrepAfterAppointment).not.toBe(en.reviewPrepAfterMeeting);
    });

    it('moved to exactly the meeting start, it is not before the meeting either (N5)', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      await reviewWith({});
      await edit(localOf(mockStart.getTime()));
      await waitFor(() => expect(screen.getByTestId('review-prep-after-meeting').props.children).toBe(en.reviewPrepAfterMeeting));
    });

    it('with no time, it says nothing will ring', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      await reviewWith({});
      await edit('');
      await waitFor(() => expect(screen.getByTestId('review-prep-no-reminder').props.children).toBe(en.reviewPrepNoTime));
      expect(screen.queryByTestId('review-prep-rings-at')).toBeNull();
      expect(screen.queryByTestId('review-prep-after-meeting')).toBeNull();
    });

    /*
     * FY3 review m4: the line changed after an edit and nobody using a screen
     * reader was told. Android hears it from the live region the lines sit in;
     * VoiceOver has no live regions, so it is told the new line — once the
     * person has edited, never for the line Review opened with.
     */
    it('an edit that changes the line is announced; the line Review opened with is not', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
      // React Native's jest setup makes this a shared mock: earlier cases' calls stay on it.
      announce.mockClear();
      await reviewWith({});
      expect(screen.getByTestId('review-prep-live').props.accessibilityLiveRegion).toBe('polite');
      expect(announce).not.toHaveBeenCalled();
      await edit(localOf(mockStart.getTime() + 2 * HOUR));
      await waitFor(() => expect(screen.getByTestId('review-prep-rings-at')).toBeTruthy());
      const ring = String(screen.getByTestId('review-prep-rings-at').props.children);
      await waitFor(() => expect(announce).toHaveBeenLastCalledWith(`${en.reviewPrepAfterMeeting} ${ring}`));
      await edit('');
      await waitFor(() => expect(announce).toHaveBeenLastCalledWith(en.reviewPrepNoTime));
    });

    /*
     * POLISH-MOBILE review m2: with the settings still loading, the edit first
     * showed only "not before the meeting", and VoiceOver heard it — then heard
     * it again with the ring line once the settings landed. One announcement,
     * when the answer is whole.
     */
    it('announces an edit once, when the settings have answered', async () => {
      let release: (value: unknown) => void = () => {};
      jest.spyOn(reminderEndpoints, 'getReminderSettings').mockReturnValue(new Promise((resolve) => { release = resolve; }) as never);
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
      announce.mockClear();
      await reviewWith({});
      await edit(localOf(mockStart.getTime() + 2 * HOUR));
      await waitFor(() => expect(screen.getByTestId('review-prep-after-meeting')).toBeTruthy());
      expect(announce).not.toHaveBeenCalled();
      await act(async () => { release({ ...settingsFixture, reminderSettings: { ...settingsFixture.reminderSettings, quietHours: null } }); });
      await waitFor(() => expect(screen.getByTestId('review-prep-rings-at')).toBeTruthy());
      const ring = String(screen.getByTestId('review-prep-rings-at').props.children);
      await waitFor(() => expect(announce).toHaveBeenCalledWith(`${en.reviewPrepAfterMeeting} ${ring}`));
      expect(announce).toHaveBeenCalledTimes(1);
    });

    /* Review n3: settings that cannot be read still let VoiceOver hear what is known. */
    it('announces what is known when the settings cannot be read', async () => {
      jest.spyOn(reminderEndpoints, 'getReminderSettings').mockRejectedValue(new Error('offline'));
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
      announce.mockClear();
      await reviewWith({});
      await edit(localOf(mockStart.getTime() + 2 * HOUR));
      await waitFor(() => expect(announce).toHaveBeenCalledWith(en.reviewPrepAfterMeeting));
      expect(screen.queryByTestId('review-prep-rings-at')).toBeNull();
    });

    it('announces the proposed line again when an edit is taken back (m3)', async () => {
      settingsWith();
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
      announce.mockClear();
      await reviewWith({});
      await edit(localOf(mockStart.getTime() + 2 * HOUR));
      await waitFor(() => expect(screen.getByTestId('review-prep-after-meeting')).toBeTruthy());
      await edit(localOf(Date.parse(prepared().prep.remindAt!)));
      await waitFor(() => expect(screen.queryByTestId('review-prep-after-meeting')).toBeNull());
      const proposedLine = String(screen.getByTestId('review-prep-rings-at').props.children);
      await waitFor(() => expect(announce).toHaveBeenLastCalledWith(proposedLine));
    });

    it('with reminders off, an edited time still says nothing will ring, and why', async () => {
      settingsWith({ softEnabled: false });
      jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue(emptyProfileFixture as never);
      await reviewWith({ remindAt: null, silentBecause: 'reminders_off' });
      await edit(localOf(mockStart.getTime() - 30 * 60_000));
      await waitFor(() => expect(screen.getByTestId('review-prep-no-reminder').props.children).toBe(en.reviewPrepRemindersOff));
    });
  });

  it('as proposed, ringing at the time shown, review still says when: «التذكير رح يرن: …» (N7)', async () => {
    await reviewWith({});
    const remindAt = prepared().prep.remindAt!;
    const line = String(screen.getByTestId('review-prep-rings-at').props.children);
    expect(line.startsWith(en.reviewPrepRingsAt.replace('{time}', ''))).toBe(true);
    expect(line).toContain(hhmmOf(remindAt));
    expect(screen.queryByTestId('review-prep-no-reminder')).toBeNull();
    expect(screen.queryByTestId('review-prep-after-meeting')).toBeNull();
  });

  it('with no move, review has no quiet-hours line', async () => {
    jest.spyOn(meetingEndpoints, 'prepareMeeting').mockResolvedValue(prepared());
    await show({ aiGranted: true });
    await fireEvent.press(screen.getByTestId('calendar-busy-prepare'));
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('meeting-prep-notes'), NOTES);
    await fireEvent.press(screen.getByTestId('meeting-prep-submit'));
    await waitFor(() => expect(screen.getByTestId('review-source-meeting')).toBeTruthy());
    expect(screen.queryByTestId('review-prep-quiet-moved')).toBeNull();
  });
});
