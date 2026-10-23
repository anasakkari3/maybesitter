/**
 * The Plan tab follows a text-size change made while it is open (simulator
 * 2026-10-24, shots 41b, 42 and 43).
 *
 * Growing to AX5 the strip's day labels and «شوف أبعد» were slivers; back at
 * the default size «خطّط أسبوعي» stayed 370×192 (fresh 148×44), «شوف أبعد»
 * 296×104 and the filter chips 106 pt tall. Every one of them is words inside
 * a button, and nothing about those words changes with the scale, so native
 * kept the old measurement. `Btn` holds a boundary around its children now:
 * the words are new paragraphs after each change, the buttons — what a screen
 * reader is on — stay. The header's title and range are said by views that
 * stay (`ScreenHeader`, `SaidWords`).
 *
 * Round trip: the buttons, chips and strip cells commit what a fresh open
 * commits, and never a `flex` basis, which Yoga on Fabric keeps.
 *
 * Real `useWindowDimensions` and `Dimensions.set`; the default reading is
 * restored after each test.
 */
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor, within } from '@testing-library/react-native';
import { NOW, prepareCalendar, renderCalendar, teardown, type M4aHarness } from '../../__acceptance__/m4a/harness';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const AX5 = 3.12;

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

let harness: M4aHarness | undefined;

beforeEach(() => {
  setFontScale(1);
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
  setFontScale(1);
});

type Host = ReturnType<typeof screen.getByTestId>;
type Style = Record<string, unknown>;
const flat = (node: Host) => (StyleSheet.flatten(node.props.style) ?? {}) as Style;
const drawnIn = (id: string) => within(screen.getByTestId(id)).getAllByText(/./, { includeHiddenElements: true });

async function showPlan() {
  harness = await prepareCalendar();
  await renderCalendar(harness);
  // The free-time probe has answered: «شوف أبعد» and the filter chips are up.
  await waitFor(() => expect(screen.queryByTestId('calendar-wider-open')).not.toBeNull());
  await waitFor(() => expect(screen.queryByTestId('calendar-filter-free')).not.toBeNull());
}

function buttonIds(): string[] {
  const days = screen.getAllByTestId(/^calendar-day-\d/).map((node) => String(node.props.testID));
  const chips = screen.getAllByTestId(/^calendar-filter-/).map((node) => String(node.props.testID));
  expect(days).toHaveLength(7);
  expect(chips.length).toBeGreaterThanOrEqual(3);
  return ['calendar-plan-week', 'calendar-wider-open', ...chips, ...days];
}

describe('the Plan tab after a live text-size change', () => {
  it('the words in «خطّط أسبوعي», «شوف أبعد», the chips and the strip are new after each change; the buttons are the same ones', async () => {
    await showPlan();
    const ids = buttonIds();
    const buttons = ids.map((id) => screen.getByTestId(id));
    const said = ['calendar-range-said'].map((id) => screen.getByTestId(id));
    let drawn = ids.flatMap(drawnIn);
    expect(drawn.length).toBeGreaterThanOrEqual(ids.length);
    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      const next = ids.flatMap(drawnIn);
      expect(next).toHaveLength(drawn.length);
      for (const node of next) expect(drawn).not.toContain(node);
      ids.forEach((id, i) => expect(screen.getByTestId(id)).toBe(buttons[i]));
      drawn = next;
    }
    // The range is said by a view (it leaves the header at AX5 and comes back).
    expect(said[0]!.props.accessible).toBe(true);
    expect(screen.getByTestId('calendar-range').props.accessible).toBe(false);
  });

  it('the header\'s range and title are said by views that stay; at 1.12 — still the default layout, so nothing re-renders them — each drawn paragraph is new', async () => {
    await showPlan();
    const range = screen.getByTestId('calendar-range-said');
    const title = screen.getByRole('header', { name: 'Plan' });
    expect(range.props.accessible).toBe(true);
    expect(range.props.accessibilityLabel).toBe(screen.getByTestId('calendar-range').props.children);
    let drawn = [...within(range).getAllByText(/./, { includeHiddenElements: true }), ...within(title).getAllByText(/./, { includeHiddenElements: true })];
    expect(drawn).toHaveLength(2);
    for (const node of drawn) expect(node.props.accessible).toBe(false);
    for (const scale of [1.12, 1]) {
      await act(async () => { setFontScale(scale); });
      expect(screen.getByTestId('calendar-range-said')).toBe(range);
      expect(screen.getByRole('header', { name: 'Plan' })).toBe(title);
      const next = [...within(range).getAllByText(/./, { includeHiddenElements: true }), ...within(title).getAllByText(/./, { includeHiddenElements: true })];
      next.forEach((node, i) => expect(node).not.toBe(drawn[i]));
      drawn = next;
    }
  });

  it('default → AX5 → default: the buttons, chips and strip cells commit what a fresh open commits, with no flex basis', async () => {
    await showPlan();
    const ids = buttonIds();
    const read = () => Object.fromEntries(ids.map((id) => [id, flat(screen.getByTestId(id))])) as Record<string, Style>;
    const fresh = read();
    await act(async () => { setFontScale(AX5); });
    const ax5 = read();
    // The strip does switch (an 88 pt cell at AX5): proof the round trip ran.
    const day = ids.find((id) => id.startsWith('calendar-day-'))!;
    expect(ax5[day]!.width).toBe(88);
    await act(async () => { setFontScale(1); });
    expect(read()).toEqual(fresh);
    for (const at of [fresh, ax5]) for (const style of Object.values(at)) {
      expect(style.flex).toBeUndefined();
      expect(style.flexBasis).toBeUndefined();
    }
  });
});
