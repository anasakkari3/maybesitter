/**
 * The chat's first line follows the entry it was opened from (M3b, COPY-M3b 2).
 * Inspection M3B-A-003: all three entries opened with the generic welcome.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { openGenericCapture, openProduct, prepareM3b, press, teardown, withKinds, type M3bHarness } from '../../../__acceptance__/m3b/harness';
import ar from '../../../i18n/locales/ar.json';

let harness: M3bHarness;
beforeEach(async () => { harness = await prepareM3b('ar'); });
afterEach(async () => { await teardown(harness); });

describe('the chat opens with the entry’s own line', () => {
  it.each<['things-goals' | 'things-habits' | 'things-ideas', string, string]>([
    ['things-goals', 'goals-add', ar.xChatOpenGoal],
    ['things-habits', 'habits-add', ar.xChatOpenHabit],
    ['things-ideas', 'seeds-add', ar.xChatOpenThought],
  ])('%s → %s', async (row, control, line) => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought']);
    await openProduct(harness, row);
    await screen.findByTestId(control);
    await press(control);
    await screen.findByTestId('capture-input');
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByText(ar.chatWelcome)).toBeNull();
  });

  it('the generic chat keeps its welcome', async () => {
    harness.server.handler = withKinds(['goal', 'habit', 'thought']);
    await openGenericCapture(harness);
    await screen.findByTestId('capture-input');
    expect(screen.getByText(ar.chatWelcome)).toBeTruthy();
  });
});
