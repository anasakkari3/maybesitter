import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { IntelligencePanel } from '../IntelligencePanel';
import { FeatureUnavailableError, ForbiddenError, NetworkError } from '../../../api/errors';
import en from '../../../i18n/locales/en.json';
import { AccessibilityInfo, Keyboard, Text } from 'react-native';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { DEFAULT_WAIT_MS, resetVisitThrottleForTests } from '../../../lib/deviceSettings/visitThrottle';

const mockAnalyze = jest.fn<any>();
const mockGenerate = jest.fn<any>();
const mockInbox = jest.fn<any>();
const mockDecide = jest.fn<any>();
const mockReview = jest.fn<any>();
const mockScan = jest.fn<any>();
const mockMonitor = jest.fn<any>();
const mockSetMonitor = jest.fn<any>();
const onChanged = jest.fn();
let currentInbox: any;
let mockRecommendationState: 'granted' | 'declined' = 'granted';

let mockPlanPath: { isPending: boolean; error: unknown; data: unknown[] | undefined } = { isPending: false, error: null, data: [] };
jest.mock('../../../api/queries', () => ({
  useConsents: () => ({ data: { recommendations: { state: mockRecommendationState } } }),
  // The plan path (M3a) learns whether it is on from Today's later-week read.
  useUpcomingPlans: () => mockPlanPath,
  useUid: () => 'panel-user',
  useInvalidateAfterPlanConfirm: () => () => undefined,
}));

const mockPreview = jest.fn<any>();
jest.mock('../../../api/endpoints/goalPlan', () => ({
  previewStatementGoal: (...args: unknown[]) => mockPreview(...args),
}));

jest.mock('../../../api/endpoints/intelligence', () => ({
  analyzeIntelligenceStatement: (...args: unknown[]) => mockAnalyze(...args),
  generateIntelligenceSuggestions: (...args: unknown[]) => mockGenerate(...args),
  getIntelligenceInbox: (...args: unknown[]) => mockInbox(...args),
  decideIntelligenceSuggestion: (...args: unknown[]) => mockDecide(...args),
  reviewIntelligenceObservation: (...args: unknown[]) => mockReview(...args),
  scanGmailForIntelligence: (...args: unknown[]) => mockScan(...args),
  getGmailIntelligenceMonitor: (...args: unknown[]) => mockMonitor(...args),
  setGmailIntelligenceMonitor: (...args: unknown[]) => mockSetMonitor(...args),
}));

const observedAt = '2026-09-30T10:00:00.000Z';
const evidence = {
  id: 'obs-1', kind: 'goal', evidence: 'I want more Pilates time', confidence: 1,
  source: 'manual', sourceRef: 'note-1', observedAt, review: 'pending', reviewedAt: null, linkedMemoryId: null,
};
const suggestion = {
  id: 'proposal-1', kind: 'action', title: 'Find a Pilates class', reason: 'You want more Pilates time',
  observationIds: ['obs-1'], confidence: 0.8, durationMinutes: 30,
  status: 'pending', decidedAt: null, linkedEntityId: null, generatedAt: observedAt,
};

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER = { uid: 'panel-user', email: 'p@example.com', emailVerified: true, displayName: 'P', providerIds: ['password'] };
const wrap = (props: Partial<React.ComponentProps<typeof IntelligencePanel>> = {}) => {
  const repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  return <SafeAreaProvider initialMetrics={metrics}><AppProvider><AuthProvider repository={repository} isDevBundle={false}>
    <IntelligencePanel onChanged={onChanged} {...props} />
  </AuthProvider></AppProvider></SafeAreaProvider>;
};
const watching = () => wrap({ autoGenerate: true, whenOff: <Text testID="off">off</Text> });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

beforeEach(async () => {
  jest.clearAllMocks();
  mockRecommendationState = 'granted';
  // The production build (review of 2026-10-03): the loop was released to
  // production on 2026-10-01, and whether it shows is the server's answer.
  process.env.EXPO_PUBLIC_APP_ENV = 'production';
  await AsyncStorage.clear();
  resetVisitThrottleForTests();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  currentInbox = { success: true, observations: [], suggestions: [], schedule: [] };
  mockInbox.mockImplementation(() => Promise.resolve(currentInbox));
  mockAnalyze.mockResolvedValue({ success: true, observations: [evidence] });
  mockGenerate.mockResolvedValue({ success: true, suggestions: [suggestion], schedule: [] });
  mockDecide.mockResolvedValue({ success: true, suggestion: { ...suggestion, status: 'accepted' } });
  mockMonitor.mockResolvedValue({ success: true, enabled: false, lastSuccessAt: null, error: null });
  mockSetMonitor.mockResolvedValue({ success: true, enabled: true, lastSuccessAt: null, error: null });
});
afterEach(async () => { await cleanup(); resetAuthForTests(); delete process.env.EXPO_PUBLIC_APP_ENV; jest.useRealTimers(); });

it('keeps requesting Gmail pages until the whole week is complete', async () => {
  mockScan
    .mockResolvedValueOnce({ success: true, messagesRead: 3, observations: [], scan: { status: 'running', messagesVisited: 3 } })
    .mockResolvedValueOnce({ success: true, messagesRead: 3, observations: [], scan: { status: 'running', messagesVisited: 6 } })
    .mockResolvedValueOnce({ success: true, messagesRead: 1, observations: [], scan: { status: 'complete', messagesVisited: 7 } });
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-scan')).not.toBeNull());
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan')); });
  // A press only explains; «Continue» runs it (owner audit 2026-10-06).
  expect(mockScan).not.toHaveBeenCalled();
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan-confirm')); });
  await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('intelligence-status-text')).toHaveTextContent('Done — checked 7 emails from the past week'));
});

it('takes a wish through analysis and an explicit confirmation of what came back', async () => {
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'I want more Pilates time');
  await waitFor(() => expect(screen.getByTestId('intelligence-statement').props.value).toBe('I want more Pilates time'));
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze-confirm')); });
  await waitFor(() => expect(mockAnalyze).toHaveBeenCalledWith('I want more Pilates time'));
  await waitFor(() => expect(mockInbox).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/Find a Pilates class/)).not.toBeNull());
  expect(mockDecide).not.toHaveBeenCalled();
  await act(async () => { await fireEvent.press(screen.getByText('Add to my plan')); });
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('proposal-1', 'accept', undefined, undefined));
});

// The plan path mounts a second flow under the panel; under a loaded machine its first frames take longer than waitFor's default second.
const LOADED = { timeout: 5_000 };

it('«Suggest a plan» needs a statement, and opens the plan path at its summary (M3a)', async () => {
  mockPreview.mockResolvedValue({ success: true, summaryId: 's1', revision: 1, understood: { goalText: 'Run a 5k' }, expiresAt: '2026-09-30T10:30:00.000Z' });
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-plan-flow')).not.toBeNull(), LOADED);
  // The old card-by-card «Suggest steps» is gone: the plan path replaced it.
  expect(screen.queryByTestId('intelligence-generate')).toBeNull();
  expect(screen.getByTestId('intelligence-plan-flow').props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'I want to run a 5k');
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-plan-flow')); });
  await waitFor(() => expect(screen.queryByTestId('plan-summary')).not.toBeNull(), LOADED);
  expect(mockPreview).toHaveBeenCalledWith('I want to run a 5k', 'en');
  expect(mockGenerate).not.toHaveBeenCalled();
}, 15_000);

it('«افهم» on a plan request opens the plan path instead of listing observations (M3A-032)', async () => {
  mockAnalyze.mockResolvedValueOnce({ success: true, observations: [], route: 'plan_flow' });
  mockPreview.mockResolvedValue({ success: true, summaryId: 's1', revision: 1, understood: { goalText: 'Lose weight' }, expiresAt: '2026-09-30T10:30:00.000Z' });
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull(), LOADED);
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'build me a plan to lose weight');
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze-confirm')); });
  await waitFor(() => expect(screen.queryByTestId('plan-summary')).not.toBeNull(), LOADED);
  expect(mockPreview).toHaveBeenCalledWith('build me a plan to lose weight', 'en');
}, 15_000);

it('hides «Suggest a plan» when the plan path is off on the server', async () => {
  mockPlanPath = { isPending: false, error: new FeatureUnavailableError('off'), data: undefined };
  try {
    await render(wrap());
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
    expect(screen.queryByTestId('intelligence-plan-flow')).toBeNull();
  } finally {
    mockPlanPath = { isPending: false, error: null, data: [] };
  }
});

it('lets the person correct a suggestion before accepting it', async () => {
  const slot = { startsAt: '2026-09-30T11:00:00.000Z', endsAt: '2026-09-30T11:30:00.000Z' };
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion],
    schedule: [{ suggestionId: suggestion.id, slot, reason: null }] };
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-edit-proposal-1')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('intelligence-edit-proposal-1'), 'Book a Pilates class');
  await act(async () => { await fireEvent.press(screen.getByText('Add to my plan')); });
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('proposal-1', 'accept', 'Book a Pilates class', slot));
});

it('shows in a production build when the server answers, with each suggestion marked as only a suggestion', async () => {
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
  expect(screen.getByText(/Find a Pilates class/)).toBeTruthy();
  expect(within(screen.getByTestId('intelligence-suggestion-proposal-1')).getByText(new RegExp(`From: .?${evidence.evidence}`))).toBeTruthy();
  expect(screen.getAllByText(en.suggestionNote)).toHaveLength(1);
  // Showing is not deciding.
  expect(mockDecide).not.toHaveBeenCalled();
  expect(mockGenerate).not.toHaveBeenCalled();
});

it('keeps evidence review available but does not show or generate suggestions when recommendations are off', async () => {
  mockRecommendationState = 'declined';
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await render(watching());
  await waitFor(() => expect(screen.queryByTestId('intelligence-observation-obs-1')).not.toBeNull());
  expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).toBeNull();
  expect(screen.queryByTestId('intelligence-generate')).toBeNull();
  await settle();
  expect(mockGenerate).not.toHaveBeenCalled();
});

it('on «يتابع لك» shows what is waiting first, then asks as a visit and refreshes only for something new', async () => {
  const fresh = { ...suggestion, id: 'proposal-2', title: 'Book a trial class' };
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  let answer!: (value: unknown) => void;
  mockGenerate.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  await render(watching());
  // The model is still thinking; the review is already there.
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockGenerate).toHaveBeenCalledWith({ visit: true });
  expect(mockInbox).toHaveBeenCalledTimes(1);
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion, fresh], schedule: [] };
  await act(async () => { answer({ success: true, suggestions: [suggestion, fresh], schedule: [], nextVisitAt: new Date(Date.now() + 3_600_000).toISOString() }); });
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-2')).not.toBeNull());
  expect(mockInbox).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('off')).toBeNull();
  await act(async () => { await fireEvent.press(within(screen.getByTestId('intelligence-suggestion-proposal-1')).getByText('Not for me')); });
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('proposal-1', 'dismiss'));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it('a visit that brings nothing new costs no second read', async () => {
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  mockGenerate.mockResolvedValue({ success: true, suggestions: [suggestion], schedule: [], nextVisitAt: new Date(Date.now() + 3_600_000).toISOString() });
  await render(watching());
  await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
  await settle();
  expect(mockInbox).toHaveBeenCalledTimes(1);
});

it('remounting does not ask again before the server said so', async () => {
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  mockGenerate.mockResolvedValue({ success: true, suggestions: [suggestion], schedule: [], nextVisitAt: new Date(Date.now() + 3_600_000).toISOString() });
  for (let i = 0; i < 4; i += 1) {
    await render(watching());
    await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
    await settle();
    await cleanup();
  }
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockInbox).toHaveBeenCalledTimes(4);
});

it('against a server that predates the visit policy, the phone waits its own six hours', async () => {
  const start = Date.parse('2026-10-03T08:00:00.000Z');
  let clock = start;
  const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  try {
    currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
    // No nextVisitAt: today's production server.
    mockGenerate.mockResolvedValue({ success: true, suggestions: [suggestion], schedule: [] });
    const mount = async () => {
      await render(watching());
      await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
      await settle();
      await cleanup();
    };
    await mount();
    clock = start + DEFAULT_WAIT_MS - 60_000;
    await mount();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    clock = start + DEFAULT_WAIT_MS;
    await mount();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  } finally { now.mockRestore(); }
});

it.each([
  ['the loop switched off (404 feature_unavailable)', () => new FeatureUnavailableError('not found')],
  ['AI consent refused (403 consent_required)', () => new ForbiddenError('forbidden', 'consent_required')],
])('steps aside cleanly when %s: no error, no claim of a suggestion', async (_label, error) => {
  mockInbox.mockRejectedValue(error());
  await render(watching());
  await waitFor(() => expect(screen.queryByTestId('off')).not.toBeNull());
  expect(screen.queryByTestId('intelligence-statement')).toBeNull();
  expect(screen.queryByText(en.suggestionNote)).toBeNull();
  expect(screen.queryByTestId('query-error')).toBeNull();
  expect(screen.queryByText(en.errorsRetry)).toBeNull();
  await settle();
  expect(mockGenerate).not.toHaveBeenCalled();
});

it('says what it understood before asking, never asks about the person\'s own records, and keeps the questions below the suggestions', async () => {
  const own = (id: string, source: string) => ({ ...evidence, id, source, kind: 'commitment', evidence: `own ${id}` });
  const understood = (id: string, kind: string, text: string) => ({ ...evidence, id, kind, evidence: text });
  currentInbox = { success: true, schedule: [], suggestions: [suggestion], observations: [
    understood('o-event', 'event', 'Dentist'),
    own('o-memory', 'memory'), own('o-commitment', 'commitment'), { ...own('o-behavior', 'behavior'), kind: 'outcome' },
    understood('o-goal', 'goal', 'Learn React'),
    understood('o-a', 'request', 'Send the form'), understood('o-b', 'constraint', 'No driving at night'),
    understood('o-c', 'preference', 'Mornings'),
  ] };
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-observation-o-event')).not.toBeNull());
  expect(within(screen.getByTestId('intelligence-observation-o-event')).getByText(/I understood .{1,3}Dentist.{1,3} as an appointment you have\. Is that right\?/)).toBeTruthy();
  expect(within(screen.getByTestId('intelligence-observation-o-goal')).getByText(/as a goal of yours/)).toBeTruthy();
  for (const id of ['o-memory', 'o-commitment', 'o-behavior']) expect(screen.queryByTestId(`intelligence-observation-${id}`)).toBeNull();
  const cards = screen.getAllByTestId(/^intelligence-(suggestion|observation)-/).map(node => node.props.testID as string);
  expect(cards[0]).toBe('intelligence-suggestion-proposal-1');
  expect(cards.filter(id => id.startsWith('intelligence-observation-'))).toHaveLength(4);
});

it('hides on the Goals screen when the server has the loop off', async () => {
  mockInbox.mockRejectedValue(new FeatureUnavailableError('not found'));
  await render(wrap());
  await waitFor(() => expect(mockInbox).toHaveBeenCalled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.queryByTestId('intelligence-statement')).toBeNull();
  expect(screen.queryByText(en.errorsFeatureDisabled)).toBeNull();
});

it('a failed visit generation still shows what is already waiting; a dead Gmail switch does not hide the review', async () => {
  mockGenerate.mockRejectedValue(new NetworkError('offline'));
  mockMonitor.mockRejectedValue(new NetworkError('offline'));
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await render(wrap({ autoGenerate: true, whenOff: <Text testID="off">off</Text> }));
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
  expect(screen.queryByTestId('off')).toBeNull();
});

it('on «يتابع لك» a failed read offers Retry, and Retry reads again', async () => {
  mockInbox.mockRejectedValueOnce(new NetworkError('offline'));
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await render(wrap({ autoGenerate: true, whenOff: <Text testID="off">off</Text> }));
  await waitFor(() => expect(screen.queryByTestId('query-error')).not.toBeNull());
  expect(screen.queryByTestId('off')).toBeNull();
  await act(async () => { await fireEvent.press(screen.getByText(en.errorsRetry)); });
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
});

/*
 * The three actions since the owner's audit of 2026-10-06 (image 8): a press
 * explains, «Continue» runs it once, and the panel says what came of it.
 */
async function typeStatement(text: string) {
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), text);
  await waitFor(() => expect(screen.getByTestId('intelligence-statement').props.value).toBe(text));
}

it('explains an action before running it, and cancel sends nothing', async () => {
  await render(wrap());
  await typeStatement('I want more Pilates time');
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  expect(screen.getByText(en.xIntelligenceAnalyzeExplain)).toBeTruthy();
  expect(screen.getByTestId('intelligence-statement').props.editable).toBe(false);
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze-cancel')); });
  expect(screen.queryByText(en.xIntelligenceAnalyzeExplain)).toBeNull();
  expect(mockAnalyze).not.toHaveBeenCalled();
});

it('runs a confirmed action once even when «Continue» is pressed twice in one frame', async () => {
  let release: (value: unknown) => void = () => {};
  mockAnalyze.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  await render(wrap());
  await typeStatement('Book the dentist');
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  await act(async () => {
    const confirm = screen.getByTestId('intelligence-analyze-confirm');
    void fireEvent.press(confirm);
    void fireEvent.press(confirm);
  });
  await act(async () => { release({ success: true, observations: [evidence] }); });
  await waitFor(() => expect(screen.getByTestId('intelligence-status-text')).toHaveTextContent('I understood 1 thing — review it below'));
  expect(mockAnalyze).toHaveBeenCalledTimes(1);
  expect(mockAnalyze).toHaveBeenCalledWith('Book the dentist');
});

it('says plainly when nothing clear came out of the words', async () => {
  mockAnalyze.mockResolvedValue({ success: true, observations: [] });
  await render(wrap());
  await typeStatement('hmm');
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze-confirm')); });
  await waitFor(() => expect(screen.getByTestId('intelligence-status-text')).toHaveTextContent('Nothing clear came out of that. Tell me a bit more'));
});

it('does not call a saved analysis a failure when only the refresh failed, and retries by reading only', async () => {
  await render(wrap());
  await typeStatement('Book the dentist');
  mockInbox.mockImplementationOnce(() => Promise.reject(new NetworkError('offline')));
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze-confirm')); });
  await waitFor(() => expect(screen.queryByTestId('intelligence-refresh-failed')).not.toBeNull());
  expect(screen.getByTestId('intelligence-status-text')).toHaveTextContent('I understood 1 thing — review it below');
  expect(onChanged).toHaveBeenCalledTimes(1);
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-refresh-retry')); });
  await waitFor(() => expect(screen.queryByTestId('intelligence-refresh-failed')).toBeNull());
  expect(mockAnalyze).toHaveBeenCalledTimes(1);
});

it('announces a multi-page email scan twice — when it starts and when it is done — never per page', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  mockScan
    .mockResolvedValueOnce({ success: true, messagesRead: 3, observations: [], scan: { status: 'running', messagesVisited: 3 } })
    .mockResolvedValueOnce({ success: true, messagesRead: 3, observations: [], scan: { status: 'running', messagesVisited: 6 } })
    .mockResolvedValueOnce({ success: true, messagesRead: 2, observations: [], scan: { status: 'complete', messagesVisited: 8 } });
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-scan')).not.toBeNull());
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan-confirm')); });
  await waitFor(() => expect(screen.getByTestId('intelligence-status-text')).toHaveTextContent('Done — checked 8 emails from the past week'));
  expect(announce.mock.calls.map(call => call[0])).toEqual([en.xIntelligenceGmailScanStarted, 'Done — checked 8 emails from the past week']);
});

it('says a failed email scan in the status line', async () => {
  mockScan.mockRejectedValue(new NetworkError('offline'));
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-scan')).not.toBeNull());
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan-confirm')); });
  await waitFor(() => expect(screen.getByTestId('intelligence-status-text').props.children).not.toBe(en.xIntelligenceGmailScanStarted));
  expect(onChanged).not.toHaveBeenCalled();
});

it('keeps the explanations behind their arrows until asked for', async () => {
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-panel-why')).not.toBeNull());
  expect(screen.queryByText(en.xIntelligenceBody)).toBeNull();
  expect(screen.queryByText(en.xIntelligenceGmailMonitorInfo)).toBeNull();
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-panel-why')); });
  expect(screen.getByText(en.xIntelligenceBody)).toBeTruthy();
});

it('says an action is expanded and moves a screen reader to its explanation', async () => {
  const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-scan')).not.toBeNull());
  expect(screen.getByTestId('intelligence-gmail-scan').props.accessibilityState).toMatchObject({ expanded: false });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan')); });
  expect(screen.getByTestId('intelligence-gmail-scan').props.accessibilityState).toMatchObject({ expanded: true });
  await waitFor(() => expect(focus).toHaveBeenCalledWith(expect.anything(), 'focus'));
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan-cancel')); });
  expect(screen.getByTestId('intelligence-gmail-scan').props.accessibilityState).toMatchObject({ expanded: false });
});

it('says nothing — and never «done» — when the panel leaves the screen mid-scan', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  let releasePage: (value: unknown) => void = () => {};
  mockScan.mockImplementation(() => new Promise(resolve => { releasePage = resolve; }));
  const view = await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-scan')).not.toBeNull());
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-gmail-scan-confirm')); });
  await view.unmount();
  await act(async () => { releasePage({ success: true, messagesRead: 3, observations: [], scan: { status: 'running', messagesVisited: 3 } }); });
  await settle();
  expect(announce.mock.calls.map(call => call[0])).toEqual([en.xIntelligenceGmailScanStarted]);
  expect(mockScan).toHaveBeenCalledTimes(1);
});

it('draws nothing of one account for the next after a direct switch', async () => {
  const repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  currentInbox = { success: true, observations: [evidence], suggestions: [], schedule: [] };
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><AuthProvider repository={repository} isDevBundle={false}>
    <IntelligencePanel onChanged={onChanged} />
  </AuthProvider></AppProvider></SafeAreaProvider>);
  await waitFor(() => expect(screen.queryByTestId('intelligence-observation-obs-1')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'Alice private words');
  // Blake's first read never answers: whatever is on screen now is the first frame.
  mockInbox.mockImplementation(() => new Promise(() => {}));
  await act(async () => { repository.emit({ ...USER, uid: 'blake' }); });
  expect(screen.queryByText('Alice private words')).toBeNull();
  expect(screen.queryByTestId('intelligence-observation-obs-1')).toBeNull();
});

it('tells VoiceOver both the result and that the list could not refresh', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  await render(wrap());
  await typeStatement('Book the dentist');
  mockInbox.mockImplementationOnce(() => Promise.reject(new NetworkError('offline')));
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze-confirm')); });
  await waitFor(() => expect(screen.queryByTestId('intelligence-refresh-failed')).not.toBeNull());
  expect(announce.mock.calls.map(call => call[0])).toEqual([en.xIntelligenceAnalyzing, `I understood 1 thing — review it below ${en.xIntelligenceRefreshFailed}`]);
});

it('puts the keyboard away when an explanation opens, so «Continue» is not covered', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  await render(wrap());
  await typeStatement('Book the dentist');
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  expect(dismiss).toHaveBeenCalled();
  expect(screen.getByTestId('intelligence-analyze-confirm')).toBeTruthy();
});
