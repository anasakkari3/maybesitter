/**
 * The tab bar under Dynamic Type.
 *
 * The reader's text is never capped, so at some size the painted labels stop
 * fitting the pill. The claim worth a test is not "labels disappear" — it is
 * that **the controls never do**. Painted labels come off at the accessibility
 * sizes, or the moment a label measures itself out of its slot; the four
 * `testID`s and the four accessible names stay at every size, so a screen
 * reader and a device flow find the same bar whatever the text is set to.
 */
import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, type RenderResult } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { TabBar, decideIconsOnly, labelOverflows } from '../TabBar';

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
const IDS = ['tab-today', 'tab-calendar', 'tab-capture', 'tab-settings'];

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

beforeEach(() => {
  useWindowDimensions.mockReset();
});

describe('the tab bar keeps its identity at every text size', () => {
  it('paints the labels at the default size, under stable testIDs', async () => {
    const view = await atFontScale(1);
    for (const name of names(view)) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('still paints them one category up (large mode is not icons-only by itself)', async () => {
    const view = await atFontScale(1.35);
    for (const name of names(view)) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('is icons-only from the first accessibility size', async () => {
    const view = await atFontScale(1.64);
    for (const name of names(view)) expect(view.queryAllByText(name)).toHaveLength(0);
  });

  it('announces the same four names at 2.0× as at 1×, and every control is still there', async () => {
    const small = names(await atFontScale(1));
    const view = await atFontScale(2.0);
    expect(names(view)).toEqual(small);
    for (const id of IDS) expect(view.getByTestId(id)).toBeTruthy();
    expect(small.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
  });

  it('holds the xl structure past the top of the platform ramp', async () => {
    const view = await atFontScale(3.12);
    for (const id of IDS) expect(view.getByTestId(id)).toBeTruthy();
    for (const name of names(view)) expect(view.queryAllByText(name)).toHaveLength(0);
  });
});

describe('below the accessibility sizes, measurement decides', () => {
  it('a label that wrapped has no room', () => {
    expect(labelOverflows([{ width: 40 }, { width: 12 }], 70)).toBe(true);
  });

  it('a label wider than its slot has no room', () => {
    expect(labelOverflows([{ width: 74 }], 70)).toBe(true);
  });

  it('a label inside its slot has room', () => {
    expect(labelOverflows([{ width: 52 }], 70)).toBe(false);
  });

  it('an unmeasured slot says nothing, so labels are not removed on a guess', () => {
    expect(labelOverflows([{ width: 999 }], 0)).toBe(false);
  });

  it('measured overflow removes labels even in normal mode; xl removes them regardless', () => {
    expect(decideIconsOnly('normal', true)).toBe(true);
    expect(decideIconsOnly('large', true)).toBe(true);
    expect(decideIconsOnly('normal', false)).toBe(false);
    expect(decideIconsOnly('xl', false)).toBe(true);
  });
});
