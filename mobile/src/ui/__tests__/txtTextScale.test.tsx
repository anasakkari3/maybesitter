/** RN scales fontSize and lineHeight together. Base metrics must stay stable
 * across Dynamic Type categories, with no cap or disabled platform scaling.
 * Device evidence at AX5 verifies the native behavior these props request. */
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

describe('Txt delegates scaling once to the native renderer', () => {
  it.each([0.82, 1, 1.24, 1.35, 1.64, 2, 2.35, 3.12])(
    'keeps base Arabic metrics and uncapped native scaling at %sx', async scale => {
      const { fontSize, lineHeight, max, allow } = await lineBoxAt(scale);
      expect(fontSize).toBe(20);
      expect(lineHeight).toBe(20 * LINE_HEIGHT.arabic);
      expect(max).toBeUndefined();
      expect(allow).not.toBe(false);
      // RN 0.86 RCTAttributedTextUtils.mm applies the same multiplier to both.
      expect((lineHeight * scale) / (fontSize * scale)).toBeCloseTo(1.6);
    },
  );
});
