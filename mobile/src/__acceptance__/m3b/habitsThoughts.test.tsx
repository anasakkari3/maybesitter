import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  defaultReply,
  lastRequest,
  openCards,
  openGenericCapture,
  openProduct,
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
  GOAL_POINT_ID,
  HABIT_ITEM_ID,
  HABIT_POINT_ID,
  ITEM_ID,
  SEED_ITEM_ID,
  SEED_POINT_ID,
  answer,
  confirmation,
  habit,
  incompleteHabit,
  mixedProposal,
  proposal,
  seed,
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

function proposalServer(rawProposal: Record<string, unknown>, editReply?: (request: RecordedRequest) => RouteReply) {
  return withKinds(['goal', 'habit', 'thought'], (request) => {
    if (request.method === 'POST' && request.path.endsWith('/capture/chat')) {
      const body = request.body as { edit?: unknown } | null;
      if (body?.edit && editReply) return editReply(request);
      return { status: 200, body: answer(rawProposal) };
    }
    if (request.method === 'POST' && request.path.endsWith('/capture/confirm')) {
      return { status: 200, body: confirmation() };
    }
    return defaultReply(request);
  });
}

async function showGeneric(rawProposal: Record<string, unknown>): Promise<void> {
  harness.server.handler = proposalServer(rawProposal);
  await openGenericCapture(harness);
  await say();
  await waitForRequest(harness, 'POST', /\/capture\/chat$/);
  await openCards();
}

async function showThought(rawProposal: Record<string, unknown>): Promise<void> {
  harness.server.handler = proposalServer(rawProposal);
  await openProduct(harness, 'things-ideas');
  await screen.findByTestId('seeds-add');
  await press('seeds-add');
  await say();
  await waitForRequest(harness, 'POST', /\/capture\/chat$/);
  await openCards();
}

describe('M3b A2 habit cards and answers', () => {
  it('A2 habit: a complete habit shows its card and server explanation', async () => {
    await showGeneric(proposal({
      habits: [habit()],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk every morning' }],
    }));

    expect(screen.getByTestId(`capture-habit-${HABIT_POINT_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`capture-habit-explanation-${HABIT_POINT_ID}`)).toBeTruthy();
  });

  it('A2 habit: an incomplete habit shows its question and no save', async () => {
    await showGeneric(proposal({
      status: 'needs_clarification',
      habits: [incompleteHabit()],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk regularly' }],
    }));

    expect(screen.getByTestId(`capture-habit-question-${HABIT_POINT_ID}`)).toBeTruthy();
    expect(screen.queryByTestId('review-confirm')).toBeNull();
  });

  it('A2 habit: tapping frequency sends one structured habit edit and redraws the answer', async () => {
    const initial = proposal({
      status: 'needs_clarification',
      habits: [incompleteHabit()],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk regularly' }],
    });
    const updated = proposal({
      revision: 8,
      habits: [habit()],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk every morning' }],
    });
    harness.server.handler = proposalServer(initial, () => ({ status: 200, body: answer(updated) }));
    await openGenericCapture(harness);
    await say();
    await openCards();
    await screen.findByTestId(`capture-habit-option-${HABIT_POINT_ID}-3`);
    await press(`capture-habit-option-${HABIT_POINT_ID}-3`);
    await waitFor(() => expect(harness.server.matching('POST', /\/capture\/chat$/)).toHaveLength(2));

    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).toEqual(expect.objectContaining({
      edit: expect.objectContaining({
        target: { habitItemId: HABIT_ITEM_ID },
        change: { cadence: { kind: 'weekly_count', count: 3 } },
      }),
    }));
    expect(screen.getByTestId(`capture-habit-explanation-${HABIT_POINT_ID}`)).toBeTruthy();
  });

  it('A2 R4-002: an incomplete habit is disabled and omitted from a mixed save', async () => {
    const raw = mixedProposal();
    raw.habits = [incompleteHabit()];
    harness.server.handler = proposalServer(raw);
    await openGenericCapture(harness);
    await say();
    await openCards();
    const control = await screen.findByTestId(`capture-habit-${HABIT_POINT_ID}`);

    expect(control.props.accessibilityState?.disabled).toBe(true);
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/);
    expect(lastRequest(harness, 'POST', /\/capture\/confirm$/).body).toEqual(
      expect.objectContaining({ selectedHabitItemIds: [] }),
    );
  });

  it('A2 R4-002: only incomplete habits has no save action', async () => {
    await showGeneric(proposal({
      status: 'needs_clarification',
      habits: [incompleteHabit('duration')],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk regularly' }],
    }));

    expect(screen.getByTestId(`capture-habit-question-${HABIT_POINT_ID}`)).toBeTruthy();
    expect(screen.queryByTestId('review-confirm')).toBeNull();
  });

  it('A2 R4-002: a 409 answer adopts the returned habit answer', async () => {
    const initial = proposal({
      status: 'needs_clarification',
      habits: [incompleteHabit()],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk regularly' }],
    });
    const current = proposal({
      revision: 9,
      habits: [habit()],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk three mornings' }],
    });
    harness.server.handler = proposalServer(initial, () => ({
      status: 409,
      body: { success: false, error: 'proposal changed', reason: 'proposal_changed', state: 'open', answer: answer(current) },
    }));
    await openGenericCapture(harness);
    await say();
    await openCards();
    await press(`capture-habit-option-${HABIT_POINT_ID}-3`);

    await screen.findByTestId(`capture-habit-explanation-${HABIT_POINT_ID}`);
    expect(harness.server.matching('POST', /\/capture\/chat$/)).toHaveLength(2);
  });
});

describe('M3b A3 thought behavior', () => {
  it('A3 thought: a timed seed can become a commitment through a structured edit', async () => {
    const initial = proposal({
      seeds: [seed()],
      understood: [{ kind: 'consideration', seedItemId: SEED_ITEM_ID, pointId: SEED_POINT_ID, text: 'Maybe go tomorrow' }],
    });
    const updated = proposal({
      revision: 8,
      items: [{
        itemId: ITEM_ID,
        pointId: SEED_POINT_ID,
        title: 'Go to the gym',
        resolvedTime: '2030-01-08T18:00:00.000Z',
        needsClarification: false,
      }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, pointId: SEED_POINT_ID, text: 'Go to the gym tomorrow' }],
    });
    harness.server.handler = proposalServer(initial, () => ({ status: 200, body: answer(updated) }));
    await openGenericCapture(harness);
    await say();
    await openCards();
    await screen.findByTestId(`capture-seed-commit-${SEED_POINT_ID}`);
    await press(`capture-seed-commit-${SEED_POINT_ID}`);
    await waitFor(() => expect(harness.server.matching('POST', /\/capture\/chat$/)).toHaveLength(2));

    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).toEqual(expect.objectContaining({
      edit: expect.objectContaining({
        target: { seedItemId: SEED_ITEM_ID },
        change: { kind: 'commitment' },
      }),
    }));
  });

  it('A3 thought entry: Save selects seeds and removes the per-seed Keep path', async () => {
    const raw = proposal({
      entry: 'thought',
      seeds: [seed()],
      understood: [{ kind: 'consideration', seedItemId: SEED_ITEM_ID, pointId: SEED_POINT_ID, text: 'Maybe go tomorrow' }],
    });
    await showThought(raw);

    expect(screen.queryByTestId(`review-seed-keep-${SEED_ITEM_ID}`)).toBeNull();
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/);
    expect(lastRequest(harness, 'POST', /\/capture\/confirm$/).body).toEqual(
      expect.objectContaining({ selectedSeedItemIds: [SEED_ITEM_ID] }),
    );
  });

  it('A3 generic entry: seeds keep their own Keep action and never enter confirm', async () => {
    const raw = mixedProposal(null);
    await showGeneric(raw);
    expect(screen.getByTestId(`capture-goal-${GOAL_POINT_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`review-seed-keep-${SEED_ITEM_ID}`)).toBeTruthy();

    await press(`capture-goal-${GOAL_POINT_ID}`);
    await press(`capture-habit-${HABIT_POINT_ID}`);
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/);
    expect(lastRequest(harness, 'POST', /\/capture\/confirm$/).body).not.toHaveProperty('selectedSeedItemIds');
  });
});
