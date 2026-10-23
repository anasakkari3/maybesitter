/**
 * SIM-M5B2A-02 (simulator design notes, seen again 2026-10-23): the line that
 * says what a learned-card review did was drawn in the panel's shared status
 * area, about 400 pt below the tapped row at the default size and 2000 pt at
 * AX5. A screen reader heard it; a sighted person never saw it.
 *
 * Now there is one copy of the line, inside the learned card, under the
 * header and above the rows. VoiceOver is told once (`announceForAccessibility`);
 * TalkBack hears the same node, which sits in the card's own polite live
 * region, mounted with the card before any tap can fill it (M5-LS-001).
 * With no row left, the title is a plain header, not a disclosure (M5-LS-002).
 */
import { AccessibilityInfo, Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import {
  NOW,
  ZONE,
  initialState,
  outcome,
  panelHandler,
  panelState,
  prepare,
  readdMarker,
  readdTestIds,
  showPanel,
  teardown,
  type M5bHarness,
  type ReaddPanelState,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5bHarness | undefined;
const originalOs = Platform.OS;

beforeEach(() => {
  process.env.TZ = ZONE;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  jest.useRealTimers();
});

async function openPanel(state: ReaddPanelState) {
  harness = await prepare('en', initialState(), panelHandler(state));
  await showPanel(harness);
  await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('m5b-learned'));
}

function countAnnouncements() {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  announce.mockClear();
  return announce;
}

/** The card's direct children, by testID, in drawing order. */
function cardOrder(): string[] {
  return screen.getByTestId('m5b-learned-card').children
    .map(child => (typeof child === 'string' ? '' : String(child.props.testID ?? '')))
    .filter(Boolean);
}

type Node = ReturnType<typeof screen.getByTestId>;
/** Every host node at or under `from` that `match` accepts. */
function findAll(from: Node, match: (node: Node) => boolean): Node[] {
  const own = match(from) ? [from] : [];
  return [...own, ...from.children.flatMap(child => (typeof child === 'string' ? [] : findAll(child, match)))];
}
/** Every node in the screen a reader could stop on or be told, that says exactly `text`. */
function nodesSaying(text: string): Node[] {
  return findAll(screen.container, node => node.props.accessibilityLabel === text
    || (node.type === 'Text' && node.children.some(child => child === text)));
}

/** The card's live region is there, polite and empty, before the tap that fills it. */
function expectEmptyCardRegion() {
  const live = within(screen.getByTestId('m5b-learned-card')).getByTestId('m5b-learned-live');
  expect(live.props.accessibilityLiveRegion).toBe('polite');
  expect(within(live).queryByTestId('m5b-learned-status')).toBeNull();
}

function expectOneLineInCard() {
  const card = screen.getByTestId('m5b-learned-card');
  const live = within(card).getByTestId('m5b-learned-live');
  expect(live.props.accessibilityLiveRegion).toBe('polite');
  const line = within(live).getByTestId('m5b-learned-status');
  const text = line.props.children as string;
  expect(typeof text).toBe('string');
  expect(text.length).toBeGreaterThan(0);
  // One node in the whole tree says it: nothing to see twice or swipe past twice.
  expect(nodesSaying(text)).toHaveLength(1);
  expect(within(screen.getByTestId('intelligence-status')).queryByText(text)).toBeNull();
  // Under the header and above every row: where the person tapped.
  const order = cardOrder();
  expect(['m5b-learned', 'm5b-learned-title']).toContain(order[0]);
  expect(order[1]).toBe('m5b-learned-live');
  return text;
}

const TWO_OUTCOMES = () => panelState({
  observations: [
    outcome('gone', 'dropped', '2030-03-28T08:00:00.000Z'),
    outcome('stays', 'completed', '2030-03-27T08:00:00.000Z'),
  ],
});

describe('SIM-M5B2A-02 the learned result line sits in the learned card', () => {
  it('after «right» on a re-add guess, the one line is in the card and VoiceOver hears it once', async () => {
    const announce = countAnnouncements();
    await openPanel(panelState({
      observations: [readdMarker('guess'), outcome('kept', 'completed', '2030-03-27T08:00:00.000Z')],
    }));
    expectEmptyCardRegion();
    const reads = harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length;

    await fireEvent.press(screen.getByTestId(readdTestIds.right('guess')));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(reads));

    expectOneLineInCard();
    // The confirmed guess is still on the card, now with only «wrong».
    expect(screen.getByTestId(readdTestIds.row('guess'))).toBeTruthy();
    expect(screen.queryByTestId(readdTestIds.right('guess'))).toBeNull();
    expect(screen.getByTestId('intelligence-status').props.accessibilityLiveRegion).toBe('polite');
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('after «wrong» on a tapped outcome, the one line is in the card above the rows that stay, and VoiceOver hears it once', async () => {
    const announce = countAnnouncements();
    await openPanel(TWO_OUTCOMES());

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-gone'));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-row-gone')).toBeNull());

    expectOneLineInCard();
    expect(cardOrder().slice(2)).toEqual(['m5b-learned-row-stays']);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('on Android the one line is spoken from the card\'s polite live region, mounted before the tap, with no copy elsewhere', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const announce = countAnnouncements();
    await openPanel(TWO_OUTCOMES());
    expectEmptyCardRegion();
    const regionBefore = within(screen.getByTestId('m5b-learned-card')).getByTestId('m5b-learned-live');

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-gone'));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-row-gone')).toBeNull());

    expectOneLineInCard();
    // The same region instance took the line: it was not mounted with it.
    expect(within(screen.getByTestId('m5b-learned-card')).getByTestId('m5b-learned-live')).toBe(regionBefore);
    expect(announce).not.toHaveBeenCalled();
  });

  it('after the last row goes, the title is a plain header: no disclosure, no toggle, no chevron', async () => {
    const announce = countAnnouncements();
    await openPanel(panelState({ observations: [outcome('only', 'completed', '2030-03-27T08:00:00.000Z')] }));
    const regionBefore = within(screen.getByTestId('m5b-learned-card')).getByTestId('m5b-learned-live');

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-only'));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-row-only')).toBeNull());

    expectOneLineInCard();
    expect(within(screen.getByTestId('m5b-learned-card')).getByTestId('m5b-learned-live')).toBe(regionBefore);
    expect(screen.queryByTestId('m5b-learned')).toBeNull();
    const title = screen.getByTestId('m5b-learned-title');
    expect(title.props.accessibilityRole).toBe('header');
    expect(title.props.accessible).toBe(true);
    const card = screen.getByTestId('m5b-learned-card');
    expect(findAll(card, node => node.props.accessibilityState?.expanded !== undefined)).toHaveLength(0);
    expect(findAll(card, node => typeof node.props.onPress === 'function')).toHaveLength(0);
    expect(findAll(card, node => node.props.accessibilityRole === 'button')).toHaveLength(0);
    expect(findAll(card, node => /^chevron-/.test(String(node.props.name ?? '')))).toHaveLength(0);
    expect(cardOrder()).toEqual(['m5b-learned-title', 'm5b-learned-live']);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('collapsing the card hides the rows and keeps the line under the header', async () => {
    await openPanel(panelState({
      observations: [readdMarker('guess'), outcome('kept', 'completed', '2030-03-27T08:00:00.000Z')],
    }));
    await fireEvent.press(screen.getByTestId(readdTestIds.right('guess')));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('m5b-learned'));

    expect(screen.queryByTestId(readdTestIds.row('guess'))).toBeNull();
    expect(cardOrder()).toEqual(['m5b-learned', 'm5b-learned-live']);
    expect(screen.getByTestId('m5b-learned').props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
  });
});
