/**
 * M2A-REV-003 / -004: a tapped line of «هيك فهمت» brings up exactly its own
 * card — a seed included — and only for the proposal it belongs to.
 */
import { AccessibilityInfo } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CaptureProposal } from '../../../api/schemas/capture';
import * as captureEndpoints from '../../../api/endpoints/capture';
import { resetAuthForTests } from '../../../api/auth';
import { chatServer } from '../../../testing/captureChat';
import { openCapture, prepareRoot, say, type RootHarness } from '../../../__acceptance__/m2a/harness';

// The page's own props, to read which proposal it is told to reveal: jest
// fires no layout, so the scroll itself cannot be observed here.
const pageProps: { current: { revealConfirmKey?: string | null } | null } = { current: null };
jest.mock('../SayItChatPage', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const actual = jest.requireActual<typeof import('../SayItChatPage')>('../SayItChatPage');
  return { ...actual, SayItChatPage: (props: import('../SayItChatPage').SayItChatPageProps) => {
    pageProps.current = props;
    return React.createElement(actual.SayItChatPage, props);
  } };
});

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const START = new Date(Date.now() + 48 * 3_600_000).toISOString();

const withSeeds: CaptureProposal = {
  version: 'v1', proposalId: 'p-seeds', status: 'proposed',
  items: [{ itemId: 'study', title: 'Study', resolvedTime: START, needsClarification: false }],
  seeds: [
    { seedItemId: 'italian', kind: 'possible_goal', summary: 'Learn Italian' },
    { seedItemId: 'move', kind: 'consideration', summary: 'Move closer to work' },
  ],
  understood: [
    { kind: 'commitment', itemId: 'study', text: 'Study session' },
    { kind: 'possible_goal', seedItemId: 'italian', text: 'Learn Italian' },
    { kind: 'consideration', seedItemId: 'move', text: 'Move closer to work' },
  ],
};
const legacy: CaptureProposal = {
  version: 'v1', proposalId: 'p-legacy', status: 'proposed', seeds: [],
  items: [{ itemId: 'dentist', title: 'Dentist', resolvedTime: START, needsClarification: false }],
};

let harness: RootHarness;
beforeEach(async () => { harness = await prepareRoot('en'); });
afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

type Node = { props: { accessibilityLabel?: string } };
const focusedLabels = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([node]) => String((node as Node | null)?.props?.accessibilityLabel ?? ''));

describe('revealing a line\'s card', () => {
  it('lands the screen reader on the very seed the line named, not the first one', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => withSeeds) as never);
    await openCapture(harness);
    await say('three things');
    await waitFor(() => expect(screen.queryByTestId('understood-line-3')).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId('understood-line-3')); });
    await waitFor(() => expect(screen.queryByTestId('review-seed-move')).not.toBeNull());
    await waitFor(() => expect(focusedLabels(focus).some((label) => label.includes('Move closer to work'))).toBe(true));
    expect(focusedLabels(focus).some((label) => label.includes('Learn Italian'))).toBe(false);
  });

  it('lands on a commitment\'s checkbox', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => withSeeds) as never);
    await openCapture(harness);
    await say('three things');
    await waitFor(() => expect(screen.queryByTestId('understood-line-1')).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId('understood-line-1')); });
    await waitFor(() => expect(focusedLabels(focus).some((label) => label.startsWith('Study'))).toBe(true));
  });

  it('a later proposal with no summary opens as before: the old request does not follow it', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer((_m, call) => (call === 0 ? withSeeds : legacy)) as never);
    await openCapture(harness);
    await say('three things');
    await waitFor(() => expect(screen.queryByTestId('understood-line-1')).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId('understood-line-1')); });
    await waitFor(() => expect(screen.queryByTestId('review-card-study')).not.toBeNull());
    const before = focus.mock.calls.length;
    await say('and the dentist');
    await waitFor(() => expect(screen.queryByTestId('review-card-dentist')).not.toBeNull());
    expect(screen.queryByTestId('understood-line-1')).toBeNull();
    // Nothing focuses a card of the old proposal once the new one is on screen.
    expect(focus.mock.calls.length).toBe(before);
    expect(screen.getByTestId('review-back')).toBeTruthy();
    // And the new proposal still reveals its first card on its own, as before.
    expect(pageProps.current?.revealConfirmKey).toBe('p-legacy');
  });
});
