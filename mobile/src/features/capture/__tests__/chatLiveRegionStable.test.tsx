/**
 * #780: the newest reply sits in an always-mounted polite live region
 * (`chat-live`). Android announces whatever changes inside a live region, and
 * «هيك صح» takes the reply's summary (`body`) and «هيك صح» itself (`actions`)
 * away — so while they sat inside the region, TalkBack could read the reply
 * again, over the move to the time question (#752).
 *
 * The region now holds only an announcement node with the full arrival words.
 * The visible/navigable reply, summary and controls sit beside it in the same
 * bubble. This test takes the region's subtree — every node's type,
 * test id, accessibility props, style and text — before and after the press,
 * and asks that nothing in it changed.
 */
import { AccessibilityInfo, ScrollView, StyleSheet } from 'react-native';
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

const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const REPLY = 'فهمت عليك: بدك تروح عالبنك بكرا.';

/** «بدي روح عالبنك بكرا»: one point with a time question, so «هيك صح» opens on it. */
const bank: CaptureProposal = {
  version: 'v1', proposalId: 'p-bank', revision: 1, status: 'needs_clarification', seeds: [],
  items: [{
    itemId: 'bank', title: 'روح عالبنك', resolvedTime: null, needsClarification: true,
    clarification: {
      questionId: 'q-time', field: 'time', questionKey: 'ask_time', params: { title: 'روح عالبنك' },
      options: [
        { optionId: 'slot-1', labelKey: 'freeSlot', labelParams: { localDate: TOMORROW, localTime: '10:30' }, value: { localDate: TOMORROW, localTime: '10:30' } },
        { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
      ],
      allowFreeText: true,
    },
  }],
  understood: [{ kind: 'commitment', itemId: 'bank', text: 'روح عالبنك' }],
} as unknown as CaptureProposal;

type HostNode = { type: unknown; props: Record<string, unknown>; children: readonly (HostNode | string)[] };
/** The subtree as a screen reader and a layout see it: structure, semantics, style and text. */
function shape(node: HostNode | string): unknown {
  if (typeof node === 'string') return node;
  const { props } = node;
  return {
    type: node.type,
    testID: props.testID,
    accessible: props.accessible,
    accessibilityLabel: props.accessibilityLabel,
    accessibilityRole: props.accessibilityRole,
    accessibilityLiveRegion: props.accessibilityLiveRegion,
    importantForAccessibility: props.importantForAccessibility,
    accessibilityElementsHidden: props.accessibilityElementsHidden,
    style: StyleSheet.flatten(props.style as never) ?? null,
    children: node.children.map(shape),
  };
}
const liveSubtree = () => shape(screen.getByTestId('chat-live', { includeHiddenElements: true }) as unknown as HostNode);
const layout = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 390, height } } });

let harness: RootHarness;
beforeEach(async () => { harness = await prepareRoot('ar'); });
afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

describe('#780: «هيك صح» leaves the chat’s live region untouched', () => {
  it('keeps the summary and its controls outside the region, and the region’s subtree identical across the press', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(ScrollView.prototype as unknown as { scrollTo: (...args: unknown[]) => void }, 'scrollTo').mockImplementation(() => {});
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    focus.mockClear();
    announce.mockClear();
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => bank, { reply: () => REPLY }) as never);
    await openCapture(harness);
    await say('بدي روح عالبنك بكرا');
    await waitFor(() => expect(screen.queryByTestId('understood-confirm')).not.toBeNull());

    // The region says the reply, as one element, and nothing else.
    const live = within(screen.getByTestId('chat-live', { includeHiddenElements: true }));
    expect(live.getByTestId('chat-turn-assistant-1-announcement', { includeHiddenElements: true }).props.accessibilityLabel).toBe(REPLY);
    expect(live.queryByTestId('chat-turn-assistant-1-words')).toBeNull();
    expect(live.queryByTestId('understood-confirm')).toBeNull();
    expect(live.queryByTestId('understood-line-1')).toBeNull();
    expect(live.queryByTestId('chat-turn-assistant-1-body')).toBeNull();
    expect(live.queryByTestId('chat-turn-assistant-1-actions')).toBeNull();
    // …while the summary and «هيك صح» are still in the reply's bubble.
    const message = within(screen.getByTestId('chat-turn-assistant-1'));
    expect(message.queryByTestId('chat-turn-assistant-1-words')).not.toBeNull();
    expect(message.queryByTestId('chat-turn-assistant-1-body')).not.toBeNull();
    expect(message.queryByTestId('understood-confirm')).not.toBeNull();

    const before = liveSubtree();
    await act(async () => { await fireEvent(screen.getByTestId('capture-scroll'), 'layout', layout(0, 540)); });
    await act(async () => { await fireEvent.press(screen.getByTestId('understood-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('review-scroll')).not.toBeNull());
    // The summary and «هيك صح» are gone from the bubble…
    expect(screen.queryByTestId('understood-confirm')).toBeNull();
    expect(screen.queryByTestId('chat-turn-assistant-1-body')).toBeNull();
    await act(async () => { await fireEvent(screen.getByTestId('chat-clarification'), 'layout', layout(408, 360)); });
    // …the screen reader is still taken to the question (#752)…
    await waitFor(() => expect(focus.mock.calls.some(([node, event]) => event === 'focus'
      && (node as { props?: { testID?: string } } | null)?.props?.testID === 'clarify-question-focus')).toBe(true));
    // …and nothing inside the live region changed, so TalkBack has nothing to read again.
    expect(liveSubtree()).toEqual(before);

    // VoiceOver (no live regions) heard the reply once, when it came, and not again.
    expect(announce.mock.calls.filter(([said]) => said === REPLY)).toHaveLength(1);
  });
});
