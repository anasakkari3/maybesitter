/**
 * The tab bar at the largest text size (Round 2 `--ts`, step 3 of the
 * round-1-to-round-2 migration).
 *
 * Round 1 set a fixed `fontSize` and left `allowFontScaling` at its default,
 * so the OS enlarged these labels without limit while the pill that holds
 * them kept a 56-pt capture button and 8-pt padding. The row broke, and
 * nothing in the app read the font scale, so nothing could react.
 *
 * The claim worth a test is not "labels disappear" — it is that **the name
 * never disappears**. The painted label comes off at `xl`; the accessible
 * name stays at every size, so a screen-reader user loses nothing at all.
 */
import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, type RenderResult } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { TabBar } from '../TabBar';

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

/**
 * Queries come off the returned view rather than the global `screen`, because
 * one of these cases mounts the bar twice to compare two text sizes.
 */
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
  return view
    .getAllByRole('button')
    .map((node) => node.props.accessibilityLabel)
    .filter((label): label is string => typeof label === 'string');
}

beforeEach(() => {
  useWindowDimensions.mockReset();
});

describe('the tab bar carries its names at every text size', () => {
  it('paints the labels at the default size', async () => {
    const view = await atFontScale(1);
    const painted = names(view);
    expect(painted).toHaveLength(4);
    for (const name of painted) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('still paints them one step up', async () => {
    const view = await atFontScale(1.2);
    expect(names(view)).toHaveLength(4);
    for (const name of names(view)) expect(view.getAllByText(name).length).toBeGreaterThan(0);
  });

  it('takes the painted labels off at xl', async () => {
    const view = await atFontScale(1.45);
    expect(names(view)).toHaveLength(4);
    for (const name of names(view)) expect(view.queryAllByText(name)).toHaveLength(0);
  });

  it('announces the same four names at xl as at the default size', async () => {
    const small = names(await atFontScale(1)).slice().sort();
    const large = names(await atFontScale(1.45)).slice().sort();
    expect(large).toEqual(small);
    expect(small).toHaveLength(4);
  });

  it('keeps the names past the top of the ramp, where the OS can still go', async () => {
    // iOS accessibility sizes reach beyond 3x. There is no step past xl, so
    // the bar must hold that layout rather than fall back to a smaller one.
    const view = await atFontScale(3.1);
    expect(names(view)).toHaveLength(4);
    for (const name of names(view)) expect(view.queryAllByText(name)).toHaveLength(0);
  });
});
