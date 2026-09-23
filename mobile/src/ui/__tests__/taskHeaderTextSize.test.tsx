/**
 * The task header under Dynamic Type (F3, found on device 2026-09-22).
 *
 * `TaskHeader` is one fixed row of three: a pill that cannot shrink, the
 * flow's name with `flexShrink: 1`, and an end slot holding 64 pt open. At
 * AX5 the two ends took the whole width, the title was squeezed to about a
 * glyph, and the Arabic name wrapped character by character into a vertical
 * column of letters.
 *
 * The claim under test is the same one the tab bar makes: **the structure
 * changes, the identity does not.** Past the first accessibility size the
 * header stacks — the pill on its own line, the name on the next, with the
 * whole width to itself — and the pill's `testID`, its accessible name and
 * the title's own text survive at every size.
 */
import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, type RenderResult } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { Txt } from '../primitives';
import { TaskHeader, taskHeaderStacks } from '../taskHeader';
import { LAYOUT_MODE_FROM } from '../../theme/textScale';

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

const TITLE = 'التقاط جديد';
const PILL = 'إلغاء';

async function atFontScale(fontScale: number): Promise<RenderResult> {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <TaskHeader
          pill={PILL}
          onPill={() => {}}
          title={TITLE}
          pillTestID="task-pill"
          end={<Txt size={12}>الذكاء: مطفي</Txt>}
        />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

/** The one flattened style object the header's root actually renders with. */
function rootStyle(view: RenderResult): Record<string, unknown> {
  const style = view.getByTestId('task-header').props.style as unknown;
  return Object.assign({}, ...(Array.isArray(style) ? style : [style])) as Record<string, unknown>;
}

beforeEach(() => {
  useWindowDimensions.mockReset();
});

describe('taskHeaderStacks follows the layout modes, not a number of its own', () => {
  it('is a row until the first accessibility size, and stacks from there', () => {
    expect(taskHeaderStacks('normal')).toBe(false);
    expect(taskHeaderStacks('large')).toBe(false);
    expect(taskHeaderStacks('xl')).toBe(true);
  });

  it('turns over at exactly the mode boundary the rest of the chrome uses', () => {
    expect(LAYOUT_MODE_FROM.xl).toBe(1.64);
  });
});

describe('the task header keeps its identity at every text size', () => {
  it.each([1, 1.35, LAYOUT_MODE_FROM.xl, 3.12])('paints the pill and the name at %sx', async (scale) => {
    const view = await atFontScale(scale);
    expect(view.getByTestId('task-pill').props.accessibilityLabel).toBe(PILL);
    expect(view.getAllByText(TITLE).length).toBeGreaterThan(0);
  });
});

describe('the structure reflows so the name is never squeezed into a column', () => {
  it('is one row at the ordinary sizes, with the end slot reserving its width', async () => {
    for (const scale of [1, 1.12, 1.35, 1.45]) {
      const view = await atFontScale(scale);
      expect(rootStyle(view).flexDirection).toBe('row');
      expect(view.getByTestId('task-header-end-reserve')).toBeTruthy();
    }
  });

  it('stacks at the accessibility sizes', async () => {
    for (const scale of [LAYOUT_MODE_FROM.xl, 1.94, 3.12]) {
      expect(rootStyle(await atFontScale(scale)).flexDirection).toBe('column');
    }
  });

  it('gives the name the whole width once stacked — nothing shrinks it, nothing reserves against it', async () => {
    const view = await atFontScale(3.12);
    const title = view.getAllByText(TITLE)[0]!;
    const style = Object.assign({}, ...[title.props.style].flat().filter(Boolean)) as Record<string, unknown>;
    expect(style.flexShrink).toBeUndefined();
    // The end slot's 64 pt reserve is the other half of what took the row's
    // width from the title. Stacked, nothing holds a line open for a status.
    expect(view.queryByTestId('task-header-end-reserve')).toBeNull();
    expect(rootStyle(view).alignItems).toBe('flex-start');
  });
});
