/**
 * SIM-M5B2A-02 (simulator design notes, seen again 2026-10-23): the line that
 * says what a learned-card review did was drawn in the panel's shared status
 * area, about 400 pt below the tapped row at the default size and 2000 pt at
 * AX5. A screen reader heard it; a sighted person never saw it.
 *
 * Now it is drawn inside the learned card, under the header and above the
 * rows. Who hears it is unchanged: VoiceOver once, from
 * `announceForAccessibility`; TalkBack from the panel's one live region,
 * which carries the line on Android only (iOS reads no live region).
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

function expectLineInCard() {
  const card = screen.getByTestId('m5b-learned-card');
  const line = within(card).getByTestId('m5b-learned-status');
  expect(line.props.children).toEqual(expect.any(String));
  expect((line.props.children as string).length).toBeGreaterThan(0);
  // Under the header and above every row: where the person tapped, and no
  // row is pushed aside to make room for it.
  const order = cardOrder();
  expect(order[0]).toBe('m5b-learned');
  expect(order[1]).toBe('m5b-learned-status');
  return line;
}

describe('SIM-M5B2A-02 the learned result line sits in the learned card', () => {
  it('after «right» on a re-add guess, the line is in the card, not the shared area, and VoiceOver hears it once', async () => {
    const announce = countAnnouncements();
    await openPanel(panelState({
      observations: [readdMarker('guess'), outcome('kept', 'completed', '2030-03-27T08:00:00.000Z')],
    }));
    const reads = harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length;

    await fireEvent.press(screen.getByTestId(readdTestIds.right('guess')));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(reads));

    expectLineInCard();
    // The confirmed guess is still on the card, now with only «wrong».
    expect(screen.getByTestId(readdTestIds.row('guess'))).toBeTruthy();
    expect(screen.queryByTestId(readdTestIds.right('guess'))).toBeNull();
    // Not drawn a second time in the panel's shared area on iOS.
    const region = screen.getByTestId('intelligence-status');
    expect(region.props.accessibilityLiveRegion).toBe('polite');
    expect(within(region).queryByTestId('m5b-learned-status')).toBeNull();
    expect(screen.queryByTestId('m5b-learned-status-live')).toBeNull();
    expect(screen.getAllByTestId('m5b-learned-status')).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('after «wrong» on a tapped outcome, the line is in the card above the rows that stay, and VoiceOver hears it once', async () => {
    const announce = countAnnouncements();
    await openPanel(panelState({
      observations: [
        outcome('gone', 'dropped', '2030-03-28T08:00:00.000Z'),
        outcome('stays', 'completed', '2030-03-27T08:00:00.000Z'),
      ],
    }));

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-gone'));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-row-gone')).toBeNull());

    expectLineInCard();
    expect(cardOrder().slice(2)).toEqual(['m5b-learned-row-stays']);
    expect(within(screen.getByTestId('intelligence-status')).queryByTestId('m5b-learned-status')).toBeNull();
    expect(screen.getAllByTestId('m5b-learned-status')).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('on Android the panel\'s one live region still carries the line for TalkBack, and nothing else announces it', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const announce = countAnnouncements();
    await openPanel(panelState({
      observations: [
        outcome('gone', 'dropped', '2030-03-28T08:00:00.000Z'),
        outcome('stays', 'completed', '2030-03-27T08:00:00.000Z'),
      ],
    }));

    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-gone'));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-row-gone')).toBeNull());

    const line = expectLineInCard();
    const region = screen.getByTestId('intelligence-status');
    expect(region.props.accessibilityLiveRegion).toBe('polite');
    expect(within(region).getByTestId('m5b-learned-status-live').props.children).toBe(line.props.children);
    // The region is the only live region the line is in, and the card is none.
    expect(screen.getByTestId('m5b-learned-card').props.accessibilityLiveRegion).toBeUndefined();
    expect(announce).not.toHaveBeenCalled();
  });

  it('collapsing the card hides the rows and keeps the line under the header', async () => {
    await openPanel(panelState({
      observations: [readdMarker('guess'), outcome('kept', 'completed', '2030-03-27T08:00:00.000Z')],
    }));
    await fireEvent.press(screen.getByTestId(readdTestIds.right('guess')));
    await waitFor(() => expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('m5b-learned'));

    expect(screen.queryByTestId(readdTestIds.row('guess'))).toBeNull();
    expect(cardOrder()).toEqual(['m5b-learned', 'm5b-learned-status']);
  });
});
