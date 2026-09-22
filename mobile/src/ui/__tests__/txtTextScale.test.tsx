/**
 * `Txt` under an enlarged text size.
 *
 * React Native scales `fontSize` for you and leaves `lineHeight` alone. A
 * fixed line box therefore clips its own text the moment the reader enlarges
 * it, and it clips worst in Arabic, whose face asks for 1.6 and whose glyphs
 * are tall — the app's primary language.
 *
 * Claims: the line box tracks the rendered size at every scale, nothing caps
 * the platform, and 2.0× is 2.0×.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, waitFor, type RenderResult } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { LINE_HEIGHT } from '../../theme/fonts';
import { Txt } from '../primitives';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock;

type Box = { fontSize: number; lineHeight: number; max: number | undefined; allow: boolean | undefined };

async function lineBoxAt(fontScale: number, size = 20): Promise<Box> {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  // Arabic is the app's primary language and the one whose face asks for the
  // tallest line box, so it is the one these numbers are checked against.
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  const view: RenderResult = await render(
    <AppProvider>
      <Txt size={size} testID="subject">اليوم</Txt>
    </AppProvider>,
  );
  // The stored preference is read in an effect; until then the box is Latin.
  await waitFor(() => {
    const st = StyleSheet.flatten(view.getByTestId('subject').props.style) as { fontFamily: string };
    expect(st.fontFamily).toContain('NotoNaskhArabic');
  });
  const node = view.getByTestId('subject');
  const style = StyleSheet.flatten(node.props.style) as { fontSize: number; lineHeight: number };
  return {
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    max: node.props.maxFontSizeMultiplier as number | undefined,
    allow: node.props.allowFontScaling as boolean | undefined,
  };
}

beforeEach(async () => {
  useWindowDimensions.mockReset();
  await AsyncStorage.clear();
});

describe('Txt keeps its line box around its text at every size', () => {
  it('1.35× renders at 1.35×: the line box is the Arabic ratio of the rendered size', async () => {
    const { fontSize, lineHeight } = await lineBoxAt(1.35);
    expect(fontSize).toBe(20); // the platform multiplies this by 1.35
    expect(lineHeight).toBe(Math.round(20 * 1.35 * LINE_HEIGHT.arabic));
  });

  it('2.0× is not reduced to 1.45×', async () => {
    const two = await lineBoxAt(2.0);
    const capped = Math.round(20 * 1.45 * LINE_HEIGHT.arabic);
    expect(two.lineHeight).toBe(Math.round(20 * 2.0 * LINE_HEIGHT.arabic));
    expect(two.lineHeight).toBeGreaterThan(capped);
  });

  it('never tells the platform to stop scaling', async () => {
    const { max, allow } = await lineBoxAt(3.12);
    expect(max).toBeUndefined();
    expect(allow).not.toBe(false);
  });

  it('Arabic does not clip: the line box is at least 1.6× the rendered size at every scale', async () => {
    for (const scale of [1, 1.24, 1.64, 2.35, 3.12]) {
      const { lineHeight } = await lineBoxAt(scale);
      expect(lineHeight).toBeGreaterThanOrEqual(Math.floor(20 * scale * 1.6));
    }
  });

  it('a smaller-than-default reading shrinks the box too, so it never floats', async () => {
    const { lineHeight } = await lineBoxAt(0.82);
    expect(lineHeight).toBe(Math.round(20 * 0.82 * LINE_HEIGHT.arabic));
  });
});
