/**
 * `Txt` under an enlarged text size.
 *
 * React Native scales `fontSize` for you and leaves `lineHeight` alone. A
 * fixed line box therefore clips its own text the moment the reader enlarges
 * it, and it clips worst in Arabic, whose face asks for 1.6 and whose glyphs
 * are tall — which is the app's primary language.
 *
 * So the two claims here are: the line box grows with the text, and the text
 * stops growing at the ceiling the design lays out.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { render, type RenderResult } from '@testing-library/react-native';
import { AppProvider } from '../../state/AppContext';
import { MAX_TEXT_SCALE } from '../../theme/textScale';
import { Txt } from '../primitives';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock;

async function lineBoxAt(fontScale: number): Promise<{ fontSize: number; lineHeight: number; max: number }> {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  const view: RenderResult = await render(
    <AppProvider>
      <Txt size={20} testID="subject">اليوم</Txt>
    </AppProvider>,
  );
  const node = view.getByTestId('subject');
  const style = StyleSheet.flatten(node.props.style) as { fontSize: number; lineHeight: number };
  return {
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    max: node.props.maxFontSizeMultiplier as number,
  };
}

beforeEach(() => {
  useWindowDimensions.mockReset();
});

describe('Txt keeps its line box around its text', () => {
  it('leaves the ratio alone at the default size', async () => {
    const { fontSize, lineHeight } = await lineBoxAt(1);
    expect(fontSize).toBe(20);
    expect(lineHeight / fontSize).toBeGreaterThanOrEqual(1.4);
  });

  it('grows the line box with the reader, not just the glyphs', async () => {
    const plain = await lineBoxAt(1);
    const large = await lineBoxAt(1.45);
    // fontSize stays the authored number — the platform multiplies it — so the
    // line box is what has to carry the scale, and it must carry all of it.
    expect(large.fontSize).toBe(plain.fontSize);
    expect(large.lineHeight).toBeCloseTo(plain.lineHeight * 1.45, 0);
  });

  it('stops growing the line box at the ceiling, as the text does', async () => {
    const atCeiling = await lineBoxAt(MAX_TEXT_SCALE);
    const wayPast = await lineBoxAt(3.1);
    expect(wayPast.lineHeight).toBe(atCeiling.lineHeight);
  });

  it('caps the platform at the same ceiling, so the two cannot drift apart', async () => {
    const { max } = await lineBoxAt(3.1);
    expect(max).toBe(MAX_TEXT_SCALE);
  });
});
