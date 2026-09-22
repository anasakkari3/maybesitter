import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { AppProvider } from '../../state/AppContext';
import { ActionRow } from '../chrome';
import { Btn, Pill, Txt, textAlignment } from '../primitives';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 })),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dimensions = require('react-native/Libraries/Utilities/useWindowDimensions').default as jest.Mock;

describe('logical text edges at the native boundary', () => {
  it.each([false, true])('iOS lets Fabric apply RTL exactly once (rtl=%s)', rtl => {
    // RN 0.86 RCTAttributedTextUtils swaps left/right when Yoga is RTL.
    const nativeEdge = (value: string) => rtl ? (value === 'left' ? 'right' : 'left') : value;
    expect(nativeEdge(textAlignment('start', rtl, 'ios'))).toBe(rtl ? 'right' : 'left');
    expect(nativeEdge(textAlignment('end', rtl, 'ios'))).toBe(rtl ? 'left' : 'right');
    expect(textAlignment('center', rtl, 'ios')).toBe('center');
  });
  it('keeps Android physical alignment and centered numbers intact', () => {
    expect(textAlignment('start', true, 'android')).toBe('right');
    expect(textAlignment('start', false, 'android')).toBe('left');
    expect(textAlignment('end', true, 'android')).toBe('left');
    expect(textAlignment('center', true, 'android')).toBe('center');
  });
});

it('announces proposal selection separately from disabled state', async () => {
  const view = await render(<AppProvider>
    <Btn label="Proposal" accessibilityRole="checkbox" accessibilityState={{ checked: false }} disabled><Txt>Proposal</Txt></Btn>
    <Btn label="Chosen" accessibilityRole="radio" accessibilityState={{ checked: true }}><Txt>Chosen</Txt></Btn>
  </AppProvider>);
  expect(view.getByRole('checkbox', { checked: false, disabled: true })).toBeTruthy();
  expect(view.getByRole('radio', { checked: true })).toBeTruthy();
});

it.each([1.24, 1.64, 3.12])('gives both long actions a full row without capping text at %sx', async fontScale => {
  dimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  const view = await render(<AppProvider><ActionRow testID="actions">
    <Pill label="Keep editing this commitment" />
    <Pill label="Confirm this proposal" />
  </ActionRow></AppProvider>);
  expect(StyleSheet.flatten(view.getByTestId('actions').props.style).flexDirection).toBe('column');
  expect(view.getAllByRole('button')).toHaveLength(2);
  const text = view.getByText('Confirm this proposal');
  expect(text.props.maxFontSizeMultiplier).toBeUndefined();
  expect(text.props.allowFontScaling).not.toBe(false);
  // Native scales the base line box once, alongside the glyphs.
  expect(StyleSheet.flatten(text.props.style).lineHeight).toBeGreaterThan(15);
});
