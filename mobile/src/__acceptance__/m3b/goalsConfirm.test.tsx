import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import * as habitEndpoints from '../../api/endpoints/habits';
import * as profileEndpoints from '../../api/endpoints/profile';
import * as seedEndpoints from '../../api/endpoints/seeds';
import {
  MEMORY,
  PLAN,
} from '../m3a/harness';
import {
  defaultReply,
  lastRequest,
  openCards,
  openGenericCapture,
  prepareM3b,
  press,
  say,
  teardown,
  waitForRequest,
  withKinds,
  type M3bHarness,
  type RecordedRequest,
  type RouteReply,
} from './harness';
import {
  GOAL_ID,
  GOAL_ITEM_ID,
  GOAL_POINT_ID,
  HABIT_ID,
  HABIT_ITEM_ID,
  HABIT_POINT_ID,
  ITEM_ID,
  SEED_ID,
  SEED_ITEM_ID,
  SEED_POINT_ID,
  answer,
  commitment,
  confirmation,
  goal,
  mixedConfirmation,
  mixedProposal,
  proposal,
} from './fixtures';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3bHarness;

beforeEach(async () => {
  harness = await prepareM3b();
});

afterEach(async () => {
  await teardown(harness);
});

function serve(
  rawProposal: Record<string, unknown>,
  confirmReply: (request: RecordedRequest, call: number) => RouteReply = () => ({ status: 200, body: mixedConfirmation() }),
  extra: (request: RecordedRequest) => RouteReply | null = () => null,
) {
  let confirms = 0;
  return withKinds(['goal', 'habit', 'thought'], (request) => {
    const handled = extra(request);
    if (handled) return handled;
    if (request.method === 'POST' && request.path.endsWith('/capture/chat')) {
      return { status: 200, body: answer(rawProposal) };
    }
    if (request.method === 'POST' && request.path.endsWith('/capture/confirm')) {
      confirms += 1;
      return confirmReply(request, confirms);
    }
    return defaultReply(request);
  });
}

async function show(rawProposal: Record<string, unknown>): Promise<void> {
  await openGenericCapture(harness);
  await say();
  await waitForRequest(harness, 'POST', /\/capture\/chat$/);
  await openCards();
}

function goalProposal(): Record<string, unknown> {
  return proposal({
    entry: 'goal',
    goals: [goal()],
    understood: [{ kind: 'goal', goalItemId: GOAL_ITEM_ID, pointId: GOAL_POINT_ID, text: 'Lose weight gradually' }],
  });
}

function goalReceipt(): Record<string, unknown> {
  return confirmation({
    goalsPersisted: [{ goalItemId: GOAL_ITEM_ID, pointId: GOAL_POINT_ID, goalId: GOAL_ID, title: 'Lose weight gradually' }],
  });
}

async function saveGoal(): Promise<void> {
  await show(goalProposal());
  await screen.findByTestId(`capture-goal-${GOAL_POINT_ID}`);
  await press('review-confirm');
  await screen.findByTestId('capture-saved');
}

describe('M3b A4 goals and plan handoff', () => {
  it('A4 goal: the card renders and confirm sends the goal family id', async () => {
    harness.server.handler = serve(goalProposal(), () => ({ status: 200, body: goalReceipt() }));
    await show(goalProposal());

    expect(screen.getByTestId(`capture-goal-${GOAL_POINT_ID}`)).toBeTruthy();
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/);
    expect(lastRequest(harness, 'POST', /\/capture\/confirm$/).body).toEqual(
      expect.objectContaining({ selectedGoalItemIds: [GOAL_ITEM_ID] }),
    );
  });

  it('A4 R3-006: saved goal with goalPlan starts the existing draft', async () => {
    harness.server.handler = serve(goalProposal(), () => ({ status: 200, body: goalReceipt() }));
    await saveGoal();

    await press(`capture-saved-start-plan-${GOAL_ID}`);
    await screen.findByTestId('plan-step-step-1');
  });

  it('A4 R4-003: a confirmed plan shows progress and never generates', async () => {
    harness.server.handler = serve(
      goalProposal(),
      () => ({ status: 200, body: goalReceipt() }),
      (request) => request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)
        ? { status: 200, body: { success: true, draft: null, confirmed: { ...PLAN, status: 'confirmed' }, linkedWork: [] } }
        : null,
    );
    await saveGoal();
    await press(`capture-saved-start-plan-${GOAL_ID}`);

    await screen.findByTestId('goal-plan-progress');
    expect(harness.server.matching('POST', new RegExp(`/goals/${GOAL_ID}/plan$`))).toHaveLength(0);
  });

  it('A4 R2-013: with goalPlan off the receipt opens the goal and has no start-plan action', async () => {
    harness.server.handler = serve(
      goalProposal(),
      () => ({ status: 200, body: goalReceipt() }),
      (request) => request.path.endsWith(`/goals/${GOAL_ID}/plan`)
        ? { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } }
        : null,
    );
    await saveGoal();

    expect(screen.queryByTestId(`capture-saved-start-plan-${GOAL_ID}`)).toBeNull();
    await press(`capture-saved-open-goal-${GOAL_ID}`);
    await screen.findByTestId(`memory-screen-item-${GOAL_ID}`);
  });

  it('A4 R4-003: remounting a start-plan goal does not generate twice', async () => {
    harness.server.handler = serve(
      goalProposal(),
      () => ({ status: 200, body: goalReceipt() }),
      (request) => {
        if (request.method === 'GET' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)) {
          return { status: 200, body: { success: true, draft: null, confirmed: null, linkedWork: [] } };
        }
        if (request.method === 'POST' && request.path.endsWith(`/goals/${GOAL_ID}/plan`)) {
          return { status: 200, body: { success: true, plan: PLAN } };
        }
        return null;
      },
    );
    await saveGoal();
    await press(`capture-saved-start-plan-${GOAL_ID}`);
    await waitForRequest(harness, 'POST', new RegExp(`/goals/${GOAL_ID}/plan$`));
    await press('goal-back-list');
    await press(`goal-open-${GOAL_ID}`);
    await screen.findByTestId('goal-back-list');

    expect(harness.server.matching('POST', new RegExp(`/goals/${GOAL_ID}/plan$`))).toHaveLength(1);
  });
});

describe('M3b A5 confirm, receipt and recovery', () => {
  it('A5 R3-002: confirm translates point selections into all four family lists and keeps today\'s choices', async () => {
    const raw = mixedProposal('thought');
    harness.server.handler = serve(raw);
    await show(raw);
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/);

    expect(lastRequest(harness, 'POST', /\/capture\/confirm$/).body).toEqual(expect.objectContaining({
      itemIds: [ITEM_ID],
      selectedHabitItemIds: [HABIT_ITEM_ID],
      selectedGoalItemIds: [GOAL_ITEM_ID],
      selectedSeedItemIds: [SEED_ITEM_ID],
      goalLinkItemIds: [ITEM_ID],
      weeklyBlockItemIds: [ITEM_ID],
      idempotencyKey: expect.any(String),
    }));
  });

  it('A5 R3-002 guard: a retried unchanged confirm reuses its idempotency key', async () => {
    const raw = mixedProposal('thought');
    harness.server.handler = serve(raw, (_request, call) => call === 1
      ? { status: 503, body: { success: false, error: 'offline' } }
      : { status: 200, body: mixedConfirmation() });
    await show(raw);
    await press('review-confirm');
    await screen.findByTestId('review-confirm-failed');
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/, 2);

    const requests = harness.server.matching('POST', /\/capture\/confirm$/);
    const first = requests[0]!.body as { idempotencyKey: string };
    const second = requests[1]!.body as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it.each<['habit' | 'goal' | 'seed', string]>([
    ['habit', `capture-habit-${HABIT_POINT_ID}`],
    ['goal', `capture-goal-${GOAL_POINT_ID}`],
    ['seed', `capture-seed-${SEED_POINT_ID}`],
  ])('A5 R3-002: changed %s selection gets a new confirm key', async (_family, control) => {
    const raw = mixedProposal('thought');
    harness.server.handler = serve(raw, (_request, call) => call === 1
      ? { status: 503, body: { success: false, error: 'offline' } }
      : { status: 200, body: mixedConfirmation() });
    await show(raw);
    await press('review-confirm');
    await screen.findByTestId('review-confirm-failed');
    await press(control);
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/, 2);

    const requests = harness.server.matching('POST', /\/capture\/confirm$/);
    const first = requests[0]!.body as { idempotencyKey: string };
    const second = requests[1]!.body as { idempotencyKey: string };
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('A5 R3-004: a mixed receipt exposes every family action and no Undo', async () => {
    const raw = mixedProposal('thought');
    harness.server.handler = serve(raw);
    await show(raw);
    await press('review-confirm');

    await screen.findByTestId('capture-saved');
    expect(screen.getByTestId(`capture-saved-open-habit-${HABIT_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`capture-saved-open-goal-${GOAL_ID}`)).toBeTruthy();
    expect(screen.getByTestId('capture-saved-open-thoughts')).toBeTruthy();
    expect(screen.queryByTestId('chat-saved-undo')).toBeNull();
  });

  it('A5 R3-004 guard: a commitment-only receipt keeps Undo', async () => {
    const raw = proposal({
      items: [commitment()],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, pointId: 'point-commitment', text: 'Call Dana' }],
    });
    const receipt = confirmation({
      persisted: [{ itemId: ITEM_ID, pointId: 'point-commitment', commitmentId: 'commitment-saved', title: 'Call Dana', resolvedTime: '2030-01-08T09:00:00.000Z' }],
    });
    harness.server.handler = serve(raw, () => ({ status: 200, body: receipt }));
    await show(raw);
    await press('review-confirm');

    await screen.findByTestId('chat-saved-1');
    expect(screen.getByTestId('chat-saved-undo')).toBeTruthy();
  });

  it('A5 R4-004: the mixed receipt opens the saved goal in Memory and it can be removed there', async () => {
    const raw = mixedProposal('thought');
    harness.server.handler = serve(raw);
    await show(raw);
    await press('review-confirm');
    await screen.findByTestId('capture-saved');
    await press(`capture-saved-open-goal-${GOAL_ID}`);

    await screen.findByTestId(`memory-screen-item-${GOAL_ID}`);
    await press(`memory-screen-delete-${GOAL_ID}`);
    expect(screen.queryByTestId(`memory-screen-item-${GOAL_ID}`)).toBeNull();
  });

  it('A5 R3-005: saving a habit invalidates the habits page immediately', async () => {
    const raw = proposal({ habits: [{
      habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, title: 'Walk every morning',
      cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: 30, preferredWindow: 'morning',
      explanation: 'Three mornings each week.', question: null, confirmable: true,
    }], understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk every morning' }] });
    const receipt = confirmation({ habitsPersisted: [{ habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, habitId: HABIT_ID, title: 'Walk every morning' }] });
    jest.mocked(habitEndpoints.listHabits).mockImplementation(async () => harness.server.answeredMatching('POST', /\/capture\/confirm$/).length
      ? [{ habitId: HABIT_ID, title: 'Walk every morning', status: 'active', cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: 30, preferredWindows: [], minimumOccurrences: 3, maximumOccurrences: 3, flexibility: 'flexible', recoveryPolicy: 'skip', source: 'capture_chat', confirmation: { confirmedByUserAt: '2030-01-07T09:00:00.000Z', sourceRef: 'm3b-proposal', acceptedSuggestedValues: true } }] as never
      : [] as never);
    harness.server.handler = serve(raw, () => ({ status: 200, body: receipt }));
    await show(raw);
    await press('review-confirm');
    await screen.findByTestId('capture-saved');
    await press(`capture-saved-open-habit-${HABIT_ID}`);

    await screen.findByTestId(`habit-toggle-${HABIT_ID}`);
  });

  it('A5 R3-005: saving a goal invalidates Memory immediately', async () => {
    let saved = false;
    jest.mocked(profileEndpoints.listMemory).mockImplementation(async () => saved ? MEMORY as never : { items: [], suggestions: [], adaptive: null } as never);
    harness.server.handler = serve(goalProposal(), (_request, call) => {
      saved = call > 0;
      return { status: 200, body: goalReceipt() };
    });
    await saveGoal();
    await press(`capture-saved-open-goal-${GOAL_ID}`);

    await screen.findByTestId(`memory-screen-item-${GOAL_ID}`);
  });

  it('A5 R3-005: saving a thought invalidates the thoughts page immediately', async () => {
    let saved = false;
    jest.mocked(seedEndpoints.listSeeds).mockImplementation(async () => saved ? { items: [{
      seedId: SEED_ID, kind: 'consideration', summary: 'Maybe go tomorrow', status: 'open', revisitAt: null,
      createdAt: '2030-01-07T09:00:00.000Z', updatedAt: '2030-01-07T09:00:00.000Z', source: 'capture', sourceRef: 'm3b-proposal',
    }] } as never : { items: [] } as never);
    const raw = proposal({ entry: 'thought', seeds: [{ seedItemId: SEED_ITEM_ID, pointId: SEED_POINT_ID, kind: 'consideration', summary: 'Maybe go tomorrow', suggestedTime: null }], understood: [{ kind: 'consideration', seedItemId: SEED_ITEM_ID, pointId: SEED_POINT_ID, text: 'Maybe go tomorrow' }] });
    const receipt = confirmation({ seedsPersisted: [{ seedItemId: SEED_ITEM_ID, pointId: SEED_POINT_ID, seedId: SEED_ID, kind: 'consideration', title: 'Maybe go tomorrow' }] });
    harness.server.handler = serve(raw, (_request, call) => {
      saved = call > 0;
      return { status: 200, body: receipt };
    });
    await show(raw);
    await press('review-confirm');
    await screen.findByTestId('capture-saved');
    await press('capture-saved-open-thoughts');

    await screen.findByTestId(`seed-${SEED_ID}`);
  });

  it('A5 R4-001/R5-001: confirmed proposal 409 shows the original finalized receipt', async () => {
    const raw = mixedProposal('thought');
    harness.server.handler = serve(raw, () => ({
      status: 409,
      body: {
        success: false,
        error: 'proposal changed',
        reason: 'proposal_changed',
        state: 'confirmed',
        proposal: raw,
        confirmation: mixedConfirmation(),
      },
    }));
    await show(raw);
    await press('review-confirm');

    await screen.findByTestId('capture-saved');
    expect(screen.getByTestId(`capture-saved-open-habit-${HABIT_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`capture-saved-open-goal-${GOAL_ID}`)).toBeTruthy();
    expect(screen.getByTestId('capture-saved-open-thoughts')).toBeTruthy();
  });
});
