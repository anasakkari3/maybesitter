import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import en from '../../i18n/locales/en.json';
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
  HABIT_ITEM_ID,
  HABIT_POINT_ID,
  ITEM_ID,
  answer,
  confirmation,
  habit,
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

function refusalServer(rawProposal: Record<string, unknown>, refusal: RouteReply) {
  let confirms = 0;
  return withKinds(['goal', 'habit', 'thought'], (request) => {
    if (request.method === 'POST' && request.path.endsWith('/capture/chat')) {
      return { status: 200, body: answer(rawProposal) };
    }
    if (request.method === 'POST' && request.path.endsWith('/capture/confirm')) {
      confirms += 1;
      return confirms === 1 ? refusal : { status: 200, body: mixedConfirmation() };
    }
    return defaultReply(request);
  });
}

async function showAndConfirm(rawProposal: Record<string, unknown>): Promise<void> {
  await openGenericCapture(harness);
  await say();
  await openCards();
  await press('review-confirm');
}

describe('M3b A6 typed refusals', () => {
  it('A6 R2-010 kinds_unavailable: offers commitment-only recovery and never errorsServer', async () => {
    const raw = mixedProposal('thought');
    harness.server.handler = refusalServer(raw, {
      status: 409,
      body: { success: false, error: 'capture kinds unavailable', reason: 'kinds_unavailable' },
    });
    await showAndConfirm(raw);

    await screen.findByTestId('capture-confirm-refused');
    expect(screen.getByTestId('capture-confirm-refused-action')).toBeTruthy();
    expect(screen.queryByText(en.errorsServer)).toBeNull();
    await press('capture-confirm-refused-action');
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/, 2);
    expect(lastRequest(harness, 'POST', /\/capture\/confirm$/).body).toEqual(expect.objectContaining({
      itemIds: [ITEM_ID],
      selectedHabitItemIds: [],
      selectedGoalItemIds: [],
      selectedSeedItemIds: [],
    }));
  });

  it('A6 R2-010 goals_unavailable: removes the goal and saves the rest without errorsServer', async () => {
    const raw = mixedProposal('thought');
    harness.server.handler = refusalServer(raw, {
      status: 409,
      body: { success: false, error: 'goals unavailable', reason: 'goals_unavailable' },
    });
    await showAndConfirm(raw);

    await screen.findByTestId('capture-confirm-refused');
    expect(screen.getByTestId('capture-confirm-refused-action')).toBeTruthy();
    expect(screen.queryByText(en.errorsServer)).toBeNull();
    await press('capture-confirm-refused-action');
    await press('review-confirm');
    await waitForRequest(harness, 'POST', /\/capture\/confirm$/, 2);
    expect(lastRequest(harness, 'POST', /\/capture\/confirm$/).body).toEqual(expect.objectContaining({
      selectedGoalItemIds: [],
    }));
  });

  it.each<['too_many_writes' | 'habit_invalid' | 'key_reused', 400 | 409]>([
    ['too_many_writes', 400],
    ['habit_invalid', 400],
    ['key_reused', 409],
  ])('A6 R3-007 %s: shows its typed failure and never errorsServer', async (reason, status) => {
    const raw = mixedProposal('thought');
    const body = status === 400
      ? { success: false, error: 'capture refused', failureCode: reason, replayed: false, persisted: [], failed: [] }
      : { success: false, error: 'idempotency key reused', reason };
    harness.server.handler = refusalServer(raw, { status, body });
    await showAndConfirm(raw);

    await screen.findByTestId('capture-confirm-refused');
    expect(screen.queryByText(en.errorsServer)).toBeNull();
    if (reason === 'habit_invalid') {
      expect(screen.getByTestId(`capture-habit-question-${HABIT_POINT_ID}`)).toBeTruthy();
    }
  });
});

describe('M3b R2-011 stable point ids', () => {
  it('R2-011 point ids: a deselected habit converted to a commitment stays deselected', async () => {
    const initial = proposal({
      habits: [habit()],
      understood: [{ kind: 'habit', habitItemId: HABIT_ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk every morning' }],
    });
    const converted = proposal({
      revision: 8,
      items: [{
        itemId: ITEM_ID,
        pointId: HABIT_POINT_ID,
        title: 'Walk every morning',
        resolvedTime: null,
        needsClarification: true,
      }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, pointId: HABIT_POINT_ID, text: 'Walk every morning' }],
    });
    harness.server.handler = withKinds(['goal', 'habit', 'thought'], (request: RecordedRequest): RouteReply => {
      if (request.method === 'POST' && request.path.endsWith('/capture/chat')) {
        const body = request.body as { edit?: unknown } | null;
        return { status: 200, body: answer(body?.edit ? converted : initial) };
      }
      if (request.method === 'POST' && request.path.endsWith('/capture/confirm')) {
        return { status: 200, body: confirmation() };
      }
      return defaultReply(request);
    });
    await openGenericCapture(harness);
    await say();
    await openCards();
    await press(`capture-habit-${HABIT_POINT_ID}`);
    await press('header-back');
    await press('understood-edit-1');
    await press('understood-edit-kind-commitment');
    await press('understood-edit-save');
    await waitFor(() => expect(harness.server.matching('POST', /\/capture\/chat$/)).toHaveLength(2));
    await openCards();

    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).toEqual(expect.objectContaining({
      edit: expect.objectContaining({
        target: { habitItemId: HABIT_ITEM_ID },
        change: expect.objectContaining({ kind: 'commitment' }),
      }),
    }));
    expect(screen.queryByTestId('review-confirm')).toBeNull();
  });
});
