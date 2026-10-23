/**
 * «شو تعلّمت من اللي عملته» follows a text-size change made while it is open
 * (simulator 2026-10-23, screens 33/33b and 37/37b).
 *
 * Nothing in the card changes with the layout mode, so on a live change none
 * of its paragraphs got new props: growing to AX5 they drew at AX5 inside the
 * boxes measured at the default size — slivers — and shrinking back the title
 * kept its AX5 height of 305 pt. Under the card's own `RemeasureOnTextScale`
 * every one of them is a new paragraph after the change, while its buttons and
 * the wrappers that say its standalone words stay mounted. The Watching
 * header's line (a gap under the header back at the default size) is held the
 * same way.
 *
 * Real `useWindowDimensions` and `Dimensions.set`, as in
 * understoodLiveTextScale.test; the default reading is restored after each test.
 */
import React from 'react';
import { Dimensions } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { IntelligencePanel } from '../IntelligencePanel';
import { WatchingScreen } from '../../watching/WatchingScreen';
import { DirectionRoot } from '../../../ui/DirectionRoot';
import {
  NOW, Providers, ZONE, initialState, outcome, panelHandler, panelState, prepare, readdMarker, readdTestIds, teardown,
  type M5bHarness,
} from '../../../__acceptance__/m5b2b2/harness';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const AX5 = 3.12;

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

let harness: M5bHarness | undefined;
beforeEach(() => { process.env.TZ = ZONE; jest.useFakeTimers(); jest.setSystemTime(NOW); setFontScale(1); });
afterEach(async () => { await teardown(harness); harness = undefined; jest.useRealTimers(); setFontScale(1); });

type Host = ReturnType<typeof screen.getByTestId>;

/** Every native paragraph drawn in the card. */
function paragraphs(): Host[] {
  return within(screen.getByTestId('m5b-learned-card')).getAllByText(/./, { includeHiddenElements: true });
}

const BUTTON_IDS = ['m5b-learned', readdTestIds.right('g1'), readdTestIds.wrong('g1'), readdTestIds.wrong('c1')];
/** The accessible wrappers that say the guess word and each line: what a reader rests on instead of the paragraphs. */
const WRAPPER_IDS = [readdTestIds.guess('g1'), 'm5b-learned-line-g1', 'm5b-learned-line-c1'];

describe('the learned card re-measures after a live text-size change', () => {
  it('default → AX5 → default: every line is a new paragraph each time, the buttons the same ones', async () => {
    harness = await prepare('ar', initialState(), panelHandler(panelState({
      observations: [readdMarker('g1'), outcome('c1', 'completed')],
    })));
    await render(
      <Providers harness={harness}>
        <DirectionRoot>
          <IntelligencePanel onChanged={() => undefined} />
        </DirectionRoot>
      </Providers>,
    );
    await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId('m5b-learned')); });
    await waitFor(() => expect(screen.queryByTestId(readdTestIds.right('g1'))).not.toBeNull());

    const buttons = BUTTON_IDS.map((id) => screen.getByTestId(id));
    const wrappers = WRAPPER_IDS.map((id) => screen.getByTestId(id));
    for (const node of wrappers) {
      expect(node.props.accessible).toBe(true);
      expect(node.props.accessibilityRole).toBe('text');
      expect(String(node.props.accessibilityLabel).length).toBeGreaterThan(0);
      // The drawn paragraph inside is not a second thing to focus.
      expect(within(node).getByText(/./).props.accessible).toBe(false);
    }
    let drawn = paragraphs();
    // The title, the guess word, both lines and their answers — not one or two.
    expect(drawn.length).toBeGreaterThanOrEqual(6);

    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      const next = paragraphs();
      expect(next).toHaveLength(drawn.length);
      for (const node of next) expect(drawn).not.toContain(node);
      BUTTON_IDS.forEach((id, i) => expect(screen.getByTestId(id)).toBe(buttons[i]));
      WRAPPER_IDS.forEach((id, i) => expect(screen.getByTestId(id)).toBe(wrappers[i]));
      drawn = next;
    }
  });

  it('the Watching header\'s line: the wrapper that says it stays, the drawn paragraph is new after each change', async () => {
    harness = await prepare('ar', initialState(), panelHandler(panelState({ observations: [] })));
    await render(<Providers harness={harness}><WatchingScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('watching-body')).not.toBeNull());
    const wrapper = screen.getByTestId('watching-body');
    expect(wrapper.props.accessible).toBe(true);
    expect(wrapper.props.accessibilityLabel).toBe(within(wrapper).getByTestId('watching-body-text').props.children);
    let text = screen.getByTestId('watching-body-text');
    expect(text.props.accessible).toBe(false);
    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      expect(screen.getByTestId('watching-body')).toBe(wrapper);
      expect(screen.getByTestId('watching-body-text')).not.toBe(text);
      text = screen.getByTestId('watching-body-text');
    }
  });
});
