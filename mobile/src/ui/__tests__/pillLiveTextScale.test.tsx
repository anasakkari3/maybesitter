/**
 * A pill follows a text-size change made while it is on screen (#740).
 *
 * On device (M2b load run, F11) the text size was raised to AX5 with the app
 * open: «هيك صح» stayed a 50-pt pill with no visible label, while the same
 * pill opened fresh at AX5 was 117 pt and readable. Nothing the pill passed to
 * the renderer depended on the scale, so the change re-committed none of its
 * props and the label was never measured again.
 *
 * The scale here changes the way it does on a phone — `Dimensions` emits a
 * change and the real `useWindowDimensions` hears it — with no parent
 * re-render to paper over a component that does not listen. The global jest
 * setup replaces that hook with a fixed reading, so this file restores the
 * real one.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, type RenderResult } from '@testing-library/react-native';
import { AppProvider } from '../../state/AppContext';
import { Pill } from '../primitives';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);

const LABEL = 'هيك صح';
const AX5 = 3.12;

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

async function mountAt(fontScale: number): Promise<RenderResult> {
  setFontScale(fontScale);
  return render(
    <AppProvider>
      <Pill testID="pill" label={LABEL} onPress={() => {}} size={15} pad={12} />
    </AppProvider>,
  );
}

function minHeightOf(view: RenderResult): number {
  return (StyleSheet.flatten(view.getByTestId('pill').props.style) as { minHeight: number }).minHeight;
}

afterEach(() => {
  setFontScale(1);
});

describe('Pill re-measures its label on a live Dynamic Type change', () => {
  it('mounts a fresh label when the scale moves from Large to AX5 while mounted', async () => {
    const view = await mountAt(1);
    const before = view.getByText(LABEL);

    await act(async () => { setFontScale(AX5); });

    const after = view.getByText(LABEL);
    // A new host Text is a new paragraph to the native renderer, measured at
    // the live scale — the same path as opening the screen fresh at AX5.
    expect(after).not.toBe(before);
    // The label is still there, still the pill's own words, at base metrics
    // (the native renderer applies the scale once; see txtTextScale.test).
    expect(after.props.children).toBe(LABEL);
    expect((StyleSheet.flatten(after.props.style) as { fontSize: number }).fontSize).toBe(15);
    // The touch target floor is unchanged.
    expect(minHeightOf(view)).toBe(48);
  });

  it('mounts a fresh label again when the scale comes back down', async () => {
    const view = await mountAt(AX5);
    const atAx5 = view.getByText(LABEL);

    await act(async () => { setFontScale(1); });

    const atLarge = view.getByText(LABEL);
    expect(atLarge).not.toBe(atAx5);
    expect(atLarge.props.children).toBe(LABEL);
  });

  it('keeps the same label when nothing about the scale changed', async () => {
    const view = await mountAt(AX5);
    const first = view.getByText(LABEL);

    // A dimension change that is not a text-size change (a rotation) must not
    // throw the label away.
    await act(async () => {
      const window = { width: 844, height: 390, scale: 3, fontScale: AX5 };
      Dimensions.set({ window, screen: window });
    });

    expect(view.getByText(LABEL)).toBe(first);
  });
});
