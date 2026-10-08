/**
 * A page opens the chat for its own kind (M3b, D1) without discarding anything
 * in progress (M2b condition 9). Simulator 2026-10-08: after a goal was saved,
 * «ضيف عادة» showed the goal chat's opening line and its next message carried
 * the goal hint.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import en from '../../../i18n/locales/en.json';
import {
  defaultReply, lastRequest, openCards, openProduct, prepareM3b, press, say, teardown, waitForRequest, withKinds, type M3bHarness,
} from '../../../__acceptance__/m3b/harness';
import { GOAL_ID, GOAL_ITEM_ID, GOAL_POINT_ID, answer, confirmation, goal, proposal } from '../../../__acceptance__/m3b/fixtures';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3bHarness;
beforeEach(async () => { harness = await prepareM3b(); });
afterEach(async () => { await teardown(harness); });

const goalProposal = () => proposal({
  entry: 'goal', goals: [goal()],
  understood: [{ kind: 'goal', goalItemId: GOAL_ITEM_ID, pointId: GOAL_POINT_ID, text: 'Lose weight gradually' }],
});

function serve() {
  harness.server.handler = withKinds(['goal', 'habit', 'thought'], (request) => {
    if (request.method === 'POST' && request.path.endsWith('/capture/chat')) return { status: 200, body: answer(goalProposal()) };
    if (request.method === 'POST' && request.path.endsWith('/capture/confirm')) {
      return { status: 200, body: confirmation({ goalsPersisted: [{ goalItemId: GOAL_ITEM_ID, pointId: GOAL_POINT_ID, goalId: GOAL_ID, title: 'Lose weight gradually' }] }) };
    }
    return defaultReply(request);
  });
}

/** From the goals page: say a goal and, unless told otherwise, save it; then leave the chat. */
async function goalChat(save: boolean): Promise<void> {
  await openProduct(harness, 'things-goals');
  await press(await screen.findByTestId('goals-add').then(() => 'goals-add'));
  await screen.findByTestId('capture-input');
  await say('Lose weight');
  await waitForRequest(harness, 'POST', /\/capture\/chat$/);
  await openCards();
  if (save) {
    await press('review-confirm');
    await screen.findByTestId('capture-saved');
  } else {
    await press('review-back');
  }
  await press(await screen.findByTestId('capture-cancel').then(() => 'capture-cancel'));
}

describe('a page opens the chat for its own kind', () => {
  it('after a saved goal chat, «ضيف عادة» opens with the habit line and its message carries the habit entry', async () => {
    serve();
    await goalChat(true);
    await press(await screen.findByTestId('header-back').then(() => 'header-back'));
    await press(await screen.findByTestId('things-habits').then(() => 'things-habits'));
    await press(await screen.findByTestId('habits-add').then(() => 'habits-add'));
    await screen.findByTestId('capture-input');
    expect(screen.getByText(en.xChatOpenHabit)).toBeTruthy();
    expect(screen.queryByText(en.xChatOpenGoal)).toBeNull();
    // The goal's save is still there (M2b condition 9, inspection M3B-A-R2-001).
    expect(screen.getByTestId('capture-saved')).toBeTruthy();
    await say('Walk every day');
    await waitForRequest(harness, 'POST', /\/capture\/chat$/, 2);
    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).toEqual(expect.objectContaining({ entry: 'habit' }));
  });

  it('after a saved goal chat, the plain «احكيها» keeps the chat but drops the goal hint', async () => {
    serve();
    await goalChat(true);
    await press(await screen.findByTestId('header-back').then(() => 'header-back'));
    await press(await screen.findByTestId('tab-capture').then(() => 'tab-capture'));
    await screen.findByTestId('capture-input');
    // The saves are still there (M2b condition 9).
    expect(screen.getByTestId('capture-saved')).toBeTruthy();
    await say('Something else');
    await waitForRequest(harness, 'POST', /\/capture\/chat$/, 2);
    expect(lastRequest(harness, 'POST', /\/capture\/chat$/).body).not.toHaveProperty('entry');
  });

  it('a goal chat still in progress is kept as it is, even from another page', async () => {
    serve();
    await goalChat(false);
    await press(await screen.findByTestId('header-back').then(() => 'header-back'));
    await press(await screen.findByTestId('things-habits').then(() => 'things-habits'));
    await press(await screen.findByTestId('habits-add').then(() => 'habits-add'));
    // The unsaved goal is still there: nothing in progress is discarded.
    await screen.findByTestId('capture-input');
    expect(screen.getByText(en.xChatOpenGoal)).toBeTruthy();
    expect(screen.queryByText(en.xChatOpenHabit)).toBeNull();
  });
});
