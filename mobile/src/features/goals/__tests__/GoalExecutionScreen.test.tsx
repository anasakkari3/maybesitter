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
let mockGenerateError: unknown = null;
let mockPlanView: any;

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
  useConsents: () => ({ data: { recommendations: { state: 'granted' } } }),
  useIntelligenceDecided: () => () => undefined,
  useMemory: () => ({
    data: { items: [{ id: 'goal-1', kind: 'goal', content: 'Launch the pilot' }] },
    isPending: false, error: null, refetch: jest.fn(),
  }),
  useCreateMemory: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useGoalExecution: (...args: unknown[]) => mockUseGoalExecution(...args),
  useGenerateGoalExecution: () => ({ mutate: mockGenerate, isPending: false, error: mockGenerateError }),
  useRegenerateGoalExecution: () => ({ mutate: mockRegenerate, isPending: false, error: null }),
  useConfirmGoalSelections: () => ({ mutate: mockConfirm, isPending: false, error: null }),
  useUnlinkGoalNode: () => ({ mutate: mockUnlink, isPending: false, error: null }),
  useHabits: () => ({ data: mockHabits, isPending: false, error: null, refetch: jest.fn() }),
  useCommitment: (id: string | null) => ({ data: id ? mockCommitment : undefined, isPending: false, error: null, refetch: jest.fn() }),
  useGoalPlan: () => mockPlanView,
  useUpcomingPlans: () => ({ isPending: false, error: null, data: [] }),
  useUid: () => 'user-1',
  useInvalidateAfterPlanConfirm: () => () => undefined,
}));

const mockGeneratePlan = jest.fn<any>();
jest.mock('../../../api/endpoints/goalPlan', () => ({
  generateGoalPlan: (...args: unknown[]) => mockGeneratePlan(...args),
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
  mockGenerateError = null;
  mockPlanView = { data: { success: true, draft: null, confirmed: null, linkedWork: [] }, isSuccess: true, error: null, refetch: jest.fn() };
  mockHabits = [];
  mockCommitment = undefined;
  execution = { data: { success: true, graph: graph(1, [proposal('g1.step.s1', 'Draft invitation')]), progress: baseProgress }, isPending: false, isFetching: false, error: null, refetch: mockRefetch };
  mockUseGoalExecution.mockImplementation(() => execution);
  mockGenerate.mockImplementation((_input: unknown, options: any) => options.onSuccess(graph(1, [proposal('g1.step.s1', 'Draft invitation'), proposal('g1.step.s2', 'Invite participants')])));
  mockRegenerate.mockImplementation((_input: unknown, options: any) => options.onSuccess(graph(2, [proposal('g2.step.s2', 'Invite participants again')])));
  mockUnlink.mockImplementation((_input: unknown, options: any) => options.onSuccess({ success: true }));
});
afterEach(cleanup);

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

it('refreshes progress and unlinks without deletion copy', async () => {
  mockCommitment = { title: 'Call the venue', status: 'active' };
  execution = {
    data: {
      success: true,
      graph: graph(1, [{ nodeId: 'g1.step.s1', kind: 'linked_commitment', status: 'confirmed', commitmentId: 'commitment-1' }]),
      progress: { ...baseProgress, confirmedCount: 1, nodes: [{ nodeKey: 'step.s1', entityKind: 'commitment', entityId: 'commitment-1', status: 'active', completed: false }] },
    },
    isPending: false, isFetching: false, error: null, refetch: mockRefetch,
  };
  await openGoal();
  await fireEvent.press(screen.getByTestId('goal-refresh'));
  expect(mockRefetch).toHaveBeenCalled();
  expect(screen.getAllByText(/Call the venue/).length).toBeGreaterThan(0);

  await fireEvent.press(screen.getByText(strings.en.xGoalUnlink));
  expect(screen.getByText(strings.en.xGoalUnlinkKeep)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('goal-unlink-confirm-g1.step.s1'));
  expect(mockUnlink).toHaveBeenCalledWith('g1.step.s1', expect.any(Object));
  expect(screen.getByTestId('goal-notice-unlinked')).toBeTruthy();
});

it('opens the one plan path instead of the old card-by-card review (M3a)', async () => {
  mockGeneratePlan.mockResolvedValue({
    planId: 'plan-1', goalId: 'goal-1', revision: 1, status: 'draft', horizon: 'days', removedSteps: [],
    steps: [{ stepId: 's1', order: 1, phase: { unit: 'day', index: 1 }, title: 'List the venues', kind: 'commitment', durationMinutes: 30, buildsOn: null, expectedOutcome: null }],
  });
  await openGoal();
  expect(screen.queryByTestId('goal-generate')).toBeNull();
  await fireEvent.press(screen.getByTestId('goal-plan-open'));
  await waitFor(() => expect(screen.queryByTestId('plan-step-s1')).not.toBeNull());
  expect(mockGeneratePlan).toHaveBeenCalledWith('goal-1', expect.any(String), undefined);
  expect(mockGenerate).not.toHaveBeenCalled();
});

it('a confirmed plan shows its progress and offers no regeneration (S1)', async () => {
  mockPlanView = { data: { success: true, draft: null, confirmed: { planId: 'plan-1', saved: [], pendingLater: [] }, linkedWork: [] }, isSuccess: true, error: null, refetch: jest.fn() };
  await openGoal();
  expect(screen.getByTestId('goal-plan-progress')).toBeTruthy();
  expect(screen.queryByTestId('goal-plan-open')).toBeNull();
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

describe.each([
  { lang: 'ar' as const, rtl: true },
  { lang: 'he' as const, rtl: true },
  { lang: 'en' as const, rtl: false },
])('$lang localization', ({ lang, rtl }) => {
  it('renders the goal flow in the selected language and direction', async () => {
    await openGoal(lang);
    const heading = screen.getAllByText(strings[lang].xPlanOpen)[0]!;
    expect(heading).toBeTruthy();
    expect([heading.props.style].flat(4)).toEqual(expect.arrayContaining([
      expect.objectContaining({ writingDirection: rtl ? 'rtl' : 'ltr' }),
    ]));
  });
});

it('has no page subtitle and keeps the add-goal explanation behind its arrow (owner audit 2026-10-06)', async () => {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  await render(wrap(<GoalExecutionScreen />));
  await waitFor(() => expect(screen.queryByText(strings.ar.xGoals)).not.toBeNull());
  // The struck subtitle «أهدافك، من الاقتراح لخطوات بتأكدها بنفسك.» is gone.
  expect(screen.queryByText('أهدافك، من الاقتراح لخطوات بتأكدها بنفسك.')).toBeNull();
  expect(screen.queryByText(strings.ar.xAddGoalBody)).toBeNull();
  await fireEvent.press(screen.getByTestId('goal-add-why'));
  expect(screen.getByTestId('goal-add-why-body')).toHaveTextContent(strings.ar.xAddGoalBody);
});
