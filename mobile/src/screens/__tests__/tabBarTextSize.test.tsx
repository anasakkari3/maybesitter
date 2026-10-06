/**
 * The tab bar under Dynamic Type.
 *
 * The reader's text is never capped, so at some size the painted labels stop
 * fitting the pill. The claim worth a test is not "labels disappear" — it is
 * that **the controls never do**. Painted labels come off at the accessibility
 * sizes, or the moment a label measures itself out of its slot; the four
 * `testID`s and the four accessible names stay at every size, so a screen
 * reader and a device flow find the same bar whatever the text is set to.
 *
 * Since 2026-10-06 «احكيها» is the bar's first item and shows the app's mark
 * instead of a word (owner decision), so it is named but never painted as
 * text; the four tabs still paint theirs.
 */
import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, type RenderResult } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { TAB_LABEL_MAX_SCALE, TabBar } from '../TabBar';
import en from '../../i18n/locales/en.json';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const IDS = ['tab-today', 'tab-calendar', 'tab-things', 'tab-watching', 'tab-capture'];
/** The four that paint a word; `tab-capture` shows the mark instead. */
const TEXT_IDS = ['tab-today', 'tab-calendar', 'tab-things', 'tab-watching'];

async function atFontScale(fontScale: number): Promise<RenderResult> {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <TabBar />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

/** The names the bar announces, in whatever language the app booted in. */
function names(view: RenderResult): string[] {
  return IDS.map((id) => view.getByTestId(id).props.accessibilityLabel as string);
}

function painted(view: RenderResult): string[] {
  return TEXT_IDS.map((id) => view.getByTestId(id).props.accessibilityLabel as string);
}

function fontSizeOf(view: RenderResult, testID: string): number {
  const style = [view.getByTestId(testID).props.style].flat(Infinity).filter(Boolean);
  return Object.assign({}, ...style).fontSize as number;
}

beforeEach(() => {
  useWindowDimensions.mockReset();
});

describe('the tab bar keeps its identity at every text size', () => {
  it('paints the labels at the default size, under stable testIDs', async () => {
    const view = await atFontScale(1);
    for (const name of painted(view)) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('still paints them one category up (large mode is not icons-only by itself)', async () => {
    const view = await atFontScale(1.35);
    for (const name of painted(view)) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('keeps visible names at the first accessibility size', async () => {
    const view = await atFontScale(1.64);
    for (const name of painted(view)) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('announces the same five names at 2.0× as at 1×, and every control is still there', async () => {
    const small = names(await atFontScale(1));
    const view = await atFontScale(2.0);
    expect(names(view)).toEqual(small);
    for (const id of IDS) expect(view.getByTestId(id)).toBeTruthy();
    expect(small.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
  });

  it('occupies layout space instead of covering the active screen', async () => {
    const view = await atFontScale(2.0);
    expect(view.getByTestId('floating-tab-bar').props.style).toEqual({ flexShrink: 0 });
  });

  it('keeps names visible past the top of the platform ramp', async () => {
    const view = await atFontScale(3.12);
    for (const id of IDS) expect(view.getByTestId(id)).toBeTruthy();
    for (const name of painted(view)) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('is five items with «احكيها» first, shown as the mark and named for a screen reader', async () => {
    const view = await atFontScale(1);
    const bar = view.getByTestId('tab-bar');
    const order: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const n = node as { props?: { testID?: unknown }; children?: unknown };
      if (typeof n.props?.testID === 'string' && IDS.includes(n.props.testID) && !order.includes(n.props.testID)) order.push(n.props.testID);
      walk(n.children);
    };
    walk(view.toJSON());
    expect(order).toEqual(['tab-capture', 'tab-today', 'tab-calendar', 'tab-things', 'tab-watching']);
    expect(bar).toBeTruthy();
    const capture = view.getByTestId('tab-capture');
    expect(capture.props.accessibilityLabel).toBe(en.tabCapture);
    expect(view.queryAllByText(en.tabCapture)).toHaveLength(0);
  });

  it('sets the tab labels at 13 points, and never below 12 at the larger sizes', async () => {
    const normal = await atFontScale(1);
    for (const id of TEXT_IDS) expect(fontSizeOf(normal, `${id}-label`)).toBeGreaterThanOrEqual(13);
    await normal.unmount();
    const large = await atFontScale(1.35);
    for (const id of TEXT_IDS) {
      expect(fontSizeOf(large, `${id}-label`)).toBeGreaterThanOrEqual(12);
      expect(large.getByTestId(`${id}-label`).props.numberOfLines ?? 2).toBeGreaterThanOrEqual(2);
      expect(large.getByTestId(`${id}-label`).props.ellipsizeMode).toBeUndefined();
    }
  });

  it('caps how far a label grows at the accessibility sizes instead of breaking inside the word', async () => {
    // Five slots at AX5 split «اليوم» into «الي / وم» on a device (2026-10-06).
    const view = await atFontScale(2.0);
    for (const id of TEXT_IDS) expect(view.getByTestId(`${id}-label`).props.maxFontSizeMultiplier).toBe(TAB_LABEL_MAX_SCALE);
    await view.unmount();
    // …and only there: at the ordinary sizes the label grows with the reader.
    const normal = await atFontScale(1);
    for (const id of TEXT_IDS) expect(normal.getByTestId(`${id}-label`).props.maxFontSizeMultiplier).toBeUndefined();
  });
});
