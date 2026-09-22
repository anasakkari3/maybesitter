/**
 * The screen shell (F1/F2, found on device 2026-09-22).
 *
 * Two claims, and they are the two defects:
 *
 *   F1  A pushed screen's way back is not content. It lives outside the
 *       scroller, so no amount of scrolling can take it off the display.
 *   F2  The frame owns the safe-area inset, not the content. The scroller's
 *       viewport starts below the Dynamic Island, so scrolled content cannot
 *       travel under it — and the inset is applied exactly once.
 */
import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { render, within, type RenderResult } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { BackHeader } from '../chrome';
import { Txt } from '../primitives';
import { Screen, ScreenScroll } from '../screen';

const TOP = 47;
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: TOP, left: 0, right: 0, bottom: 34 },
};

async function shell(pinned: React.ReactNode): Promise<RenderResult> {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <Screen testID="frame" pinned={pinned}>
          <ScreenScroll testID="body">
            {Array.from({ length: 40 }, (_, i) => <Txt key={i} size={15}>{`صف ${i}`}</Txt>)}
          </ScreenScroll>
        </Screen>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

function flat(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
}

describe('F1 — the way back is not content', () => {
  it('renders the pinned header outside the scroller', async () => {
    const view = await shell(<BackHeader title="الإشعارات" onBack={() => {}} />);
    // It is on the screen…
    expect(view.getByTestId('header-back')).toBeTruthy();
    // …and it is not among the things that scroll.
    expect(within(view.getByTestId('body')).queryByTestId('header-back')).toBeNull();
  });

  it('puts a long body in the scroller without taking the header with it', async () => {
    const view = await shell(<BackHeader title="الإشعارات" onBack={() => {}} />);
    const body = within(view.getByTestId('body'));
    expect(body.getByText('صف 39')).toBeTruthy();
    expect(body.queryByText('الإشعارات')).toBeNull();
  });
});

describe('F2 — the frame owns the inset, once', () => {
  it('clears the island on the frame, so the viewport starts below it', async () => {
    const view = await shell(<BackHeader title="الإشعارات" onBack={() => {}} />);
    expect(flat(view.getByTestId('frame').props.style).paddingTop).toBe(TOP);
  });

  it('never adds the inset a second time to the scrolling content', async () => {
    const view = await shell(<BackHeader title="الإشعارات" onBack={() => {}} />);
    const content = flat(view.getByTestId('body').props.contentContainerStyle);
    expect(content.paddingTop as number).toBeLessThan(TOP);
  });

  it('BackHeader no longer reads the inset itself — the shell is the one owner', async () => {
    const view = await shell(<BackHeader title="الإشعارات" onBack={() => {}} />);
    // The header's own root is the parent of the back button's row; if it
    // still padded for the island the title would sit a second inset down.
    const header = view.getByTestId('back-header');
    expect(flat(header.props.style).paddingTop ?? 0).toBeLessThan(TOP);
  });

  it('works with no pinned header at all — a tab root still clears the island', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <Screen testID="frame"><ScreenScroll testID="body" bottom={130}><Txt size={15}>اليوم</Txt></ScreenScroll></Screen>
        </AppProvider>
      </SafeAreaProvider>,
    );
    expect(flat(view.getByTestId('frame').props.style).paddingTop).toBe(TOP);
    expect(flat(view.getByTestId('body').props.contentContainerStyle).paddingBottom).toBe(130);
  });
});
