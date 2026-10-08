import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  ACCOUNT_B,
  defaultReply,
  emitAccount,
  kindsUnavailable,
  lastRequest,
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
import { answer } from './fixtures';

let harness: M3bHarness;

beforeEach(async () => {
  harness = await prepareM3b();
});

afterEach(async () => {
  await teardown(harness);
});

function chatReply(request: RecordedRequest): RouteReply {
  if (request.method === 'POST' && request.path.endsWith('/capture/chat')) {
    return { status: 200, body: answer(null) };
  }
  return defaultReply(request);
}

describe('M3b A1 entries and capability', () => {
  it.each<['things-goals' | 'things-habits' | 'things-ideas', string, 'goal' | 'habit' | 'thought']>([
    ['things-goals', 'goals-add', 'goal'],
    ['things-habits', 'habits-add', 'habit'],
    ['things-ideas', 'seeds-add', 'thought'],
  ])('A1 entry %s: opens the shared chat and the first message carries entry %s/%s', async (row, control, entry) => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought'], chatReply);
    await openProduct(harness, row);

    await screen.findByTestId(control);
    await press(control);
    await screen.findByTestId('capture-input');
    await say();
    await waitForRequest(harness, 'POST', /\/capture\/chat$/);

    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).toEqual(
      expect.objectContaining({ entry }),
    );
  });

  it('A1 probe 200: goals uses its entry and removes the IntelligencePanel', async () => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought']);
    await openProduct(harness, 'things-goals');

    await screen.findByTestId('goals-add');
    expect(screen.queryByTestId('intelligence-statement')).toBeNull();
    expect(screen.queryByTestId('goal-add-input')).toBeNull();
  });

  it('A1 probe 200: habits uses its entry and removes the create form', async () => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought']);
    await openProduct(harness, 'things-habits');

    await screen.findByTestId('habits-add');
    expect(screen.queryByTestId('habit-create')).toBeNull();
  });

  it('A1 probe 200: thoughts exposes its entry', async () => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought']);
    await openProduct(harness, 'things-ideas');

    await screen.findByTestId('seeds-add');
  });

  it.each<['things-goals' | 'things-habits' | 'things-ideas', string]>([
    ['things-goals', 'goal-add-input'],
    ['things-habits', 'habit-create'],
    ['things-ideas', 'seeds-empty-capture'],
  ])('A1 probe 404 %s: keeps the legacy path %s', async (row, legacyControl) => {
    harness.server.handler = kindsUnavailable(chatReply);
    await openProduct(harness, row);

    await waitForRequest(harness, 'GET', /\/capture\/kinds$/);
    await screen.findByTestId(legacyControl);
  });

  it('A1 probe 404: the legacy thought CTA opens plain chat with no entry', async () => {
    harness.server.handler = kindsUnavailable(chatReply);
    await openProduct(harness, 'things-ideas');
    await waitForRequest(harness, 'GET', /\/capture\/kinds$/);
    await press('seeds-empty-capture');
    await say();
    await waitForRequest(harness, 'POST', /\/capture\/chat$/);

    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).not.toHaveProperty('entry');
  });

  it('A1 probe pending: neither the goals entry nor the legacy goal path renders', async () => {
    harness.server.handler = async (request) => {
      if (request.method === 'GET' && request.path.endsWith('/capture/kinds')) {
        return await new Promise<RouteReply>(() => undefined);
      }
      return defaultReply(request);
    };
    await openProduct(harness, 'things-goals');
    await waitForRequest(harness, 'GET', /\/capture\/kinds$/);

    expect(screen.queryByTestId('goals-add')).toBeNull();
    expect(screen.queryByTestId('goal-add-input')).toBeNull();
  });

  it('A1 probe without goal: goals keeps today\'s behavior', async () => {
    harness.server.handler = withKinds(['habit', 'thought']);
    await openProduct(harness, 'things-goals');
    await waitForRequest(harness, 'GET', /\/capture\/kinds$/);

    expect(screen.queryByTestId('goals-add')).toBeNull();
    await screen.findByTestId('goal-add-input');
  });

  it('A1 account switch: clears the capability cache and the open entry hint', async () => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought'], chatReply);
    await openProduct(harness, 'things-goals');
    await screen.findByTestId('goals-add');
    await press('goals-add');
    await screen.findByTestId('capture-input');

    emitAccount(harness, ACCOUNT_B);
    await say('Message after account switch');
    await waitForRequest(harness, 'POST', /\/capture\/chat$/);
    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).not.toHaveProperty('entry');

    await press('capture-cancel');
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());
    await waitFor(() => expect(harness.server.matching('GET', /\/capture\/kinds$/).length).toBeGreaterThan(1));
  });

  it('A1 D4: the panel is absent from goals and still renders on Watching', async () => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought']);
    await openProduct(harness, 'things-goals');
    await screen.findByTestId('goals-add');
    expect(screen.queryByTestId('intelligence-statement')).toBeNull();

    await press('header-back');
    await press('tab-watching');
    await screen.findByTestId('watching-root');
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  });
});
