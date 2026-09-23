import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { strings, type Lang } from '../../../i18n/strings';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { GoalExecutionScreen } from '../GoalExecutionScreen';

const mockGenerate = jest.fn<any>();
const mockConfirm = jest.fn<any>();
const mockRegenerate = jest.fn<any>();
const mockUnlink = jest.fn<any>();
const mockRefetch = jest.fn<any>();
const mockUseGoalExecution = jest.fn<any>();

const graph = (generation = 1, nodes: any[] = []) => ({
  version: 'v1', schema: 'goal-graph-v1', graphId: `graph-${generation}`, goalMemoryId: 'goal-1', scopeId: 'user-1',
  language: 'en', nodes, edges: [], generatedAt: '2026-09-23T09:00:00.000Z', generation,
  provenance: { decompositionProposalId: 'proposal-1', decompositionOutcome: 'decomposed' },
});
const proposal = (id: string, title: string) => ({
  nodeId: id, kind: 'decomposition_step_proposal', status: 'proposed', stepId: id,
  title, sourceSpans: [], inferred: false, statedTiming: null, statedOwner: null,
});
const baseProgress = {
  scopeId: 'user-1', goalMemoryId: 'goal-1', confirmedCount: 0, completedCount: 0, nodes: [],
  derivedAt: '2026-09-23T09:00:00.000Z', period: { fromLocalDate: '2026-09-21', toLocalDate: '2026-09-27' },
};

let execution: any;
let mockHabits: any[];
let mockCommitment: any;

jest.mock('../../../api/queries', () => ({
  useMemory: () => ({
    data: { items: [{ id: 'goal-1', kind: 'goal', content: 'Launch the pilot' }] },
    isPending: false, error: null, refetch: jest.fn(),
  }),
  useCreateMemory: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useGoalExecution: (...args: unknown[]) => mockUseGoalExecution(...args),
  useGenerateGoalExecution: () => ({ mutate: mockGenerate, isPending: false, error: null }),
  useRegenerateGoalExecution: () => ({ mutate: mockRegenerate, isPending: false, error: null }),
  useConfirmGoalSelections: () => ({ mutate: mockConfirm, isPending: false, error: null }),
  useUnlinkGoalNode: () => ({ mutate: mockUnlink, isPending: false, error: null }),
  useHabits: () => ({ data: mockHabits, isPending: false, error: null, refetch: jest.fn() }),
  useCommitment: (id: string | null) => ({ data: id ? mockCommitment : undefined, isPending: false, error: null, refetch: jest.fn() }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const wrap = (child: React.ReactNode) => <SafeAreaProvider initialMetrics={metrics}><AppProvider>{child}</AppProvider></SafeAreaProvider>;

async function openGoal(lang: Lang = 'en') {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  const view = await render(wrap(<GoalExecutionScreen />));
  await waitFor(() => expect(screen.queryByText(strings[lang].xGoals)).not.toBeNull());
  await fireEvent.press(screen.getByTestId('goal-open-goal-1'));
  await waitFor(() => expect(screen.queryByTestId('goal-back-list')).not.toBeNull());
  return view;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockHabits = [];
  mockCommitment = undefined;
  execution = { data: { success: true, graph: graph(1, [proposal('g1.step.s1', 'Draft invitation')]), progress: baseProgress }, isPending: false, isFetching: false, error: null, refetch: mockRefetch };
  mockUseGoalExecution.mockImplementation(() => execution);
  mockGenerate.mockImplementation((_input: unknown, options: any) => options.onSuccess(graph(1, [proposal('g1.step.s1', 'Draft invitation'), proposal('g1.step.s2', 'Invite participants')])));
  mockRegenerate.mockImplementation((_input: unknown, options: any) => options.onSuccess(graph(2, [proposal('g2.step.s2', 'Invite participants again')])));
  mockUnlink.mockImplementation((_input: unknown, options: any) => options.onSuccess({ success: true }));
});
afterEach(cleanup);

it('keeps generated work visibly provisional and confirms only selected nodes with explicit types', async () => {
  await openGoal();
  expect(screen.queryByText('Draft invitation')).toBeNull();

  await fireEvent.press(screen.getByTestId('goal-generate'));
  expect(screen.getByText(strings.en.xGoalProposalNotSaved)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('goal-proposal-g1.step.s1'));
  await fireEvent.press(screen.getByTestId('goal-proposal-g1.step.s2'));
  await fireEvent.press(screen.getByTestId('goal-kind-habit-g1.step.s2'));
  await fireEvent.press(screen.getByTestId('goal-confirm-selected'));

  expect(mockConfirm).toHaveBeenCalledWith({
    generation: 1,
    selections: [
      { nodeId: 'g1.step.s1', as: 'commitment' },
      { nodeId: 'g1.step.s2', as: 'habit', habit: expect.objectContaining({ cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: 30 }) },
    ],
  }, expect.any(Object));
  const period = mockUseGoalExecution.mock.calls.at(-1)?.[2];
  expect(period).toEqual(expect.objectContaining({ fromLocalDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), toLocalDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
});

it('refreshes a stale unknown node and never reports it as saved', async () => {
  mockConfirm.mockImplementation((_input: unknown, options: any) => options.onSuccess({
    success: true,
    graph: graph(1, [proposal('g1.step.current', 'Current step')]),
    created: [], replayed: [],
    refused: [{ nodeId: 'g1.step.s1', nodeKey: 'step.s1', code: 'unknown_node', detail: 'stale' }],
  }));
  await openGoal();
  await fireEvent.press(screen.getByTestId('goal-generate'));
  await fireEvent.press(screen.getByTestId('goal-proposal-g1.step.s1'));
  await fireEvent.press(screen.getByTestId('goal-confirm-selected'));

  expect(screen.getByTestId('goal-notice-stale')).toBeTruthy();
  expect(screen.queryByTestId('goal-notice-saved')).toBeNull();
  expect(screen.getByTestId('goal-proposal-g1.step.current')).toBeTruthy();
  expect(mockRefetch).toHaveBeenCalled();
});

it('renders canonical linked titles and never invents habit counts when the period is null', async () => {
  mockCommitment = { title: 'Call the venue', status: 'active' };
  mockHabits = [{ habitId: 'habit-1', title: 'Practice the talk', status: 'active' }];
  execution = {
    data: {
      success: true,
      graph: graph(1, [
        { nodeId: 'g1.step.s1', kind: 'linked_commitment', status: 'confirmed', commitmentId: 'commitment-1' },
        { nodeId: 'g1.step.s2', kind: 'linked_habit', status: 'confirmed', habitId: 'habit-1' },
      ]),
      progress: { ...baseProgress, confirmedCount: 2, period: null, nodes: [] },
    },
    isPending: false, isFetching: false, error: null, refetch: mockRefetch,
  };
  await openGoal();

  expect(screen.getByText(/Call the venue/)).toBeTruthy();
  expect(screen.getByText(/Practice the talk/)).toBeTruthy();
  expect(screen.getAllByText(strings.en.xGoalProgressUnscoped).length).toBeGreaterThan(0);
  expect(JSON.stringify(screen.toJSON())).not.toContain('0 of 3 occurrences');
  expect(JSON.stringify(screen.toJSON())).not.toContain('commitment-1');
  expect(JSON.stringify(screen.toJSON())).not.toContain('habit-1');
});

it('keeps linked work through regeneration, refreshes progress, and unlinks without deletion copy', async () => {
  mockCommitment = { title: 'Call the venue', status: 'active' };
  execution = {
    data: {
      success: true,
      graph: graph(1, [{ nodeId: 'g1.step.s1', kind: 'linked_commitment', status: 'confirmed', commitmentId: 'commitment-1' }]),
      progress: { ...baseProgress, confirmedCount: 1, nodes: [{ nodeKey: 'step.s1', entityKind: 'commitment', entityId: 'commitment-1', status: 'active', completed: false }] },
    },
    isPending: false, isFetching: false, error: null, refetch: mockRefetch,
  };
  mockRegenerate.mockImplementation((_input: unknown, options: any) => options.onSuccess(graph(2, [
    { nodeId: 'g2.step.s1', kind: 'linked_commitment', status: 'confirmed', commitmentId: 'commitment-1' },
    proposal('g2.step.s2', 'Book the room'),
  ])));
  await openGoal();
  await fireEvent.press(screen.getByTestId('goal-refresh'));
  expect(mockRefetch).toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId('goal-regenerate'));
  expect(screen.getByText(/Call the venue/)).toBeTruthy();
  expect(screen.getByTestId('goal-proposal-g2.step.s2')).toBeTruthy();

  await fireEvent.press(screen.getByText(strings.en.xGoalUnlink));
  expect(screen.getByText(strings.en.xGoalUnlinkKeep)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('goal-unlink-confirm-g1.step.s1'));
  expect(mockUnlink).toHaveBeenCalledWith('g1.step.s1', expect.any(Object));
  expect(screen.getByTestId('goal-notice-unlinked')).toBeTruthy();
});

it('drops an unconfirmed proposal on reload and restores server truth', async () => {
  const first = await openGoal();
  await fireEvent.press(screen.getByTestId('goal-generate'));
  expect(screen.getByTestId('goal-proposal-g1.step.s1')).toBeTruthy();
  first.unmount();

  await openGoal();
  expect(screen.queryByTestId('goal-proposal-g1.step.s1')).toBeNull();
  expect(screen.getByText(strings.en.xGoalPlanEmpty)).toBeTruthy();
});

it('renders the loading state while server truth is pending', async () => {
  execution = { data: undefined, isPending: true, isFetching: true, error: null, refetch: mockRefetch };
  await openGoal();
  expect(screen.getByTestId('query-loading')).toBeTruthy();
});

it('renders a retryable error from the shared query boundary', async () => {
  execution = { data: undefined, isPending: false, isFetching: false, error: new Error('offline'), refetch: mockRefetch };
  await openGoal();
  await fireEvent.press(screen.getByText(strings.en.errorsRetry));
  expect(mockRefetch).toHaveBeenCalled();
});

it('says when generation returns no actionable proposal', async () => {
  execution = { data: { success: true, graph: graph(), progress: baseProgress }, isPending: false, isFetching: false, error: null, refetch: mockRefetch };
  mockGenerate.mockImplementation((_input: unknown, options: any) => options.onSuccess(graph(1, [])));
  await openGoal();
  await fireEvent.press(screen.getByTestId('goal-generate'));
  expect(screen.getByText(strings.en.xGoalProposalEmpty)).toBeTruthy();
});

describe.each([
  { lang: 'ar' as const, rtl: true },
  { lang: 'he' as const, rtl: true },
  { lang: 'en' as const, rtl: false },
])('$lang localization', ({ lang, rtl }) => {
  it('renders the goal flow in the selected language and direction', async () => {
    await openGoal(lang);
    const heading = screen.getByText(strings[lang].xGoalPlanEmpty);
    expect(heading).toBeTruthy();
    expect([heading.props.style].flat(4)).toEqual(expect.arrayContaining([
      expect.objectContaining({ writingDirection: rtl ? 'rtl' : 'ltr' }),
    ]));
  });
});
