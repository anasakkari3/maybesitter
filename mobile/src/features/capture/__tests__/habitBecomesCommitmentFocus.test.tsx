/**
 * A habit answered «موعد ثابت» comes back as a commitment card; the screen
 * reader is taken to that card, since the habit card it was on is gone
 * (inspection M3B-A-R2-005).
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { screen, waitFor } from '@testing-library/react-native';
import {
  defaultReply, openCards, openGenericCapture, prepareM3b, press, say, teardown, waitForRequest, withKinds, type M3bHarness,
} from '../../../__acceptance__/m3b/harness';
import { HABIT_POINT_ID, answer, incompleteHabit, proposal } from '../../../__acceptance__/m3b/fixtures';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3bHarness;
beforeEach(async () => { harness = await prepareM3b(); });
afterEach(async () => { await teardown(harness); jest.restoreAllMocks(); });

it('after «موعد ثابت», focus goes to the commitment card the habit became', async () => {
  const asked = proposal({ habits: [incompleteHabit('kind')], understood: [{ kind: 'habit', habitItemId: 'habit-family-id', pointId: HABIT_POINT_ID, text: 'Walk every morning' }] });
  const converted = proposal({
    revision: 2, habits: [],
    items: [{ itemId: 'new-item', pointId: HABIT_POINT_ID, title: 'Walk every morning', resolvedTime: '2030-01-08T07:00:00.000Z', needsClarification: false, priority: 'normal' }],
    understood: [{ kind: 'commitment', itemId: 'new-item', pointId: HABIT_POINT_ID, text: 'Walk every morning' }],
  });
  let chats = 0;
  harness.server.handler = withKinds(['goal', 'habit', 'thought'], (request) => {
    if (request.method === 'POST' && request.path.endsWith('/capture/chat')) {
      chats += 1;
      return { status: 200, body: answer(chats === 1 ? asked : converted) };
    }
    return defaultReply(request);
  });
  await openGenericCapture(harness);
  await say();
  await openCards();
  await screen.findByTestId(`capture-habit-option-${HABIT_POINT_ID}-commitment`);
  const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => undefined);
  await press(`capture-habit-option-${HABIT_POINT_ID}-commitment`);
  await waitForRequest(harness, 'POST', /\/capture\/chat$/, 2);
  await screen.findByTestId('review-card-new-item');
  await waitFor(() => expect(focus).toHaveBeenCalledWith(expect.anything(), 'focus'));
});
