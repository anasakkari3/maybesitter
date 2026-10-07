import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { NetworkError } from '../../api/errors';
import { GoalExecutionScreen } from '../../features/goals/GoalExecutionScreen';
import { IntelligencePanel } from '../../features/goals/IntelligencePanel';
import en from '../../i18n/locales/en.json';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock;

const mockAnalyze = jest.fn<any>();
const mockGenerate = jest.fn<any>();
const mockInbox = jest.fn<any>();
const mockDecide = jest.fn<any>();
const mockReview = jest.fn<any>();
const mockAnswer = jest.fn<any>();
const mockScan = jest.fn<any>();
const mockMonitor = jest.fn<any>();
const mockSetMonitor = jest.fn<any>();
const mockCreateGoal = jest.fn<any>();
const mockPreview = jest.fn<any>();
const mockOnChanged = jest.fn();
let currentInbox: any;
let mockRecommendationState: 'granted' | 'declined' = 'granted';

jest.mock('../../api/queries', () => ({
  useConsents: () => ({ data: { recommendations: { state: mockRecommendationState } } }),
  useIntelligenceDecided: () => mockOnChanged,
  useMemory: () => ({ data: { items: [] }, isPending: false, error: null, refetch: jest.fn() }),
  useCreateMemory: () => ({ mutate: mockCreateGoal, isPending: false, error: null }),
  useGoalExecution: () => ({ data: undefined, isPending: false, isFetching: false, error: null, refetch: jest.fn() }),
  useGenerateGoalExecution: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useRegenerateGoalExecution: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useConfirmGoalSelections: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useUnlinkGoalNode: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useHabits: () => ({ data: [], isPending: false, error: null, refetch: jest.fn() }),
  useCommitment: () => ({ data: undefined, isPending: false, error: null, refetch: jest.fn() }),
  useUpcomingPlans: () => ({ isPending: false, error: null, data: [] }),
  useUid: () => 'm1-goals-user',
  useInvalidateAfterPlanConfirm: () => () => undefined,
}));

jest.mock('../../api/endpoints/goalPlan', () => ({
  previewStatementGoal: (...args: unknown[]) => mockPreview(...args),
}), { virtual: true });

jest.mock('../../api/endpoints/intelligence', () => ({
  analyzeIntelligenceStatement: (...args: unknown[]) => mockAnalyze(...args),
  generateIntelligenceSuggestions: (...args: unknown[]) => mockGenerate(...args),
  getIntelligenceInbox: (...args: unknown[]) => mockInbox(...args),
  decideIntelligenceSuggestion: (...args: unknown[]) => mockDecide(...args),
  reviewIntelligenceObservation: (...args: unknown[]) => mockReview(...args),
  answerIntelligenceQuestion: (...args: unknown[]) => mockAnswer(...args),
  scanGmailForIntelligence: (...args: unknown[]) => mockScan(...args),
  getGmailIntelligenceMonitor: (...args: unknown[]) => mockMonitor(...args),
  setGmailIntelligenceMonitor: (...args: unknown[]) => mockSetMonitor(...args),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER = {
  uid: 'm1-goals-user', email: 'm1@example.com', emailVerified: true, displayName: 'M1', providerIds: ['password'],
};
const observedAt = '2026-10-06T09:00:00.000Z';
const observation = (id = 'obs-1') => ({
  id, kind: 'goal', evidence: `signal ${id}`, confidence: 1,
  source: 'manual', sourceRef: `note-${id}`, observedAt, review: 'confirmed', reviewedAt: observedAt, linkedMemoryId: null,
});
const suggestion = (id: string) => ({
  id, kind: 'action', title: `Suggestion ${id}`, reason: `Reason ${id}`,
  observationIds: ['obs-1'], confidence: 0.8, durationMinutes: 30,
  status: 'pending', decidedAt: null, linkedEntityId: null, generatedAt: observedAt,
});
const inbox = (observations: any[] = [observation()], suggestions: any[] = []) => ({
  success: true, observations, suggestions, schedule: [],
});

// These exact strings come from ar.json at 62699810. They are intentionally
// literals: deleting or renaming their keys must not weaken the acceptance gate.
const OLD_GOAL_SUBTITLE = '\u0623\u0647\u062f\u0627\u0641\u0643\u060c \u0645\u0646 \u0627\u0644\u0627\u0642\u062a\u0631\u0627\u062d \u0644\u062e\u0637\u0648\u0627\u062a \u0628\u062a\u0623\u0643\u062f\u0647\u0627 \u0628\u0646\u0641\u0633\u0643.';
const OLD_AI_BODY = '\u0627\u062d\u0643\u064a\u0644\u064a \u0634\u0648 \u0639\u0646\u062f\u0643 \u0623\u0648 \u0634\u0648 \u062d\u0627\u0628\u0628 \u062a\u0639\u0645\u0644. \u0631\u0627\u062c\u0639 \u0643\u0644 \u0627\u0642\u062a\u0631\u0627\u062d \u0642\u0628\u0644 \u0645\u0627 \u064a\u0635\u064a\u0631 \u0647\u062f\u0641 \u0623\u0648 \u0627\u0644\u062a\u0632\u0627\u0645.';
const OLD_ADD_GOAL_BODY = '\u0627\u062d\u0641\u0638 \u0647\u062f\u0641\u0643 \u0628\u0643\u0644\u0645\u0627\u062a\u0643. MaybeSitter \u0631\u062d \u064a\u0642\u062a\u0631\u062d \u062e\u0637\u0648\u0627\u062a \u062a\u0631\u0627\u062c\u0639\u0647\u0627 \u0628\u0646\u0641\u0633\u0643.';
const OLD_GMAIL_INFO = '\u0628\u0645\u0648\u0627\u0641\u0642\u062a\u0643\u060c \u0628\u0646\u0641\u062d\u0635 \u0627\u0644\u0625\u064a\u0645\u064a\u0644\u0627\u062a \u0627\u0644\u062c\u062f\u064a\u062f\u0629 \u0643\u0644 \u0643\u0645 \u062f\u0642\u064a\u0642\u0629 \u0648\u0646\u0633\u062a\u062e\u0631\u062c \u0645\u0646\u0647\u0627 \u0627\u0642\u062a\u0631\u0627\u062d\u0627\u062a \u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629. \u0645\u0627 \u0628\u0646\u0639\u0645\u0644 \u0627\u0644\u062a\u0632\u0627\u0645 \u062a\u0644\u0642\u0627\u0626\u064a.';
const STRUCK_SAVE_SENTENCE = '\u0627\u062d\u0641\u0638 \u0647\u062f\u0641\u0643 \u0628\u0643\u0644\u0645\u0627\u062a\u0643.';
const STRUCK_AUTO_SENTENCE = '\u0645\u0627 \u0628\u0646\u0639\u0645\u0644 \u0627\u0644\u062a\u0632\u0627\u0645 \u062a\u0644\u0642\u0627\u0626\u064a.';
const OLD_AI_TITLE = '\u0634\u0648 \u0645\u0645\u0643\u0646 \u064a\u0633\u0627\u0639\u062f\u0643 \u0647\u0644\u0651\u0642';
const OLD_ADD_GOAL_TITLE = '\u0636\u064a\u0641 \u0647\u062f\u0641';
const OLD_ACTION_LABELS = ['\u0627\u0641\u0647\u0645 \u0627\u0644\u0644\u064a \u062d\u0643\u064a\u062a\u0644\u064a \u0625\u064a\u0627\u0647', '\u0627\u0642\u062a\u0631\u062d\u0644\u064a \u062e\u0637\u0629', '\u0634\u0648\u0641 \u0627\u0644\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u062c\u062f\u064a\u062f\u0629 \u0628\u0625\u064a\u0645\u064a\u0644\u064a'] as const;

function providers(child: React.ReactNode) {
  const repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>{child}</AuthProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

async function showPanel(
  lang: 'ar' | 'en' = 'en',
  fontScale = 1,
  props: Partial<React.ComponentProps<typeof IntelligencePanel>> = {},
) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  const view = await render(providers(<IntelligencePanel onChanged={mockOnChanged} {...props} />));
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  return view;
}

async function showGoals(lang: 'ar' | 'en' = 'ar', fontScale = 1) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  const view = await render(providers(<GoalExecutionScreen />));
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  return view;
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

async function openConfirmation(buttonId: string) {
  await act(async () => { await fireEvent.press(screen.getByTestId(buttonId)); });
  return screen.queryByTestId(`${buttonId}-confirm`);
}

async function runConfirmed(buttonId: string) {
  const confirm = await openConfirmation(buttonId);
  if (confirm) await act(async () => { await fireEvent.press(confirm); });
}

function liveRegions() {
  const walk = (node: any): any[] => {
    if (!node || typeof node === 'string') return [];
    return [node, ...(node.children ?? []).flatMap(walk)];
  };
  return walk(screen.toJSON()).filter(node => node.props?.accessibilityLiveRegion === 'polite');
}

function textInside(node: any): string {
  if (typeof node === 'string') return node;
  return node.children.map((child: any) => typeof child === 'string' ? child : textInside(child)).join('');
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockRecommendationState = 'granted';
  useWindowDimensions.mockReset();
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
  await AsyncStorage.clear();
  currentInbox = inbox();
  mockInbox.mockImplementation(() => Promise.resolve(currentInbox));
  mockAnalyze.mockResolvedValue({ success: true, observations: [observation()] });
  mockGenerate.mockResolvedValue({ success: true, suggestions: [suggestion('new-1')], schedule: [] });
  mockPreview.mockResolvedValue({
    success: true,
    summaryId: 'm1-summary',
    revision: 1,
    understood: { goalText: 'One request' },
    expiresAt: '2030-01-07T10:30:00.000Z',
  });
  mockScan.mockResolvedValue({ success: true, messagesRead: 1, observations: [], scan: { status: 'complete', messagesVisited: 1 } });
  mockMonitor.mockResolvedValue({ success: true, enabled: false, lastSuccessAt: null, error: null });
  mockSetMonitor.mockResolvedValue({ success: true, enabled: true, lastSuccessAt: null, error: null });
});

afterEach(async () => {
  await cleanup();
  resetAuthForTests();
  await AsyncStorage.clear();
  jest.useRealTimers();
});

it('A1 disclosure and A4 goals panel: the three explanations are absent until their accessible 44-point disclosures are opened', async () => {
  await showGoals('ar');

  expect(screen.queryByText(OLD_GOAL_SUBTITLE)).toBeNull();
  expect(screen.queryByText(OLD_AI_BODY)).toBeNull();
  expect(screen.queryByText(OLD_ADD_GOAL_BODY)).toBeNull();
  expect(screen.queryByText(OLD_GMAIL_INFO)).toBeNull();
  const serialized = JSON.stringify(screen.toJSON());
  expect(serialized).not.toContain(STRUCK_SAVE_SENTENCE);
  expect(serialized).not.toContain(STRUCK_AUTO_SENTENCE);

  const controls = screen.getAllByTestId(/-why$/);
  expect(controls).toHaveLength(3);
  for (const control of controls) {
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityState).toMatchObject({ expanded: false });
    expect(String(control.props.accessibilityLabel).trim().length).toBeGreaterThan(0);
    expect(StyleSheet.flatten(control.props.style)?.minWidth).toBeGreaterThanOrEqual(44);
    expect(StyleSheet.flatten(control.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
    const bodyId = String(control.props.testID).replace(/-why$/, '-why-body');
    expect(screen.queryByTestId(bodyId)).toBeNull();
    await act(async () => { await fireEvent.press(control); });
    expect(screen.getByTestId(bodyId)).toBeTruthy();
    expect(screen.getByTestId(String(control.props.testID)).props.accessibilityState).toMatchObject({ expanded: true });
    await act(async () => { await fireEvent.press(screen.getByTestId(String(control.props.testID))); });
    expect(screen.queryByTestId(bodyId)).toBeNull();
  }
});

it('A4 goals panel: the two cards have distinct new names and the plan action remains honest when recommendation consent is off', async () => {
  mockRecommendationState = 'declined';
  await showGoals('ar');

  expect(screen.queryByText(OLD_AI_TITLE)).toBeNull();
  expect(screen.queryByText(OLD_ADD_GOAL_TITLE)).toBeNull();
  expect(screen.getByTestId('intelligence-statement')).toBeTruthy();
  expect(screen.getByTestId('goal-add-input')).toBeTruthy();
  expect(screen.queryByTestId('intelligence-generate')).toBeNull();
  expect((await screen.findByTestId('intelligence-plan-flow')).props.accessibilityLabel).toBe(OLD_ACTION_LABELS[1]);
  const names = screen.getAllByTestId(/-why$/).map(control => String(control.props.accessibilityLabel));
  expect(new Set(names).size).toBe(names.length);
});

it('A4 watching panel: embedded auto-generate mode keeps the explanation optional and actions confirmation-only', async () => {
  await showPanel('ar', 1, { autoGenerate: true });
  expect(screen.queryByText(OLD_AI_BODY)).toBeNull();
  expect(screen.getByTestId('intelligence-panel-why')).toBeTruthy();

  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), '\u0628\u062f\u0651\u064a \u0648\u0642\u062a \u0623\u062a\u0645\u0631\u0651\u0646');
  const confirm = await openConfirmation('intelligence-analyze');
  expect(mockAnalyze).not.toHaveBeenCalled();
  expect(confirm).not.toBeNull();
});

it('A4 goals actions: the three distinct small actions share one wrapping row at accessibility text size', async () => {
  await showPanel('ar', 2);
  const buttons = ['intelligence-analyze', 'intelligence-plan-flow', 'intelligence-gmail-scan'].map(id => screen.getByTestId(id));
  expect(new Set(buttons.map(button => button.props.accessibilityLabel)).size).toBe(3);
  expect(OLD_ACTION_LABELS).not.toContain(buttons[0]!.props.accessibilityLabel);
  expect(buttons[1]!.props.accessibilityLabel).toBe(OLD_ACTION_LABELS[1]);
  expect(OLD_ACTION_LABELS).not.toContain(buttons[2]!.props.accessibilityLabel);
  expect(new Set(buttons.map(button => button.parent)).size).toBe(1);
  const row = buttons[0]!.parent!;
  expect(StyleSheet.flatten(row.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
});

it('A4 goals actions: analyze explains first, freezes a trimmed snapshot, and preserves newer text when that request succeeds', async () => {
  let resolveAnalyze!: (value: unknown) => void;
  mockAnalyze.mockImplementation(() => new Promise(resolve => { resolveAnalyze = resolve; }));
  await showPanel();
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), '  first version  ');

  await act(async () => {
    await fireEvent.press(screen.getByTestId('intelligence-analyze'));
    await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'newer text');
  });
  const confirm = screen.queryByTestId('intelligence-analyze-confirm');
  expect(mockAnalyze).not.toHaveBeenCalled();
  expect(confirm).not.toBeNull();
  expect(screen.getByTestId('intelligence-statement').props.editable).toBe(false);
  expect(screen.getByTestId('intelligence-statement').props.value).toBe('newer text');
  expect(screen.getAllByRole('button').filter(node => node.parent === confirm!.parent)).toHaveLength(2);

  await act(async () => { await fireEvent.press(confirm!); });
  expect(mockAnalyze).toHaveBeenCalledWith('first version');
  expect(screen.getByTestId('intelligence-statement').props.editable).toBe(false);
  currentInbox = inbox([observation()], []);
  await act(async () => { resolveAnalyze({ success: true, observations: [observation()] }); });
  await waitFor(() => expect(mockOnChanged).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('intelligence-statement').props.value).toBe('newer text');
});

it('A4 goals actions: analyze clears the field after success only while it still equals the submitted snapshot', async () => {
  await showPanel();
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), '  unchanged  ');
  const confirm = await openConfirmation('intelligence-analyze');
  expect(mockAnalyze).not.toHaveBeenCalled();
  expect(confirm).not.toBeNull();
  await act(async () => { await fireEvent.press(confirm!); });
  await waitFor(() => expect(mockOnChanged).toHaveBeenCalledTimes(1));
  expect(mockAnalyze).toHaveBeenCalledWith('unchanged');
  expect(screen.getByTestId('intelligence-statement').props.value).toBe('');
});

const CONFIRMATION_CASES: [string, string, typeof mockGenerate][] = [
  ['Gmail scan', 'intelligence-gmail-scan', mockScan],
];

it.each(CONFIRMATION_CASES)('A4 goals actions: %s shows an explanation and confirmation before its mutation runs', async (_name, buttonId, endpoint) => {
  await showPanel();
  const confirm = await openConfirmation(buttonId);
  expect(endpoint).not.toHaveBeenCalled();
  expect(confirm).not.toBeNull();
  expect(screen.getAllByRole('button').filter(node => node.parent === confirm!.parent)).toHaveLength(2);
  await act(async () => { await fireEvent.press(confirm!); });
  await waitFor(() => expect(endpoint).toHaveBeenCalledTimes(1));
});

const DOUBLE_RUN_CASES: [string, string, typeof mockGenerate][] = [
  ['analyze', 'intelligence-analyze', mockAnalyze],
  ['Gmail scan', 'intelligence-gmail-scan', mockScan],
];

it.each(DOUBLE_RUN_CASES)('A4 no double run: two same-frame presses send %s exactly once', async (name, buttonId, endpoint) => {
  await showPanel();
  if (buttonId === 'intelligence-analyze') await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'one request');

  let runner = await openConfirmation(buttonId);
  if (!runner) {
    await settle();
    if (buttonId === 'intelligence-analyze') await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'one request');
    runner = screen.getByTestId(buttonId);
  }
  endpoint.mockClear();
  let finish!: (value: unknown) => void;
  endpoint.mockImplementation(() => new Promise(resolve => { finish = resolve; }));

  await act(async () => {
    await fireEvent.press(runner!);
    await fireEvent.press(runner!);
  });
  expect(endpoint).toHaveBeenCalledTimes(1);

  const result = name === 'analyze'
    ? { success: true, observations: [observation()] }
    : { success: true, messagesRead: 1, observations: [], scan: { status: 'complete', messagesVisited: 1 } };
  await act(async () => { finish(result); });
  await settle();
});

it('A4 plan preview: two same-frame presses run one preview per press', async () => {
  await showPanel();
  expect(screen.getByTestId('intelligence-plan-flow').props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'one request');
  const planEntry = screen.getByTestId('intelligence-plan-flow');
  expect(planEntry.props.accessibilityState).toMatchObject({ disabled: false });
  mockPreview.mockClear();

  await act(async () => {
    await fireEvent.press(planEntry);
    await fireEvent.press(planEntry);
  });

  expect(mockPreview).toHaveBeenCalledTimes(2);
  expect(mockPreview).toHaveBeenNthCalledWith(1, 'one request', 'en');
  expect(mockPreview).toHaveBeenNthCalledWith(2, 'one request', 'en');
});

it('A4 mutation versus refresh: analyze success survives a failed inbox refresh and Retry reads without resending', async () => {
  mockInbox.mockReset()
    .mockResolvedValueOnce(inbox())
    .mockRejectedValueOnce(new NetworkError('offline'))
    .mockRejectedValueOnce(new NetworkError('offline'));
  await showPanel();
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'keep the mutation');
  await runConfirmed('intelligence-analyze');

  await waitFor(() => expect(mockAnalyze).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mockOnChanged).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(en.errorsNetwork)).toBeNull();

  const readsBeforeRetry = mockInbox.mock.calls.length;
  mockInbox.mockResolvedValueOnce(inbox([observation()], []));
  const retryLabel = screen.getByText(en.errorsRetry);
  expect(textInside(retryLabel.parent!.parent!).replace(en.errorsRetry, '').trim().length).toBeGreaterThan(0);
  expect(textInside(liveRegions()[0]!)).toMatch(/1/);
  await act(async () => { await fireEvent.press(retryLabel); });
  await waitFor(() => expect(mockInbox).toHaveBeenCalledTimes(readsBeforeRetry + 1));
  expect(mockAnalyze).toHaveBeenCalledTimes(1);
});

it('A5 feedback: one polite live region is mounted before any action starts', async () => {
  await showPanel();
  const regions = liveRegions();
  expect(regions).toHaveLength(1);
  expect(textInside(regions[0]!)).toBe('');
  expect(StyleSheet.flatten(regions[0]!.props.style)).toMatchObject({ position: 'absolute' });
});

it('A5 feedback: analyze announces start and a terminal observation count, not intermediate noise', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  currentInbox = inbox([], []);
  mockAnalyze.mockResolvedValue({ success: true, observations: [observation('1'), observation('2')] });
  mockInbox.mockImplementation(() => Promise.resolve(currentInbox));
  await showPanel();
  announce.mockClear();
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'two signals');
  currentInbox = inbox([observation('1'), observation('2')], []);
  await runConfirmed('intelligence-analyze');

  await waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
  const spoken = announce.mock.calls.map(call => String(call[0]));
  expect(spoken[0]).not.toBe(spoken[1]);
  expect(spoken[1]).toMatch(/2/);
  expect(textInside(liveRegions()[0]!)).toMatch(/2/);
});

it('A5 feedback: analyze zero-result completion is a distinct terminal status without a made-up count', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  currentInbox = inbox([], []);
  mockAnalyze.mockResolvedValue({ success: true, observations: [] });
  await showPanel();
  announce.mockClear();
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'nothing clear');
  await runConfirmed('intelligence-analyze');

  await waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
  const spoken = announce.mock.calls.map(call => String(call[0]));
  expect(spoken[0]).not.toBe(spoken[1]);
  expect(spoken[1]).not.toMatch(/\d/);
});

it('A5 feedback: Gmail multi-page progress stays visual while only start and final total are announced', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  let first!: (value: unknown) => void;
  let second!: (value: unknown) => void;
  mockScan
    .mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
  await showPanel();
  announce.mockClear();
  await runConfirmed('intelligence-gmail-scan');

  await act(async () => { first({ success: true, messagesRead: 3, observations: [], scan: { status: 'running', messagesVisited: 3 } }); });
  await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText(/3/)).toBeTruthy());
  const announcementsAfterPage = announce.mock.calls.length;
  const regionsDuringPage = liveRegions().length;

  await act(async () => { second({ success: true, messagesRead: 4, observations: [], scan: { status: 'complete', messagesVisited: 7 } }); });
  await waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
  expect(announcementsAfterPage).toBe(1);
  expect(regionsDuringPage).toBe(1);
  expect(String(announce.mock.calls[1]?.[0])).toMatch(/7/);
  expect(screen.getByText(/7/)).toBeTruthy();
});

it('A5 feedback: a failed action announces the same existing user-facing error it shows', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  mockAnalyze.mockRejectedValue(new NetworkError('offline'));
  await showPanel();
  announce.mockClear();
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'will fail');
  await runConfirmed('intelligence-analyze');

  await waitFor(() => expect(screen.getByText(en.errorsNetwork)).toBeTruthy());
  expect(announce).toHaveBeenCalledTimes(2);
  expect(announce.mock.calls[1]?.[0]).toBe(en.errorsNetwork);
});

it.todo('A1 disclosure: RTL chevron direction and accessibility-size rendering need simulator inspection');
it.todo('A2/A4 visual layout: rightmost Arabic order, BrandMark identity, clipping, and clean wrapping need simulator inspection');
it.todo('A4 goals naming: plain-Levantine meaning and absence of near-synonyms need human copy review');
it.todo('A6 no regression: the full mobile-suite gate needs builder validation after implementation');
