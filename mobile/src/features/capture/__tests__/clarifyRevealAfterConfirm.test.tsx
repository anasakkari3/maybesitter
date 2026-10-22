/**
 * #752: after «هيك صح» the time question opened below the fold — it started
 * on screen, but its free-time chips sat under the composer, and nothing said
 * a question was waiting. Now the question and its chips are scrolled into
 * view (a jump under reduce motion), and a screen reader is taken to it.
 *
 * jest fires no layout, so each test lays the page out itself, with the
 * numbers of the M4a simulator shot (`evidence/claudex-20261006/M4/sim-m4a/08`):
 * the question starts on screen and its chips run under the composer.
 */
import { AccessibilityInfo, ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CaptureProposal } from '../../../api/schemas/capture';
import * as captureEndpoints from '../../../api/endpoints/capture';
import { resetAuthForTests } from '../../../api/auth';
import { chatServer } from '../../../testing/captureChat';
import { openCapture, prepareRoot, say, type RootHarness } from '../../../__acceptance__/m2a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const TOMORROW = day(1);

/** «بدي روح عالبنك بكرا»: one point, no time yet, three free times offered. */
const bank: CaptureProposal = {
  version: 'v1', proposalId: 'p-bank', revision: 1, status: 'needs_clarification', seeds: [],
  items: [{
    itemId: 'bank', title: 'روح عالبنك', resolvedTime: null, needsClarification: true,
    clarification: {
      questionId: 'q-time', field: 'time', questionKey: 'ask_time', params: { title: 'روح عالبنك' },
      options: [
        ...['08:30', '10:30', '15:30'].map((time, index) => ({
          optionId: `slot-${index + 1}`, labelKey: 'freeSlot',
          labelParams: { localDate: TOMORROW, localTime: time }, value: { localDate: TOMORROW, localTime: time },
        })),
        { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
      ],
      allowFreeText: true,
    },
  }],
  understood: [{ kind: 'commitment', itemId: 'bank', text: 'روح عالبنك' }],
} as unknown as CaptureProposal;

const layout = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 390, height } } });
type Node = { props: { testID?: string } };
/** The testIDs a screen reader was moved to: `focus` events only. */
const focusedIds = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([, event]) => event === 'focus').map(([node]) => (node as Node | null)?.props?.testID ?? null);

let harness: RootHarness;
beforeEach(async () => { harness = await prepareRoot('ar'); });
afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

describe('#752: «هيك صح» reveals the question it opens on', () => {
  it.each([
    { reduced: false, animated: true },
    { reduced: true, animated: false },
  ])('scrolls the question and its chips into view (reduce motion: $reduced) and focuses it', async ({ reduced, animated }) => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced);
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    const scrollTo = jest.spyOn(ScrollView.prototype as unknown as { scrollTo: (...args: unknown[]) => void }, 'scrollTo')
      .mockImplementation(() => {});
    // A spy carried over from the last case keeps its calls: start from none.
    focus.mockClear();
    scrollTo.mockClear();
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => bank) as never);
    await openCapture(harness);
    await say('بدي روح عالبنك بكرا');
    await waitFor(() => expect(screen.queryByTestId('understood-confirm')).not.toBeNull());

    // Under the summary the question is already there, and nothing moves yet:
    // the person is still reading what was understood.
    await act(async () => { await fireEvent(screen.getByTestId('capture-scroll'), 'layout', layout(0, 540)); });
    await act(async () => { await fireEvent(screen.getByTestId('chat-clarification'), 'layout', layout(520, 360)); });
    expect(focusedIds(focus)).not.toContain('clarify-question-focus');
    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockClear();
    focus.mockClear();

    await act(async () => { await fireEvent.press(screen.getByTestId('understood-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('review-scroll')).not.toBeNull());
    expect(screen.queryByTestId('understood-confirm')).toBeNull();

    // The summary folds away: the question moves up to 408 — on screen — but
    // its chips end at 768, under the composer of a 540-point window.
    await act(async () => { await fireEvent(screen.getByTestId('chat-clarification'), 'layout', layout(408, 360)); });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 768 - 540 + 80, animated });
    // And a screen reader lands on the question, not on nothing.
    await waitFor(() => expect(focusedIds(focus)).toContain('clarify-question-focus'));
    expect(screen.getByTestId('clarify-question-focus').props.accessibilityLabel)
      .toContain('روح عالبنك');

    // One header: the wrapper the reader lands on; the text inside is not a second one.
    expect(screen.getByTestId('clarify-question-focus').props.accessibilityRole).toBe('header');
    expect(screen.getByTestId('clarify-question').props.accessibilityRole).toBeUndefined();

    // Once per opening: laying out again does not pull the person back.
    const calls = scrollTo.mock.calls.length;
    await act(async () => { await fireEvent(screen.getByTestId('chat-clarification'), 'layout', layout(410, 360)); });
    expect(scrollTo.mock.calls.length).toBe(calls);
  });

  it('back to the summary and «هيك صح» again reveals and focuses the question afresh (Q-A1-001)', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    const scrollTo = jest.spyOn(ScrollView.prototype as unknown as { scrollTo: (...args: unknown[]) => void }, 'scrollTo')
      .mockImplementation(() => {});
    focus.mockClear();
    scrollTo.mockClear();
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => bank) as never);
    await openCapture(harness);
    await say('بدي روح عالبنك بكرا');
    await waitFor(() => expect(screen.queryByTestId('understood-confirm')).not.toBeNull());
    await act(async () => { await fireEvent(screen.getByTestId('capture-scroll'), 'layout', layout(0, 540)); });
    await act(async () => { await fireEvent.press(screen.getByTestId('understood-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('understood-confirm')).toBeNull());
    await act(async () => { await fireEvent(screen.getByTestId('chat-clarification'), 'layout', layout(408, 360)); });
    await waitFor(() => expect(focusedIds(focus)).toContain('clarify-question-focus'));

    // Back to the summary (the header's back), then the same proposal again.
    await act(async () => { await fireEvent.press(within(screen.getByTestId('chat-header')).getAllByRole('button')[0]!); });
    await waitFor(() => expect(screen.queryByTestId('understood-confirm')).not.toBeNull());
    scrollTo.mockClear();
    focus.mockClear();
    await act(async () => { await fireEvent.press(screen.getByTestId('understood-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('understood-confirm')).toBeNull());
    await act(async () => { await fireEvent(screen.getByTestId('chat-clarification'), 'layout', layout(408, 360)); });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 768 - 540 + 80, animated: true });
    await waitFor(() => expect(focusedIds(focus)).toContain('clarify-question-focus'));
  });
});
