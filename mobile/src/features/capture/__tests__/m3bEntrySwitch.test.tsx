/**
 * A page opens the chat for its own kind (M3b, D1) without discarding anything
 * in progress (M2b condition 9). Simulator 2026-10-08: after a goal was saved,
 * «ضيف عادة» showed the goal chat's opening line and its next message carried
 * the goal hint.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import * as accessibilityFocus from '../../../ui/accessibilityFocus';
import { AccessibilityInfo, Platform } from 'react-native';
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

  // M3b SIM-5, owner decision 2026-10-09: an entry page over a chat of another
  // kind that is still in progress asks which chat this is going to be.
  async function habitsPageOverGoalChat(): Promise<void> {
    serve();
    await goalChat(false);
    await press(await screen.findByTestId('header-back').then(() => 'header-back'));
    await press(await screen.findByTestId('things-habits').then(() => 'things-habits'));
    await press(await screen.findByTestId('habits-add').then(() => 'habits-add'));
    await screen.findByTestId('capture-entry-ask');
  }

  it('a goal chat still in progress is not discarded from another page: the person is asked', async () => {
    await habitsPageOverGoalChat();
    expect(screen.getByText(en.xEntryOpenChatTitle)).toBeTruthy();
    expect(screen.getByText(en.xEntryOpenChatBody)).toBeTruthy();
    // Nothing was sent or thrown away by asking.
    expect(harness.server.matching('POST', /\/capture\/chat$/)).toHaveLength(1);
  });

  // Inspection FU-003: a screen reader hears that a question is waiting.
  it('the question takes the accessibility focus on its heading and is announced', async () => {
    const focus = jest.spyOn(accessibilityFocus, 'focusForAccessibility').mockImplementation(() => {});
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    await habitsPageOverGoalChat();
    const heading = screen.getByTestId('capture-entry-ask-title');
    expect(heading.props.accessibilityRole).toBe('header');
    expect(heading.props.accessibilityLabel).toBe(en.xEntryOpenChatTitle);
    // Once, and at a mounted view: the heading.
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.calls[0]![0]).not.toBeNull();
    if (Platform.OS === 'ios') expect(announce).toHaveBeenCalledWith(`${en.xEntryOpenChatTitle}. ${en.xEntryOpenChatBody}`);
    // Both answers are buttons named by their words.
    expect(screen.getByRole('button', { name: en.xEntryOpenChatContinue })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.xEntryOpenChatNew })).toBeTruthy();
  });

  // Inspection FU-005: nothing else on the page opens under the question.
  it('«المزيد» is off while the question is up, so «كمّل» opens the chat and not a menu', async () => {
    await habitsPageOverGoalChat();
    const more = screen.getByTestId('chat-more');
    expect(more.props.accessibilityState?.disabled ?? more.props.disabled).toBe(true);
    await press('capture-entry-ask-continue');
    await screen.findByTestId('capture-input');
    expect(screen.queryByTestId('chat-menu')).toBeNull();
    const after = screen.getByTestId('chat-more');
    expect(after.props.accessibilityState?.disabled ?? after.props.disabled ?? false).toBe(false);
  });

  it('«كمّل المحادثة» shows the goal chat as it was', async () => {
    await habitsPageOverGoalChat();
    await press('capture-entry-ask-continue');
    await screen.findByTestId('capture-input');
    expect(screen.queryByTestId('capture-entry-ask')).toBeNull();
    expect(screen.getByText(en.xChatOpenGoal)).toBeTruthy();
    expect(screen.queryByText(en.xChatOpenHabit)).toBeNull();
    // Its next message still belongs to the goal chat.
    await say('And walk more');
    await waitForRequest(harness, 'POST', /\/capture\/chat$/, 2);
    // The same conversation (which is what carries its entry), not a new habit one.
    const sent = lastRequest(harness, 'POST', /\/capture\/chat$/).body as Record<string, unknown>;
    expect(sent.conversationId).toBe('m3b-conversation');
    expect(sent.entry).not.toBe('habit');
  });

  it('«ابدأ جديدة» starts the habit chat: the habit line, and its message carries the habit entry and no conversation', async () => {
    await habitsPageOverGoalChat();
    await press('capture-entry-ask-new');
    await screen.findByTestId('capture-input');
    expect(screen.queryByTestId('capture-entry-ask')).toBeNull();
    expect(screen.getByText(en.xChatOpenHabit)).toBeTruthy();
    expect(screen.queryByText(en.xChatOpenGoal)).toBeNull();
    await say('Walk every day');
    await waitForRequest(harness, 'POST', /\/capture\/chat$/, 2);
    const sent = lastRequest(harness, 'POST', /\/capture\/chat$/).body as Record<string, unknown>;
    expect(sent).toEqual(expect.objectContaining({ entry: 'habit' }));
    expect(sent.conversationId ?? null).toBeNull();
  });

  it('back from the question keeps the open chat', async () => {
    await habitsPageOverGoalChat();
    // The chat's own back button, whichever name the page it is on gives it.
    await press(screen.queryByTestId('capture-cancel') ? 'capture-cancel' : 'review-back');
    await screen.findByTestId('capture-input');
    expect(screen.queryByTestId('capture-entry-ask')).toBeNull();
    expect(screen.getByText(en.xChatOpenGoal)).toBeTruthy();
  });

  it('the same page over its own chat in progress asks nothing', async () => {
    serve();
    await goalChat(false);
    await press(await screen.findByTestId('goals-add').then(() => 'goals-add'));
    await screen.findByTestId('capture-input');
    expect(screen.queryByTestId('capture-entry-ask')).toBeNull();
    expect(screen.getByText(en.xChatOpenGoal)).toBeTruthy();
  });

  it('the plain «احكيها» over a chat in progress asks nothing', async () => {
    serve();
    await goalChat(false);
    await press(await screen.findByTestId('header-back').then(() => 'header-back'));
    await press(await screen.findByTestId('tab-capture').then(() => 'tab-capture'));
    await screen.findByTestId('capture-input');
    expect(screen.queryByTestId('capture-entry-ask')).toBeNull();
  });
});
