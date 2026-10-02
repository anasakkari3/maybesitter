import React from 'react';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppProvider, useApp } from '../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import { THEME_STORAGE_KEY } from '../../lib/deviceSettings/theme';
import { ReferenceCard, ReferenceHeader, useReferencePalette } from '../referenceDesign';
import { Btn, Txt } from '../primitives';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 })),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dimensions = require('react-native/Libraries/Utilities/useWindowDimensions').default as jest.Mock;

function HeaderHarness() {
  const { s, lang, scheme, actions } = useApp();
  return <>
    <Text testID="reference-route">{s.screen}</Text>
    <Text testID="reference-language">{lang}</Text>
    <Text testID="reference-scheme">{scheme}</Text>
    <ReferenceHeader title="Your week" eyebrow="September 29" subtitle="One step at a time" />
    <Btn label="Back to the previous screen" onPress={actions.back}><Txt>Back</Txt></Btn>
  </>;
}

function PaletteProbe() {
  const palette = useReferencePalette();
  return <Text testID="reference-bar-fill">{palette.sfBar}</Text>;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  dimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
  jest.spyOn(AccessibilityInfo, 'isReduceTransparencyEnabled').mockResolvedValue(false);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('reference header keeps the real product routes', () => {
  for (const locale of [{ lang: 'en', copy: en }, { lang: 'ar', copy: ar }]) {
    // Stitch (2026-10-02): search and the avatar. The avatar is the way into
    // Settings now; notifications and the account are inside it.
    const routes = [
      { label: locale.copy.xSearch, route: 'commitments' },
      { label: locale.copy.settingsTitle, route: 'settings' },
    ];
    it.each(routes)(`${locale.lang}: $route is reachable and returns to Today`, async ({ label, route }) => {
      await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, locale.lang);
      await render(<AppProvider><HeaderHarness /></AppProvider>);
      await waitFor(() => expect(screen.getByTestId('reference-language')).toHaveTextContent(locale.lang));
      const control = screen.getByRole('button', { name: label });
      const target = StyleSheet.flatten(control.props.style);
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      await fireEvent.press(control);
      expect(screen.getByTestId('reference-route')).toHaveTextContent(route);
      await fireEvent.press(screen.getByRole('button', { name: 'Back to the previous screen' }));
      expect(screen.getByTestId('reference-route')).toHaveTextContent('today');
    });
  }

  it('keeps the named controls and uncapped heading at the largest Dynamic Type scale', async () => {
    dimensions.mockReturnValue({ width: 320, height: 568, scale: 2, fontScale: 3.12 });
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    await render(<AppProvider><HeaderHarness /></AppProvider>);
    await waitFor(() => expect(screen.getByTestId('reference-language')).toHaveTextContent('en'));
    for (const name of [en.xSearch, en.settingsTitle]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    const heading = screen.getByRole('header', { name: 'Your week' });
    expect(heading.props.numberOfLines).toBeUndefined();
    expect(heading.props.maxFontSizeMultiplier).toBeUndefined();
    expect(heading.props.allowFontScaling).not.toBe(false);
  });
});

describe('reference decoration leaves native content usable', () => {
  async function decoration() {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const onPress = jest.fn();
    const view = await render(<AppProvider>
      <HeaderHarness />
      <PaletteProbe />
      <ReferenceCard testID="reference-card" tone="hero">
        <Btn label="Open commitment" onPress={onPress}><Txt>Open commitment</Txt></Btn>
      </ReferenceCard>
    </AppProvider>);
    await waitFor(() => expect(screen.getByTestId('reference-scheme')).toHaveTextContent('dark'));
    return { view, onPress };
  }

  it('keeps the gradient outside touch handling and assistive navigation', async () => {
    const { view, onPress } = await decoration();
    const decorativeViews = view.container.queryAll(node => node.props.accessibilityElementsHidden === true);
    // The card gradient is the one decoration left (the mockup's laptop crop
    // was removed: it drew the design screenshot onto every card).
    expect(decorativeViews.length).toBeGreaterThanOrEqual(1);
    for (const node of decorativeViews) {
      expect(node.props.accessible).toBe(false);
      expect(node.props.importantForAccessibility).toBe('no-hide-descendants');
      expect(StyleSheet.flatten(node.props.style).pointerEvents).toBe('none');
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Open commitment' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('removes decorative layers when reduced transparency changes without removing the action', async () => {
    let update: ((enabled: boolean) => void) | undefined;
    const listen = ((event: string, callback: unknown) => {
      if (event === 'reduceTransparencyChanged') update = callback as (enabled: boolean) => void;
      return { remove: jest.fn() };
    }) as unknown as typeof AccessibilityInfo.addEventListener;
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(listen);
    const { view, onPress } = await decoration();
    await act(() => update?.(true));
    expect(view.container.queryAll(node => node.props.accessibilityElementsHidden === true)).toHaveLength(0);
    const card = StyleSheet.flatten(screen.getByTestId('reference-card').props.style);
    expect(card.backgroundColor).toMatch(/^#[\da-f]{6}$/i);
    // The scoped palette is also used by TabBar and must keep the provider's
    // opaque fallback instead of restoring its translucent reference color.
    expect(screen.getByTestId('reference-bar-fill').props.children).toMatch(/^#[\da-f]{6}$/i);
    await fireEvent.press(screen.getByRole('button', { name: 'Open commitment' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
